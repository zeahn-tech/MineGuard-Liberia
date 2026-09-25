// ---------------------------------------------------------------------------
// PGlite test harness — a REAL Postgres (WASM, in-process) that applies
// supabase/migrations/*.sql in order from a completely empty database.
//
// Supabase platform objects the migrations depend on (auth schema, storage
// schema, the anon/authenticated/service_role roles, the realtime publication)
// are stubbed here to match Supabase's hosted behaviour: auth.uid()/auth.role()
// read the `request.jwt.claims` GUC exactly like PostgREST sets it, and
// storage.objects has RLS enabled with no policies of its own — the only
// storage policies that exist are the ones our migrations create.
//
// Every role-scoped test runs inside a transaction that is always rolled
// back, so the shared database stays pristine across tests and files.
// ---------------------------------------------------------------------------

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/** Every .sql file under supabase/migrations, in name order — i.e. exactly
 *  what a fresh deployer would run, top to bottom. Auto-discovered so a new
 *  migration is covered by the suite the moment it lands in the repo. */
export const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

export const PLATFORM_STUB = `
-- ---- roles Supabase provisions by default ---------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- ---- auth schema ----------------------------------------------------------
create schema auth;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- PostgREST puts the JWT claims into this GUC; our stub reads it the same way.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    'anon')
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb,
                  '{}'::jsonb)
$$;

grant usage on schema auth to anon, authenticated;
grant execute on all functions in schema auth to anon, authenticated;

-- ---- storage schema -------------------------------------------------------
create schema storage;

create table storage.buckets (
  id              text primary key,
  name            text,
  public          boolean not null default false,
  file_size_limit bigint
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text not null references storage.buckets(id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

-- Hosted Supabase has RLS ON for storage.objects; the only policies that may
-- exist are the ones our own migrations create.
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : cardinality(string_to_array(name, '/')) - 1]
$$;

grant usage on schema storage to anon, authenticated;
grant execute on all functions in schema storage to anon, authenticated;
grant select, insert, update, delete on storage.buckets, storage.objects
  to anon, authenticated;

-- ---- realtime publication -------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
`;

let dbPromise: Promise<PGlite> | null = null;

