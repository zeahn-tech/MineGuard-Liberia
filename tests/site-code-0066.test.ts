// ---------------------------------------------------------------------------
// Migration 0066 — county text containing a digit is refused (audit finding N-1), plus the N-3 probe.
//   N-1  "Bo1mi" is refused (INVALID_COUNTY, SQLSTATE 22023) everywhere a county is resolved; punctuation/spacing variants stay valid;
//        legacy rows are never rewritten; the 9999 -> 10000 boundary is unchanged; the grants and function attributes are unchanged;
//        0066 is idempotent and changes no data; the rollback script restores the 0065 definitions verbatim.
//   N-3  mg_decide_site_request has no licence or grace check: a request made during the grace period can still be decided after it ends.
// The shared in-memory database is rolled back after every test (withRole). The idempotency / rollback block uses its own private
// in-memory PGlite (no URL, no path: it cannot reach any real database). Real parallelism is in site-code-concurrency.pg.test.ts.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, MIGRATIONS, PLATFORM_STUB, type Runner } from "./helpers/pglite-db";

const ROOT = join(import.meta.dir, "..");
const M0065 = readFileSync(join(ROOT, "supabase", "migrations", "0065_site_code_hardening.sql"), "utf8");
const M0066 = readFileSync(join(ROOT, "supabase", "migrations", "0066_county_reject_digits.sql"), "utf8");
const ROLLBACK_0066 = readFileSync(join(ROOT, "supabase", "maintenance", "rollback_0066_county_reject_digits.sql"), "utf8");

let f: Awaited<ReturnType<typeof getFixture>>;
beforeAll(async () => {
  f = await getFixture();
  await getDb();
});

async function failure(p: Promise<unknown>): Promise<{ message: string; code: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { code?: string };
    return { message: String(err.message), code: String(err.code ?? "") };
  }
  return { message: "", code: "" };
}
const as = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
const insertSite = (run: Runner, county: string, name = "S", code?: string, operator = "AgriLib Mining") =>
  run(`insert into public.sites (${code ? "code, " : ""}name, operator_name, county, created_by)
       values (${code ? `'${code}', ` : ""}'${name}', '${operator}', '${county}', '${f.admin}') returning code, county`);
const canonical = async (run: Runner, county: string) =>
  (await run(`select public.mg_county_canonical('${county.replace(/'/g, "''")}') as c`))[0].c as string;
const prefix = async (run: Runner, county: string) =>
  (await run(`select public.mg_county_prefix('${county.replace(/'/g, "''")}') as p`))[0].p as string;

const DIGIT_COUNTIES = ["Bo1mi", "Bomi2", "1Bomi", "Nimba3", "Grand Bassa 2", "Sin0e", "L0fa", "Bo-1-mi", "Bomi 2024", "Bo1mi!!"];
const GOOD: [string, string, string][] = [
  ["bomi", "Bomi", "BOMI"],
  ["Bo-mi!!", "Bomi", "BOMI"],
  [" GRAND   bassa", "Grand Bassa", "GRANDB"],
  ["river-cess", "River Cess", "RIVERC"],
  ["  Grand_Cape.Mount ", "Grand Cape Mount", "GRANDC"],
];

