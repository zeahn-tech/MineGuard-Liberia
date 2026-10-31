// ---------------------------------------------------------------------------
// Migration 0034 — in-app notifications for company administration.
// Created by the database from the events themselves; private to each recipient;
// no emails, links or secrets in their text; never able to block the real action.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const ROOT = join(import.meta.dir, "..");
const REG = "aaaaaaaa-0000-4000-8000-000000000091";
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const YA = "aaaaaaaa-0000-4000-8000-0000000000b1"; // OreCo company administrator
const P1 = "aaaaaaaa-0000-4000-8000-0000000000e1"; // outsider

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of [
    "0024_self_service_tenant_lockdown.sql", "0025_company_status_membership_invitations.sql",
    "0026_company_workforce.sql", "0027_site_scoped_access.sql", "0028_account_names_invitation_cleanup.sql",
    "0029_onboarding_officer_bulk_import.sql", "0030_registrar_role_value.sql", "0031_company_registrar.sql",
    "0032_government_roles_hold_no_company.sql", "0033_companies_are_registered_not_typed.sql",
    "0034_company_notifications.sql",
  ]) await db.exec(readFileSync(join(ROOT, "supabase", "migrations", m), "utf8"));
});

const as = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
/** Run as the table owner with NO signed-in user (like the SQL editor), then restore the session. */
async function owner(run: Runner, sql: string) {
  const claims = String((await run("select coalesce(current_setting('request.jwt.claims', true), '') as c"))[0].c);
  await run("reset role");
  await run("select set_config('request.jwt.claims', '', true)");
  const rows = await run(sql);
  await run("select set_config('request.jwt.claims', $1, true)", [claims]);
  await run("set local role authenticated");
  return rows;
}
const inbox = async (run: Runner, uid: string) => {
  await as(run, uid);
  return run("select kind, severity, title, body, link_to from public.notifications order by created_at, title");
};

/** Registrar REG, company administrators XA (AgriLib) and YA (OreCo), an outsider P1 with an account. */
async function world<T>(fn: (run: Runner, c: { orgA: string; orgB: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email) values ('${REG}','registrar@ministry.test'), ('${XA}','xa@agrilib.test'), ('${YA}','ya@oreco.test'), ('${P1}','p1@mail.test')`);
    await run(`update public.profiles set role = 'registrar' where id = '${REG}'`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    await run("set local role authenticated");
    for (const [org, uid, email] of [[orgA, XA, "xa@agrilib.test"], [orgB, YA, "ya@oreco.test"]] as const) {
      await as(run, REG);
      const inv = (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${inv}')`);
    }
    await owner(run, "delete from public.notifications"); // start each case with empty inboxes
    return fn(run, { orgA, orgB });
  });
}

describe("invitations", () => {
  test("an invitee WITH an account is notified; the text carries the company and role, never the email or a link", async () => {
    await world(async (run, { orgA }) => {
      await as(run, XA);
      await run(`select public.mg_create_org_invitation('${orgA}', 'p1@mail.test', 'safety_officer')`);
      const n = await inbox(run, P1);
      expect(n).toEqual([{ kind: "org_invitation", severity: "info", title: "You have been invited to AgriLib Mining", body: "Role: Safety officer. Open to review and accept.", link_to: "/invitation" }]);
      expect(JSON.stringify(n)).not.toMatch(/@|http|token/i);
      // someone without an account yet is simply not notified (the email is their notice)
      await as(run, XA);
      await run(`select public.mg_create_org_invitation('${orgA}', 'nobody.yet@mail.test', 'worker')`);
      expect((await owner(run, "select count(*)::int as n from public.notifications"))[0].n).toBe(1);
    });
  });

  test("the sender is told when it is accepted, with a link that suits their role", async () => {
    await world(async (run, { orgA }) => {
      await as(run, REG);
      const reg = (await run(`select public.mg_create_company_admin_invitation('${orgA}', 'p1@mail.test') as id`))[0].id;
      await as(run, P1);
      await run(`select public.mg_accept_invitation('${reg}')`);
      expect((await inbox(run, REG)).map((n) => [n.title, n.link_to])).toEqual([["Invitation accepted", "/registry"]]);
      await as(run, XA);
      const w = (await run(`select public.mg_create_org_invitation('${orgA}', 'newhire@mail.test', 'worker') as id`))[0].id;
      await owner(run, "insert into auth.users (id, email) values ('aaaaaaaa-0000-4000-8000-0000000000e2','newhire@mail.test')");
      await as(run, "aaaaaaaa-0000-4000-8000-0000000000e2");
      await run(`select public.mg_accept_invitation('${w}')`);
      expect((await inbox(run, XA)).map((n) => [n.title, n.link_to])).toContainEqual(["Invitation accepted", "/operate/team"]);
    });
  });
});

describe("join requests and decisions", () => {
  test("a request notifies THAT company's administrators only; the decision notifies the requester", async () => {
    await world(async (run, { orgA }) => {
      await as(run, P1);
      const req = (await run(`select public.mg_request_membership('${orgA}') as id`))[0].id;
      expect((await inbox(run, XA)).map((n) => [n.kind, n.title, n.link_to])).toEqual([["org_request", "New request to join AgriLib Mining", "/operate/team"]]);
      expect(JSON.stringify(await inbox(run, XA))).not.toMatch(/p1@mail|@/); // no personal data in the preview
      expect(await inbox(run, YA)).toEqual([]); // another company's administrator hears nothing
      expect(await inbox(run, REG)).toEqual([]);
      await as(run, XA);
      await run(`select public.mg_decide_membership_request('${req}', true, 'safety_officer')`);
      expect((await inbox(run, P1)).map((n) => [n.kind, n.title, n.body])).toEqual([["org_decision", "Request approved", "You were added to AgriLib Mining as Safety officer."]]);
    });
  });

  test("a declined request tells the requester where to go next", async () => {
    await world(async (run, { orgA }) => {
      await as(run, P1);
      const req = (await run(`select public.mg_request_membership('${orgA}') as id`))[0].id;
      await as(run, XA);
      await run(`select public.mg_decide_membership_request('${req}', false)`);
      expect((await inbox(run, P1)).map((n) => [n.title, n.severity, n.link_to])).toEqual([["Request declined", "warning", "/join"]]);
    });
  });
});

