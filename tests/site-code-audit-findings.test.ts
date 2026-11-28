// ---------------------------------------------------------------------------
// Re-audit of PR #80 (migration 0065): one test per finding, using the auditor's exact failing cases.
//   F-1 numbering past 9999 · F-2 canonical county · F-7 prefix vs county · F-3 licence integrity · F-9 auto-created companies
//   G-2 impossible grace date · G-3 grace audit   (G-1, re-applying after deleting the setting, is in site-code-idempotency.test.ts)
// Everything rolls back (withRole). PGlite is one connection: real parallelism is proved in site-code-concurrency.pg.test.ts.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
beforeAll(async () => {
  f = await getFixture();
  await getDb();
});

async function fails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}
const as = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
const REG = "aaaaaaaa-0000-4000-8000-0000000000e1";
async function registrar(run: Runner) {
  await run(`insert into auth.users (id, email) values ('${REG}','reg-audit@ministry.test') on conflict do nothing`);
  await run(`update public.profiles set role = 'registrar', scope = 'national', profile_complete = true where id = '${REG}'`);
}
const insertSite = (run: Runner, county: string, name = "S", code?: string, operator = "AgriLib Mining") =>
  run(`insert into public.sites (${code ? "code, " : ""}name, operator_name, county, created_by)
       values (${code ? `'${code}', ` : ""}'${name}', '${operator}', '${county}', '${f.admin}') returning code, county`);
const setCounter = (run: Runner, prefix: string, n: number) =>
  run(`insert into public.site_code_counters (prefix, last_number) values ('${prefix}', ${n})
       on conflict (prefix) do update set last_number = excluded.last_number`);

describe("F-1 numbering past 9999", () => {
  test("9999 -> 10000 -> 10001 (never the truncated MGL-SINOE-1000), counter follows", async () => {
    await withRole("postgres", null, async (run) => {
      await setCounter(run, "SINOE", 9998);
      await as(run, f.admin);
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await insertSite(run, "Sinoe", `Edge ${i}`))[0].code);
      expect(codes).toEqual(["MGL-SINOE-9999", "MGL-SINOE-10000", "MGL-SINOE-10001"]);
      expect((await run("select last_number from public.site_code_counters where prefix = 'SINOE'"))[0].last_number).toBe(10001);
    });
  });

  test("50 allocations in flight across the boundary: all distinct, contiguous 9991..10040, five digits from 10000", async () => {
    await withRole("postgres", null, async (run) => {
      await setCounter(run, "RIVERG", 9990);
      await as(run, f.admin);
      const res = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => insertSite(run, "River Gee", `Par ${i}`)));
      expect(res.filter((r) => r.status === "rejected")).toHaveLength(0);
      const codes = res.map((r) => (r as PromiseFulfilledResult<{ code: string }[]>).value[0].code).sort();
      expect(new Set(codes).size).toBe(50);
      const nums = codes.map((c) => Number(c.split("-")[2])).sort((a, b) => a - b);
      expect(nums[0]).toBe(9991);
      expect(nums[49]).toBe(10040);
      for (const c of codes) expect(c.split("-")[2].length).toBe(Number(c.split("-")[2]) < 10000 ? 4 : 5);
    });
  });

  test("a county whose 4-digit codes are ALL taken (counter empty) does not hang: the next code is 10000", async () => {
    await withRole("postgres", null, async (run) => {
      await run("alter table public.sites disable trigger sites_code_guard");
      await run(`insert into public.sites (code, name, operator_name, county, created_by)
                 select 'MGL-MARGIB-' || lpad(g::text, 4, '0'), 'Full ' || g, 'AgriLib Mining', 'Margibi', '${f.admin}' from generate_series(1, 9999) g`);
      await run("alter table public.sites enable trigger sites_code_guard");
      await run("delete from public.site_code_counters where prefix = 'MARGIB'");
      await as(run, f.admin);
      const t0 = Date.now();
      const code = (await insertSite(run, "Margibi", "After the full range"))[0].code;
      expect(code).toBe("MGL-MARGIB-10000");
      expect(Date.now() - t0).toBeLessThan(5000);
      expect((await run("select last_number from public.site_code_counters where prefix = 'MARGIB'"))[0].last_number).toBe(10000);
    });
  }, 120_000);
});

