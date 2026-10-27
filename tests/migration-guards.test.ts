// ---------------------------------------------------------------------------
// Migration preconditions (0015–0018).
//
// A real incident: these files were pasted into the SQL editor of the WRONG
// Supabase project (a different application's database) and failed halfway
// with an opaque `relation "public.sites" does not exist`. Each file now checks
// first and stops with a plain explanation and a fix — and leaves nothing
// behind. (That they still apply cleanly on a correctly migrated database is
// proven by migration-apply.test.ts and every suite that boots the full chain.)
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { adminSql } from "./helpers/backend-edge";

const sql = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "supabase", "migrations", name), "utf8");

async function failure(db: PGlite, file: string) {
  try {
    await db.exec(sql(file));
  } catch (e) {
    const err = e as { message?: string; detail?: string; hint?: string };
    return { message: err.message ?? "", detail: err.detail ?? "", hint: err.hint ?? "" };
  }
  return null;
}

/** What the wrong project looked like: a different app's tables, no MineGuard. */
async function wrongProject() {
  const db = new PGlite();
  await db.exec(`
    create table public.organizations (id uuid primary key, name text);
    create table public.users (id uuid primary key, email text);
    create table public.payments (id uuid primary key, amount numeric);
  `);
  return db;
}

describe("0015 on a database without the MineGuard base schema", () => {
  test.each([
    ["an empty database", async () => new PGlite()],
    ["another application's database (the real mistake)", wrongProject],
  ])("%s: stops first, says why, says how to fix it", async (_label, make) => {
    const db = await make();
    const err = await failure(db, "0015_gis.sql");
    expect(err).not.toBeNull();
    expect(err!.message).toContain("MineGuard migration 0015_gis cannot run");
    expect(err!.message).toContain("base schema is missing");
    expect(err!.detail).toContain("0001-0014");
    expect(err!.hint).toContain("src/lib/supabase.ts");
    expect(err!.hint).toContain("scripts/db-sql.ts");
    // …and it must not have half-applied anything.
    const left = await db.query(
      `select count(*)::int as n from pg_proc where proname like 'mg\\_%' escape '\\'`,
    );
    expect((left.rows[0] as { n: number }).n).toBe(0);
    await db.close();
  });
});

describe("0016 / 0017 without their prerequisites", () => {
  test("0016 says the boundary tables are missing and names the file that creates them", async () => {
    const db = await wrongProject();
    const err = await failure(db, "0016_gis_boundary_hardening.sql");
    expect(err!.message).toContain("MineGuard migration 0016_gis_boundary_hardening cannot run");
    expect(err!.detail).toContain("0015_gis.sql");
    await db.close();
  });

  test("0017 says public.sites is missing", async () => {
    const db = await wrongProject();
    const err = await failure(db, "0017_fix_demo_site_longitudes.sql");
    expect(err!.message).toContain("MineGuard migration 0017_fix_demo_site_longitudes cannot run");
    expect(err!.message).toContain("public.sites does not exist");
    await db.close();
  });
});

describe("0018 (realtime publication)", () => {
  test("where Realtime exists but the boundary tables do not, it says so instead of a bare relation error", async () => {
    const db = await wrongProject();
    await db.exec(`create publication supabase_realtime`);
    const err = await failure(db, "0018_realtime_boundaries.sql");
    expect(err!.message).toContain("MineGuard migration 0018_realtime_boundaries cannot run");
    expect(err!.message).toContain("public.admin_boundaries does not exist");
    expect(err!.detail).toContain("0015_gis.sql");
    await db.close();
  });

  test("with no Realtime in the environment it does nothing, successfully", async () => {
    const db = new PGlite();
    expect(await failure(db, "0018_realtime_boundaries.sql")).toBeNull();
    await db.close();
  });

  test("where the tables exist it publishes them once, and re-running is safe", async () => {
    const db = new PGlite();
    await db.exec(`
      create table public.admin_boundaries (id uuid primary key);
      create table public.site_boundaries (id uuid primary key);
      create publication supabase_realtime;
    `);
    expect(await failure(db, "0018_realtime_boundaries.sql")).toBeNull();
    expect(await failure(db, "0018_realtime_boundaries.sql")).toBeNull();
    const rows = await db.query(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`,
    );
    expect(rows.rows.map((r) => (r as { tablename: string }).tablename)).toEqual([
      "admin_boundaries",
      "site_boundaries",
    ]);
    await db.close();
  });
});

describe("supabase/checks/migration_state.sql (the read-only 'what is applied?' check)", () => {
  const check = readFileSync(join(import.meta.dir, "..", "supabase", "checks", "migration_state.sql"), "utf8");
  const stateOf = (rows: Array<{ migration: string; applied: boolean }>) =>
    Object.fromEntries(rows.map((r) => [r.migration.slice(0, 4), r.applied]));

  test("on a database without MineGuard (the wrong project) every migration reads as NOT applied — and it does not error", async () => {
    const db = await wrongProject();
    const res = await db.query(check);
    const state = stateOf(res.rows as Array<{ migration: string; applied: boolean }>);
    expect(Object.keys(state)).toEqual(["0001", "0010", "0012", "0013", "0014", "0015", "0016", "0018", "0019", "0021", "0024", "0025", "0026", "0027"]);
    expect(Object.values(state).every((v) => v === false)).toBe(true);
    await db.close();
  });

  test("on the fully migrated database every migration reads as applied", async () => {
    const rows = (await adminSql(check)) as Array<{ migration: string; applied: boolean }>;
    expect(stateOf(rows)).toEqual({
      "0001": true, "0010": true, "0012": true, "0013": true,
      "0014": true, "0015": true, "0016": true, "0018": true, "0019": true, "0021": true,
      "0024": true, "0025": true, "0026": true, "0027": true,
    });
  });

  test("it is strictly read-only (a single SELECT — checked on the code, not the comments or labels)", () => {
    const code = check
      .replace(/--[^\n]*/g, "") // comments
      .replace(/'(?:[^']|'')*'/g, "''"); // string literals (labels, object names)
    expect(code).not.toMatch(/\b(insert|update|delete|alter|drop|create|grant|revoke|truncate|copy|do)\b/i);
    expect(code.trim()).toMatch(/^with fns as \(/i);
    expect(code.split(";").filter((x) => x.trim()).length).toBe(1); // one statement only
  });
});