/** Boots the database once per test process: stub → migrations in order. */
export function getDb(): Promise<PGlite> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
      await db.exec(PLATFORM_STUB);
      for (const file of MIGRATIONS) {
        const sql = readFileSync(
          join(ROOT, "supabase", "migrations", file),
          "utf8",
        );
        try {
          await db.exec(sql);
        } catch (e) {
          throw new Error(
            `migration ${file} failed on a clean database: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      return db;
    })();
  }
  return dbPromise;
}

export type Row = Record<string, unknown>;
export type Runner = (sql: string, params?: unknown[]) => Promise<Row[]>;

function lit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function runIn(db: PGlite, sql: string, params?: unknown[]): Promise<Row[]> {
  // Every statement runs inside its own SAVEPOINT: tests are allowed to
  // catch an expected RLS/guard denial and keep going, and without this the
  // aborted transaction would poison every later statement in the block
  // ("current transaction is aborted").
  //
  // Transaction/session-control statements (BEGIN/COMMIT/ROLLBACK/SAVEPOINT,
  // SET/RESET, …) pass through untouched: wrapping them in a savepoint would
  // either fail outright or corrupt the transaction state that `withRole`
  // deliberately manages itself (e.g. a test's own `rollback` in `finally`).
  const head = sql
    .trim()
    .replace(/;+\s*$/, "")
    .split(/\s/)[0]
    ?.toUpperCase();
  if (
    head &&
    [
      "BEGIN",
      "COMMIT",
      "END",
      "ROLLBACK",
      "SAVEPOINT",
      "RELEASE",
      "SET",
      "RESET",
      "PREPARE",
      "DEALLOCATE",
    ].includes(head)
  ) {
    await db.exec(sql);
    return [];
  }

  await db.exec("savepoint mg_sp");
  try {
    const res = await db.query(sql, params);
    await db.exec("release savepoint mg_sp");
    return res.rows as Row[];
  } catch (e) {
    await db.exec("rollback to savepoint mg_sp").catch(() => {});
    throw e;
  }
}

/**
 * Execute `fn` while the session impersonates a Postgres role with the given
 * JWT claims (null claims = no session), then ALWAYS roll back. Errors thrown
 * by SQL surface as exceptions from `fn`; the transaction is cleaned up first.
 */
export async function withRole<T>(
  role: "anon" | "authenticated" | "postgres",
  claims: Record<string, unknown> | null,
  fn: (run: Runner) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  await db.exec("begin");
  try {
    if (role !== "postgres") await db.exec(`set local role ${role}`);
    await db.exec(
      `set local request.jwt.claims = ${lit(claims ? JSON.stringify(claims) : "")}`,
    );
    const out = await fn((sql, params) => runIn(db, sql, params));
    await db.exec("rollback");
    return out;
  } catch (e) {
    try {
      await db.exec("rollback");
    } catch {
      /* already aborted */
    }
    throw e;
  }
}

/** Convenience: an authenticated (but possibly role-less) session. */
export function asUser<T>(
  userId: string,
  fn: (run: Runner) => Promise<T>,
): Promise<T> {
  return withRole("authenticated", { sub: userId, role: "authenticated" }, fn);
}

/**
 * Affected-row count for `INSERT/UPDATE/DELETE … RETURNING 1`. A write that
 * RLS or a guard trigger rejects touches ZERO rows — `db.query` then returns
 * an empty rows array, which is a legitimate denial signal (not a crash), so
 * it maps to 0. `withRole`'s always-rollback still applies.
 */
export async function affectedRows(
  run: Runner,
  sql: string,
): Promise<number> {
  const rows = await run(sql);
  return rows.length;
}

// ---------------------------------------------------------------------------
// FIXTURE — one shared, deterministic dataset per test process.
// ---------------------------------------------------------------------------

export const IDS = {
  admin: "aaaaaaaa-0000-4000-8000-000000000001",
  opA: "aaaaaaaa-0000-4000-8000-000000000002",
  opB: "aaaaaaaa-0000-4000-8000-000000000003",
  county: "aaaaaaaa-0000-4000-8000-000000000004",
  national: "aaaaaaaa-0000-4000-8000-000000000005",
  guest: "aaaaaaaa-0000-4000-8000-000000000006",
  siteA: "bbbbbbbb-0000-4000-8000-000000000001",
  siteB: "bbbbbbbb-0000-4000-8000-000000000002",
  template: "cccccccc-0000-4000-8000-000000000001",
  inspection: "dddddddd-0000-4000-8000-000000000001",
  findingA: "eeeeeeee-0000-4000-8000-000000000001",
  findingB: "eeeeeeee-0000-4000-8000-000000000002",
  caA: "eeeeeeee-0000-4000-8000-000000000003",
  incidentA: "ffffffff-0000-4000-8000-000000000001",
  obsB: "ffffffff-0000-4000-8000-000000000002",
  evidenceA: "99999999-0000-4000-8000-000000000001",
};

const adminClaims = JSON.stringify({ sub: IDS.admin, role: "authenticated" });

const SEED_SQL = `
begin;

-- 1. Accounts. The on_auth_user_created trigger creates every profile row.
insert into auth.users (id, email, raw_user_meta_data) values
  ('${IDS.admin}',  'alice@mineguard.test', '{"name":"Alice Admin"}'),
  ('${IDS.opA}',    'bob@agrilib.test',     '{"name":"Bob Operator"}'),
  ('${IDS.opB}',    'carol@oreco.test',     '{"name":"Carol Operator"}'),
  ('${IDS.county}', 'dave@mineguard.test',  '{"name":"Dave Inspector"}'),
  ('${IDS.national}','erin@mineguard.test', '{"name":"Erin Supervisor"}'),
  ('${IDS.guest}',  'frank@guest.test',     '{"name":"Frank Guest"}');

-- 2. First-admin bootstrap through the real user-facing path: an
--    authenticated account claiming admin while NO profile has a role yet.
set local role authenticated;
set local request.jwt.claims = '${adminClaims}';
update public.profiles
   set role = 'admin', scope = 'national', profile_complete = true,
       job_title = 'Director', organization = 'MineGuard Liberia'
 where id = '${IDS.admin}';
reset role;
set local request.jwt.claims = '';

-- 3. The admin provisions everyone else (admin-writes-other-profiles path).
set local role authenticated;
set local request.jwt.claims = '${adminClaims}';
update public.profiles set role = 'operator', scope = 'site',
       operator_name = 'AgriLib Mining', county = 'Bomi', profile_complete = true
 where id = '${IDS.opA}';
update public.profiles set role = 'operator', scope = 'site',
       operator_name = 'OreCo Liberia', county = 'Grand Cape Mount',
       profile_complete = true
 where id = '${IDS.opB}';
update public.profiles set role = 'inspector', scope = 'county',
       county = 'Bomi', profile_complete = true, job_title = 'County Inspector'
 where id = '${IDS.county}';
update public.profiles set role = 'supervisor', scope = 'national',
       profile_complete = true, job_title = 'Compliance Supervisor'
 where id = '${IDS.national}';
-- ${IDS.guest} deliberately stays role-less (unassigned "guest" account).

-- 4. Registry + workflow records (admin context: sites/templates guards).
insert into public.sites
  (id, code, name, operator_name, mineral_type, county, district, community,
   status, latitude, longitude, created_by) values
  ('${IDS.siteA}', 'LB-BOM-001', 'Bomi River Wash Plant', 'AgriLib Mining',
   'Gold', 'Bomi', 'Senjeh', 'Bomi Hills', 'active', 6.85, -10.85, '${IDS.admin}'),
  ('${IDS.siteB}', 'LB-GCM-001', 'Cape Mount Ore Site', 'OreCo Liberia',
   'Iron ore', 'Grand Cape Mount', 'Garwula', 'Kerry Town', 'active',
   7.10, -11.10, '${IDS.admin}');

insert into public.inspection_templates
  (id, name, description, active, sections, created_by) values
  ('${IDS.template}', 'Routine Site Inspection',
   'Baseline safety + environment checks', true,
   '[{"title":"Safety","questions":[{"id":"q1","label":"PPE in use?","type":"boolean","required":true}]}]'::jsonb,
   '${IDS.admin}');

insert into public.inspections
  (id, site_id, template_id, inspector_id, status, answers) values
  ('${IDS.inspection}', '${IDS.siteA}', '${IDS.template}', '${IDS.admin}',
   'draft', '[]'::jsonb);

insert into public.findings
  (id, inspection_id, site_id, title, severity, created_by_id) values
  ('${IDS.findingA}', '${IDS.inspection}', '${IDS.siteA}',
   'Unguarded jaw crusher', 'high', '${IDS.admin}'),
  ('${IDS.findingB}', '${IDS.inspection}', '${IDS.siteB}',
   'Tailings pond overtopping risk', 'critical', '${IDS.admin}');

insert into public.corrective_actions
  (id, finding_id, site_id, description, due_at, opened_by_id) values
  ('${IDS.caA}', '${IDS.findingA}', '${IDS.siteA}',
   'Install machine guard and retrain crew', now() + interval '7 days',
   '${IDS.admin}');
reset role;
set local request.jwt.claims = '';

-- 5. Operator files an incident at his own site (RLS insert path).
set local role authenticated;
set local request.jwt.claims = '{"sub":"${IDS.opA}","role":"authenticated"}';
insert into public.incidents
  (id, site_id, type, severity, description, occurred_at, reported_by_id,
   report_source) values
  ('${IDS.incidentA}', '${IDS.siteA}', 'near_miss', 'medium',
   'Haul truck near miss at the ramp junction', now() - interval '1 day',
   '${IDS.opA}', 'operator');

-- The operator also attaches the evidence for that incident: the evidence
-- INSERT policy requires uploaded_by_id = auth.uid(), so it must be written
-- in HIS session, not the admin's.
insert into public.evidence
  (id, storage_path, parent_type, parent_id, site_id, kind, file_name,
   mime_type, size_bytes, uploaded_by_id) values
  ('${IDS.evidenceA}',
   '${IDS.opA}/${IDS.evidenceA}__haul-road.jpg',
   'incident', '${IDS.incidentA}', '${IDS.siteA}', 'photo', 'haul-road.jpg',
   'image/jpeg', 2048, '${IDS.opA}');
reset role;
set local request.jwt.claims = '';

-- 6. Observation at site B (admin session).
set local role authenticated;
set local request.jwt.claims = '${adminClaims}';
insert into public.environmental_observations
  (id, site_id, category, verification, description, observed_at,
   reported_by_id) values
  ('${IDS.obsB}', '${IDS.siteB}', 'water_pollution', 'alleged',
   'Orange discharge entering the stream below the plant',
   now() - interval '2 days', '${IDS.admin}');
reset role;
set local request.jwt.claims = '';

-- 7. The matching storage object, uploaded into the operator's own namespace
--    (storage INSERT policy: uid folder + assigned role).
set local role authenticated;
set local request.jwt.claims = '{"sub":"${IDS.opA}","role":"authenticated"}';
insert into storage.objects (bucket_id, name, owner) values
  ('evidence', '${IDS.opA}/${IDS.evidenceA}__haul-road.jpg', '${IDS.opA}');
reset role;
set local request.jwt.claims = '';

-- 8. World-readable mirrors + audit row (superuser context, RLS bypassed).
insert into public.meta (key, value)
  values ('public_stats', '{"sites":2,"incidents":1}'::jsonb)
  on conflict (key) do nothing;

insert into public.community_reports
  (id, tracking_code, category, description, county, status) values
  ('99999999-0000-4000-8000-000000000010', 'CR-TEST0001', 'pollution',
   'Brown water near the wash plant', 'Bomi', 'submitted');

insert into public.report_tracking (tracking_code, status)
  values ('CR-TEST0001', 'submitted') on conflict (tracking_code) do nothing;

insert into public.rate_limits (bucket, count)
  values ('community_report:global', 0)
  on conflict (bucket) do nothing;

insert into public.audit_log
  (actor_id, actor_label, action, entity_type, entity_id, summary) values
  ('${IDS.admin}', 'Alice Admin', 'site.create', 'site', '${IDS.siteA}',
   'seeded fixture site');

commit;
`;

let fixturePromise: Promise<typeof IDS> | null = null;

/** Seeds the shared fixture exactly once per process. */
export function getFixture(): Promise<typeof IDS> {
  if (!fixturePromise) {
    fixturePromise = (async () => {
      const db = await getDb();
      try {
        await db.exec(SEED_SQL);
      } catch (e) {
        // Leave no half-open transaction behind, or every later test would
        // fail with "current transaction is aborted".
        await db.exec("rollback").catch(() => {});
        throw e;
      }
      return IDS;
    })();
  }
  return fixturePromise;
}
