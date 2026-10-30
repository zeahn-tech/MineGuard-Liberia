// ---------------------------------------------------------------------------
// Phase D — site-scoped company access (migration 0027).
// A site manager reaches ONLY assigned sites; workers keep company-wide access
// until scoped; nobody crosses company or site boundaries; the backend (RLS +
// definer RPCs) enforces all of it. Every case rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const YA = "aaaaaaaa-0000-4000-8000-0000000000b1"; // OreCo company administrator
const SM = "aaaaaaaa-0000-4000-8000-0000000000d1"; // site manager (AgriLib)
const SM2 = "aaaaaaaa-0000-4000-8000-0000000000d2"; // second site manager (AgriLib)
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // worker (AgriLib)

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of [
    "0024_self_service_tenant_lockdown.sql",
    "0025_company_status_membership_invitations.sql",
    "0026_company_workforce.sql",
    "0027_site_scoped_access.sql",
    "0028_account_names_invitation_cleanup.sql", "0029_onboarding_officer_bulk_import.sql", "0030_registrar_role_value.sql", "0031_company_registrar.sql", "0032_government_roles_hold_no_company.sql",
  ]) {
    await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", m), "utf8"));
  }
});

const as = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);

async function fails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

/** Owner-level lookup (RLS would hide other companies' rows), then resume the session role. */
async function owner(run: Runner, sql: string): Promise<Record<string, unknown>[]> {
  await run("reset role");
  const rows = await run(sql);
  await run("set local role authenticated");
  return rows;
}
const memberId = async (run: Runner, uid: string) =>
  (await owner(run, `select id from public.organization_members where user_id = '${uid}' and status = 'active'`))[0].id as string;

/**
 * AgriLib: administrator XA, site manager SM + SM2, worker WK; two sites (siteA + site2).
 * OreCo: administrator YA. Session starts as XA.
 */