describe("role changes, removal and status changes", () => {
  test("role change and removal notify the member; each change notifies once", async () => {
    await world(async (run, { orgA }) => {
      await as(run, XA);
      const mOp = (await owner(run, `select id from public.organization_members where user_id = '${f.opA}'`))[0].id;
      await run(`select public.mg_set_member_role('${mOp}', 'site_manager')`);
      await run(`select public.mg_set_member_role('${mOp}', 'site_manager')`); // no change -> no second notice
      await run(`select public.mg_set_member_role('${mOp}', 'safety_officer')`);
      const roles = (await inbox(run, f.opA)).map((n) => n.body);
      // (one transaction = one timestamp, so compare as a set: exactly these two, once each)
      expect([...roles].sort()).toEqual(["At AgriLib Mining you are now Safety officer.", "At AgriLib Mining you are now Site manager."]);
      await as(run, XA);
      await run(`select public.mg_revoke_member('${mOp}')`);
      const after = await inbox(run, f.opA);
      expect(after.map((n) => n.title)).toContain("Removed from AgriLib Mining");
      expect(after.find((n) => n.title.startsWith("Removed"))!.link_to).toBe("/join");
      void orgA;
    });
  });

  test("a company suspension / reactivation notifies its administrators — and only them", async () => {
    await world(async (run, { orgA }) => {
      await as(run, REG);
      await run(`select public.mg_set_company_status('${orgA}', 'suspended', 'licence under review')`);
      await run(`select public.mg_set_company_status('${orgA}', 'approved')`);
      const n = await inbox(run, XA);
      expect(n.map((x) => `${x.title}|${x.severity}`).sort()).toEqual(["AgriLib Mining is now approved|info", "AgriLib Mining is now suspended|urgent"]);
      expect(n.find((x) => x.title.endsWith("suspended"))!.body).toContain("licence under review");
      expect(await inbox(run, YA)).toEqual([]);
    });
  });

  test("a site status change notifies the company's administrators", async () => {
    await world(async (run) => {
      await owner(run, `update public.sites set status = 'suspended' where id = '${f.siteA}'`);
      expect((await inbox(run, XA)).map((n) => [n.kind, n.severity, n.link_to])).toEqual([["org_status", "warning", "/operate/sites"]]);
      expect(await inbox(run, YA)).toEqual([]);
    });
  });
});

describe("the inbox stays private and trustworthy", () => {
  test("nobody reads another account's inbox; a client cannot write into someone else's; content is immutable", async () => {
    await world(async (run, { orgA }) => {
      await as(run, XA);
      await run(`select public.mg_create_org_invitation('${orgA}', 'p1@mail.test', 'worker')`);
      await as(run, YA);
      expect((await run("select id from public.notifications")).length).toBe(0);
      await as(run, f.admin);
      expect((await run("select id from public.notifications")).length).toBe(0);
      // a client inserting "for" someone else lands in its OWN inbox (the guard forces it)
      await as(run, YA);
      await run(`insert into public.notifications (user_id, source_key, kind, severity, title, link_to, event_at) values ('${P1}', 'x', 'org_request', 'info', 'forged', '/operate', now())`).catch(() => undefined);
      expect((await owner(run, `select count(*)::int as n from public.notifications where user_id = '${P1}' and title = 'forged'`))[0].n).toBe(0);
      await as(run, P1);
      await expect(run("update public.notifications set title = 'changed'")).rejects.toThrow(/IMMUTABLE|permission denied/i);
    });
  });

  test("a notification can never carry an external link", async () => {
    await world(async (run) => {
      await as(run, XA);
      await expect(run(`insert into public.notifications (user_id, source_key, kind, severity, title, link_to, event_at) values ('${XA}', 'y', 'org_request', 'info', 'x', 'https://evil.test', now())`)).rejects.toThrow(/check|violat/i);
    });
  });

  test("a failure while notifying never blocks the real action", async () => {
    await world(async (run, { orgA }) => {
      await owner(run, "alter table public.notifications add constraint test_always_fails check (false) not valid");
      await as(run, XA);
      const id = (await run(`select public.mg_create_org_invitation('${orgA}', 'p1@mail.test', 'worker') as id`))[0].id;
      expect(id).toBeTruthy(); // the invitation exists although its notification could not be written
      await owner(run, "alter table public.notifications drop constraint test_always_fails");
    });
  });
});

describe("the bell shows them (UI contracts)", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  test("server-created notifications are loaded and have icons", () => {
    const b = read("src/lib/backend.ts");
    expect(b).toContain("loadOrgNotifications");
    const v = read("src/components/NotificationBellView.tsx");
    for (const k of ["org_invitation", "org_request", "org_decision", "org_role", "org_status"]) expect(v).toContain(k);
  });
  test("the registry header carries the bell and the security link", () => {
    const r = read("src/pages/RegistryLayout.tsx");
    expect(r).toContain("<NotificationBell />");
    expect(r).toContain("/registry/security");
    expect(read("src/main.tsx")).toMatch(/path="security" element=\{<OperatorSecurity \/>\}[\s\S]{0,40}\/Route>/);
  });
});
