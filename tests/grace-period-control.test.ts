// ---------------------------------------------------------------------------
// Migration 0067 — Ministry-controlled licence grace period (mg_set_licence_grace_until / mg_licence_grace_status and the
// 'platform_settings.write' permission). Every case rolls back (withRole). Runs on PGlite from an empty database, so the
// whole chain 0001..0067 is applied by the shared harness.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const ROOT = join(import.meta.dir, "..");
const GRACE = "licence_grace_until_for_site_requests";
const REG = "aaaaaaaa-0000-4000-8000-000000000291";
const ADMIN2 = "aaaaaaaa-0000-4000-8000-000000000292";
const CADMIN = "aaaaaaaa-0000-4000-8000-000000000293";
const CSUP = "aaaaaaaa-0000-4000-8000-000000000294";
const CREG = "aaaaaaaa-0000-4000-8000-000000000295";
const LADMIN = "aaaaaaaa-0000-4000-8000-000000000296";

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  // Other files in the same run replay older migrations on the shared database; re-assert the pieces these tests rely on
  // (both are idempotent): the company supervisor role value (0054) and the 0067 objects themselves.
  for (const m of ["0054_company_supervisor_role.sql", "0067_grace_period_control.sql"]) {
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", m), "utf8"));
  }
});

async function fails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}
const signedIn = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
const day = (offset: number) => `to_char(current_date + ${offset}, 'YYYY-MM-DD')::date`;
const setG = (run: Runner, date: string | null, reason: string | null) =>
  run(`select public.mg_set_licence_grace_until(${date === null ? "null" : date}, ${reason === null ? "null" : `'${reason}'`})`);
const value = async (run: Runner) => (await run(`select value from public.platform_settings where key = '${GRACE}'`))[0]?.value as string | null;

/** accounts as the owner would set them up, then switch to the signed-in role */
async function seedUsers(run: Runner) {
  await run(`insert into auth.users (id, email) values ('${REG}','reg67@ministry.test'), ('${ADMIN2}','admin2@ministry.test'),
    ('${CADMIN}','cadmin67@co.test'), ('${CSUP}','csup67@co.test'), ('${CREG}','creg67@co.test') on conflict do nothing`);
  await run(`update public.profiles set role = 'registrar', scope = 'national', profile_complete = true where id = '${REG}'`);
  await run(`update public.profiles set role = 'admin', scope = 'national', profile_complete = true where id = '${ADMIN2}'`);
  const org = (await run(`insert into public.organizations (name, status) values ('Grace Co', 'approved') returning id`))[0].id as string;
  for (const [u, r] of [[CADMIN, "company_admin"], [CSUP, "supervisor"], [CREG, "company_admin"]]) {
    await run(`update public.profiles set role = 'operator', scope = 'operator', profile_complete = true where id = '${u}'`);
    await run(`insert into public.organization_members (organization_id, user_id, org_role, status) values ('${org}', '${u}', '${r}', 'active')
               on conflict do nothing`);
  }
  return org;
}
const asAuth = (run: Runner, uid: string) => run("set local role authenticated").then(() => signedIn(run, uid));

describe("permission rows", () => {
  test("platform_settings.write is held by exactly admin and registrar, and registrar gets nothing else new", async () => {
    await withRole("postgres", null, async (run) => {
      const rows = await run("select role::text from public.permissions where permission = 'platform_settings.write' order by 1");
      expect(rows.map((r) => r.role)).toEqual(["admin", "registrar"]);
      const reg = await run("select permission from public.permissions where role = 'registrar' order by 1");
      expect(reg.map((r) => r.permission)).toEqual(["organizations.write", "platform_settings.write"]);
    });
  });
});

