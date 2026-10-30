// ---------------------------------------------------------------------------
// Post-deployment fixes (migration 0028 + UI gates): account names, invitation
// cleanup, mobile/desktop nav parity, role-less accounts never land in the
// staff portal. Every DB case rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const ROOT = join(import.meta.dir, "..");
const MIG = (n: string) => readFileSync(join(ROOT, "supabase", "migrations", n), "utf8");
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1";
const P1 = "aaaaaaaa-0000-4000-8000-0000000000e1";
const P2 = "aaaaaaaa-0000-4000-8000-0000000000e2";

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of [
    "0024_self_service_tenant_lockdown.sql",
    "0025_company_status_membership_invitations.sql",
    "0026_company_workforce.sql",
    "0027_site_scoped_access.sql",
    "0028_account_names_invitation_cleanup.sql", "0029_onboarding_officer_bulk_import.sql", "0030_registrar_role_value.sql", "0031_company_registrar.sql", "0032_government_roles_hold_no_company.sql",
  ]) await db.exec(MIG(m));
});

const as = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);

async function owner(run: Runner, sql: string) {
  await run("reset role");
  const rows = await run(sql);
  await run("set local role authenticated");
  return rows;
}

describe("account names (0028)", () => {
  test("the profile name comes from name, full_name or display_name; none stays empty", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email, raw_user_meta_data) values
        ('${P1}', 'a@x.test', '{"full_name":"Ada Lovelace"}'),
        ('${P2}', 'b@x.test', '{"display_name":"Grace Hopper"}'),
        ('aaaaaaaa-0000-4000-8000-0000000000e3', 'c@x.test', '{"name":"Alan Turing"}'),
        ('aaaaaaaa-0000-4000-8000-0000000000e4', 'd@x.test', '{}')`);
      const rows = await run("select email, name from public.profiles where email in ('a@x.test','b@x.test','c@x.test','d@x.test') order by email");
      expect(rows).toEqual([
        { email: "a@x.test", name: "Ada Lovelace" },
        { email: "b@x.test", name: "Grace Hopper" },
        { email: "c@x.test", name: "Alan Turing" },
        { email: "d@x.test", name: null },
      ]);
    });
  });

  test("backfill fills only missing names and never overwrites an existing one", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email, raw_user_meta_data) values ('${P1}', 'a@x.test', '{"full_name":"Ada Lovelace"}'), ('${P2}', 'b@x.test', '{"full_name":"Grace Hopper"}')`);
      await run(`update public.profiles set name = null where id = '${P1}'`);
      await run(`update public.profiles set name = 'Chosen Name' where id = '${P2}'`);
      // multi-statement script: run on the shared connection inside this rolled-back transaction
      await (await getDb()).exec(MIG("0028_account_names_invitation_cleanup.sql").replace(/^begin;|^commit;\s*$/gm, ""));
      const rows = await run(`select email, name from public.profiles where id in ('${P1}','${P2}') order by email`);
      expect(rows).toEqual([{ email: "a@x.test", name: "Ada Lovelace" }, { email: "b@x.test", name: "Chosen Name" }]);
    });
  });
});

