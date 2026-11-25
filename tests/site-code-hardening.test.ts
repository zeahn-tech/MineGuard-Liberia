// ---------------------------------------------------------------------------
// Migration 0065 — database-allocated site codes, immutable codes, official counties, company licence numbers and
// duplicate-company rules. Every case rolls back (withRole), except the replay in beforeAll.
//
// PGlite is a single connection, so "50 parallel registrations" here proves the allocator has no gaps/duplicates when
// 50 requests are in flight, but cannot prove row-lock behaviour across sessions. That is proved against REAL Postgres
// in tests/site-code-concurrency.pg.test.ts (needs SITE_CODE_PG_URL; see the header there).
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";
import { COUNTY_CODE_PREFIXES, SITE_CODE_PATTERN } from "../src/lib/site-codes";
import { COUNTIES } from "../src/lib/counties";
import { licenceFormatRecognised, licenceProblem, normaliseLicence } from "../src/lib/licence";

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
const signedIn = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);

const SITE = (name: string, county: string, code?: string) =>
  `insert into public.sites (${code ? "code, " : ""}name, operator_name, county, created_by)
   values (${code ? `'${code}', ` : ""}'${name}', 'AgriLib Mining', '${county}', '${f.admin}') returning code`;

describe("site codes are allocated by the database", () => {
  test("sequential per county, independent between counties, format MGL-<prefix>-<4 digits>", async () => {
    await withRole("postgres", null, async (run) => {
      await run("delete from public.site_code_counters");
      await signedIn(run, f.admin);
      const a = (await run(SITE("S1", "Nimba")))[0].code;
      const b = (await run(SITE("S2", "Nimba")))[0].code;
      const c = (await run(SITE("S3", "Lofa")))[0].code;
      expect([a, b, c]).toEqual(["MGL-NIMBA-0001", "MGL-NIMBA-0002", "MGL-LOFA-0001"]);
      expect(a).toMatch(SITE_CODE_PATTERN);
    });
  });

  test("a client-supplied code is ignored for a signed-in session", async () => {
    await withRole("postgres", null, async (run) => {
      await run("delete from public.site_code_counters");
      await signedIn(run, f.admin);
      const code = (await run(SITE("Forger", "Margibi", "MGL-MARGIB-0999")))[0].code;
      expect(code).toBe("MGL-MARGIB-0001");
    });
  });

  test("50 registrations in one county in flight at once: no duplicates, no errors, no gaps", async () => {
    await withRole("postgres", null, async (run) => {
      await run("delete from public.site_code_counters");
      await signedIn(run, f.admin);
      const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => run(SITE(`P${i}`, "Grand Kru"))));
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
      const codes = results.map((r) => (r as PromiseFulfilledResult<{ code: string }[]>).value[0].code);
      expect(new Set(codes).size).toBe(50);
      expect([...codes].sort()[0]).toBe("MGL-GRANDK-0001");
      expect([...codes].sort()[49]).toBe("MGL-GRANDK-0050");
    });
  });

  test("backward compatible: counters start from the current maximum; unusual existing codes are left alone", async () => {
    await withRole("postgres", null, async (run) => {
      await run("delete from public.site_code_counters");
      // legacy shapes already in the registry: a gap, a non-MGL code, and a hand-made prefix
      await run(SITE("L1", "Nimba", "MGL-NIMBA-0007"));
      await run(SITE("L2", "Nimba", "MGL-NIMBA-0003"));
      await run(SITE("L3", "Maryland", "MGL-MARYLA-0001"));
      await run("alter table public.sites disable trigger sites_code_guard");
      await run(SITE("Odd", "Nimba", "LB-ODD-1"));
      await run("alter table public.sites enable trigger sites_code_guard");
      await run("delete from public.site_code_counters");
      // re-initialise exactly as the migration does
      await run(`insert into public.site_code_counters (prefix, last_number)
        select m[1], max(m[2]::integer) from (select regexp_match(code, '^MGL-([A-Z]+)-([0-9]{1,9})$') as m from public.sites) s
        where m is not null group by m[1]`);
      await signedIn(run, f.admin);
      expect((await run(SITE("N", "Nimba")))[0].code).toBe("MGL-NIMBA-0008");
      expect((await run(SITE("B", "Maryland")))[0].code).toBe("MGL-MARYLA-0002");
      expect((await run("select count(*)::int as n from public.sites where code = 'LB-ODD-1'"))[0].n).toBe(1);
    });
  });

  test("owner-run loads may supply a well-formed code (the counter moves past it) but not a malformed one", async () => {
    await withRole("postgres", null, async (run) => {
      await run("delete from public.site_code_counters");
      await run(SITE("Loaded", "Sinoe", "MGL-SINOE-0040"));
      expect((await run("select last_number from public.site_code_counters where prefix = 'SINOE'"))[0].last_number).toBe(40);
      await signedIn(run, f.admin);
      expect((await run(SITE("Next", "Sinoe")))[0].code).toBe("MGL-SINOE-0041");
    });
    await withRole("postgres", null, async (run) => {
      expect(await fails(run(SITE("Bad", "Sinoe", "LB-BOM-001")))).toContain("INVALID_CODE_FORMAT");
    });
  });

  test("a code that already exists is never handed out again", async () => {
    await withRole("postgres", null, async (run) => {
      await run("delete from public.site_code_counters");
      await run("alter table public.sites disable trigger sites_code_guard");
      await run(SITE("Squatter", "Lofa", "MGL-LOFA-0001")); // beyond the (empty) counter
      await run("alter table public.sites enable trigger sites_code_guard");
      await signedIn(run, f.admin);
      expect((await run(SITE("Real", "Lofa")))[0].code).toBe("MGL-LOFA-0002");
    });
  });
});

