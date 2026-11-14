// ---------------------------------------------------------------------------
// Migration 0055 (retire the legacy access layer) and 0056 (no client TRUNCATE).
//
// Production was found to answer "may this user see this site?" with the pre-organisation
// model: an old mg_can_access_site(uuid) body plus legacy "... select scoped" policies that
// no migration creates. This suite rebuilds that state on top of a clean build, proves the
// defect (an assigned-only site manager reads a site they are not assigned to), applies the
// migration, and proves the repo's rules hold. Every scenario rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const YA = "aaaaaaaa-0000-4000-8000-0000000000b1"; // OreCo company administrator
const SM = "aaaaaaaa-0000-4000-8000-0000000000d1"; // AgriLib site manager, assigned to site2 ONLY
const REG = "aaaaaaaa-0000-4000-8000-000000000091"; // registrar

const mig = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "supabase", "migrations", name), "utf8")
    .replace(/^begin;$/m, "")
    .replace(/^commit;$/m, ""); // keep the scenario inside the test's rolled-back transaction

beforeAll(async () => {
  f = await getFixture();
});

// multi-statement SQL cannot go through the single-statement runner; exec on the same (rolled-back) transaction
const exec = async (sql: string) => void (await (await getDb()).exec(sql));

const as = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);

// What production was found to hold (text taken from the read-only probe of the live database).
const LEGACY = `
create or replace function public.mg_can_access_site(p_county text, p_operator text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select case
      when p.role = 'admin' then true
      when p.role = 'operator' then p.operator_name is not null and p.operator_name = p_operator
      when p.role in ('supervisor','inspector') then (p.scope = 'national') or (p.scope = 'county' and p.county is not null and p.county = p_county)
      else false end from public.mg_profile() p), false);
$$;
create or replace function public.mg_can_access_site_row(p_county text, p_operator_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public.mg_is_admin()
       or (public.mg_is_staff() and (select scope from public.mg_profile()) = 'national')
       or (public.mg_is_staff() and (select scope from public.mg_profile()) = 'county' and (select county from public.mg_profile()) = p_county)
       or ((select role from public.mg_profile()) = 'operator' and (select operator_name from public.mg_profile()) = p_operator_name)), false);
$$;
create or replace function public.mg_can_access_site(p_site_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public.mg_can_access_site_row(s.county, s.operator_name) from public.sites s where s.id = p_site_id), false)
$$;
create policy "sites select scoped" on public.sites for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "incidents select scoped" on public.incidents for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "findings select scoped" on public.findings for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "audit select staff" on public.audit_log for select to authenticated using (mg_is_staff());
`;
const LEGACY_POLICIES = [
  ["sites", "sites select scoped"], ["incidents", "incidents select scoped"],
  ["findings", "findings select scoped"], ["audit_log", "audit select staff"],
];

async function world<T>(fn: (run: Runner, c: { siteA: string; site2: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email, raw_user_meta_data) values
      ('${XA}','xa@agrilib.test','{"name":"Xavier Admin"}'), ('${YA}','ya@oreco.test','{"name":"Yolanda Admin"}'),
      ('${SM}','sm@agrilib.test','{"name":"Sam Manager"}'), ('${REG}','reg@ministry.test','{"name":"Rita Registrar"}')`);
    await run(`update public.profiles set role = 'registrar', scope = 'national', profile_complete = true where id = '${REG}'`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    const siteA = (await run("select id from public.sites where code = 'LB-BOM-001'"))[0].id as string;
    const site2 = (await run(`insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude, created_by)
      values ('LB-BOM-002','Bomi North Pit','AgriLib Mining','Gold','Bomi','Senjeh','Bomi Hills','active',6.9,-10.9,'${f.admin}') returning id`))[0].id as string;
    await run("set local role authenticated");
    for (const [org, uid, email] of [[orgA, XA, "xa@agrilib.test"], [orgB, YA, "ya@oreco.test"]] as const) {
      await as(run, REG);
      const inv = (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${inv}')`);
    }
    await as(run, XA);
    const inv = (await run(`select public.mg_create_org_invitation('${orgA}', 'sm@agrilib.test', 'site_manager') as id`))[0].id;
    await as(run, SM);
    await run(`select public.mg_accept_invitation('${inv}')`);
    await as(run, XA);
    await run("reset role");
    const mSm = (await run(`select id from public.organization_members where user_id = '${SM}'`))[0].id;
    await run("set local role authenticated");
    await as(run, XA);
    await run(`select public.mg_assign_member_site('${mSm}', '${site2}')`);
    return fn(run, { siteA, site2 });
  });
}

const count = async (run: Runner, sql: string) => Number((await run(sql))[0].n);
const policyNames = async (run: Runner) =>
  (await run(`select tablename||'.'||policyname as p from pg_policies where schemaname='public' order by 1`)).map((r) => String(r.p));

