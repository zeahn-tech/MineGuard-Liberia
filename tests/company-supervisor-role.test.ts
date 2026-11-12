// ---------------------------------------------------------------------------
// Migration 0052 — the company "supervisor" role: appointed only by a company
// administrator, site-scoped like a safety officer, no management rights. Real Postgres (PGlite).
// ---------------------------------------------------------------------------
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const SM = "aaaaaaaa-0000-4000-8000-0000000000b1"; // site manager (assigned siteA)
const SO = "aaaaaaaa-0000-4000-8000-0000000000b2"; // safety officer (assigned siteA)
const SO2 = "aaaaaaaa-0000-4000-8000-0000000000b3"; // safety officer, NOT assigned to any site
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // worker (assigned siteA)
const OO = "aaaaaaaa-0000-4000-8000-0000000000e1"; // onboarding officer
const NB = "aaaaaaaa-0000-4000-8000-0000000000f1"; // newcomer who becomes a supervisor
const OTH = "aaaaaaaa-0000-4000-8000-0000000000d1"; // another company's administrator

beforeAll(async () => { f = await getFixture(); });
beforeEach(async () => {
  const db = await getDb();
  for (const m of ["0040_emergency_alerts", "0041_emergency_authority_corrections", "0043_jsa_with_human_review", "0044_role_assignment_and_emergency_contacts", "0052_company_supervisor_role"]) {
    await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", `${m}.sql`), "utf8"));
  }
});

const as = (run: Runner, uid: string) => run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
async function fails(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return String((e as Error).message); }
  return "";
}
async function owner(run: Runner, sql: string, params: unknown[] = []) {
  const claims = String((await run("select coalesce(current_setting('request.jwt.claims', true), '') as c"))[0].c);
  await run("reset role");
  await run("select set_config('request.jwt.claims', '', true)");
  const rows = await run(sql, params);
  await run("select set_config('request.jwt.claims', $1, true)", [claims]);
  await run("set local role authenticated");
  return rows;
}

async function world<T>(fn: (run: Runner, c: { orgA: string; orgB: string; siteA: string; siteB: string; member: (u: string) => Promise<string> }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email, raw_user_meta_data) values
      ('${XA}','xa@agrilib.test','{"name":"Xavier Admin"}'), ('${SM}','sm@agrilib.test','{"name":"Sia Manager"}'),
      ('${SO}','so@agrilib.test','{"name":"Sam Safety"}'), ('${SO2}','so2@agrilib.test','{"name":"Sana Safety"}'),
      ('${WK}','wk@agrilib.test','{"name":"Wale Worker"}'), ('${OO}','oo@agrilib.test','{"name":"Ona Officer"}'),
      ('${NB}','nb@agrilib.test','{"name":"Nia Newcomer"}'), ('${OTH}','oth@ore.test','{"name":"Olu Other"}')`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    await run(`update public.sites set organization_id = '${orgA}' where id = '${f.siteA}'`);
    await run(`update public.sites set organization_id = '${orgB}' where id = '${f.siteB}'`);
    await run("set local role authenticated");
    const accept = async (uid: string, org: string, email: string, role: string | null) => {
      await as(run, role ? XA : f.admin);
      const id = role
        ? (await run(`select public.mg_create_org_invitation('${org}', '${email}', '${role}') as id`))[0].id
        : (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${id}')`);
    };
    await accept(XA, orgA, "xa@agrilib.test", null);
    await accept(SM, orgA, "sm@agrilib.test", "site_manager");
    await accept(SO, orgA, "so@agrilib.test", "safety_officer");
    await accept(SO2, orgA, "so2@agrilib.test", "safety_officer");
    await accept(WK, orgA, "wk@agrilib.test", "worker");
    await accept(OO, orgA, "oo@agrilib.test", "onboarding_officer");
    await accept(OTH, orgB, "oth@ore.test", null);
    await as(run, XA);
    const member = async (u: string) => (await owner(run, `select id from public.organization_members where user_id = '${u}'`))[0].id as string;
    for (const u of [SM, SO, WK]) await run(`select public.mg_assign_member_site('${await member(u)}', '${f.siteA}')`);
    await as(run, f.admin);
    return fn(run, { orgA, orgB, siteA: f.siteA, siteB: f.siteB, member });
  });
}

describe("company supervisor role (0052)", () => {
  test("a company administrator appoints a supervisor; the invitee becomes exactly that role", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = (await run(`select public.mg_create_org_invitation('${c.orgA}', 'nb@agrilib.test', 'supervisor') as id`))[0].id;
      await as(run, NB);
      await run(`select public.mg_accept_invitation('${id}')`);
      const r = await owner(run, `select org_role from public.organization_members where user_id = '${NB}'`);
      expect(r[0].org_role).toBe("supervisor");
    });
  });

  test("an onboarding officer and a site manager cannot appoint a supervisor", async () => {
    await world(async (run, c) => {
      await as(run, OO);
      expect(await fails(run(`select public.mg_create_org_invitation('${c.orgA}', 'nb@agrilib.test', 'supervisor')`))).toMatch(/FORBIDDEN/);
      await as(run, SM);
      expect(await fails(run(`select public.mg_create_org_invitation('${c.orgA}', 'nb@agrilib.test', 'supervisor')`))).not.toBe("");
    });
  });

  test("only a company administrator changes a member to supervisor", async () => {
    await world(async (run, c) => {
      const wk = await c.member(WK);
      await as(run, SM);
      expect(await fails(run(`select public.mg_set_member_role('${wk}', 'supervisor')`))).toMatch(/FORBIDDEN/);
      await as(run, XA);
      await run(`select public.mg_set_member_role('${wk}', 'supervisor')`);
      const r = await owner(run, `select org_role from public.organization_members where id = '${wk}'`);
      expect(r[0].org_role).toBe("supervisor");
    });
  });

  test("site scoping matches a safety officer: assigned site is reachable, a site manager may assign them", async () => {
    await world(async (run, c) => {
      const wk = await c.member(WK);
      await as(run, XA);
      await run(`select public.mg_set_member_role('${wk}', 'supervisor')`);
      await as(run, SM);
      await run(`select public.mg_assign_member_site('${wk}', '${c.siteA}')`);
      const ok = await owner(run, `select public.mg_operator_site_ok('${WK}', '${c.siteA}', '${c.orgA}') as ok`);
      expect(ok[0].ok).toBe(true);
      const other = await owner(run, `select public.mg_operator_site_ok('${WK}', '${c.siteB}', '${c.orgB}') as ok`);
      expect(other[0].ok).toBe(false);
      await run(`select public.mg_unassign_member_site('${wk}', '${c.siteA}')`);
    });
  });

  test("a supervisor gets no management rights and is a member of the workers alert audience", async () => {
    await world(async (run, c) => {
      const wk = await c.member(WK);
      await as(run, XA);
      await run(`select public.mg_set_member_role('${wk}', 'supervisor')`);
      await as(run, WK);
      expect(await fails(run(`select public.mg_set_member_role('${await c.member(SO)}', 'worker')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_create_org_invitation('${c.orgA}', 'nb@agrilib.test', 'worker')`))).not.toBe("");
      const def = await owner(run, `select pg_get_functiondef('public.mg_emergency_audience(uuid)'::regprocedure) as d`);
      expect(String(def[0].d)).toContain("'worker','supervisor'");
    });
  });
});