describe("sites.code is immutable", () => {
  test("rejected for any update, including with county or operator changes — and other edits still work", async () => {
    await withRole("postgres", null, async (run) => {
      await signedIn(run, f.admin);
      const row = (await run(`insert into public.sites (name, operator_name, county, created_by) values ('Imm', 'AgriLib Mining', 'Nimba', '${f.admin}') returning id, code`))[0];
      expect(await fails(run(`update public.sites set code = 'MGL-NIMBA-9999' where id = '${row.id}'`))).toContain("CODE_IMMUTABLE");
      expect(await fails(run(`update public.sites set code = 'MGL-LOFA-0001', county = 'Lofa' where id = '${row.id}'`))).toContain("CODE_IMMUTABLE");
      expect(await fails(run(`update public.sites set code = 'X', operator_name = 'OreCo Liberia' where id = '${row.id}'`))).toContain("CODE_IMMUTABLE");
    });
    await withRole("postgres", null, async (run) => {
      await signedIn(run, f.admin);
      const row = (await run(`insert into public.sites (name, operator_name, county, created_by) values ('Imm2', 'AgriLib Mining', 'Nimba', '${f.admin}') returning id, code`))[0];
      await run(`update public.sites set county = 'Lofa', operator_name = 'OreCo Liberia', name = 'Renamed' where id = '${row.id}'`);
      const after = (await run(`select code, county from public.sites where id = '${row.id}'`))[0];
      expect(after).toEqual({ code: row.code, county: "Lofa" }); // county moves, the code never does
    });
  });
});

