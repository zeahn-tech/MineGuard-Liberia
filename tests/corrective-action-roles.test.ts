// ---------------------------------------------------------------------------
// Migration 0046 — company administrators, site managers and safety officers answer corrective
// actions, and an action that is open OR in progress can be answered.
// Exercised as a hostile client would: raw updates, real RLS, real guard.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // company administrator
const REG = "aaaaaaaa-0000-4000-8000-000000000091"; // registrar
const SM = "aaaaaaaa-0000-4000-8000-0000000000d1"; // site manager, assigned to site2
const SO = "aaaaaaaa-0000-4000-8000-0000000000e1"; // safety officer, no assignments (all company sites)
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // worker
const OF = "aaaaaaaa-0000-4000-8000-0000000000f1"; // onboarding officer
const CA_OPEN = "eeeeeeee-0000-4000-8000-0000000000c1";
const CA_PROG = "eeeeeeee-0000-4000-8000-0000000000c2";
const CA_ESC = "eeeeeeee-0000-4000-8000-0000000000c3";
const CA_S2 = "eeeeeeee-0000-4000-8000-0000000000c4";

beforeAll(async () => {
  f = await getFixture();
});

const as = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);

async function world<T>(fn: (run: Runner) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email, raw_user_meta_data) values
      ('${XA}','xa@agrilib.test','{"name":"Xavier Admin"}'), ('${SM}','sm@agrilib.test','{"name":"Sam Manager"}'),
      ('${SO}','so@agrilib.test','{"name":"Sade Safety"}'), ('${WK}','wk@agrilib.test','{"name":"Wale Worker"}'),
      ('${OF}','of@agrilib.test','{"name":"Ola Officer"}'), ('${REG}','reg@ministry.test','{"name":"Rita Registrar"}')`);
    await run(`update public.profiles set role = 'registrar', scope = 'national', profile_complete = true where id = '${REG}'`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const siteA = (await run("select id from public.sites where code = 'LB-BOM-001'"))[0].id as string;
    const site2 = (await run(`insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude, created_by)
      values ('LB-BOM-002','Bomi North Pit','AgriLib Mining','Gold','Bomi','Senjeh','Bomi Hills','active',6.9,-10.9,'${f.admin}') returning id`))[0].id as string;
    await run("set local role authenticated");
    await as(run, REG);
    const inv = (await run(`select public.mg_create_company_admin_invitation('${orgA}', 'xa@agrilib.test') as id`))[0].id;
    await as(run, XA);
    await run(`select public.mg_accept_invitation('${inv}')`);
    for (const [uid, email, role] of [[SM, "sm@agrilib.test", "site_manager"], [SO, "so@agrilib.test", "safety_officer"], [WK, "wk@agrilib.test", "worker"], [OF, "of@agrilib.test", "onboarding_officer"]] as const) {
      const i = (await run(`select public.mg_create_org_invitation('${orgA}', '${email}', '${role}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${i}')`);
      await as(run, XA);
    }
    await run("reset role");
    const mSm = (await run(`select id from public.organization_members where user_id = '${SM}'`))[0].id;
    await run("set local role authenticated");
    await as(run, XA);
    await run(`select public.mg_assign_member_site('${mSm}', '${site2}')`);
    await run("reset role");
    // finding on site2, and four actions in different states (owner inserts)
    await run(`insert into public.findings (id, inspection_id, site_id, title, severity, created_by_id) values
      ('eeeeeeee-0000-4000-8000-0000000000f2', (select id from public.inspections limit 1), '${site2}', 'Site2 finding', 'high', '${f.admin}')`);
    await run(`insert into public.corrective_actions (id, finding_id, site_id, description, due_at, opened_by_id, status) values
      ('${CA_OPEN}', '${f.findingA}', '${siteA}', 'open one', now() + interval '3 days', '${f.admin}', 'open'),
      ('${CA_PROG}', '${f.findingA}', '${siteA}', 'in progress one', now() + interval '3 days', '${f.admin}', 'in_progress'),
      ('${CA_ESC}', '${f.findingA}', '${siteA}', 'escalated one', now() - interval '3 days', '${f.admin}', 'escalated'),
      ('${CA_S2}', 'eeeeeeee-0000-4000-8000-0000000000f2', '${site2}', 'site2 one', now() + interval '3 days', '${f.admin}', 'open')`);
    await run("set local role authenticated");
    return fn(run);
  });
}

/** Attempt a response; the outcome is read back as the table owner. */
async function respond(run: Runner, uid: string, id: string) {
  await run("reset role");
  await run("set local role authenticated");
  await as(run, uid);
  try {
    await run(`update public.corrective_actions set operator_note = 'Repaired and retrained', status = 'submitted' where id = '${id}'`);
  } catch {
    /* a refusal is an acceptable outcome */
  }
  await run("reset role");
  const r = (await run(`select status from public.corrective_actions where id = '${id}'`))[0].status as string;
  await run("set local role authenticated");
  return r;
}

describe("who may answer a corrective action (migration 0046)", () => {
  test("a safety officer can answer an open action", async () => {
    await world(async (run) => expect(await respond(run, SO, CA_OPEN)).toBe("submitted"));
  });

  test("an action in progress can be answered (it was refused by the guard before)", async () => {
    await world(async (run) => expect(await respond(run, SO, CA_PROG)).toBe("submitted"));
  });

  test("a site manager can answer an action on a site they are assigned to, but not on another", async () => {
    await world(async (run) => {
      expect(await respond(run, SM, CA_S2)).toBe("submitted");
      expect(await respond(run, SM, CA_OPEN)).toBe("open");
    });
  });

  test("a company administrator can answer", async () => {
    await world(async (run) => expect(await respond(run, XA, CA_OPEN)).toBe("submitted"));
  });

  test("a worker or onboarding officer cannot answer", async () => {
    await world(async (run) => {
      expect(await respond(run, WK, CA_OPEN)).toBe("open");
      expect(await respond(run, OF, CA_OPEN)).toBe("open");
    });
  });

  test("an escalated action is no longer answerable by the company", async () => {
    await world(async (run) => expect(await respond(run, SO, CA_ESC)).toBe("escalated"));
  });

  test("the role rule reports correctly for each role", async () => {
    await world(async (run) => {
      const may = async (uid: string) => {
        // evaluated as the table owner with the caller's claims: the rule reads auth.uid(),
        // so this tests the rule itself, independent of grant plumbing (checked statically below)
        await run("reset role");
        await as(run, uid);
        return (await run("select public.mg_can_work_corrective_actions() as ok"))[0].ok;
      };
      expect(await may(SM)).toBe(true);
      expect(await may(SO)).toBe(true);
      expect(await may(XA)).toBe(true);
      expect(await may(WK)).toBe(false);
      expect(await may(OF)).toBe(false);
    });
  });

  test("reviewers are unchanged: the administrator can still decide an action", async () => {
    await withRole("postgres", null, async (run) => {
      await run("set local role authenticated");
      await as(run, f.admin);
      await run(`update public.corrective_actions set status = 'closed' where id = '${f.caA}'`);
      await run("reset role");
      expect((await run(`select status from public.corrective_actions where id = '${f.caA}'`))[0].status).toBe("closed");
    });
  });

  test("a legacy operator account with no membership keeps working; a revoked member does not", async () => {
    await world(async (run) => {
      await run("reset role");
      const legacy = "aaaaaaaa-0000-4000-8000-0000000000e9";
      await run(`insert into auth.users (id, email, raw_user_meta_data) values ('${legacy}','legacy@x.test','{"name":"Legacy"}')`);
      await run(`update public.organization_members set status = 'revoked' where user_id = '${WK}'`);
      await run(`update public.organization_members set status = 'revoked' where user_id = '${SO}'`);
      const may = async (uid: string) => {
        await as(run, uid);
        return (await run("select public.mg_can_work_corrective_actions() as ok"))[0].ok;
      };
      expect(await may(legacy)).toBe(true);
      expect(await may(SO)).toBe(false);
    });
  });
});

describe("migration 0046 grants", () => {
  const sql = readFileSync(join(import.meta.dir, "..", "supabase", "migrations", "0046_corrective_action_roles.sql"), "utf8");
  test("the role rule is closed to anon and open to signed-in users only", () => {
    expect(sql).toContain("revoke all on function public.mg_can_work_corrective_actions() from public, anon");
    expect(sql).toContain("grant execute on function public.mg_can_work_corrective_actions() to authenticated");
  });
});
