// ---------------------------------------------------------------------------
// Migration 0062 — site-code allocation under REAL parallelism, against a real PostgreSQL (not PGlite).
//
// Skipped unless SITE_CODE_PG_URL is set. It spawns 50 independent `psql` sessions at once, each registering a site in the
// same county as a signed-in user, and asserts: 50 distinct codes, zero errors, one contiguous run (no gaps).
//
// SAFETY: the target is read from SITE_CODE_PG_URL only, and tests/helpers/disposable-pg.ts refuses to connect unless the host
// is local, the database name contains test/scratch/disposable, the URL is not a Supabase/known-project target, and
// SITE_CODE_PG_ALLOW_WRITES=yes is set. (The guard itself is unit-tested in tests/disposable-pg-guard.test.ts.)
//
// WARNING: sites are never deleted (lifecycle only), so this leaves 50 rows behind. Point it at a SCRATCH database or a
// Supabase BRANCH — never production.
//
// Setup (any Postgres 15+ with the repo's migrations applied, e.g. a Supabase branch, or locally):
//   psql "$URL" -f <platform stub: PLATFORM_STUB in tests/helpers/pglite-db.ts>   # local, non-Supabase only
//   for f in supabase/migrations/*.sql; do psql "$URL" -v ON_ERROR_STOP=1 -f "$f"; done
//   SITE_CODE_PG_ALLOW_WRITES=yes SITE_CODE_PG_URL="postgresql://postgres:pw@localhost:5432/mgl_test" bun test tests/site-code-concurrency.pg.test.ts
// ---------------------------------------------------------------------------
import { describe, expect, test } from "bun:test";
import { assertDisposablePgUrl } from "./helpers/disposable-pg";

const URL = process.env.SITE_CODE_PG_URL;
const USER = "aaaaaaaa-0000-4000-8000-0000000000c1";

async function psql(sql: string): Promise<{ out: string; err: string; code: number }> {
  assertDisposablePgUrl(URL); // every connection goes through this guard: throws before spawning psql on a wrong target
  const p = Bun.spawn(["psql", URL!, "-q", "-At", "-v", "ON_ERROR_STOP=1"], { stdin: new TextEncoder().encode(sql), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { out: out.trim(), err: err.trim(), code: await p.exited };
}

describe.skipIf(!URL)("site-code allocation under real parallelism (real PostgreSQL)", () => {
  test("50 parallel signed-in registrations in one county: no duplicates, no errors, no gaps", async () => {
    // the operator must be a registered company (0033); the licence number keeps the 0062 rules satisfied
    const setup = await psql(`insert into auth.users (id, email) values ('${USER}', 'concurrency@x.test') on conflict do nothing;
      insert into public.organizations (name, status, licence_number)
        select 'Concurrency Op', 'approved', 'CON 1001/20' where not exists (select 1 from public.organizations where name = 'Concurrency Op');`);
    expect(setup.err).toBe("");
    const county = "Sinoe";
    const session = (i: number) =>
      psql(`select set_config('request.jwt.claims', '{"sub":"${USER}","role":"authenticated"}', false);
            insert into public.sites (name, operator_name, county, created_by) values ('Par ${i}', 'Concurrency Op', '${county}', '${USER}') returning code;`);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => session(i)));
    expect(results.filter((r) => r.code !== 0).map((r) => r.err)).toEqual([]);
    const codes = results.map((r) => r.out.split("\n").find((l) => l.startsWith("MGL-"))!);
    expect(new Set(codes).size).toBe(50);
    const nums = codes.map((c) => Number(c.split("-")[2])).sort((a, b) => a - b);
    expect(nums[49] - nums[0]).toBe(49); // contiguous: the counter never skipped or repeated
  });
});