describe("who may use it", () => {
  test("admin and registrar can set a date with a reason", async () => {
    for (const who of [f.admin, REG]) {
      await withRole("postgres", null, async (run) => {
        await seedUsers(run);
        const target = (await run(`select to_char(current_date + 30, 'YYYY-MM-DD') as d`))[0].d;
        await asAuth(run, who);
        await setG(run, day(30), "Ministry extended the deadline");
        await run("reset role");
        expect(await value(run)).toBe(target as string);
      });
    }
  });

  test("everyone else gets FORBIDDEN on both functions: supervisor, inspector, operator, guest, company admin, company supervisor", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      for (const who of [f.national, f.county, f.opA, f.guest, CADMIN, CSUP]) {
        await asAuth(run, who);
        expect(await fails(setG(run, day(30), "trying it out"))).toContain("FORBIDDEN");
        expect(await fails(run("select public.mg_licence_grace_status()"))).toContain("FORBIDDEN");
        await run("reset role");
      }
    });
  });

  test("a company member who also holds the registrar role is judged by the Ministry role only: 0032 strips the membership, so company users never inherit it", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      // forcing a registrar assignment on a company admin: the database removes the company binding and membership (0032)
      await run(`update public.profiles set role = 'registrar' where id = '${CREG}'`);
      expect((await run(`select count(*)::int as n from public.organization_members where user_id = '${CREG}' and status in ('pending','active')`))[0].n).toBe(0);
      // and a company admin who stays a company user is refused even with a registrar-looking profile NOT set
      await asAuth(run, CADMIN);
      expect(await fails(setG(run, day(30), "company admin attempt"))).toContain("FORBIDDEN");
    });
  });

  test("no session and the anon role cannot call either function", async () => {
    await withRole("anon", null, async (run) => {
      expect(await fails(setG(run, day(30), "anonymous attempt"))).not.toBe("");
      expect(await fails(run("select public.mg_licence_grace_status()"))).not.toBe("");
    });
  });

  test("platform_settings stays closed to client roles", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      await asAuth(run, f.admin);
      expect(await fails(run("select * from public.platform_settings"))).toContain("permission denied");
      expect(await fails(run(`update public.platform_settings set value = null where key = '${GRACE}'`))).toContain("permission denied");
    });
  });

  test("a registrar cannot approve or promote anyone through this feature (profiles and permissions are unchanged)", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      const snap = async () => JSON.stringify([
        await run("select id, role::text, scope from public.profiles order by id"),
        await run("select role::text, permission from public.permissions order by 1, 2"),
      ]);
      const before = await snap();
      await asAuth(run, REG);
      await setG(run, day(10), "registrar adjusts the deadline");
      await run("reset role");
      expect(await snap()).toBe(before);
      await asAuth(run, REG);
      expect(await fails(run(`select public.provision_user_by_email('x@y.test','admin',null,null,null)`))).not.toBe("");
    });
  });
});

describe("validation", () => {
  test("reason is required (5 to 300 characters), also for switching off", async () => {
    await withRole("postgres", null, async (run) => {
      await asAuth(run, f.admin);
      for (const bad of [null, "", "    ", "abcd", "x".repeat(301)]) {
        expect(await fails(setG(run, day(30), bad))).toContain("REASON_REQUIRED");
        expect(await fails(setG(run, null, bad))).toContain("REASON_REQUIRED");
      }
      await setG(run, day(30), "x".repeat(300)); // exactly 300 is fine
    });
  });

  test("a past date is refused; today is allowed; the cap is 365 days (365 allowed, 366 refused)", async () => {
    await withRole("postgres", null, async (run) => {
      await asAuth(run, f.admin);
      expect(await fails(setG(run, day(-1), "a date in the past"))).toContain("PAST_DATE");
      await setG(run, day(0), "ends today");
      await setG(run, day(365), "the longest allowed period");
      expect(await fails(setG(run, day(366), "one day too far"))).toContain("MAX_GRACE_EXCEEDED");
    });
  });

  test("null switches the grace period off and is audited with the reason", async () => {
    await withRole("postgres", null, async (run) => {
      await asAuth(run, f.admin);
      await setG(run, null, "licence numbers are all recorded");
      await run("reset role");
      expect(await value(run)).toBeNull();
      const a = (await run(`select actor_label, summary, details from public.audit_log where entity_id = '${GRACE}' and actor_id = '${f.admin}'`))[0];
      expect(String(a.summary)).toContain("to NULL (off)");
      expect(String(a.summary)).toContain("Reason: licence numbers are all recorded");
      expect((a.details as { reason: string }).reason).toBe("licence numbers are all recorded");
    });
  });

  test("a no-op change writes no audit row and sends no notification", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      await asAuth(run, f.admin);
      await setG(run, day(20), "first set");
      await run("reset role");
      const n1 = (await run("select count(*)::int as n from public.audit_log where entity_id = '" + GRACE + "'"))[0].n;
      const m1 = (await run("select count(*)::int as n from public.notifications"))[0].n;
      await asAuth(run, f.admin);
      await setG(run, day(20), "same date again");
      await run("reset role");
      expect((await run("select count(*)::int as n from public.audit_log where entity_id = '" + GRACE + "'"))[0].n).toBe(n1);
      expect((await run("select count(*)::int as n from public.notifications"))[0].n).toBe(m1);
    });
  });
});