describe("county validation", () => {
  test("the database table matches the app's frozen prefix mapping exactly", async () => {
    await withRole("postgres", null, async (run) => {
      const rows = await run("select county, prefix from public.county_codes order by county");
      expect(Object.fromEntries(rows.map((r) => [r.county, r.prefix]))).toEqual(COUNTY_CODE_PREFIXES);
      expect(rows.map((r) => r.county).sort()).toEqual([...COUNTIES].sort());
      // and equal to the legacy "first six letters" rule, so every existing code stays valid
      for (const [county, prefix] of Object.entries(COUNTY_CODE_PREFIXES)) {
        expect(county.replace(/[^A-Za-z]/g, "").slice(0, 6).toUpperCase()).toBe(prefix);
      }
    });
  });

  test("spelling variants of an official county resolve; anything else is refused", async () => {
    await withRole("postgres", null, async (run) => {
      await signedIn(run, f.admin);
      for (const [typed, prefix] of [["river cess", "RIVERC"], ["Rivercess", "RIVERC"], [" GRAND-GEDEH ", "GRANDG"]] as const) {
        expect((await run(SITE("V", typed)))[0].code).toMatch(new RegExp(`^MGL-${prefix}-`));
      }
    });
    for (const bad of ["Narnia", "", "Nimb", "Montserrado Highlands"]) {
      await withRole("postgres", null, async (run) => {
        await signedIn(run, f.admin);
        expect(await fails(run(SITE("Bad", bad)))).toContain("INVALID_COUNTY");
      });
    }
  });

  test("a county change must stay official, but legacy rows with an odd county can still be edited otherwise", async () => {
    await withRole("postgres", null, async (run) => {
      await run("alter table public.sites disable trigger sites_code_guard");
      const id = (await run(`insert into public.sites (code, name, operator_name, county, created_by) values ('MGL-OLD-0001','Legacy','AgriLib Mining','Old Spelling','${f.admin}') returning id`))[0].id;
      await run("alter table public.sites enable trigger sites_code_guard");
      await signedIn(run, f.admin);
      await run(`update public.sites set name = 'Legacy renamed' where id = '${id}'`);
      expect(await fails(run(`update public.sites set county = 'Nowhere' where id = '${id}'`))).toContain("INVALID_COUNTY");
      await run(`update public.sites set county = 'Bong' where id = '${id}'`);
    });
  });
});

describe("licence number rules", () => {
  const ok = ["MBL 1008/14", "CBL 2472/14", "MQL 1938/14", "MEL 2111/16", "MEL 7003519", "ab-12345"];
  const bad: [string, string][] = [
    ["", "LICENCE_REQUIRED"],
    ["APL-12345", "cadastre application"],
    ["apl - 99", "cadastre application"],
    ["CLC-0042", "category code"],
    ["1234", "5 to 30"],
    ["A".repeat(31) + "1", "5 to 30"],
    ["ABCDEFG", "at least one digit"],
    ["MEL 21*1/16", "letters, digits"],
  ];
  test("hard validation (database and the app's mirror agree)", async () => {
    await withRole("postgres", null, async (run) => {
      for (const v of ok) {
        expect(await fails(run(`select public.mg_validate_licence('${v}')`))).toBe("");
        expect(licenceProblem(v)).toBeUndefined();
      }
      for (const [v, why] of bad) {
        expect(await fails(run(`select public.mg_validate_licence('${v}')`))).toContain(why.split(" ")[0] === "" ? "" : why.includes("5 to 30") || why.includes("digit") || why.includes("letters") || why.includes("cadastre") || why.includes("category") ? why : why);
        expect(licenceProblem(v)).toBeDefined();
      }
    });
  });
  test("soft format check recognises the two known shapes only", async () => {
    await withRole("postgres", null, async (run) => {
      for (const v of ["MBL 1008/14", "CBL 2472/14", "MQL 1938/14", "MEL 2111/16", "MEL 7003519"]) {
        expect((await run(`select public.mg_licence_format_recognised('${v}') as r`))[0].r).toBe(true);
        expect(licenceFormatRecognised(v)).toBe(true);
      }
      for (const v of ["XYZ-123", "MEL 123456", "MBL 1008/1"]) {
        expect((await run(`select public.mg_licence_format_recognised('${v}') as r`))[0].r).toBe(false);
        expect(licenceFormatRecognised(v)).toBe(false);
      }
      expect(normaliseLicence(" mbl 1008-/14 ")).toBe("MBL1008/14");
    });
  });
});

