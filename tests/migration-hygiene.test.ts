// ---------------------------------------------------------------------------
// Release hygiene for the migration chain and the Public User programme's operational files.
// These are cheap file-level checks that catch the mistakes that are expensive to find later:
// a colliding migration number (two branches picking the same "next" number), a missing rollback,
// a stale generated seed, or a security suite quietly dropped from the required CI job.
// ---------------------------------------------------------------------------
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATIONS = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort();

describe("migration numbering", () => {
  test("numbers are unique — the one historical duplicate (0046) is pinned and no new one may appear", () => {
    const byNumber = new Map<string, string[]>();
    for (const f of MIGRATIONS) {
      const n = f.slice(0, 4);
      byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
    }
    const dupes = [...byNumber.entries()].filter(([, v]) => v.length > 1);
    expect(dupes).toEqual([["0046", ["0046_corrective_action_roles.sql", "0046_worker_voice.sql"]]]);
  });

  test("the chain has no gaps and every file is NNNN_snake_case.sql", () => {
    for (const f of MIGRATIONS) expect(f, f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    const numbers = [...new Set(MIGRATIONS.map((f) => Number(f.slice(0, 4))))];
    expect(numbers[0]).toBe(1);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });

  test("migrations are transactional and idempotent in style (begin/commit, 'if not exists' / 'or replace')", () => {
    for (const f of MIGRATIONS.filter((m) => Number(m.slice(0, 4)) >= 47)) {
      const sql = read(`supabase/migrations/${f}`);
      expect(sql, f).toMatch(/^begin;$/m);
      expect(sql, f).toMatch(/^commit;$/m);
    }
  });
});

describe("Public User programme: rollback and recovery files", () => {
  test("every programme migration has a rollback script outside supabase/migrations", () => {
    for (const [n, name] of [
      ["0047", "reopens_admin_bootstrap"],
      ["0048", "public_user_identity"],
      ["0049", "public_reports_feedback"],
      ["0051", "public_content"],
    ]) {
      const p = `supabase/maintenance/rollback_${n}_${name}.sql`;
      expect(existsSync(join(ROOT, p)), p).toBe(true);
      expect(MIGRATIONS.some((m) => m.includes("rollback")), "rollbacks must not live in migrations/").toBe(false);
    }
  });

  test("the administrator recovery script and the zero-administrator check exist", () => {
    expect(existsSync(join(ROOT, "supabase/maintenance/promote_to_admin.sql"))).toBe(true);
    expect(read("supabase/checks/admin_present.sql")).toMatch(/NO ADMINISTRATOR/);
  });

  test("the glossary draft seed is not a migration and is up to date", () => {
    expect(MIGRATIONS.some((m) => m.includes("glossary"))).toBe(false);
    const proc = Bun.spawnSync(["node", "scripts/gen-public-glossary-seed.mjs", "--check"], { cwd: ROOT });
    expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
  });
});

describe("CI keeps the security suites required", () => {
  const ci = read(".github/workflows/ci.yml");
  test("the required rls-security-test job names every Public User security suite", () => {
    for (const t of [
      "tests/phase-a-security.test.ts",
      "tests/phase-b-public-identity.test.ts",
      "tests/phase-c-public-reports.test.ts",
      "tests/phase-d-public-content.test.ts",
      "tests/public-surface-matrix.test.ts",
      "tests/migration-hygiene.test.ts",
    ]) {
      expect(ci, t).toContain(t);
    }
  });
  test("the full suite, typecheck, lint and build still gate every release", () => {
    for (const step of ["bunx tsc -b --noEmit", "bunx eslint .", "bunx vite build", "bun test --timeout 60000"]) expect(ci, step).toContain(step);
  });
});
