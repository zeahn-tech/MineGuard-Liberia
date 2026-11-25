// Migration 0062 is idempotent: applying it again (once or twice) on a database that already has it must not error,
// duplicate counters, lower a counter, change any issued site code, or alter the county table.
// Runs on its OWN in-memory PGlite (no URL, no path: it cannot reach any real database), so the committed re-applies
// cannot disturb the shared fixture database used by other test files.
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, PLATFORM_STUB } from "./helpers/pglite-db";

const DIR = join(import.meta.dir, "..", "supabase", "migrations");
const M0062 = readFileSync(join(DIR, "0062_site_code_hardening.sql"), "utf8");
const USER = "aaaaaaaa-0000-4000-8000-0000000000d1";

async function snapshot(db: PGlite) {
  const q = async (sql: string) => (await db.query(sql)).rows as Record<string, unknown>[];
  return {
    counters: await q("select prefix, last_number from public.site_code_counters order by prefix"),
    codes: await q("select id, code, county from public.sites order by code"),
    counties: await q("select county, prefix, county_key from public.county_codes order by county"),
    triggers: await q("select tgname from pg_trigger where tgname in ('sites_code_guard','organizations_identity_guard') order by 1"),
    indexes: await q("select indexname from pg_indexes where indexname like 'organizations_%_norm_uq' order by 1"),
  };
}

describe("0062 re-applied", () => {
  test("twice more on a database that has data: no error, counters and codes unchanged, no counter lowered", async () => {
    const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
    await db.exec(PLATFORM_STUB);
    for (const f of MIGRATIONS) await db.exec(readFileSync(join(DIR, f), "utf8")); // includes 0062 once

    // data created after the first apply: signed-in allocations, an owner-run load, and a counter set HIGHER than the max
    await db.exec(`insert into auth.users (id, email) values ('${USER}', 'idem@x.test')`);
    await db.exec(`insert into public.organizations (name, status, licence_number) values ('Idem Co', 'approved', 'IDM 1001/20')`);
    await db.exec(`select set_config('request.jwt.claims', '{"sub":"${USER}","role":"authenticated"}', false)`);
    for (let i = 0; i < 3; i++) {
      await db.exec(`insert into public.sites (name, operator_name, county, created_by) values ('N${i}', 'Idem Co', 'Nimba', '${USER}')`);
    }
    await db.exec(`select set_config('request.jwt.claims', '', false)`);
    await db.exec(`insert into public.sites (code, name, operator_name, county, created_by) values ('MGL-LOFA-0040', 'Loaded', 'Idem Co', 'Lofa', '${USER}')`);
    await db.exec(`update public.site_code_counters set last_number = 500 where prefix = 'LOFA'`); // e.g. numbers burned by rolled-back work

    const before = await snapshot(db);
    expect(before.counters).toEqual([{ prefix: "LOFA", last_number: 500 }, { prefix: "NIMBA", last_number: 3 }, ...before.counters.filter((c) => !["LOFA", "NIMBA"].includes(String(c.prefix)))]);
    expect(before.codes.map((c) => c.code)).toContain("MGL-NIMBA-0003");

    await db.exec(M0062); // 2nd apply
    await db.exec(M0062); // 3rd apply
    const after = await snapshot(db);

    expect(after).toEqual(before); // counters (incl. the raised LOFA = 500), codes, county table, triggers, indexes: identical
    expect(after.counters.filter((c) => c.prefix === "NIMBA")).toHaveLength(1); // no duplicated counter rows

    // and allocation continues from where it was, never from a lowered counter
    await db.exec(`select set_config('request.jwt.claims', '{"sub":"${USER}","role":"authenticated"}', false)`);
    const next = await db.query(`insert into public.sites (name, operator_name, county, created_by) values ('After', 'Idem Co', 'Nimba', '${USER}') returning code`);
    expect((next.rows[0] as { code: string }).code).toBe("MGL-NIMBA-0004");
    const lofa = await db.query(`insert into public.sites (name, operator_name, county, created_by) values ('AfterLofa', 'Idem Co', 'Lofa', '${USER}') returning code`);
    expect((lofa.rows[0] as { code: string }).code).toBe("MGL-LOFA-0501");
    await db.close();
  });
});