describe("duplicate companies", () => {
  const REG = "aaaaaaaa-0000-4000-8000-000000000191";
  async function registrar(run: Runner) {
    await run(`insert into auth.users (id, email) values ('${REG}','reg62@ministry.test') on conflict do nothing`);
    await run(`update public.profiles set role = 'registrar', scope = 'national', profile_complete = true where id = '${REG}'`);
    await run("set local role authenticated");
    await signedIn(run, REG);
  }
  const reg = (run: Runner, name: string, lic: string | null) =>
    run(`select public.mg_register_company('${name}', ${lic === null ? "null" : `'${lic}'`}) as id`);

  test("a licence number is mandatory for a new company; the old one-argument call gets a clear message", async () => {
    await withRole("postgres", null, async (run) => {
      await registrar(run);
      expect(await fails(reg(run, "No Licence Co", null))).toContain("LICENCE_REQUIRED");
      expect(await fails(run(`select public.mg_register_company('Old Client Co')`))).toContain("LICENCE_REQUIRED");
      expect(await fails(reg(run, "Cadastre Co", "APL-777"))).toContain("INVALID_LICENCE");
    });
  });

  test("normalised licence uniqueness: case, spaces and hyphens are ignored; '/' is kept", async () => {
    await withRole("postgres", null, async (run) => {
      await registrar(run);
      await reg(run, "First Mining", "MBL 1008/14");
      expect(await fails(reg(run, "Second Mining", "mbl-1008/14"))).toContain("DUPLICATE_LICENCE");
      await reg(run, "Third Mining", "MBL 100814"); // no "/" — a different number
    });
  });

  test("normalised name uniqueness across pending, approved and suspended; only deactivated companies are excluded", async () => {
    await withRole("postgres", null, async (run) => {
      await registrar(run);
      const id = (await reg(run, "Atlas Gold Ltd", "TST2001/20"))[0].id as string;
      expect(await fails(reg(run, "ATLAS  GOLD, Ltd.", "TST2002/20"))).toContain("DUPLICATE_ORGANIZATION");
      await run(`select public.mg_set_company_status('${id}', 'suspended', 'under review')`);
      expect(await fails(reg(run, "Atlas Gold Ltd", "TST2003/20"))).toContain("DUPLICATE_ORGANIZATION"); // suspended still counts
      await run(`select public.mg_set_company_status('${id}', 'deactivated', 'closed down')`);
      await reg(run, "Atlas Gold Ltd", "TST2004/20"); // a deactivated entry no longer blocks
      expect(await fails(run(`select public.mg_set_company_status('${id}', 'approved', 'back')`))).toContain("DUPLICATE_ORGANIZATION");
    });
  });

  test("the database also enforces it without the RPC (unique indexes), so a race cannot slip through", async () => {
    await withRole("postgres", null, async (run) => {
      const idx = await run(`select indexname from pg_indexes where tablename = 'organizations' and indexname in ('organizations_licence_norm_uq','organizations_name_norm_uq')`);
      expect(idx.map((r) => r.indexname).sort()).toEqual(["organizations_licence_norm_uq", "organizations_name_norm_uq"]);
      await run(`insert into public.organizations (name, licence_number) values ('Direct One', 'DIR 1001/20')`);
      expect(await fails(run(`insert into public.organizations (name, licence_number) values ('Direct Two', 'dir1001/20')`))).toBeTruthy();
      expect(await fails(run(`insert into public.organizations (name) values ('direct one')`))).toBeTruthy();
    });
  });

  test("the registrar preview flags same-licence, same-name and similar-name matches and never blocks", async () => {
    await withRole("postgres", null, async (run) => {
      await registrar(run);
      await reg(run, "Liberty Mining Corporation", "MEL 2111/16");
      const r = async (n: string, l: string) => JSON.parse(JSON.stringify((await run(`select public.mg_company_registration_check('${n}', '${l}') as r`))[0].r));
      expect((await r("Other Name", "MEL 2111/16")).duplicates[0].reason).toBe("same_licence");
      expect((await r("liberty mining corporation", "")).duplicates[0].reason).toBe("same_name");
      expect((await r("Liberty Mining", "")).duplicates[0].reason).toBe("similar_name");
      expect((await r("Totally Different", "MEL 9999/16")).duplicates).toEqual([]);
      const odd = await r("Totally Different", "XYZ-12345");
      expect(odd.formatRecognised).toBe(false);
      expect((await r("Totally Different", "APL-1")).licenceError).toContain("INVALID_LICENCE");
    });
  });

  const LEGACY_ADMIN = "aaaaaaaa-0000-4000-8000-000000000192";
  /** A company that pre-dates 0065: approved, no licence number (the fixture companies were registered with one). */
  async function legacyCompany(run: Runner) {
    return (await run(`insert into public.organizations (name, status) values ('Legacy Mining Co', 'approved') returning id`))[0].id as string;
  }

  test("existing companies keep NULL; the registrar can add a number; duplicates are refused", async () => {
    await withRole("postgres", null, async (run) => {
      const legacy = await legacyCompany(run);
      const other = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id;
      expect((await run(`select licence_number from public.organizations where id = '${legacy}'`))[0].licence_number).toBeNull();
      await registrar(run);
      await run(`select public.mg_set_company_licence('${legacy}', 'MEL 2111/16')`);
      expect(await fails(run(`select public.mg_set_company_licence('${other}', 'mel2111/16')`))).toContain("DUPLICATE_LICENCE");
      expect(await fails(run(`select public.mg_set_company_licence('${other}', 'CLC-5')`))).toContain("INVALID_LICENCE");
    });
  });

  test("a company without a licence number cannot REQUEST a site; with one it can; the county must be official", async () => {
    await withRole("postgres", null, async (run) => {
      const legacy = await legacyCompany(run);
      await run(`insert into auth.users (id, email) values ('${LEGACY_ADMIN}', 'legacy-admin@x.test')`);
      await run(`update public.profiles set role = 'operator', profile_complete = true where id = '${LEGACY_ADMIN}'`);
      await run(`insert into public.organization_members (organization_id, user_id, org_role, status) values ('${legacy}', '${LEGACY_ADMIN}', 'company_admin', 'active')`);
      await run("set local role authenticated");
      await signedIn(run, LEGACY_ADMIN);
      const req = (county: string) =>
        run(`select public.mg_request_site('${legacy}', 'New Pit', '${county}', null, null, null, null, null, null) as id`);
      expect(await fails(req("Nimba"))).toContain("LICENCE_REQUIRED");
      await run("reset role");
      await run(`update public.organizations set licence_number = 'MEL 2111/16' where id = '${legacy}'`);
      await run("set local role authenticated");
      expect(await fails(req("Atlantis"))).toContain("INVALID_COUNTY");
      expect((await req("Nimba"))[0].id).toBeTruthy();
    });
  });
});