async function world<T>(fn: (run: Runner, ctx: { siteA: string; site2: string; siteB: string; orgA: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(
      `insert into auth.users (id, email) values
        ('${XA}','xa@agrilib.test'), ('${YA}','ya@oreco.test'),
        ('${SM}','sm@agrilib.test'), ('${SM2}','sm2@agrilib.test'), ('${WK}','wk@agrilib.test')`,
    );
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    const siteA = (await run("select id from public.sites where code = 'LB-BOM-001'"))[0].id as string;
    const siteB = (await run("select id from public.sites where code = 'LB-GCM-001'"))[0].id as string;
    const site2 = (
      await run(
        `insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude, created_by)
         values ('LB-BOM-002','Bomi North Pit','AgriLib Mining','Gold','Bomi','Senjeh','Bomi Hills','active',6.9,-10.9,'${f.admin}')
         returning id`,
      )
    )[0].id as string;
    const insp = (await run("select id from public.inspections limit 1"))[0].id as string;
    await run(
      `insert into public.findings (inspection_id, site_id, title, severity, created_by_id)
       values ('${insp}', '${site2}', 'Loose bench edge', 'high', '${f.admin}')`,
    );
    await run("set local role authenticated");
    await as(run, f.admin);
    const invite = async (org: string, uid: string, email: string, role: string) => {
      const id = (await run(`select public.mg_create_org_invitation('${org}', '${email}', '${role}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${id}')`);
      await as(run, f.admin);
    };
    await invite(orgA, XA, "xa@agrilib.test", "company_admin");
    await invite(orgB, YA, "ya@oreco.test", "company_admin");
    await as(run, XA);
    await invite(orgA, SM, "sm@agrilib.test", "site_manager");
    await invite(orgA, SM2, "sm2@agrilib.test", "site_manager");
    await invite(orgA, WK, "wk@agrilib.test", "worker");
    // invite() ends as f.admin: act as the company administrator again
    await as(run, XA);
    return fn(run, { siteA, site2, siteB, orgA });
  });
}

const codes = async (run: Runner) => (await run("select code from public.sites order by code")).map((r) => r.code);

describe("site manager is scoped to assigned sites", () => {
  test("no assignment = no site and no site records; assignment opens exactly that site", async () => {
    await world(async (run, { site2 }) => {
      await as(run, SM);
      expect(await codes(run)).toEqual([]);
      expect((await run("select id from public.findings")).length).toBe(0);
      expect((await run("select id from public.inspections")).length).toBe(0);
      await as(run, XA);
      await run(`select public.mg_assign_member_site('${await memberId(run, SM)}', '${site2}')`);
      await as(run, SM);
      expect(await codes(run)).toEqual(["LB-BOM-002"]); // not the company's other site, not OreCo's
      expect((await run("select title from public.findings")).map((r) => r.title)).toEqual(["Loose bench edge"]);
    });
  });

  test("the company administrator reaches every company site; the other company's administrator reaches none of them", async () => {
    await world(async (run) => {
      expect(await codes(run)).toEqual(["LB-BOM-001", "LB-BOM-002"]);
      await as(run, YA);
      expect(await codes(run)).toEqual(["LB-GCM-001"]);
    });
  });

  test("a site manager manages only their own site, only workers/safety officers, never themselves or another site manager", async () => {
    await world(async (run, { siteA, site2 }) => {
      const mSM = await memberId(run, SM);
      const mSM2 = await memberId(run, SM2);
      const mWK = await memberId(run, WK);
      await run(`select public.mg_assign_member_site('${mSM}', '${site2}')`);
      await as(run, SM);
      // own site: may scope a worker, may read the roster
      await run(`select public.mg_assign_member_site('${mWK}', '${site2}')`);
      const roster = await run(`select email, assigned from public.mg_site_roster('${site2}') order by email`);
      expect(roster).toContainEqual({ email: "wk@agrilib.test", assigned: true });
      expect(roster.some((r) => r.email === "xa@agrilib.test")).toBe(false); // administrators are implicit
      // a site they do NOT manage
      expect(await fails(run(`select public.mg_assign_member_site('${mWK}', '${siteA}')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select * from public.mg_site_roster('${siteA}')`))).toMatch(/FORBIDDEN/);
      // other site managers / themselves are a company administrator's call
      expect(await fails(run(`select public.mg_assign_member_site('${mSM2}', '${site2}')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_unassign_member_site('${mSM}', '${site2}')`))).toMatch(/FORBIDDEN/);
      // direct table writes are closed
      expect(await fails(run(`insert into public.site_assignments (user_id, site_id) values ('${SM}', '${siteA}')`))).toMatch(/permission denied|row-level security/i);
      // RLS hides every row from the update (no update policy applies): nothing changes.
      expect(await run("update public.site_assignments set revoked_at = null returning id")).toEqual([]);
      // no widening through role changes either
      expect(await fails(run(`select public.mg_set_member_role('${mWK}', 'site_manager')`))).toMatch(/FORBIDDEN/);
    });
  });

  test("another company's administrator cannot assign, unassign or read a roster; cross-company ids are indistinguishable from unknown ones", async () => {
    await world(async (run, { site2, siteB }) => {
      const mWK = await memberId(run, WK);
      await as(run, YA);
      for (const sql of [
        `select public.mg_assign_member_site('${mWK}', '${site2}')`,
        `select public.mg_unassign_member_site('${mWK}', '${site2}')`,
        `select * from public.mg_site_roster('${site2}')`,
        `select public.mg_assign_member_site('${mWK}', '${siteB}')`, // own site, foreign member
        `select public.mg_assign_member_site(gen_random_uuid(), gen_random_uuid())`,
      ]) expect(await fails(run(sql))).toMatch(/FORBIDDEN/);
    });
  });
});

describe("workers: company-wide until scoped", () => {
  test("no assignment keeps today's company-wide access; assigning scopes; unassigning restores", async () => {
    await world(async (run, { site2 }) => {
      const mWK = await memberId(run, WK);
      await as(run, WK);
      expect(await codes(run)).toEqual(["LB-BOM-001", "LB-BOM-002"]);
      await as(run, XA);
      await run(`select public.mg_assign_member_site('${mWK}', '${site2}')`);
      await as(run, WK);
      expect(await codes(run)).toEqual(["LB-BOM-002"]);
      await as(run, XA);
      await run(`select public.mg_unassign_member_site('${mWK}', '${site2}')`);
      await as(run, WK);
      expect(await codes(run)).toEqual(["LB-BOM-001", "LB-BOM-002"]);
    });
  });

  test("a worker has no administrative power over sites or people", async () => {
    await world(async (run, { site2 }) => {
      const mSM = await memberId(run, SM);
      await as(run, WK);
      expect(await fails(run(`select public.mg_assign_member_site('${mSM}', '${site2}')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select * from public.mg_site_roster('${site2}')`))).toMatch(/FORBIDDEN/);
    });
  });
});

describe("lifecycle and invariants", () => {
  test("removing a member ends their assignments for good; a returning member starts unscoped", async () => {
    await world(async (run, { site2, orgA }) => {
      const mWK = await memberId(run, WK);
      await run(`select public.mg_assign_member_site('${mWK}', '${site2}')`);
      await run(`select public.mg_revoke_member('${mWK}')`);
      const rows = await owner(run, `select revoked_at is not null as revoked from public.site_assignments where user_id = '${WK}'`);
      expect(rows).toEqual([{ revoked: true }]);
      await as(run, WK);
      expect(await codes(run)).toEqual([]); // no role, no company
      await as(run, XA);
      const inv = (await run(`select public.mg_create_org_invitation('${orgA}', 'wk@agrilib.test', 'worker') as id`))[0].id;
      await as(run, WK);
      await run(`select public.mg_accept_invitation('${inv}')`);
      expect(await codes(run)).toEqual(["LB-BOM-001", "LB-BOM-002"]); // old assignment did not resurrect
    });
  });

  test("assignment changes are audit-trailed with the acting user", async () => {
    await world(async (run, { site2 }) => {
      const mWK = await memberId(run, WK);
      await run(`select public.mg_assign_member_site('${mWK}', '${site2}')`);
      await run(`select public.mg_unassign_member_site('${mWK}', '${site2}')`);
      const audit = await owner(run, `select action from public.audit_log where entity_type = 'site_assignments' order by created_at`);
      expect(audit.map((a) => a.action)).toEqual(["site_assignments.insert", "site_assignments.update"]);
    });
  });

  test("Ministry provisioning still works and always yields a membership; rebinding retires the old one", async () => {
    await withRole("postgres", null, async (run) => {
      await run("set local role authenticated");
      await as(run, f.admin);
      await run("select public.provision_user_by_email('frank@guest.test','operator','operator',null,'OreCo Liberia')");
      let rows = await owner(run, "select o.name, m.org_role, m.status from public.organization_members m join public.organizations o on o.id = m.organization_id where m.user_id = (select id from public.profiles where email = 'frank@guest.test') and m.status = 'active'");
      expect(rows).toEqual([{ name: "OreCo Liberia", org_role: "worker", status: "active" }]);
      await as(run, f.admin);
      await run("select public.provision_user_by_email('frank@guest.test','operator','operator',null,'AgriLib Mining')");
      rows = await owner(run, "select o.name from public.organization_members m join public.organizations o on o.id = m.organization_id where m.user_id = (select id from public.profiles where email = 'frank@guest.test') and m.status = 'active'");
      expect(rows).toEqual([{ name: "AgriLib Mining" }]);
    });
  });

  test("legacy operators (opA/opB) keep exactly their company's data", async () => {
    await world(async (run) => {
      await as(run, f.opA);
      expect(await codes(run)).toEqual(["LB-BOM-001", "LB-BOM-002"]);
      await as(run, f.opB);
      expect(await codes(run)).toEqual(["LB-GCM-001"]);
    });
  });
});