describe("effect, audit and notification", () => {
  test("the new date takes effect immediately in mg_request_site; a licensed company is unaffected in every state", async () => {
    await withRole("postgres", null, async (run) => {
      const org = await seedUsers(run);
      const licensed = (await run(`insert into public.organizations (name, status, licence_number) values ('Licensed Co', 'approved', 'MEL 2111/16') returning id`))[0].id as string;
      await run(`insert into auth.users (id, email) values ('${LADMIN}','ladmin67@co.test') on conflict do nothing`);
      await run(`update public.profiles set role = 'operator', scope = 'operator', profile_complete = true where id = '${LADMIN}'`);
      await run(`insert into public.organization_members (organization_id, user_id, org_role, status) values ('${licensed}', '${LADMIN}', 'company_admin', 'active')`);
      const req = (who: string, o: string, name: string) =>
        asAuth(run, who).then(() => run(`select public.mg_request_site('${o}', '${name}', 'Nimba', null, null, null, null, null, null) as id`));
      const setAs = async (d: string | null) => {
        await run("reset role");
        await asAuth(run, f.admin);
        await setG(run, d, "test change of the deadline");
        await run("reset role");
      };
      await setAs(day(0)); // today = last day
      expect((await req(CADMIN, org, "Day Zero Pit"))[0].id).toBeTruthy();
      await run("reset role");
      // the day after: simulate by clearing the date to off (a past date is not settable) — and by moving the stored value back
      await run(`update public.platform_settings set value = to_char(current_date - 1, 'YYYY-MM-DD') where key = '${GRACE}'`);
      expect(await fails(req(CADMIN, org, "Day After Pit"))).toContain("LICENCE_REQUIRED");
      await setAs(day(30));
      expect((await req(CADMIN, org, "Extended Pit"))[0].id).toBeTruthy();
      await run("reset role");
      await setAs(null);
      expect(await fails(req(CADMIN, org, "Off Pit"))).toContain("LICENCE_REQUIRED");
      await run("reset role");
      // licensed company: allowed while off, on, and expired
      expect((await req(LADMIN, licensed, "Licensed Off Pit"))[0].id).toBeTruthy();
      await run("reset role");
      await setAs(day(30));
      expect((await req(LADMIN, licensed, "Licensed On Pit"))[0].id).toBeTruthy();
    });
  });

  test("audit shows old value, new value, actor and reason; direct SQL still works and keeps the 0065 format", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      await run(`update public.platform_settings set value = to_char(current_date + 40, 'YYYY-MM-DD') where key = '${GRACE}'`);
      const old = await value(run);
      await asAuth(run, REG);
      await setG(run, day(50), "Parliament asked for more time");
      await run("reset role");
      const last = (await run(`select actor_id, actor_label, action, summary, details from public.audit_log where entity_id = '${GRACE}' and actor_id = '${REG}'`))[0];
      expect(last.actor_label).toBe("reg67@ministry.test");
      expect(last.actor_id).toBe(REG);
      expect((last.details as Record<string, string>).before).toBe(old);
      expect((last.details as Record<string, string>).reason).toBe("Parliament asked for more time");
      expect(String(last.summary)).toContain(`changed from ${old} to `);
      // a direct SQL change afterwards: no reason (the setting is transaction-local and cleared), same format as 0065
      await run(`select set_config('request.jwt.claims', '', true)`); // the owner's SQL session: no signed-in user
      await run(`update public.platform_settings set value = '2099-01-01' where key = '${GRACE}'`);
      const d = (await run(`select summary, details from public.audit_log where entity_id = '${GRACE}' and actor_id is null and summary like '%2099-01-01%'`))[0];
      expect(String(d.summary)).not.toContain("Reason");
      expect(Object.keys(d.details as object).sort()).toEqual(["after", "before", "database_user"]);
    });
  });

  test("every other admin is notified (old, new, who); the person who made the change is not", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      await run("delete from public.notifications");
      await asAuth(run, f.admin);
      await setG(run, day(45), "Ministry extended the deadline");
      await run("reset role");
      const n = await run("select user_id, kind, title, body, link_to from public.notifications order by user_id");
      expect(n.map((r) => r.user_id)).toEqual([ADMIN2]);
      expect(String(n[0].body)).toContain("alice@mineguard.test");
      expect(String(n[0].body)).toContain(" to ");
      expect(String(n[0].body)).toContain("Ministry extended the deadline");
      expect(n[0].link_to).toBe("/portal/companies");
    });
  });

  test("a second change by the other admin notifies the first, not the actor", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      await run("delete from public.notifications");
      await asAuth(run, ADMIN2);
      await setG(run, day(12), "second administrator adjusts");
      await run("reset role");
      expect((await run("select user_id from public.notifications")).map((r) => r.user_id)).toEqual([f.admin]);
    });
  });
});