describe("F-2 the county is stored in its canonical spelling", () => {
  const cases: [string, string][] = [["bomi", "Bomi"], ["Bo-mi!!", "Bomi"], ["Bo1mi", "Bomi"], [" GRAND   bassa", "Grand Bassa"]];
  test("on insert: the auditor's four inputs are stored canonically", async () => {
    for (const [typed, canonical] of cases) {
      await withRole("postgres", null, async (run) => {
        await as(run, f.admin);
        const row = (await insertSite(run, typed))[0];
        expect(row.county).toBe(canonical);
        expect(row.code).toMatch(canonical === "Bomi" ? /^MGL-BOMI-/ : /^MGL-GRANDB-/);
      });
    }
  });
  test("on a county change: a variant is stored canonically; the code never moves; Atlantis is refused", async () => {
    await withRole("postgres", null, async (run) => {
      await as(run, f.admin);
      const row = (await insertSite(run, "Nimba", "Mover"))[0];
      await run(`update public.sites set county = '  river-cess ' where code = '${row.code}'`);
      expect((await run(`select county, code from public.sites where code = '${row.code}'`))[0]).toEqual({ county: "River Cess", code: row.code });
      expect(await fails(run(`update public.sites set county = 'Atlantis' where code = '${row.code}'`))).toContain("INVALID_COUNTY");
      expect(await fails(insertSite(run, "Atlantis"))).toContain("INVALID_COUNTY");
    });
  });
  test("a company's site request is stored with the canonical county too", async () => {
    await withRole("postgres", null, async (run) => {
      const orgId = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
      await run(`update public.organizations set licence_number = 'CNT 1001/20' where id = '${orgId}' and licence_number is null`);
      const uid = "aaaaaaaa-0000-4000-8000-0000000000e2";
      await run(`insert into auth.users (id, email) values ('${uid}','req-audit@x.test')`);
      await run(`update public.profiles set role = 'operator', profile_complete = true where id = '${uid}'`);
      await run(`insert into public.organization_members (organization_id, user_id, org_role, status) values ('${orgId}', '${uid}', 'company_admin', 'active')`);
      await run("set local role authenticated");
      await as(run, uid);
      const id = (await run(`select public.mg_request_site('${orgId}', 'Canon Pit', 'grand   BASSA', null, null, null, null, null, null) as id`))[0].id;
      await run("reset role");
      expect((await run(`select county from public.site_registration_requests where id = '${id}'`))[0].county).toBe("Grand Bassa");
    });
  });
});

describe("F-7 owner-run codes must carry the prefix of the site's county", () => {
  test("MGL-NIMBA-0001 on a Bomi site is refused", async () => {
    await withRole("postgres", null, async (run) => {
      expect(await fails(insertSite(run, "Bomi", "Wrong county", "MGL-NIMBA-0001"))).toContain("CODE_PREFIX_MISMATCH");
    });
  });
  test("MGL-ZZZZ-0001 is refused and leaves no stray ZZZZ counter row", async () => {
    await withRole("postgres", null, async (run) => {
      expect(await fails(insertSite(run, "Bomi", "Junk prefix", "MGL-ZZZZ-0001"))).toContain("CODE_PREFIX_MISMATCH");
      expect(await fails(insertSite(run, "Nimba", "Junk prefix 2", "MGL-ZZZZ-0001"))).toContain("CODE_PREFIX_MISMATCH");
      expect((await run("select count(*)::int as n from public.site_code_counters where prefix = 'ZZZZ'"))[0].n).toBe(0);
    });
  });
  test("a code with the right prefix is still accepted and moves the counter", async () => {
    await withRole("postgres", null, async (run) => {
      await run("delete from public.site_code_counters where prefix = 'LOFA'");
      expect((await insertSite(run, "Lofa", "Right prefix", "MGL-LOFA-0042"))[0].code).toBe("MGL-LOFA-0042");
      expect((await run("select last_number from public.site_code_counters where prefix = 'LOFA'"))[0].last_number).toBe(42);
    });
  });
});