describe("old app (client-computed codes, free-text county) against the new database", () => {
  // The pre-0065 app inserts { code: nextSiteCodeFrom(county, allCodes), name, operator_name, county, … } as a signed-in user.
  test("an explicit client code is overridden: a stale/duplicate/malformed one never collides and never errors", async () => {
    await withRole("postgres", null, async (run) => {
      await run("delete from public.site_code_counters");
      await signedIn(run, f.admin);
      const first = (await run(SITE("Old 1", "Nimba", "MGL-NIMBA-0001")))[0].code;
      const stale = (await run(SITE("Old 2", "Nimba", "MGL-NIMBA-0001")))[0].code; // old app's stale list: same code again
      const junk = (await run(SITE("Old 3", "Nimba", "LB-BOM-001")))[0].code;
      expect([first, stale, junk]).toEqual(["MGL-NIMBA-0001", "MGL-NIMBA-0002", "MGL-NIMBA-0003"]);
    });
  });

  test("site-request approval (old app = the same signed-in insert, then mg_decide_site_request) is unaffected", async () => {
    await withRole("postgres", null, async (run) => {
      await signedIn(run, f.admin);
      const code = (await run(SITE("Approved site", "Grand Gedeh", "MGL-GRANDG-0001")))[0].code;
      expect(code).toMatch(SITE_CODE_PATTERN);
    });
  });

  test("free-text county: case/spacing variants pass; a real mistake fails with SQLSTATE 22023 and the INVALID_COUNTY token", async () => {
    await withRole("postgres", null, async (run) => {
      await signedIn(run, f.admin);
      for (const ok of ["nimba", "NIMBA ", "grand cape mount", "Grand  Gedeh"]) await run(SITE("Free text", ok));
    });
    for (const bad of ["Grand Cape Mt", "Bomi County", "Monrovia", ""]) {
      await withRole("postgres", null, async (run) => {
        await signedIn(run, f.admin);
        try {
          await run(SITE("Free text bad", bad));
          throw new Error("accepted " + bad);
        } catch (e) {
          expect(String((e as Error).message)).toContain("INVALID_COUNTY");
          expect((e as { code?: string }).code).toBe("22023");
        }
      });
    }
  });
});