async function world<T>(fn: (run: Runner, ctx: { orgA: string; orgB: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email) values ('${XA}','xa@agrilib.test'), ('${P1}','p1@mail.test')`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    await run("set local role authenticated");
    await as(run, f.admin);
    const inv = (await run(`select public.mg_create_company_admin_invitation('${orgA}', 'xa@agrilib.test') as id`))[0].id;
    await as(run, XA);
    await run(`select public.mg_accept_invitation('${inv}')`);
    return fn(run, { orgA, orgB });
  });
}

describe("invitation / request cleanup", () => {
  test("accepting an invitation withdraws a pending request to ANOTHER company and leaves no pending row", async () => {
    await world(async (run, { orgA, orgB }) => {
      await as(run, P1);
      const req = (await run(`select public.mg_request_membership('${orgB}') as id`))[0].id;
      await as(run, XA);
      const inv = (await run(`select public.mg_create_org_invitation('${orgA}', 'p1@mail.test', 'worker') as id`))[0].id;
      await as(run, P1);
      await run(`select public.mg_accept_invitation('${inv}')`);
      const mine = await run("select organization_id, member_status from public.mg_my_membership()");
      expect(mine).toEqual([{ organization_id: orgA, member_status: "active" }]); // the /join page now shows ONLY the new company
      expect((await owner(run, `select status from public.organization_members where id = '${req}'`))[0].status).toBe("revoked");
      expect(await owner(run, `select id from public.organization_members where user_id = '${P1}' and status = 'pending'`)).toEqual([]);
    });
  });

  test("accepting an invitation to the SAME company converts the pending request instead of leaving it", async () => {
    await world(async (run, { orgA }) => {
      await as(run, P1);
      await run(`select public.mg_request_membership('${orgA}')`);
      await as(run, XA);
      const inv = (await run(`select public.mg_create_org_invitation('${orgA}', 'p1@mail.test', 'safety_officer') as id`))[0].id;
      await as(run, P1);
      await run(`select public.mg_accept_invitation('${inv}')`);
      expect(await owner(run, `select org_role, status from public.organization_members where user_id = '${P1}' order by created_at`)).toEqual([{ org_role: "safety_officer", status: "active" }]);
      await as(run, XA);
      expect((await run(`select * from public.mg_company_workforce('${orgA}') where status = 'pending'`)).length).toBe(0); // gone from the admin's request list
    });
  });

  test("approving a request supersedes the same person's still-pending invitation", async () => {
    await world(async (run, { orgA }) => {
      await as(run, XA);
      await run(`select public.mg_create_org_invitation('${orgA}', 'p1@mail.test', 'worker')`);
      await as(run, P1);
      const req = (await run(`select public.mg_request_membership('${orgA}') as id`))[0].id;
      await as(run, XA);
      await run(`select public.mg_decide_membership_request('${req}', true, 'worker')`);
      const inv = await run("select status from public.organization_invitations where email = 'p1@mail.test'");
      expect(inv).toEqual([{ status: "revoked" }]);
      await as(run, P1);
      expect((await run("select * from public.mg_my_pending_invitations()")).length).toBe(0);
    });
  });

  test("invitations to other companies disappear once the person belongs to one", async () => {
    await world(async (run, { orgA, orgB }) => {
      await as(run, f.admin);
      await run(`select public.mg_create_org_invitation('${orgB}', 'p1@mail.test', 'worker')`);
      await as(run, XA);
      await run(`select public.mg_create_org_invitation('${orgA}', 'p1@mail.test', 'worker')`);
      await as(run, P1);
      expect((await run("select organization_id from public.mg_my_pending_invitations()")).length).toBe(2);
      const mine = (await run("select id from public.mg_my_pending_invitations() where organization_id = '" + orgA + "'"))[0].id;
      await run(`select public.mg_accept_invitation('${mine}')`);
      expect((await run("select * from public.mg_my_pending_invitations()")).length).toBe(0);
    });
  });
});

describe("UI gates (source contracts)", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  test("operator nav: desktop and mobile use the same company-admin-filtered list", () => {
    const s = read("src/pages/operate/OperatorLayout.tsx");
    expect(s).not.toMatch(/items=\{OPERATOR_NAV\}/);
    expect((s.match(/items=\{navItems\}/g) ?? []).length).toBe(2);
  });
  test("role-less accounts never reach the staff portal directly: invitations first, then a choice", () => {
    const s = read("src/components/RequireAuth.tsx");
    expect(s).toContain("function RolelessGate");
    expect(s).toMatch(/invitations\.length > 0\) return <Navigate to="\/invitation"/);
    expect(s).toMatch(/if \(!user\?\.role\) \{[\s\S]{0,200}RolelessGate/);
  });
  test("the invitation page requires a name and password before Accept", () => {
    const s = read("src/pages/Invitation.tsx");
    expect(s).toContain("completeInviteAccount");
    expect(s).toMatch(/disabled=\{busyId !== null \|\| needsAccount\}/);
  });
});
