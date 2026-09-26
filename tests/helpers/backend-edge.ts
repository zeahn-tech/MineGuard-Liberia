// ---------------------------------------------------------------------------
// BACKEND EDGE BRIDGE — runs the REAL src/lib/backend.ts unmodified against
// a REAL Postgres (its own PGlite instance: stub → all migrations → compact
// seed) by translating the supabase-js wire vocabulary into RLS-enforced
// SQL. Gap Closure Directive v1.0, Gap #3.
//
// FIDELITY MODEL
//   * One PGlite instance per process dedicated to this suite — mutations
//     from authorized-path tests COMMIT, so post-conditions are verified in
//     SQL afterwards. Cross-test state is real, like the wire.
//   * Each wire request runs as its own transaction: BEGIN, SET LOCAL role +
//     request.jwt.claims (exactly what PostgREST does per HTTP request),
//     COMMIT on success, ROLLBACK on error. Errors surface as real Postgres
//     error objects for backendError() to shape.
//   * A global request MUTEX serializes wire requests. backend.ts fires
//     concurrent requests (Promise.all); PGlite is single-connection, so
//     interleaved transactions would corrupt isolation. Serializing is the
//     honest PostgREST-equivalent: every request still sees the committed
//     state of the request before it.
//   * LOUD-FAIL: any supabase-js vocabulary the bridge does not implement
//     throws BRIDGE_UNSUPPORTED_* at the point of use — a silent
//     mis-translation would make the suite lie.
//
// STORAGE: object rows live in the stub storage.objects under the real
// storage policies applied from the migrations (upload policy: own uid
// folder + assigned role). createSignedUrl is faked — URL material is not
// under test here; the mint gate (evidence_url RPC) and the storage policy
// are, and both are real.
//
// GOTRUE: a minimal fake over the stub auth.users with the failure shapes
// backend.ts's authErrorMessage() maps (invalid credentials, duplicate
// email). signUp creates auth.users rows through the REAL trigger.
// ---------------------------------------------------------------------------

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

// ---------------------------------------------------------------------------
// dedicated database — boot once per process
// ---------------------------------------------------------------------------

let edgeDb: PGlite | null = null;
let edgeBoot: Promise<PGlite> | null = null;

export const EDGE_IDS = {
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
  caA: "eeeeeeee-0000-4000-8000-000000000003",
  incidentA: "ffffffff-0000-4000-8000-000000000001",
  evidenceA: "99999999-0000-4000-8000-000000000001",
};

/** Compact committed seed (no live-probe artifacts, no rate-limit rows).
 *  Mirrors the shared fixture's identity/tenant shape so client- and
 *  server-side authorization agree. */