describe("F-3 licence integrity", () => {
  const BAD = ["APL-12345", "CLC-9", "ab", "!!!###$$$ 99", "A".repeat(199) + "1", "NODIGITS"];
  async function company(run: Runner, licence: string | null = null) {
    return (await run(`insert into public.organizations (name, status${licence ? ", licence_number" : ""}) values ('Licence Probe ${Math.random().toString(36).slice(2, 8)}', 'approved'${licence ? `, '${licence}'` : ""}) returning id`))[0].id as string;
  }
  test("an admin session (role authenticated) cannot set any of the auditor's six bad licences by direct update", async () => {
    for (const bad of BAD) {
      await withRole("postgres", null, async (run) => {
        const id = await company(run);
        await run("set local role authenticated");
        await as(run, f.admin);
        expect(await fails(run(`update public.organizations set licence_number = '${bad}' where id = '${id}'`))).not.toBe("");
        await run("reset role");
        expect((await run(`select licence_number from public.organizations where id = '${id}'`))[0].licence_number).toBeNull();
      });
    }
  });
  test("owner-run direct updates are validated by the same rules (APL-/CLC-/length/charset/digit)", async () => {
    for (const [bad, why] of [["APL-12345", "INVALID_LICENCE"], ["CLC-9", "INVALID_LICENCE"], ["ab", "5 to 30"], ["!!!###$$$ 99", "letters, digits"], ["A".repeat(199) + "1", "5 to 30"], ["NODIGITS", "at least one digit"]] as const) {
      await withRole("postgres", null, async (run) => {
        const id = await company(run);
        expect(await fails(run(`update public.organizations set licence_number = '${bad}' where id = '${id}'`))).toContain(why);
      });
    }
  });
  test("inserting a company with an invalid licence is refused too", async () => {
    await withRole("postgres", null, async (run) => {
      expect(await fails(run(`insert into public.organizations (name, licence_number) values ('Bad Licence Co', 'APL-1')`))).toContain("INVALID_LICENCE");
    });
  });
  test("a set licence: no direct change by a client role, no change without a reason, change WITH a reason works and is recorded and audited", async () => {
    await withRole("postgres", null, async (run) => {
      const id = await company(run, "OLD 1001/20");
      // direct change by an admin session
      await run("set local role authenticated");
      await as(run, f.admin);
      expect(await fails(run(`update public.organizations set licence_number = 'NEW 2002/20' where id = '${id}'`))).toContain("LICENCE_VIA_FUNCTION_ONLY");
      expect(await fails(run(`update public.organizations set licence_number = null where id = '${id}'`))).not.toBe("");
      // forging the bookkeeping columns without changing the licence does nothing
      await run(`update public.organizations set licence_change_reason = 'forged', licence_changed_by = null where id = '${id}'`);
      await run("reset role");
      expect((await run(`select licence_number, licence_change_reason from public.organizations where id = '${id}'`))[0]).toEqual({ licence_number: "OLD 1001/20", licence_change_reason: "initial entry" });
      // owner-run change without a reason
      expect(await fails(run(`update public.organizations set licence_number = 'NEW 2002/20' where id = '${id}'`))).toContain("REASON_REQUIRED");
      // registrar function: no reason, short reason, then a real reason
      await registrar(run);
      await run("set local role authenticated");
      await as(run, REG);
      expect(await fails(run(`select public.mg_set_company_licence('${id}', 'NEW 2002/20')`))).toContain("REASON_REQUIRED");
      expect(await fails(run(`select public.mg_set_company_licence('${id}', 'NEW 2002/20', 'typo')`))).toContain("REASON_REQUIRED");
      await run(`select public.mg_set_company_licence('${id}', 'NEW 2002/20', 'Ministry corrected the number after a re-issue')`);
      await run("reset role");
      const row = (await run(`select licence_number, licence_change_reason, licence_changed_by, licence_changed_at is not null as stamped from public.organizations where id = '${id}'`))[0];
      expect(row).toMatchObject({ licence_number: "NEW 2002/20", licence_change_reason: "Ministry corrected the number after a re-issue", licence_changed_by: REG, stamped: true });
      const audit = await run(`select details from public.audit_log where entity_type = 'organizations' and entity_id = '${id}' and action = 'organizations.update'`);
      const text = JSON.stringify(audit.map((r) => r.details));
      expect(text).toContain("NEW 2002/20"); // the new number
      expect(text).toContain("OLD 1001/20"); // the old number
      expect(text).toContain("re-issue"); // the reason
    });
  });
  test("clearing a licence to NULL is blocked for everyone (it would re-enter the grace period)", async () => {
    await withRole("postgres", null, async (run) => {
      const id = await company(run, "CLR 1001/20");
      expect(await fails(run(`update public.organizations set licence_number = null where id = '${id}'`))).toContain("LICENCE_CLEAR_BLOCKED");
      expect(await fails(run(`update public.organizations set licence_number = '' where id = '${id}'`))).not.toBe("");
      await registrar(run);
      await run("set local role authenticated");
      await as(run, REG);
      expect(await fails(run(`select public.mg_set_company_licence('${id}', null, 'clearing it')`))).toContain("LICENCE_REQUIRED");
      expect(await fails(run(`select public.mg_set_company_licence('${id}', '', 'clearing it')`))).toContain("LICENCE_REQUIRED");
    });
  });
});

