// ---------------------------------------------------------------------------
// Phase C — company workforce administration (migration 0026).
// Boundaries under test: a company administrator manages ONLY their own
// company; workers/other companies/outsiders manage nothing; typing a company
// name grants nothing; revocation and suspension take effect in the backend.
// Every case runs inside a rolled-back transaction.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // company admin of AgriLib
const YA = "aaaaaaaa-0000-4000-8000-0000000000b1"; // company admin of OreCo
const W1 = "aaaaaaaa-0000-4000-8000-0000000000c1"; // outsider / requester
const W2 = "aaaaaaaa-0000-4000-8000-0000000000c2";

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of [
    "0024_self_service_tenant_lockdown.sql",
    "0025_company_status_membership_invitations.sql",
    "0026_company_workforce.sql",
    "0027_site_scoped_access.sql",
    "0028_account_names_invitation_cleanup.sql", "0029_onboarding_officer_bulk_import.sql",
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

/** Runs fn as postgres with: two company admins (XA of AgriLib, YA of OreCo) and two outsiders. */
async function world<T>(fn: (run: Runner, ids: { orgA: string; orgB: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(
      `insert into auth.users (id, email) values
         ('${XA}','xa@agrilib.test'), ('${YA}','ya@oreco.test'),
         ('${W1}','w1@mail.test'), ('${W2}','w2@mail.test')`,
    );
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    await run("set local role authenticated");
    await as(run, f.admin);
    for (const [org, uid, email] of [[orgA, XA, "xa@agrilib.test"], [orgB, YA, "ya@oreco.test"]] as const) {
      const inv = (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${inv}')`);
      await as(run, f.admin);
    }
    await as(run, XA);
    return fn(run, { orgA, orgB });
  });
}

describe("company administrator: invitations", () => {
  test("invites workers/safety/site roles into OWN company only, never a company_admin, never another company", async () => {
    await world(async (run, { orgA, orgB }) => {
      for (const role of ["worker", "safety_officer", "site_manager"]) {
        const id = (await run(`select public.mg_create_org_invitation('${orgA}', '${role}@x.test', '${role}') as id`))[0].id;
        expect(id).toBeTruthy();
      }
      expect(await fails(run(`select public.mg_create_org_invitation('${orgA}', 'boss@x.test', 'company_admin')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_create_org_invitation('${orgB}', 'w@x.test', 'worker')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_create_org_invitation('${orgA}', 'w@x.test', 'regulator')`))).toMatch(/INVALID_ROLE/);
      expect(await fails(run(`select public.mg_create_org_invitation('${orgA}', 'dave@mineguard.test', 'worker')`))).toMatch(/INELIGIBLE_ACCOUNT/);
    });
  });

  test("a company administrator cannot touch another company's invitations", async () => {
    await world(async (run, { orgA, orgB }) => {
      await as(run, YA);
      const invB = (await run(`select public.mg_create_org_invitation('${orgB}', 'newb@x.test', 'worker') as id`))[0].id;
      await as(run, XA);
      expect(await fails(run(`select public.mg_prepare_invitation_send('${invB}')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_revoke_invitation('${invB}')`))).toMatch(/FORBIDDEN/);
      expect((await run("select id from public.organization_invitations")).every((r) => r.id !== invB)).toBe(true);
      // and a non-existent id is indistinguishable from someone else's
      expect(await fails(run(`select public.mg_revoke_invitation(gen_random_uuid())`))).toMatch(/FORBIDDEN/);
      void orgA;
    });
  });

  test("invitee accepts a worker invitation: operator of that company, NO administrative power", async () => {
    await world(async (run, { orgA, orgB }) => {
      const inv = (await run(`select public.mg_create_org_invitation('${orgA}', 'w1@mail.test', 'worker') as id`))[0].id;
      await as(run, W1);
      await run(`select public.mg_accept_invitation('${inv}')`);
      const me = (await run("select role, organization_id from public.profiles where id = auth.uid()"))[0];
      expect(me).toMatchObject({ role: "operator", organization_id: orgA });
      expect((await run("select org_role from public.organization_members where user_id = auth.uid() and status = 'active'"))[0].org_role).toBe("worker");
      for (const sql of [
        `select public.mg_create_org_invitation('${orgA}', 'z@x.test', 'worker')`,
        `select * from public.mg_company_workforce('${orgA}')`,
        `select public.mg_register_company('Hostile')`,
      ]) expect(await fails(run(sql))).toMatch(/FORBIDDEN/);
      expect((await run("select id from public.organization_invitations")).length).toBe(0);
      void orgB;
    });
  });
});

describe("membership requests", () => {
  test("search returns only approved companies and needs 3+ characters", async () => {
    await world(async (run, { orgB }) => {
      await as(run, W1);
      expect((await run("select * from public.mg_search_companies('Ag')")).length).toBe(0);
      expect((await run("select name from public.mg_search_companies('agri')")).map((r) => r.name)).toEqual(["AgriLib Mining"]);
      await as(run, f.admin);
      await run(`select public.mg_set_company_status('${orgB}', 'suspended', 'licence review')`);
      await as(run, W1);
      expect((await run("select * from public.mg_search_companies('oreco')")).length).toBe(0);
    });
  });

  test("typing a name grants nothing; a request is pending until a company administrator approves", async () => {
    await world(async (run, { orgA }) => {
      await as(run, W1);
      await run("select public.complete_staff_profile('x','y','operator',null,'AgriLib Mining')");
      expect((await run("select role, organization_id from public.profiles where id = auth.uid()"))[0]).toMatchObject({ role: null, organization_id: null });
      const req = (await run(`select public.mg_request_membership('${orgA}') as id`))[0].id;
      expect((await run(`select public.mg_request_membership('${orgA}') as id`))[0].id).toBe(req); // retry-safe
      expect((await run("select role from public.profiles where id = auth.uid()"))[0].role).toBeNull(); // still nothing
      expect((await run("select id from public.sites")).length).toBe(0);
      expect((await run("select member_status from public.mg_my_membership()"))[0].member_status).toBe("pending");
      await as(run, XA);
      const wf = await run(`select email, status from public.mg_company_workforce('${orgA}') where status = 'pending'`);
      expect(wf).toEqual([{ email: "w1@mail.test", status: "pending" }]);
      await run(`select public.mg_decide_membership_request('${req}', true, 'safety_officer')`);
      await as(run, W1);
      expect((await run("select role, organization_id from public.profiles where id = auth.uid()"))[0]).toMatchObject({ role: "operator", organization_id: orgA });
      expect((await run("select org_role, status from public.organization_members where user_id = auth.uid()"))[0]).toEqual({ org_role: "safety_officer", status: "active" });
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0);
    });
  });

  test("only the target company's administrators decide; company_admin cannot be granted; rejection has a cooldown", async () => {
    await world(async (run, { orgA }) => {
      await as(run, W1);
      const req = (await run(`select public.mg_request_membership('${orgA}') as id`))[0].id;
      await as(run, YA); // administrator of a DIFFERENT company
      expect(await fails(run(`select public.mg_decide_membership_request('${req}', true, 'worker')`))).toMatch(/FORBIDDEN/);
      await as(run, W2); // a stranger
      expect(await fails(run(`select public.mg_decide_membership_request('${req}', true, 'worker')`))).toMatch(/FORBIDDEN/);
      await as(run, W1); // the requester themselves
      expect(await fails(run(`select public.mg_decide_membership_request('${req}', true, 'worker')`))).toMatch(/FORBIDDEN/);
      await as(run, XA);
      expect(await fails(run(`select public.mg_decide_membership_request('${req}', true, 'company_admin')`))).toMatch(/INVALID_ROLE/);
      await run(`select public.mg_decide_membership_request('${req}', false)`);
      expect(await fails(run(`select public.mg_decide_membership_request('${req}', true, 'worker')`))).toMatch(/MEMBERSHIP_NOT_PENDING/);
      await as(run, W1);
      expect((await run("select role from public.profiles where id = auth.uid()"))[0].role).toBeNull();
      expect(await fails(run(`select public.mg_request_membership('${orgA}')`))).toMatch(/REQUEST_COOLDOWN/);
    });
  });

  test("government accounts, suspended companies and second requests are refused; cancel works", async () => {
    await world(async (run, { orgA, orgB }) => {
      await as(run, f.county);
      expect(await fails(run(`select public.mg_request_membership('${orgA}')`))).toMatch(/INELIGIBLE_ACCOUNT/);
      await as(run, W1);
      await run(`select public.mg_request_membership('${orgA}')`);
      expect(await fails(run(`select public.mg_request_membership('${orgB}')`))).toMatch(/PENDING_REQUEST_EXISTS/);
      await run("select public.mg_cancel_membership_request()");
      expect((await run("select * from public.mg_my_membership()")).length).toBe(0);
      await as(run, f.admin);
      await run(`select public.mg_set_company_status('${orgB}', 'suspended', 'licence review')`);
      await as(run, W1);
      expect(await fails(run(`select public.mg_request_membership('${orgB}')`))).toMatch(/ORG_NOT_APPROVED/);
    });
  });
});

describe("role changes and revocation", () => {
  test("change a worker's role; never to company_admin; never your own; never another company's; never an administrator's", async () => {
    await world(async (run, { orgA }) => {
      const mOp = await member(run, f.opA);
      await run(`select public.mg_set_member_role('${mOp}', 'site_manager')`);
      expect((await run(`select org_role from public.organization_members where id = '${mOp}'`))[0].org_role).toBe("site_manager");
      expect(await fails(run(`select public.mg_set_member_role('${mOp}', 'company_admin')`))).toMatch(/INVALID_ROLE/);
      const mSelf = await member(run, XA);
      expect(await fails(run(`select public.mg_set_member_role('${mSelf}', 'worker')`))).toMatch(/FORBIDDEN/);
      const mOther = await member(run, f.opB);
      expect(await fails(run(`select public.mg_set_member_role('${mOther}', 'worker')`))).toMatch(/FORBIDDEN/);
      // a second administrator can only be managed by the Ministry
      await as(run, f.admin);
      const inv = (await run(`select public.mg_create_org_invitation('${orgA}', 'w1@mail.test', 'company_admin') as id`))[0].id;
      await as(run, W1);
      await run(`select public.mg_accept_invitation('${inv}')`);
      await as(run, XA);
      const mAdmin2 = await member(run, W1);
      expect(await fails(run(`select public.mg_set_member_role('${mAdmin2}', 'worker')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_revoke_member('${mAdmin2}')`))).toMatch(/FORBIDDEN/);
      await as(run, f.admin);
      await run(`select public.mg_set_member_role('${mAdmin2}', 'worker')`); // Ministry may
    });
  });

  test("revocation ends access immediately in the backend; self-revocation and cross-company revocation are refused", async () => {
    await world(async (run) => {
      const mOp = await member(run, f.opA);
      await as(run, f.opA);
      expect((await run("select id from public.sites")).length).toBe(1);
      await as(run, YA);
      expect(await fails(run(`select public.mg_revoke_member('${mOp}')`))).toMatch(/FORBIDDEN/);
      await as(run, XA);
      expect(await fails(run(`select public.mg_revoke_member('${await member(run, XA)}')`))).toMatch(/FORBIDDEN/);
      await run(`select public.mg_revoke_member('${mOp}')`);
      await as(run, f.opA);
      expect((await run("select role, organization_id, operator_name from public.profiles where id = auth.uid()"))[0]).toEqual({ role: null, organization_id: null, operator_name: null });
      expect((await run("select id from public.sites")).length).toBe(0);
      expect((await run("select id from public.incidents")).length).toBe(0);
      // and the revoked person cannot re-bind by name
      await run("select public.complete_staff_profile('x','y','operator',null,'AgriLib Mining')");
      expect((await run("select organization_id from public.profiles where id = auth.uid()"))[0].organization_id).toBeNull();
      expect((await run("select id from public.sites")).length).toBe(0);
    });
  });

  test("a suspended company's own administrator cannot manage the workforce; the Ministry still can", async () => {
    await world(async (run, { orgA }) => {
      await as(run, f.admin);
      await run(`select public.mg_set_company_status('${orgA}', 'suspended', 'licence review')`);
      await as(run, XA);
      expect(await fails(run(`select * from public.mg_company_workforce('${orgA}')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_create_org_invitation('${orgA}', 'a@b.cc', 'worker')`))).toMatch(/FORBIDDEN/);
      await as(run, f.admin);
      expect((await run(`select * from public.mg_company_workforce('${orgA}')`)).length).toBeGreaterThan(0);
    });
  });
});

describe("data isolation", () => {
  test("administrators read only their own company's members/invitations; members read only their own row; nobody writes directly", async () => {
    await world(async (run, { orgA, orgB }) => {
      const mine = await run("select distinct organization_id from public.organization_members");
      expect(mine).toEqual([{ organization_id: orgA }]);
      await as(run, YA);
      expect(await run("select distinct organization_id from public.organization_members")).toEqual([{ organization_id: orgB }]);
      await as(run, f.opA);
      const own = await run("select user_id from public.organization_members");
      expect(own).toEqual([{ user_id: f.opA }]);
      for (const sql of [
        "update public.organization_members set org_role = 'company_admin'",
        "insert into public.organization_members (organization_id, user_id, org_role) select organization_id, user_id, 'worker' from public.organization_members",
        "delete from public.organization_members",
        "update public.organization_invitations set status = 'accepted'",
      ]) expect(await fails(run(sql))).toMatch(/permission denied/i);
      expect(await fails(run(`select * from public.mg_company_workforce('${orgA}')`))).toMatch(/FORBIDDEN/);
    });
  });

  test("0026 backfilled a worker membership for every legacy operator that already had a company binding", async () => {
    await withRole("postgres", null, async (run) => {
      const missing = await run(
        `select p.id from public.profiles p
          where p.role = 'operator' and p.organization_id is not null
            and not exists (select 1 from public.organization_members m where m.user_id = p.id and m.status = 'active')`,
      );
      expect(missing).toEqual([]);
    });
  });

  test("accepting an invitation withdraws the person's pending request elsewhere", async () => {
    await world(async (run, { orgA, orgB }) => {
      await as(run, W1);
      const req = (await run(`select public.mg_request_membership('${orgB}') as id`))[0].id;
      await as(run, XA);
      const inv = (await run(`select public.mg_create_org_invitation('${orgA}', 'w1@mail.test', 'worker') as id`))[0].id;
      await as(run, W1);
      await run(`select public.mg_accept_invitation('${inv}')`);
      expect((await run(`select status from public.organization_members where id = '${req}'`))[0]?.status ?? "revoked").toBe("revoked");
      await as(run, YA);
      expect(await fails(run(`select public.mg_decide_membership_request('${req}', true, 'worker')`))).toMatch(/MEMBERSHIP_NOT_PENDING/);
    });
  });
});

/** Look an id up as the table owner (RLS would hide other companies' rows), then resume the session role. */
async function member(run: Runner, uid: string) {
  await run("reset role");
  const id = (await run(`select id from public.organization_members where user_id = '${uid}' and status = 'active'`))[0].id as string;
  await run("set local role authenticated");
  return id;
}
