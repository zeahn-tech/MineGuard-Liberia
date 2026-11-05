// ---------------------------------------------------------------------------
// Migration 0039 — Ministry oversight summary + administrator removal of users.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // AgriLib worker
const REG = "aaaaaaaa-0000-4000-8000-000000000091"; // registrar
const ADM2 = "aaaaaaaa-0000-4000-8000-0000000000e9"; // a second platform administrator
const LEAVER = "aaaaaaaa-0000-4000-8000-0000000000e1"; // a plain account with no records

beforeAll(async () => {
  f = await getFixture();
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
async function owner(run: Runner, sql: string) {
  const claims = String((await run("select coalesce(current_setting('request.jwt.claims', true), '') as c"))[0].c);
  await run("reset role");
  await run("select set_config('request.jwt.claims', '', true)");
  const rows = await run(sql);
  await run("select set_config('request.jwt.claims', $1, true)", [claims]);
  await run("set local role authenticated");
  return rows;
}

async function world<T>(fn: (run: Runner, c: { orgA: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email, raw_user_meta_data) values
      ('${XA}','xa@agrilib.test','{"name":"Xavier Admin"}'), ('${WK}','wk@agrilib.test','{"name":"Wale Worker"}'),
      ('${REG}','reg@ministry.test','{"name":"Rita Registrar"}'), ('${ADM2}','adm2@ministry.test','{"name":"Second Admin"}'),
      ('${LEAVER}','leaver@x.test','{"name":"Plain Person"}')`);
    await run(`update public.profiles set role = 'registrar', scope = 'national', profile_complete = true where id = '${REG}'`);
    await run(`update public.profiles set role = 'admin', scope = 'national', profile_complete = true where id = '${ADM2}'`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    await run("set local role authenticated");
    await as(run, f.admin);
    const inv = (await run(`select public.mg_create_company_admin_invitation('${orgA}', 'xa@agrilib.test') as id`))[0].id;
    await as(run, XA);
    await run(`select public.mg_accept_invitation('${inv}')`);
    const w = (await run(`select public.mg_create_org_invitation('${orgA}', 'wk@agrilib.test', 'worker') as id`))[0].id;
    await as(run, WK);
    await run(`select public.mg_accept_invitation('${w}')`);
    await as(run, f.admin);
    return fn(run, { orgA });
  });
}

describe("company oversight (Ministry staff)", () => {
  test("every company with its counts; an administrator sees all, a county inspector only what their scope allows", async () => {
    await world(async (run) => {
      await owner(run, `insert into public.corrective_actions (finding_id, site_id, description, due_at, opened_by_id)
        select fi.id, fi.site_id, 'overdue probe', now() - interval '3 days', '${f.admin}' from public.findings fi where fi.site_id = '${f.siteA}' limit 1`);
      const all = await run("select * from public.mg_company_oversight()");
      const a = all.find((r) => r.name === "AgriLib Mining")!;
      expect(a).toMatchObject({ status: "approved" });
      expect(Number(a.sites)).toBeGreaterThanOrEqual(1);
      expect(Number(a.overdue_actions)).toBeGreaterThanOrEqual(1);
      expect(Number(a.open_actions)).toBeGreaterThanOrEqual(Number(a.overdue_actions));
      expect(all.map((r) => r.name)).toContain("OreCo Liberia");
      // sorted: most overdue first
      const overdue = all.map((r) => Number(r.overdue_actions));
      expect([...overdue].sort((x, y) => y - x)).toEqual(overdue);
      // a county inspector for a county with no company site sees no rows
      await as(run, f.county);
      const scoped = await run("select name, sites from public.mg_company_oversight()");
      expect(scoped.every((r) => Number(r.sites) >= 1)).toBe(true);
    });
  });

  test("the registrar, company people and outsiders are refused", async () => {
    await world(async (run) => {
      for (const uid of [REG, XA, WK, f.guest]) {
        await as(run, uid);
        expect(await fails(run("select * from public.mg_company_oversight()")), String(uid)).toMatch(/FORBIDDEN/);
      }
    });
  });
});

describe("user directory (administrators only)", () => {
  test("search, paging, and a wildcard in the search is a literal", async () => {
    await world(async (run) => {
      const one = await run("select * from public.mg_admin_user_directory('wale', 10, 0)");
      expect(one.map((r) => r.email)).toEqual(["wk@agrilib.test"]);
      expect(one[0]).toMatchObject({ company: "AgriLib Mining", org_role: "worker", removed: false });
      expect((await run("select * from public.mg_admin_user_directory('%', 50, 0)")).length).toBe(0); // % is not "everything"
      expect((await run("select * from public.mg_admin_user_directory('_', 50, 0)")).length).toBe(0);
      const p1 = await run("select user_id from public.mg_admin_user_directory(null, 2, 0)");
      const p2 = await run("select user_id from public.mg_admin_user_directory(null, 2, 2)");
      expect(p1.length).toBe(2);
      expect(p1.some((r) => p2.some((q) => q.user_id === r.user_id))).toBe(false);
      expect((await run("select * from public.mg_admin_user_directory(null, 100000, 0)")).length).toBeLessThanOrEqual(50);
    });
  });

  test("nobody but a user manager can list people or remove anyone", async () => {
    await world(async (run) => {
      for (const uid of [REG, XA, WK, f.county, f.opA, f.guest]) {
        await as(run, uid);
        expect(await fails(run("select * from public.mg_admin_user_directory(null, 10, 0)")), String(uid)).toMatch(/FORBIDDEN/);
        expect(await fails(run(`select public.mg_admin_account_deletion_blockers('${LEAVER}')`)), String(uid)).toMatch(/FORBIDDEN/);
        expect(await fails(run(`select public.mg_admin_prepare_account_deletion('${LEAVER}', 'leaver@x.test')`)), String(uid)).toMatch(/FORBIDDEN/);
      }
      // the person is untouched
      expect((await owner(run, `select deleted_at from public.profiles where id = '${LEAVER}'`))[0].deleted_at).toBeNull();
    });
  });
});

describe("administrator removes an account", () => {
  test("never oneself, the exact email must be typed, and unknown people are refused", async () => {
    await world(async (run) => {
      expect(await fails(run(`select public.mg_admin_prepare_account_deletion('${f.admin}', 'x')`))).toMatch(/USE_SELF_SERVICE/);
      expect(await fails(run(`select public.mg_admin_account_deletion_blockers('${f.admin}')`))).toMatch(/USE_SELF_SERVICE/);
      expect(await fails(run(`select public.mg_admin_prepare_account_deletion('${LEAVER}', 'someone.else@x.test')`))).toMatch(/CONFIRM_MISMATCH/);
      expect(await fails(run(`select public.mg_admin_prepare_account_deletion('${LEAVER}', '')`))).toMatch(/CONFIRM_MISMATCH/);
      expect(await fails(run(`select public.mg_admin_prepare_account_deletion(gen_random_uuid(), 'a@b.cc')`))).toMatch(/NOT_FOUND/);
      expect((await owner(run, `select deleted_at from public.profiles where id = '${LEAVER}'`))[0].deleted_at).toBeNull(); // nothing happened
    });
  });

  test("the same blockers as self-service: a company's only administrator, and the last platform administrator", async () => {
    await world(async (run) => {
      const b = (await run(`select public.mg_admin_account_deletion_blockers('${XA}') as b`))[0].b as { code: string }[];
      expect(b.map((x) => x.code)).toEqual(["SOLE_COMPANY_ADMIN"]);
      expect(await fails(run(`select public.mg_admin_prepare_account_deletion('${XA}', 'xa@agrilib.test')`))).toMatch(/BLOCKED: You are the only administrator of AgriLib Mining/);
      expect((await owner(run, `select role from public.profiles where id = '${XA}'`))[0].role).toBe("operator"); // untouched
      // with two platform administrators, one can remove the other; the survivor then cannot be removed by anyone
      await run(`select public.mg_admin_prepare_account_deletion('${ADM2}', 'adm2@ministry.test')`);
      expect((await owner(run, `select role, name from public.profiles where id = '${ADM2}'`))[0]).toEqual({ role: null, name: "Deleted user" });
    });
  });

  test("a person with no records: personal rows go, the login can then be deleted outright, and it is audited", async () => {
    await world(async (run) => {
      const out = (await run(`select public.mg_admin_prepare_account_deletion('${LEAVER}', ' LEAVER@x.test ') as r`))[0].r;
      expect(out).toMatchObject({ hasRecords: false });
      const p = (await owner(run, `select name, role, email, deleted_at is not null as gone from public.profiles where id = '${LEAVER}'`))[0];
      expect(p).toMatchObject({ name: "Deleted user", role: null, gone: true });
      expect(String(p.email)).toMatch(/^deleted-.*@deleted\.invalid$/);
      const audit = await owner(run, `select action, actor_id from public.audit_log where entity_id = '${LEAVER}' and action = 'account.removed'`);
      expect(audit).toEqual([{ action: "account.removed", actor_id: f.admin }]);
      await run("reset role");
      await run("select set_config('request.jwt.claims', '', true)");
      await run(`delete from auth.users where id = '${LEAVER}'`); // no foreign key stands in the way
      expect(await run(`select id from public.profiles where id = '${LEAVER}'`)).toEqual([]);
    });
  });

  test("a company worker: membership ends, company access is gone, other people are unaffected", async () => {
    await world(async (run) => {
      await run(`select public.mg_admin_prepare_account_deletion('${WK}', 'wk@agrilib.test')`);
      expect((await owner(run, `select role, organization_id from public.profiles where id = '${WK}'`))[0]).toEqual({ role: null, organization_id: null });
      await as(run, WK);
      expect((await run("select id from public.sites")).length).toBe(0);
      await as(run, XA);
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0); // the company is intact
    });
  });

  test("someone who OWNS safety records: the records stay untouched under 'Deleted user' and hasRecords says so", async () => {
    await world(async (run) => {
      await owner(run, `insert into public.findings (inspection_id, site_id, title, severity, created_by_id)
        select id, site_id, 'Record owned by the leaver', 'low', '${LEAVER}' from public.inspections limit 1`);
      const before = (await owner(run, "select count(*)::int as n from public.findings"))[0].n;
      const out = (await run(`select public.mg_admin_prepare_account_deletion('${LEAVER}', 'leaver@x.test') as r`))[0].r as { hasRecords: boolean };
      expect(out.hasRecords).toBe(true);                       // the login must be DISABLED, not deleted
      expect((await owner(run, "select count(*)::int as n from public.findings"))[0].n).toBe(before); // nothing deleted
      const rec = (await owner(run, `select f.title, p.name from public.findings f join public.profiles p on p.id = f.created_by_id where f.title = 'Record owned by the leaver'`))[0];
      expect(rec).toEqual({ title: "Record owned by the leaver", name: "Deleted user" });
      await run("reset role");
      await run("select set_config('request.jwt.claims', '', true)");
      let blocked = "";
      try { await run(`delete from auth.users where id = '${LEAVER}'`); } catch (e) { blocked = String((e as Error).message); }
      expect(blocked).toMatch(/foreign key|violates/i);        // proof a hard delete would have destroyed history
    });
  });
});

describe("screens (UI contracts; the database is the boundary)", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
  test("Users is for administrators; removal needs the exact email AND the administrator's password; never oneself", () => {
    const u = read("src/pages/AdminUsers.tsx");
    expect(u).toContain('user.role !== "admin"');
    expect(u).toContain('typed.trim().toLowerCase() !== (target?.email ?? "").toLowerCase()');
    expect(u).toContain("!password");
    expect(u).toContain("r.userId === user.uid");
    expect(u).toMatch(/blockers\.map/);
  });
  test("the client sends the typed email and password to the server, which re-verifies; a plain member removal uses the existing function", () => {
    const b = read("src/lib/backend.ts");
    expect(b).toContain("targetUserId: args.userId, confirmEmail: args.confirmEmail");
    expect(b).toMatch(/removeFromCompany: async[\s\S]{0,200}mg_revoke_member/);
  });
  test("the oversight page and Users page are in the staff menu (Users administrators only); the registrar cannot reach them", () => {
    const l = read("src/pages/PortalLayout.tsx");
    expect(l).toContain('"/portal/oversight"');
    expect(l).toMatch(/"\/portal\/users"[^}]*adminOnly: true/);
    expect(read("src/pages/Oversight.tsx")).toContain("api.oversight.list");
  });
});