describe("F-9 companies auto-created by owner-run site inserts are never approved", () => {
  test("an unknown operator name creates a PENDING, flagged company with no licence, visible on the registrar to-do list", async () => {
    await withRole("postgres", null, async (run) => {
      await insertSite(run, "Nimba", "Brand new", undefined, "Brand New Quarry Ltd");
      const org = (await run("select status, status_reason, licence_number from public.organizations where name = 'Brand New Quarry Ltd'"))[0];
      expect(org.status).toBe("pending_review");
      expect(String(org.status_reason)).toContain("registrar must review");
      expect(org.licence_number).toBeNull();
      const todo = await run("select name from public.organizations where licence_number is null and status <> 'deactivated' and name = 'Brand New Quarry Ltd'");
      expect(todo).toHaveLength(1);
    });
  });
  test("a signed-in session still gets UNKNOWN_COMPANY", async () => {
    await withRole("postgres", null, async (run) => {
      await as(run, f.admin);
      expect(await fails(insertSite(run, "Nimba", "Nope", undefined, "Never Registered Ltd"))).toContain("UNKNOWN_COMPANY");
    });
  });
  test("the explicit seed path (mg.seed_mode) keeps owner-run demo seeds approved, and says so", async () => {
    await withRole("postgres", null, async (run) => {
      await run("select set_config('mg.seed_mode', 'on', true)");
      await insertSite(run, "Nimba", "Demo", undefined, "Demo Seed Company");
      const org = (await run("select status, status_reason from public.organizations where name = 'Demo Seed Company'"))[0];
      expect(org.status).toBe("approved");
      expect(String(org.status_reason)).toContain("seed");
    });
  });
});

describe("G-2 / G-3 grace setting: clear errors, audited", () => {
  const KEY = "licence_grace_until_for_site_requests";
  test("G-2: an impossible or badly written date is refused at write time with a clear message; valid and blank are accepted", async () => {
    for (const bad of ["2027-13-45", "2027-02-30", "2027-1-5", "next month", "31/01/2027"]) {
      await withRole("postgres", null, async (run) => {
        const e = await fails(run(`update public.platform_settings set value = '${bad}' where key = '${KEY}'`));
        expect(e).toContain("INVALID_SETTING");
        expect(e).toContain("YYYY-MM-DD");
        expect(e).not.toContain("out of range");
      });
    }
    await withRole("postgres", null, async (run) => {
      await run(`update public.platform_settings set value = '2027-01-31' where key = '${KEY}'`);
      expect((await run(`select value from public.platform_settings where key = '${KEY}'`))[0].value).toBe("2027-01-31");
      await run(`update public.platform_settings set value = '   ' where key = '${KEY}'`);
      expect((await run(`select value from public.platform_settings where key = '${KEY}'`))[0].value).toBeNull();
    });
  });
  test("G-2: a tampered value reads as OFF with no raw database error, and the site-request message says so", async () => {
    await withRole("postgres", null, async (run) => {
      await run("alter table public.platform_settings disable trigger platform_settings_guard");
      await run(`update public.platform_settings set value = '2027-13-45' where key = '${KEY}'`);
      const orgId = (await run("insert into public.organizations (name, status) values ('Tamper Probe Co', 'approved') returning id"))[0].id as string;
      const uid = "aaaaaaaa-0000-4000-8000-0000000000e3";
      await run(`insert into auth.users (id, email) values ('${uid}','tamper@x.test')`);
      await run(`update public.profiles set role = 'operator', profile_complete = true where id = '${uid}'`);
      await run(`insert into public.organization_members (organization_id, user_id, org_role, status) values ('${orgId}', '${uid}', 'company_admin', 'active')`);
      await run("set local role authenticated");
      await as(run, uid);
      expect((await run("select public.mg_licence_grace_until() as d"))[0].d).toBeNull(); // no raw "date/time field value out of range"
      const e = await fails(run(`select public.mg_request_site('${orgId}', 'Tamper Pit', 'Nimba', null, null, null, null, null, null)`));
      expect(e).toContain("LICENCE_REQUIRED");
      expect(e).toContain("unusable date");
      expect(e).not.toContain("out of range");
    });
  });
  test("G-3: every change is audited with who, when, before and after", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`update public.platform_settings set value = '2027-02-28' where key = '${KEY}'`); // owner-run
      await as(run, f.admin);
      await run(`update public.platform_settings set value = null where key = '${KEY}'`); // a signed-in admin session
      const rows = await run(`select actor_label, summary, details from public.audit_log where entity_type = 'platform_settings' and entity_id = '${KEY}'`);
      const ownerRun = rows.find((r) => String(r.summary).includes("to 2027-02-28"));
      const signedInAdmin = rows.find((r) => String(r.summary).includes("to NULL (off)"));
      expect(ownerRun).toBeTruthy();
      expect(signedInAdmin).toBeTruthy();
      expect(String(ownerRun!.actor_label)).toContain("database:"); // who: the database user, no signed-in profile
      expect(String(signedInAdmin!.actor_label)).not.toContain("database:"); // who: the signed-in admin's own label
      expect(JSON.stringify(signedInAdmin!.details)).toContain("2027-02-28"); // before
      expect(JSON.stringify(signedInAdmin!.details)).toContain('"after":null');
      expect((await run(`select updated_at is not null as stamped from public.platform_settings where key = '${KEY}'`))[0].stamped).toBe(true);
    });
  });
});