describe("status read model", () => {
  test("returns until, is_active, days_left and the number of companies without a licence", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      const expected = (await run("select count(*)::int as n from public.organizations where licence_number is null and status <> 'deactivated'"))[0].n;
      await asAuth(run, f.admin);
      await setG(run, day(10), "set for the status test");
      let s = (await run("select public.mg_licence_grace_status() as s"))[0].s as Record<string, unknown>;
      expect(s.is_active).toBe(true);
      expect(s.days_left).toBe(10);
      expect(s.companies_without_licence).toBe(expected);
      await setG(run, null, "switched off for the test");
      s = (await run("select public.mg_licence_grace_status() as s"))[0].s as Record<string, unknown>;
      expect(s).toMatchObject({ until: null, is_active: false, days_left: null });
    });
  });

  test("deactivated companies are not counted", async () => {
    await withRole("postgres", null, async (run) => {
      await seedUsers(run);
      await run(`insert into public.organizations (name, status) values ('Gone Co', 'deactivated')`);
      await asAuth(run, f.admin);
      const base = (await run("select public.mg_licence_grace_status() as s"))[0].s as { companies_without_licence: number };
      await run("reset role");
      await run(`insert into public.organizations (name, status) values ('Gone Two Co', 'deactivated')`);
      await asAuth(run, f.admin);
      const after = (await run("select public.mg_licence_grace_status() as s"))[0].s as { companies_without_licence: number };
      expect(after.companies_without_licence).toBe(base.companies_without_licence);
    });
  });
});

describe("re-apply and grants", () => {
  test("re-applying 0067 changes nothing: setting, permissions, audit, sites, counters and organizations", async () => {
    const db = await getDb();
    const snap = async () =>
      JSON.stringify(await Promise.all([
        db.query("select key, value from public.platform_settings order by key"),
        db.query("select role::text, permission from public.permissions order by 1, 2"),
        db.query("select count(*)::int as n from public.audit_log"),
        db.query("select id, code from public.sites order by id"),
        db.query("select prefix, last_number from public.site_code_counters order by prefix"),
        db.query("select id, name, status, licence_number from public.organizations order by id"),
      ]).then((r) => r.map((x) => x.rows)));
    const before = await snap();
    await db.exec(readFileSync(join(ROOT, "supabase", "migrations", "0067_grace_period_control.sql"), "utf8"));
    expect(await snap()).toBe(before);
  });

  test("grants: authenticated only; anon and public have no execute", async () => {
    await withRole("postgres", null, async (run) => {
      for (const fn of ["mg_set_licence_grace_until(date, text)", "mg_licence_grace_status()"]) {
        const r = (await run(`select has_function_privilege('anon', 'public.${fn}', 'execute') as a,
                                     has_function_privilege('authenticated', 'public.${fn}', 'execute') as u`))[0];
        expect(r).toEqual({ a: false, u: true });
      }
      expect((await run(`select has_table_privilege('authenticated', 'public.platform_settings', 'select,insert,update,delete') as t`))[0].t).toBe(false);
    });
  });
});