describe("0055 — the repo's own rules govern site access (no legacy bypass)", () => {
  test("clean build: an assigned-only site manager sees only the assigned site", async () => {
    await world(async (run, { siteA, site2 }) => {
      await as(run, SM);
      expect(await count(run, `select count(*) n from public.sites where id = '${site2}'`)).toBe(1);
      expect(await count(run, `select count(*) n from public.sites where id = '${siteA}'`)).toBe(0);
    });
  });

  test("the legacy state reproduces the defect: the same manager reads a site they are not assigned to", async () => {
    await world(async (run, { siteA }) => {
      await run("reset role");
      await exec(LEGACY);
      await run("set local role authenticated");
      await as(run, SM);
      expect(await count(run, `select count(*) n from public.sites where id = '${siteA}'`)).toBe(1); // the leak
    });
  });

  test("after 0055 the legacy bypass is closed, legitimate access is intact, and the policy set equals a clean build", async () => {
    await world(async (run, { siteA, site2 }) => {
      await run("reset role");
      const cleanPolicies = await policyNames(run);
      await exec(LEGACY);
      await exec(mig("0056_retire_legacy_access_layer.sql"));
      await run("set local role authenticated");

      await as(run, SM);
      expect(await count(run, `select count(*) n from public.sites where id = '${site2}'`)).toBe(1);
      expect(await count(run, `select count(*) n from public.sites where id = '${siteA}'`)).toBe(0);
      expect(await count(run, `select count(*) n from public.incidents where site_id = '${siteA}'`)).toBe(0);
      expect(await count(run, `select count(*) n from public.findings where site_id = '${siteA}'`)).toBe(0);

      await as(run, XA); // the company administrator still reaches the whole company
      expect(await count(run, `select count(*) n from public.sites where id in ('${siteA}','${site2}')`)).toBe(2);
      expect(await count(run, `select count(*) n from public.incidents where site_id = '${siteA}'`)).toBeGreaterThan(0);

      await as(run, YA); // another company still sees nothing of AgriLib
      expect(await count(run, `select count(*) n from public.sites where id in ('${siteA}','${site2}')`)).toBe(0);

      await as(run, f.admin); // Ministry administrators keep national access
      expect(await count(run, `select count(*) n from public.sites where id in ('${siteA}','${site2}')`)).toBe(2);

      await run("reset role");
      const after = await policyNames(run);
      for (const [t, n] of LEGACY_POLICIES) expect(after, `${t}.${n}`).not.toContain(`${t}.${n}`);
      expect(after).toEqual(cleanPolicies);
      const def = String((await run(`select pg_get_functiondef('public.mg_can_access_site(uuid)'::regprocedure) d`))[0].d);
      expect(def).toContain("s.id, s.county, s.district, s.operator_name, s.organization_id");
    });
  });

  test("0055 is idempotent: applying it again to a clean build changes nothing", async () => {
    await world(async (run) => {
      await run("reset role");
      const before = await policyNames(run);
      await exec(mig("0056_retire_legacy_access_layer.sql"));
      await exec(mig("0056_retire_legacy_access_layer.sql"));
      expect(await policyNames(run)).toEqual(before);
    });
  });

  test("every table keeps a policy for each command it had (nothing is stranded by the drops)", async () => {
    await world(async (run) => {
      await run("reset role");
      await exec(LEGACY);
      await exec(mig("0056_retire_legacy_access_layer.sql"));
      const rows = await run(`select tablename, cmd from pg_policies where schemaname='public'
        and tablename in ('sites','incidents','inspections','findings','evidence','corrective_actions','environmental_observations','inspection_templates')`);
      const has = (t: string, c: string) => rows.some((r) => r.tablename === t && r.cmd === c);
      for (const t of ["sites", "incidents", "inspections", "findings", "evidence", "corrective_actions", "environmental_observations", "inspection_templates"]) {
        expect(has(t, "SELECT"), `${t} SELECT`).toBe(true);
      }
      for (const t of ["incidents", "inspections", "findings", "evidence", "corrective_actions", "environmental_observations", "inspection_templates", "sites"]) {
        expect(has(t, "INSERT"), `${t} INSERT`).toBe(true);
      }
    });
  });
});

describe("0056 — client roles hold no TRUNCATE", () => {
  test("after 0056 neither anon nor authenticated can truncate any public table", async () => {
    await withRole("postgres", null, async (run) => {
      await run("grant truncate on public.audit_log, public.sites, public.profiles to authenticated");
      await exec(mig("0057_revoke_client_truncate.sql"));
      const bad = await run(`select c.relname, r.rolname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        cross join (select rolname from pg_roles where rolname in ('anon','authenticated')) r
        where n.nspname='public' and c.relkind='r' and has_table_privilege(r.rolname, c.oid, 'TRUNCATE')`);
      expect(bad).toEqual([]);
    });
  });
});

describe("supabase/checks/security_posture.sql (post-deployment verification)", () => {
  const check = readFileSync(join(import.meta.dir, "..", "supabase", "checks", "security_posture.sql"), "utf8");
  const rejects = async (sql: string) => {
    await exec("savepoint chk"); // a raised exception aborts the transaction; keep the scenario usable
    try {
      await exec(sql);
      await exec("release savepoint chk");
    } catch (e) {
      await exec("rollback to savepoint chk");
      return String((e as Error).message);
    }
    return "";
  };
  test("passes on a database built from the migrations", async () => {
    await withRole("postgres", null, async () => {
      expect(await rejects(check)).toBe("");
    });
  });
  test("fails on the legacy production state and passes once 0055 and 0056 are applied", async () => {
    await withRole("postgres", null, async () => {
      await exec(LEGACY);
      expect(await rejects(check)).toMatch(/SECURITY POSTURE/);
      await exec(mig("0056_retire_legacy_access_layer.sql"));
      await exec(mig("0057_revoke_client_truncate.sql"));
      expect(await rejects(check)).toBe("");
    });
  });
  test("fails when RLS is switched off or a client role regains TRUNCATE", async () => {
    await withRole("postgres", null, async () => {
      await exec("alter table public.incidents disable row level security");
      expect(await rejects(check)).toMatch(/RLS disabled on: incidents/);
    });
    await withRole("postgres", null, async () => {
      await exec("grant truncate on public.audit_log to authenticated");
      expect(await rejects(check)).toMatch(/excess client privileges/);
    });
  });
});
