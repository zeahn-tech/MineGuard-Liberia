// ---------------------------------------------------------------------------
// Replay safety. Production holds the objects of migrations 0047 onward (applied by hand, unrecorded), so
// the first pipeline run replays them. This proves that replaying every migration from 0047 over a fully built
// database succeeds and leaves the schema (functions, policies, triggers, constraints, columns, RLS) unchanged.
// It builds its OWN database: other suites deliberately leave the shared one in partial states.
// ---------------------------------------------------------------------------
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, PLATFORM_STUB } from "./helpers/pglite-db";

const ROOT = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(ROOT, "supabase", "migrations", f), "utf8");
const FINGERPRINT = readFileSync(join(ROOT, "supabase", "checks", "schema_fingerprint.sql"), "utf8");
const REPLAY = MIGRATIONS.filter((f) => f >= "0047");

describe("replaying 0047 onward over a fully built database", () => {
  test("every migration replays without error and the schema fingerprint is identical afterwards", async () => {
    expect(REPLAY.length).toBeGreaterThanOrEqual(11);
    const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
    await db.exec(PLATFORM_STUB);
    for (const f of MIGRATIONS) await db.exec(read(f));
    const before = (await db.query(FINGERPRINT)).rows as Record<string, unknown>[];
    expect(before.length).toBeGreaterThan(1000);

    const failures: string[] = [];
    for (const f of REPLAY) {
      try {
        await db.exec(read(f)); // each file carries its own begin/commit, exactly as the CLI runs it
      } catch (e) {
        failures.push(`${f}: ${(e as Error).message.split("\n")[0]}`);
        await db.exec("rollback").catch(() => {});
      }
    }
    expect(failures).toEqual([]);

    const after = (await db.query(FINGERPRINT)).rows as Record<string, unknown>[];
    const key = (r: Record<string, unknown>) => `${r.kind}|${r.obj}`;
    const b = new Map(before.map((r) => [key(r), r.h]));
    const a = new Map(after.map((r) => [key(r), r.h]));
    expect({
      changed: after.filter((r) => b.has(key(r)) && b.get(key(r)) !== r.h).map(key),
      added: after.filter((r) => !b.has(key(r))).map(key),
      removed: before.filter((r) => !a.has(key(r))).map(key),
    }).toEqual({ changed: [], added: [], removed: [] });
    await db.close();
  });
});
