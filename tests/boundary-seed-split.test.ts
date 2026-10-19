// The split seed parts (supabase/seeds/split/) must load exactly the same
// boundaries as the single generated seed, be idempotent, and each stay small
// enough for the Supabase SQL editor.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { MIGRATIONS, PLATFORM_STUB } from "./helpers/pglite-db";

const root = join(import.meta.dir, "..");
const seedDir = join(root, "supabase/seeds");
const splitDir = join(seedDir, "split");
const parts = readdirSync(splitDir).filter((f) => f.endsWith(".sql")).sort();

async function freshDb() {
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  await db.exec(PLATFORM_STUB);
  for (const m of MIGRATIONS) await db.exec(readFileSync(join(root, "supabase/migrations", m), "utf8"));
  return db;
}
const snapshot = async (db: PGlite) =>
  (await db.query<{ id: string; name: string; level: string; g: string }>(
    "select id::text, name, level, md5(geometry_geojson::text) g from public.admin_boundaries order by id",
  )).rows;

describe("boundary seed split", () => {
  test("every part is under 100 KB", () => {
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(statSync(join(splitDir, p)).size).toBeLessThan(100_000);
  });

  test("all parts together load exactly what the single seed loads, and re-running is a no-op", async () => {
    const whole = await freshDb();
    await whole.exec(readFileSync(join(seedDir, "liberia_boundaries_geoboundaries.sql"), "utf8"));
    const expected = await snapshot(whole);
    expect(expected.length).toBe(151);

    const split = await freshDb();
    for (const p of [...parts].reverse()) await split.exec(readFileSync(join(splitDir, p), "utf8")); // order must not matter
    expect(await snapshot(split)).toEqual(expected);
    for (const p of parts) await split.exec(readFileSync(join(splitDir, p), "utf8")); // second pass
    expect(await snapshot(split)).toEqual(expected);
  }, 120_000);
});