const EDGE_SEED = `
begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('${EDGE_IDS.admin}',  'alice@mineguard.test', '{"name":"Alice Admin"}'),
  ('${EDGE_IDS.opA}',    'bob@agrilib.test',     '{"name":"Bob Operator"}'),
  ('${EDGE_IDS.opB}',    'carol@oreco.test',     '{"name":"Carol Operator"}'),
  ('${EDGE_IDS.county}', 'dave@mineguard.test',  '{"name":"Dave Inspector"}'),
  ('${EDGE_IDS.national}','erin@mineguard.test', '{"name":"Erin Supervisor"}'),
  ('${EDGE_IDS.guest}',  'frank@guest.test',     '{"name":"Frank Guest"}');

-- First-admin bootstrap through the real user-facing path.
set local role authenticated;
set local request.jwt.claims = '{"sub":"${EDGE_IDS.admin}","role":"authenticated"}';
update public.profiles
   set role = 'admin', scope = 'national', profile_complete = true,
       job_title = 'Director', organization = 'MineGuard Liberia'
 where id = '${EDGE_IDS.admin}';
update public.profiles set role = 'operator', scope = 'site',
       operator_name = 'AgriLib Mining', county = 'Bomi', profile_complete = true
 where id = '${EDGE_IDS.opA}';
update public.profiles set role = 'operator', scope = 'site',
       operator_name = 'OreCo Liberia', county = 'Grand Cape Mount',
       profile_complete = true
 where id = '${EDGE_IDS.opB}';
update public.profiles set role = 'inspector', scope = 'county',
       county = 'Bomi', profile_complete = true, job_title = 'County Inspector'
 where id = '${EDGE_IDS.county}';
update public.profiles set role = 'supervisor', scope = 'national',
       profile_complete = true, job_title = 'Compliance Supervisor'
 where id = '${EDGE_IDS.national}';
reset role;
set local request.jwt.claims = '';

-- Registry + workflow records: the site/template write guards check
-- mg_is_admin(), which reads auth.uid() — so these inserts must run inside
-- the ADMIN session (the same idiom the shared fixture seed uses).
set local role authenticated;
set local request.jwt.claims = '{"sub":"${EDGE_IDS.admin}","role":"authenticated"}';
insert into public.sites
  (id, code, name, operator_name, mineral_type, county, district, community,
   status, latitude, longitude, created_by) values
  ('${EDGE_IDS.siteA}', 'LB-BOM-001', 'Bomi River Wash Plant', 'AgriLib Mining',
   'Gold', 'Bomi', 'Senjeh', 'Bomi Hills', 'active', 6.85, -10.85, '${EDGE_IDS.admin}'),
  ('${EDGE_IDS.siteB}', 'LB-GCM-001', 'Cape Mount Ore Site', 'OreCo Liberia',
   'Iron ore', 'Grand Cape Mount', 'Garwula', 'Kerry Town', 'active',
   7.10, -11.10, '${EDGE_IDS.admin}');

insert into public.inspection_templates
  (id, name, description, active, sections, created_by) values
  ('${EDGE_IDS.template}', 'Routine Site Inspection',
   'Baseline safety + environment checks', true,
   '[{"title":"Safety","questions":[{"id":"q1","label":"PPE in use?","type":"boolean","required":true}]}]'::jsonb,
   '${EDGE_IDS.admin}');

insert into public.inspections
  (id, site_id, template_id, inspector_id, status, answers) values
  ('${EDGE_IDS.inspection}', '${EDGE_IDS.siteA}', '${EDGE_IDS.template}', '${EDGE_IDS.admin}',
   'draft', '[]'::jsonb);

insert into public.findings
  (id, inspection_id, site_id, title, severity, created_by_id) values
  ('${EDGE_IDS.findingA}', '${EDGE_IDS.inspection}', '${EDGE_IDS.siteA}',
   'Unguarded jaw crusher', 'high', '${EDGE_IDS.admin}');

insert into public.corrective_actions
  (id, finding_id, site_id, description, due_at, opened_by_id) values
  ('${EDGE_IDS.caA}', '${EDGE_IDS.findingA}', '${EDGE_IDS.siteA}',
   'Install machine guard and retrain crew', now() + interval '7 days',
   '${EDGE_IDS.admin}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"${EDGE_IDS.opA}","role":"authenticated"}';
insert into public.incidents
  (id, site_id, type, severity, description, occurred_at, reported_by_id,
   report_source) values
  ('${EDGE_IDS.incidentA}', '${EDGE_IDS.siteA}', 'near_miss', 'medium',
   'Haul truck near miss at the ramp junction', now() - interval '1 day',
   '${EDGE_IDS.opA}', 'operator');
insert into public.evidence
  (id, storage_path, parent_type, parent_id, site_id, kind, file_name,
   mime_type, size_bytes, uploaded_by_id) values
  ('${EDGE_IDS.evidenceA}',
   '${EDGE_IDS.opA}/${EDGE_IDS.evidenceA}__haul-road.jpg',
   'incident', '${EDGE_IDS.incidentA}', '${EDGE_IDS.siteA}', 'photo',
   'haul-road.jpg', 'image/jpeg', 2048, '${EDGE_IDS.opA}');
insert into storage.objects (bucket_id, name, owner) values
  ('evidence', '${EDGE_IDS.opA}/${EDGE_IDS.evidenceA}__haul-road.jpg', '${EDGE_IDS.opA}');
reset role;
set local request.jwt.claims = '';

insert into public.meta (key, value)
  values ('public_stats', '{"sites":2,"incidents":1}'::jsonb)
  on conflict (key) do nothing;
insert into public.community_reports
  (id, tracking_code, category, description, county, status) values
  ('99999999-0000-4000-8000-000000000010', 'CR-TEST0001', 'pollution',
   'Brown water near the wash plant', 'Bomi', 'submitted');
insert into public.report_tracking (tracking_code, status)
  values ('CR-TEST0001', 'submitted') on conflict (tracking_code) do nothing;

commit;
`;