describe("N-1 county text with a digit is refused", () => {
  test("mg_county_canonical and mg_county_prefix: every digit variant raises INVALID_COUNTY with SQLSTATE 22023", async () => {
    await withRole("postgres", null, async (run) => {
      for (const bad of DIGIT_COUNTIES) {
        for (const fn of [canonical, prefix]) {
          const e = await failure(fn(run, bad));
          expect(e.message, `${fn === canonical ? "canonical" : "prefix"}(${bad})`).toContain("INVALID_COUNTY");
          expect(e.code, `${bad}`).toBe("22023");
        }
      }
    });
  });

  test("spaces, hyphens and other punctuation are still ignored; the canonical name and prefix come back", async () => {
    await withRole("postgres", null, async (run) => {
      for (const [typed, name, pre] of GOOD) {
        expect(await canonical(run, typed)).toBe(name);
        expect(await prefix(run, typed)).toBe(pre);
      }
    });
  });

  test("a non-county, an empty string and NULL are still refused (unchanged)", async () => {
    await withRole("postgres", null, async (run) => {
      for (const bad of ["Atlantis", "Grand Cape Mt", "", "   "]) expect((await failure(canonical(run, bad))).code).toBe("22023");
      expect((await failure(run("select public.mg_county_canonical(null)"))).code).toBe("22023");
      expect((await failure(run("select public.mg_county_prefix(null)"))).code).toBe("22023");
    });
  });

  test("sites insert (signed-in): Bo1mi is refused and no counter moves; bomi / Bo-mi!! / ' GRAND   bassa' are stored canonically", async () => {
    await withRole("postgres", null, async (run) => {
      await as(run, f.admin);
      const before = await run("select prefix, last_number from public.site_code_counters order by prefix");
      const sitesBefore = (await run("select count(*)::int as n from public.sites"))[0].n;
      const e = await failure(insertSite(run, "Bo1mi"));
      expect(e.message).toContain("INVALID_COUNTY");
      expect(e.code).toBe("22023");
      expect(await run("select prefix, last_number from public.site_code_counters order by prefix")).toEqual(before);
      expect((await run("select count(*)::int as n from public.sites"))[0].n).toBe(sitesBefore);
      const got: [string, string][] = [];
      for (const [typed] of GOOD.slice(0, 3)) {
        const r = (await insertSite(run, typed))[0];
        got.push([String(r.county), String(r.code).replace(/-\d+$/, "")]);
      }
      expect(got).toEqual([["Bomi", "MGL-BOMI"], ["Bomi", "MGL-BOMI"], ["Grand Bassa", "MGL-GRANDB"]]);
    });
  });

  test("sites insert (owner-run, with and without a supplied code): a digit county is refused too", async () => {
    await withRole("postgres", null, async (run) => {
      expect((await failure(insertSite(run, "Bo1mi"))).message).toContain("INVALID_COUNTY");
      expect((await failure(insertSite(run, "Bo1mi", "Loaded", "MGL-BOMI-0500"))).message).toContain("INVALID_COUNTY");
    });
  });

  test("a county change with a digit is refused; a clean variant is stored canonically; the code never moves", async () => {
    await withRole("postgres", null, async (run) => {
      await as(run, f.admin);
      const row = (await insertSite(run, "Nimba", "Mover"))[0];
      const e = await failure(run(`update public.sites set county = 'Bo1mi' where code = '${row.code}'`));
      expect(e.message).toContain("INVALID_COUNTY");
      expect(e.code).toBe("22023");
      expect((await run(`select county, code from public.sites where code = '${row.code}'`))[0]).toEqual({ county: "Nimba", code: row.code });
      await run(`update public.sites set county = '  river-cess ' where code = '${row.code}'`);
      expect((await run(`select county, code from public.sites where code = '${row.code}'`))[0]).toEqual({ county: "River Cess", code: row.code });
    });
  });

  test("a company's site request with a digit county is refused; a punctuation variant is stored canonically", async () => {
    await withRole("postgres", null, async (run) => {
      const orgId = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
      await run(`update public.organizations set licence_number = 'CNT 1001/20' where id = '${orgId}' and licence_number is null`);
      const uid = "aaaaaaaa-0000-4000-8000-0000000000f6";
      await run(`insert into auth.users (id, email) values ('${uid}','req-0066@x.test')`);
      await run(`update public.profiles set role = 'operator', profile_complete = true where id = '${uid}'`);
      await run(`insert into public.organization_members (organization_id, user_id, org_role, status) values ('${orgId}', '${uid}', 'company_admin', 'active')`);
      await run("set local role authenticated");
      await as(run, uid);
      const req = (county: string, name: string) =>
        run(`select public.mg_request_site('${orgId}', '${name}', '${county}', null, null, null, null, null, null) as id`);
      const e = await failure(req("Bo1mi", "Digit Pit"));
      expect(e.message).toContain("INVALID_COUNTY");
      expect(e.code).toBe("22023");
      const id = (await req("grand   BASSA", "Canon Pit 66"))[0].id;
      await run("reset role");
      expect((await run(`select county from public.site_registration_requests where id = '${id}'`))[0].county).toBe("Grand Bassa");
    });
  });

  test("legacy rows are never rewritten: an existing site whose county contains a digit keeps working until someone changes that county", async () => {
    await withRole("postgres", null, async (run) => {
      const orgId = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
      await run("set local session_replication_role = replica"); // as a pre-0065 row would have been written: no triggers
      await run(`insert into public.sites (code, name, operator_name, county, created_by, organization_id)
                 values ('MGL-NIMBA-0900', 'Legacy digit county', 'AgriLib Mining', 'Nimba2', '${f.admin}', '${orgId}')`);
      await run("set local session_replication_role = origin");
      await as(run, f.admin);
      await run("update public.sites set name = 'Legacy renamed' where code = 'MGL-NIMBA-0900'");
      await run("update public.sites set county = 'Nimba2' where code = 'MGL-NIMBA-0900'"); // same value: not re-resolved
      expect((await run("select name, county from public.sites where code = 'MGL-NIMBA-0900'"))[0]).toEqual({ name: "Legacy renamed", county: "Nimba2" });
      expect((await failure(run("update public.sites set county = 'Nimba3' where code = 'MGL-NIMBA-0900'"))).message).toContain("INVALID_COUNTY");
      await run("update public.sites set county = 'Nimba' where code = 'MGL-NIMBA-0900'"); // fixing it is allowed
      expect((await run("select county, code from public.sites where code = 'MGL-NIMBA-0900'"))[0]).toEqual({ county: "Nimba", code: "MGL-NIMBA-0900" });
    });
  });

  test("the 9999 -> 10000 boundary still works, and a digit variant of the county does not consume a number", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into public.site_code_counters (prefix, last_number) values ('SINOE', 9998)
                 on conflict (prefix) do update set last_number = excluded.last_number`);
      await as(run, f.admin);
      const codes: string[] = [];
      codes.push((await insertSite(run, "Sinoe", "Edge 1"))[0].code as string);
      expect((await failure(insertSite(run, "Sin0e", "Digit zero"))).message).toContain("INVALID_COUNTY");
      codes.push((await insertSite(run, "sinoe", "Edge 2"))[0].code as string);
      codes.push((await insertSite(run, "Si-noe!", "Edge 3"))[0].code as string);
      expect(codes).toEqual(["MGL-SINOE-9999", "MGL-SINOE-10000", "MGL-SINOE-10001"]);
      expect((await run("select last_number from public.site_code_counters where prefix = 'SINOE'"))[0].last_number).toBe(10001);
    });
  });

  test("signatures, security definer, search_path, volatility and grants are unchanged (internal helpers: no client role can execute them)", async () => {
    await withRole("postgres", null, async (run) => {
      const rows = await run(`select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prorettype::regtype::text as ret,
          p.prosecdef, p.provolatile::text as vol, p.proconfig::text as cfg,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
          exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_grant
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('mg_county_prefix', 'mg_county_canonical') order by 1`);
      expect(rows).toEqual([
        { proname: "mg_county_canonical", args: "p_county text", ret: "text", prosecdef: true, vol: "s", cfg: "{search_path=public}", anon: false, authed: false, public_grant: false },
        { proname: "mg_county_prefix", args: "p_county text", ret: "text", prosecdef: true, vol: "s", cfg: "{search_path=public}", anon: false, authed: false, public_grant: false },
      ]);
    });
  });
});

describe("N-3 the Ministry can still decide a request after the grace period ends", () => {
  const KEY = "licence_grace_until_for_site_requests";
  test("a request made while grace is ON is approved after the grace date has passed; a NEW request is refused at the same moment", async () => {
    await withRole("postgres", null, async (run) => {
      // a legacy company: approved, no licence number (written with triggers off, as a pre-0065 company was)
      await run("set local session_replication_role = replica");
      const orgId = (await run("insert into public.organizations (name, kind, status) values ('Legacy Grace Co', 'operator', 'approved') returning id"))[0].id as string;
      await run("set local session_replication_role = origin");
      expect((await run(`select licence_number from public.organizations where id = '${orgId}'`))[0].licence_number).toBeNull();
      const uid = "aaaaaaaa-0000-4000-8000-0000000000f7";
      await run(`insert into auth.users (id, email) values ('${uid}','grace-0066@x.test')`);
      await run(`update public.profiles set role = 'operator', profile_complete = true where id = '${uid}'`);
      await run(`insert into public.organization_members (organization_id, user_id, org_role, status) values ('${orgId}', '${uid}', 'company_admin', 'active')`);

      // grace ON (tomorrow): the company administrator requests a site
      await run(`update public.platform_settings set value = to_char(current_date + 1, 'YYYY-MM-DD') where key = '${KEY}'`);
      await run("set local role authenticated");
      await as(run, uid);
      const id = (await run(`select public.mg_request_site('${orgId}', 'Grace Pit', 'Bomi', null, null, null, null, null, null) as id`))[0].id as string;
      await run("reset role");

      // the grace period ENDS (yesterday)
      await run(`update public.platform_settings set value = to_char(current_date - 1, 'YYYY-MM-DD') where key = '${KEY}'`);
      await run("set local role authenticated");
      await as(run, uid);
      expect((await failure(run(`select public.mg_request_site('${orgId}', 'Late Pit', 'Bomi', null, null, null, null, null, null)`))).message).toContain("LICENCE_REQUIRED");

      // the Ministry registers the site and approves the earlier request: no licence / grace check stops it
      await as(run, f.admin);
      const site = (await run(`insert into public.sites (name, operator_name, county, created_by) values ('Grace Pit', 'Legacy Grace Co', 'Bomi', '${f.admin}') returning id`))[0].id as string;
      await run(`select public.mg_decide_site_request('${id}', 'approved', null, '${site}')`);
      const q = (await run(`select status, site_id, decided_by from public.site_registration_requests where id = '${id}'`))[0];
      expect(q).toEqual({ status: "approved", site_id: site, decided_by: f.admin });
    });
  });
});

describe("0066 on its own database: idempotent, data-neutral, and the rollback restores 0065 verbatim", () => {
  const USER = "aaaaaaaa-0000-4000-8000-0000000000f8";
  // pg_get_functiondef is canonical, so equal md5 means an identical definition
  const defs = async (db: PGlite) =>
    (await db.query(`select p.proname, md5(pg_get_functiondef(p.oid)) as def from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and p.proname in ('mg_county_prefix', 'mg_county_canonical') order by 1`)).rows;
  const snapshot = async (db: PGlite) => {
    const q = async (sql: string) => (await db.query(sql)).rows as Record<string, unknown>[];
    return {
      counters: await q("select prefix, last_number from public.site_code_counters order by prefix"),
      sites: await q("select id, code, county, name from public.sites order by code"),
      counties: await q("select county, prefix, county_key from public.county_codes order by county"),
      settings: await q("select key, value, updated_at from public.platform_settings order by key"),
      organizations: await q("select id, name, licence_number, status from public.organizations order by id"),
      audit: await q("select count(*)::int as n from public.audit_log"),
      otherFunctions: await q(`select md5(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text)) as m, count(*)::int as n
                                 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in ('mg_county_prefix', 'mg_county_canonical')`),
      triggers: await q("select tgrelid::regclass::text as t, tgname, tgenabled::text as e from pg_trigger where not tgisinternal order by 1, 2"),
    };
  };
  /** the two county function blocks exactly as 0065 wrote them */
  const county0065 = () => {
    const m = M0065.match(/create or replace function public\.mg_county_prefix[\s\S]*?\$mg\$;\s*[\s\S]*?create or replace function public\.mg_county_canonical[\s\S]*?\$mg\$;/);
    if (!m) throw new Error("could not find the 0065 county functions");
    return m[0];
  };

  test("apply twice: no error, no data change; rollback_0066 gives back the exact 0065 definitions and Bo1mi is accepted again; re-applying 0066 restores the refusal", async () => {
    const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
    await db.exec(PLATFORM_STUB);
    for (const m of MIGRATIONS.filter((x) => x < "0066")) await db.exec(readFileSync(join(ROOT, "supabase", "migrations", m), "utf8")); // 0001..0065 only

    await db.exec(`insert into auth.users (id, email) values ('${USER}', 'idem66@x.test')`);
    await db.exec(`insert into public.organizations (name, status, licence_number) values ('Idem66 Co', 'approved', 'IDS 1001/20')`);
    await db.exec(`select set_config('request.jwt.claims', '{"sub":"${USER}","role":"authenticated"}', false)`);
    for (const c of ["Nimba", "Nimba", "bomi", " GRAND   bassa"]) {
      await db.exec(`insert into public.sites (name, operator_name, county, created_by) values ('S', 'Idem66 Co', '${c}', '${USER}')`);
    }
    await db.exec(`select set_config('request.jwt.claims', '', false)`);
    await db.exec(`update public.platform_settings set value = '2027-02-14' where key = 'licence_grace_until_for_site_requests'`);
    await db.exec(`update public.site_code_counters set last_number = 9998 where prefix = 'SINOE'`);
    const state0065 = await defs(db);
    const before = await snapshot(db);

    await db.exec(M0066); // 1st apply
    const state0066 = await defs(db);
    expect(state0066).not.toEqual(state0065); // the two functions really did change
    const afterOne = await snapshot(db);
    await db.exec(M0066); // 2nd apply (idempotent)
    expect(await defs(db)).toEqual(state0066);
    expect(await snapshot(db)).toEqual(afterOne);
    expect(afterOne).toEqual(before); // existing codes, counters, grace setting, companies, audit rows, every other function and trigger: untouched
    expect(afterOne.settings.map((s) => s.value)).toEqual(["2027-02-14"]);
    await expect(db.query("select public.mg_county_canonical('Bo1mi')")).rejects.toThrow(/INVALID_COUNTY/);

    // rollback restores the 0065 definitions verbatim (compared against the 0065 file's own text)
    await db.exec(ROLLBACK_0066);
    expect(await defs(db)).toEqual(state0065);
    await db.exec("begin");
    await db.exec(county0065()); // re-create from the 0065 text itself: must equal what the rollback produced
    expect(await defs(db)).toEqual(state0065);
    await db.exec("rollback");
    expect((await db.query("select public.mg_county_canonical('Bo1mi') as c")).rows[0]).toEqual({ c: "Bomi" }); // 0065 behaviour is back
    expect(await snapshot(db)).toEqual(before); // the rollback touches no data
    await db.exec(ROLLBACK_0066); // idempotent too
    expect(await defs(db)).toEqual(state0065);

    await db.exec(M0066); // forward again
    expect(await defs(db)).toEqual(state0066);
    await expect(db.query("select public.mg_county_canonical('Bo1mi')")).rejects.toThrow(/INVALID_COUNTY/);
    await db.close();
  }, 240_000); // boots a private database and replays 65 migrations
});