export async function getEdgeDb(): Promise<PGlite> {
  if (!edgeBoot) {
    edgeBoot = (async () => {
      const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
      // Same boot as the shared harness (inlined because pglite-db.ts owns a
      // singleton for the other suites).
      const stubPath = join(ROOT, "tests", "helpers", "pglite-db.ts");
      void stubPath;
      const { PLATFORM_STUB } = await import("./pglite-db");
      await db.exec(PLATFORM_STUB);
      const migrations = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of migrations) {
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        try {
          await db.exec(sql);
        } catch (e) {
          throw new Error(
            `edge-db migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      await db.exec(EDGE_SEED);
      edgeDb = db;
      return db;
    })();
  }
  return edgeBoot;
}

// ---------------------------------------------------------------------------
// request pipeline — mutex + per-request transaction (commit on success)
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/** Identity for subsequent wire requests. Mirrors the supabase.ts test hook
 *  (which drives backend.ts's authUserId()). */
let current: { uid: string | null } = { uid: null };

export const edgeIdentity = {
  set(uid: string | null) {
    current.uid = uid;
  },
  get(): string | null {
    return current.uid;
  },
};

type Row = Record<string, unknown>;

/** One wire request = one transaction with the caller's identity. */
async function wireQuery(sql: string): Promise<Row[]> {
  return enqueue(async () => {
    const db = await getEdgeDb();
    await db.exec("begin");
    try {
      await db.exec(
        current.uid
          ? `set local role authenticated; set local request.jwt.claims = '${JSON.stringify({ sub: current.uid, role: "authenticated" })}';`
          : `set local role anon; set local request.jwt.claims = '';`,
      );
      const res = await db.query(sql);
      await db.exec("commit");
      return res.rows as Row[];
    } catch (e) {
      try {
        await db.exec("rollback");
      } catch {
        /* already aborted */
      }
      throw e;
    }
  });
}

/** Admin-context SQL for post-condition verification and test setup. */
export async function adminSql(sql: string): Promise<Row[]> {
  return enqueue(async () => {
    const db = await getEdgeDb();
    const res = await db.query(sql);
    return res.rows as Row[];
  });
}

// ---------------------------------------------------------------------------
// value literals
// ---------------------------------------------------------------------------

function lit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "null";
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  throw new Error(`BRIDGE_UNSUPPORTED_LITERAL:${typeof v}`);
}

const jsonbCols = new Map<string, Set<string>>();

async function jsonbColumns(table: string): Promise<Set<string>> {
  const hit = jsonbCols.get(table);
  if (hit) return hit;
  // Deliberately NOT adminSql(): execWrite runs inside an already-enqueued
  // request, and adminSql re-enqueues — a self-deadlock. A read-only catalog
  // lookup can safely run on the connection outside the request mutex.
  const db = await getEdgeDb();
  const res = await db.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = '${table.replace(/'/g, "''")}'
        and data_type = 'jsonb'`,
  );
  const set = new Set(res.rows.map((r) => String((r as Row).column_name)));
  jsonbCols.set(table, set);
  return set;
}

async function typedValue(
  table: string,
  col: string,
  v: unknown,
): Promise<string> {
  if (v !== null && v !== undefined && typeof v === "object") {
    return lit(v); // objects/arrays go to jsonb explicitly
  }
  const jb = await jsonbColumns(table);
  if (jb.has(col)) return `${lit(v)}::jsonb`;
  return lit(v);
}

function pgErrorObject(e: unknown): { message: string; code?: string } {
  const err = e as { code?: string; message?: string };
  return {
    message: err?.message ?? (e instanceof Error ? e.message : String(e)),
    code: err?.code,
  };
}

// ---------------------------------------------------------------------------
// the PostgREST-ish builder (awaitable via then())
// ---------------------------------------------------------------------------

class WireQuery {
  private table = "";
  private cols = "*";
  private wheres: string[] = [];
  private orderSql = "";
  private limitSql = "";
  private values: Record<string, unknown> | null = null;
  private isUpdate = false;
  private onConflictCols: string[] | null = null;
  private ignoreDup = false;
  private wantSingle = false;
  private maybe = false;

  from(table: string) {
    this.table = table;
    return this;
  }

  // supabase-js passes upsert options through the select() call.
  select(cols = "*", opts?: { onConflict?: string }) {
    this.cols = cols;
    if (opts?.onConflict) {
      this.onConflictCols = opts.onConflict.split(",").map((c) => c.trim());
    }
    return this;
  }

  eq(col: string, val: unknown) {
    this.wheres.push(`${col} = ${lit(val)}`);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orderSql = ` order by ${col} ${opts?.ascending === false ? "desc" : "asc"}`;
    return this;
  }

  limit(n: number) {
    this.limitSql = ` limit ${Math.trunc(Number(n))}`;
    return this;
  }

  insert(values: Record<string, unknown>, opts?: { ignoreDuplicates?: boolean }) {
    this.values = values;
    this.ignoreDup = !!opts?.ignoreDuplicates;
    return this;
  }

  upsert(values: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.values = values;
    if (opts?.onConflict) this.onConflictCols = opts.onConflict.split(",").map((c) => c.trim());
    this.ignoreDup = !!opts?.ignoreDuplicates;
    return this;
  }

  update(values: Record<string, unknown>) {
    this.values = values;
    this.isUpdate = true;
    return this;
  }

  single() {
    this.wantSingle = true;
    return this;
  }

  maybeSingle() {
    this.maybe = true;
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(resolve: (v: any) => any, reject?: (e: unknown) => any): any {
    return this.exec().then(resolve, reject);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  catch(fn: (e: unknown) => any): any {
    return this.exec().catch(fn);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async exec(): Promise<any> {
    try {
      if (this.values !== null) return await this.execWrite();
      const w = this.wheres.length ? ` where ${this.wheres.join(" and ")}` : "";
      const rows = await wireQuery(
        `select ${this.cols} from public.${this.table}${w}${this.orderSql}${this.limitSql}`,
      );
      if (this.maybe) return { data: rows[0] ?? null, error: null };
      if (this.wantSingle) {
        if (rows.length === 0) {
          return {
            data: null,
            error: { message: "PGRST116: no rows returned", code: "PGRST116" },
          };
        }
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: pgErrorObject(e) };
    }
  }

  private async execWrite(): Promise<{ data: unknown; error: unknown }> {
    try {
      if (this.values!.__delete__ === true) {
        if (!this.wheres.length) {
          return { data: null, error: { message: "BRIDGE_UNSUPPORTED_DELETE_WITHOUT_WHERE" } };
        }
        const w = this.wheres.join(" and ");
        const rows = await wireQuery(
          `delete from public.${this.table} where ${w} returning 1 as deleted`,
        );
        return { data: rows, error: null };
      }

      if (this.isUpdate) {
        if (!this.wheres.length) {
          return { data: null, error: { message: "BRIDGE_UNSUPPORTED_UPDATE_WITHOUT_WHERE" } };
        }
        const assignments: string[] = [];
        for (const c of Object.keys(this.values!)) {
          assignments.push(`${c} = ${await typedValue(this.table, c, this.values![c])}`);
        }
        const rows = await wireQuery(
          `update public.${this.table} set ${assignments.join(", ")} where ${this.wheres.join(" and ")} returning 1 as updated`,
        );
        // PostgREST semantics: an UPDATE matched to zero rows (stale WHERE or
        // RLS-visibility) is a 200 with an empty array, NOT an error —
        // backend.ts only checks `error`. Guard-trigger violations RAISE and
        // surface through the catch below, exactly like the real wire.
        return { data: rows, error: null };
      }

      const cols = Object.keys(this.values!);
      const colList = cols.join(", ");
      const valSqls: string[] = [];
      for (const c of cols) valSqls.push(await typedValue(this.table, c, this.values![c]));
      const vals = valSqls.join(", ");

      if (this.onConflictCols && this.ignoreDup) {
        const oc = this.onConflictCols.join(", ");
        await wireQuery(
          `insert into public.${this.table} (${colList}) values (${vals}) on conflict (${oc}) do nothing`,
        );
        return { data: null, error: null }; // ignoreDuplicates: no row content
      }

      if (this.onConflictCols) {
        const oc = this.onConflictCols.join(", ");
        const updates = cols
          .filter((c) => !this.onConflictCols!.includes(c))
          .map((c) => `${c} = excluded.${c}`)
          .join(", ");
        const rows = updates
          ? await wireQuery(
              `insert into public.${this.table} (${colList}) values (${vals}) on conflict (${oc}) do update set ${updates} returning *`,
            )
          : await wireQuery(
              `insert into public.${this.table} (${colList}) values (${vals}) on conflict (${oc}) do nothing returning *`,
            );
        return { data: rows, error: null };
      }

      if (this.wantSingle) {
        const rows = await wireQuery(
          `insert into public.${this.table} (${colList}) values (${vals}) returning id`,
        );
        if (rows.length === 0) {
          // RLS/guard-denied insert = zero rows under PostgREST: an error,
          // never fake success. Message carries the RLS wording so
          // backendError() shapes it to the FORBIDDEN token like the wire.
          return {
            data: null,
            error: {
              message: "new row violates row-level security policy for table \"" + this.table + "\" (insert rejected by policy)",
              code: "42501",
            },
          };
        }
        return { data: rows[0], error: null };
      }

      const rows = await wireQuery(
        `insert into public.${this.table} (${colList}) values (${vals}) returning 1 as inserted`,
      );
      if (rows.length === 0) {
        return {
          data: null,
          error: { message: "insert rejected by policy (RLS or guard)", code: "42501" },
        };
      }
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: pgErrorObject(e) };
    }
  }
}

// ---------------------------------------------------------------------------
// RPC — named-notation calls through the real definer machinery
// ---------------------------------------------------------------------------

type RpcSpec = { fn: string; args: string[]; textArgs?: string[] };

const RPC_SPECS: Record<string, RpcSpec> = {
  submit_community_report: { fn: "submit_community_report", args: ["p_tracking_code", "p_category", "p_description", "p_county", "p_district", "p_community", "p_latitude", "p_longitude", "p_contact_phone"] },
  triage_community_report: { fn: "triage_community_report", args: ["p_report_id", "p_decision", "p_note"] },
  provision_user_by_email: { fn: "provision_user_by_email", args: ["p_email", "p_role", "p_scope", "p_county", "p_operator_name"] },
  complete_staff_profile: { fn: "complete_staff_profile", args: ["p_job_title", "p_organization", "p_scope", "p_county", "p_operator_name"] },
  evidence_for_parent: { fn: "evidence_for_parent", args: ["p_parent_type", "p_parent_id"] },
  evidence_url: { fn: "evidence_url", args: ["p_evidence_id", "p_ttl_seconds"] },
  refresh_public_stats: { fn: "refresh_public_stats", args: [] },
};

async function execRpc(
  fnName: string,
  payload: Record<string, unknown>,
): Promise<{ data: unknown; error: unknown }> {
  const spec = RPC_SPECS[fnName];
  if (!spec) throw new Error(`BRIDGE_UNSUPPORTED_RPC:${fnName}`);
  for (const k of Object.keys(payload)) {
    if (!spec.args.includes(k)) throw new Error(`BRIDGE_UNSUPPORTED_RPC_ARG:${fnName}.${k}`);
  }
  const parts = Object.keys(payload).map((k) => `${k} => ${lit(payload[k])}`);
  try {
    // PostgREST returns setof functions as an ARRAY of rows and scalar
    // returns as a single value. In a bare target list Postgres expands a
    // setof-composite into N rows of composite values, which would collapse
    // to rows[0] here — silently truncating evidence lists. Detect the
    // return type from pg_catalog and row-ify setof results explicitly.
    const rt = await rpcReturnType(spec.fn);
    if (rt.startsWith("setof")) {
      const rows = await wireQuery(
        `select to_jsonb(f) as result from public.${spec.fn}(${parts.join(", ")}) f`,
      );
      return { data: rows.map((r) => r.result), error: null };
    }
    const rows = await wireQuery(
      `select public.${spec.fn}(${parts.join(", ")}) as result`,
    );
    const raw = rows[0]?.result ?? null;
    return { data: raw, error: null };
  } catch (e) {
    return { data: null, error: pgErrorObject(e) };
  }
}

const rpcReturnCache = new Map<string, string>();
async function rpcReturnType(fn: string): Promise<string> {
  const hit = rpcReturnCache.get(fn);
  if (hit) return hit;
  const db = await getEdgeDb();
  const res = await db.query(
    `select prorettype::regtype::text as rt from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = '${fn.replace(/'/g, "''")}'`,
  );
  const rt = String((res.rows[0] as Row | undefined)?.rt ?? "");
  rpcReturnCache.set(fn, rt);
  return rt;
}

// ---------------------------------------------------------------------------
// storage — object rows under the real storage policies; signing faked
// ---------------------------------------------------------------------------

const KNOWN_OBJECTS = new Set<string>([
  `${EDGE_IDS.opA}/${EDGE_IDS.evidenceA}__haul-road.jpg`,
]);

async function storageInsert(
  bucket: string,
  path: string,
  owner: string | null,
): Promise<{ data: unknown; error: unknown }> {
  try {
    if (!owner) {
      return { data: null, error: { message: "storage upload requires a session" } };
    }
    const rows = await wireQuery(
      `insert into storage.objects (bucket_id, name, owner) values (${lit(bucket)}, ${lit(path)}, ${lit(owner)}) returning 1 as inserted`,
    );
    if (rows.length === 0) {
      return {
        data: null,
        error: {
          message: "new row violates row-level security policy for table \"objects\" (storage upload rejected by policy)",
          code: "42501",
        },
      };
    }
    KNOWN_OBJECTS.add(path);
    return { data: { path }, error: null };
  } catch (e) {
    return { data: null, error: pgErrorObject(e) };
  }
}

// ---------------------------------------------------------------------------
// GoTrue fake
// ---------------------------------------------------------------------------

const authBridge = {
  async signInWithPassword(args: { email: string; password: string }) {
    try {
      const rows = await adminSql(
        `select id, email from auth.users where lower(email) = lower(${lit(args.email)}) limit 1`,
      );
      const user = rows[0];
      if (!user) {
        return { data: { user: null, session: null }, error: { message: "Invalid login credentials" } };
      }
      edgeIdentity.set(user.id as string);
      return { data: { user, session: { user } }, error: null };
    } catch (e) {
      return { data: { user: null, session: null }, error: pgErrorObject(e) };
    }
  },

  async signUp(args: { email: string; password: string; options?: { data?: Record<string, unknown> } }) {
    try {
      const meta = args.options?.data ?? {};
      const rows = await adminSql(
        `select id from auth.users where lower(email) = lower(${lit(args.email)}) limit 1`,
      );
      if (rows.length > 0) {
        return { data: { user: null, session: null }, error: { message: "User already registered" } };
      }
      // The on_auth_user_created trigger creates the profile row — real
      // migration machinery, exercised exactly as in production.
      const inserted = await adminSql(
        `insert into auth.users (id, email, raw_user_meta_data)
         values (gen_random_uuid(), ${lit(args.email)}, ${lit(JSON.stringify(meta))}::jsonb)
         returning id, email`,
      );
      edgeIdentity.set(inserted[0].id as string);
      return { data: { user: inserted[0], session: { user: inserted[0] } }, error: null };
    } catch (e) {
      return { data: { user: null, session: null }, error: pgErrorObject(e) };
    }
  },

  async signInAnonymously() {
    try {
      const rows = await adminSql(
        `insert into auth.users (id, email, raw_user_meta_data)
         values (gen_random_uuid(), null, '{"guest":true}'::jsonb)
         returning id, email`,
      );
      edgeIdentity.set(rows[0].id as string);
      return { data: { user: rows[0], session: { user: rows[0] } }, error: null };
    } catch (e) {
      return { data: { user: null, session: null }, error: pgErrorObject(e) };
    }
  },

  async signOut() {
    edgeIdentity.set(null);
    return { error: null };
  },

  onAuthStateChange(_cb: unknown) {
    return { data: { subscription: { unsubscribe() {} } } };
  },
};

// ---------------------------------------------------------------------------
// exported bridge client (structural superset of the supabase-js surface
// backend.ts uses; anything else fails loudly)
// ---------------------------------------------------------------------------

export function createEdgeClient(): SupabaseClient {
  const unsupported = (what: string): never => {
    throw new Error(`BRIDGE_UNSUPPORTED:${what}`);
  };

  return {
    from(table: string) {
      return new WireQuery().from(table);
    },
    rpc(fnName: string, payload?: Record<string, unknown>) {
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (resolve: any, reject?: any) => execRpc(fnName, payload ?? {}).then(resolve, reject),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        catch: (fn: any) => execRpc(fnName, payload ?? {}).catch(fn),
      };
    },
    auth: authBridge,
    storage: {
      from(bucket: string) {
        if (bucket !== "evidence") unsupported(`storage bucket ${bucket}`);
        return {
          async upload(path: string, _file: unknown, _opts?: unknown) {
            void _file;
            void _opts;
            return storageInsert(bucket, path, edgeIdentity.get());
          },
          async createSignedUrl(path: string, ttl: number) {
            const exists = KNOWN_OBJECTS.has(path) || (await adminSql(
              `select 1 from storage.objects where bucket_id = 'evidence' and name = ${lit(path)} limit 1`,
            )).length > 0;
            if (!exists) {
              return { data: null, error: { message: "Object not found" } };
            }
            return {
              data: { signedUrl: `https://bridge.local/sign/evidence/${path}?ttl=${ttl}` },
              error: null,
            };
          },
        };
      },
    },
    channel() {
      return unsupported("realtime channel");
    },
    async removeChannel() {
      return "closed";
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as unknown as SupabaseClient;
}
