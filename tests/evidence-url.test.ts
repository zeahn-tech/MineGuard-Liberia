// ---------------------------------------------------------------------------
// EVIDENCE URL REVOCATION — Gap Closure Directive v1.0, Priority A, Gap #2.
//
// Before 0006, evidence.getUrl minted 1-hour signed URLs with no server-side
// gate and no revocation: a leaked link lived an hour, a permission change
// never reached already-minted URLs, and no record existed of who opened what.
//
// 0006's design (revocation-at-mint + short TTL): the `evidence_url` RPC
// re-derives the caller's CURRENT site access via mg_can_access_site() at
// every mint (the same predicate as the storage read policy), refuses
// role-less guest accounts, clamps TTL server-side (30-300s), and appends a
// definer-only audit row per mint. The client (backend.ts) signs with a
// 120-second TTL — a leaked link is a 2-minute exposure, and losing site
// access kills the next mint immediately.
//
// Harness pattern: every test runs in one withRole("postgres") transaction
// (always rolled back) and switches to the caller's role/claims only around
// the mint itself — the same idiom the fixture seed uses. Audit rows are
// counted as postgres because the table is definer-only (authenticated sees
// ZERO rows by design — asserted explicitly below, not assumed).
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

beforeAll(() => getFixture());

const EVIDENCE_MISSING = "eeeeeeee-0000-4000-8000-000000000099";

/** Mint inside `run` as the given user, then restore the postgres context. */
async function mintAs(
  run: Runner,
  uid: string,
  evidenceId: string,
  ttl?: number,
): Promise<{ path: unknown; error?: string }> {
  await run("set local role authenticated");
  await run(
    `set local request.jwt.claims = '${JSON.stringify({ sub: uid, role: "authenticated" })}'`,
  );
  let out: { path: unknown; error?: string };
  try {
    const sql =
      ttl === undefined
        ? `select public.evidence_url('${evidenceId}'::uuid) as path`
        : `select public.evidence_url('${evidenceId}'::uuid, ${ttl}) as path`;
    const rows = await run(sql);
    out = { path: rows[0]?.path ?? null };
  } catch (e) {
    out = { path: null, error: e instanceof Error ? e.message : String(e) };
  }
  await run("reset role");
  await run(`set local request.jwt.claims = ''`);
  return out;
}

async function auditCount(run: Runner, evidenceId: string): Promise<number> {
  const rows = await run(
    `select count(*) as n from public.evidence_url_audit
      where evidence_id = '${evidenceId}'::uuid`,
  );
  return Number(rows[0]?.n);
}

describe("evidence_url mint gate (0006)", () => {
  test("returns the storage path for an authorized caller", async () => {
    const f = await getFixture();
    await withRole("postgres", null, async (run) => {
      const { path, error } = await mintAs(run, f.opA, f.evidenceA);
      expect(error).toBeUndefined();
      expect(path).toBe(`${f.opA}/${f.evidenceA}__haul-road.jpg`);
    });
  });

  test("returns NULL (never the path) for a caller who cannot access the site", async () => {
    const f = await getFixture();
    await withRole("postgres", null, async (run) => {
      // opB is a valid operator at another tenant: no error, just NULL.
      const { path, error } = await mintAs(run, f.opB, f.evidenceA);
      expect(error).toBeUndefined();
      expect(path).toBeNull();
      // Refused mints append nothing to the audit log.
      expect(await auditCount(run, f.evidenceA)).toBe(0);
    });
  });

  test("a permission change reaches the next mint: access revoked ⇒ mint refused", async () => {
    const f = await getFixture();
    await withRole("postgres", null, async (run) => {
      const before = await mintAs(run, f.opA, f.evidenceA);
      expect(before.path).not.toBeNull();

      // The operator's site access is revoked (the production mechanism is
      // any profile/site change that breaks mg_can_access_site; performed
      // here as postgres because the guard restricts WHO may edit, not
      // whether revocation works).
      await run(
        `update public.profiles set operator_name = 'Revoked Co'
          where id = '${f.opA}'`,
      );
      const after = await mintAs(run, f.opA, f.evidenceA);
      expect(after.path).toBeNull();
      // Exactly the one accepted mint from the start of this test.
      expect(await auditCount(run, f.evidenceA)).toBe(1);
    });
  });

  test("returns NULL for a missing evidence id without leaking existence", async () => {
    const f = await getFixture();
    void f;
    await withRole("postgres", null, async (run) => {
      const { path, error } = await mintAs(
        run,
        "aaaaaaaa-0000-4000-8000-000000000004", // county inspector
        EVIDENCE_MISSING,
      );
      expect(error).toBeUndefined();
      expect(path).toBeNull();
    });
  });

  test("guest accounts (no assigned role) are refused loudly", async () => {
    const f = await getFixture();
    await withRole("postgres", null, async (run) => {
      const { path, error } = await mintAs(run, f.guest, f.evidenceA);
      expect(error).toContain("FORBIDDEN");
      expect(path).toBeNull();
    });
  });

  test("anon cannot execute the RPC at all", async () => {
    void (await getFixture());
    await withRole("anon", null, async (run) => {
      let error = "";
      try {
        await run(`select public.evidence_url('${EVIDENCE_MISSING}'::uuid)`);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      // Lineage-dependent refusal (privilege layer vs definer-body check);
      // what must never happen is a successful mint (no error at all).
      expect(error).toMatch(/FORBIDDEN|permission denied/i);
    });
  });

  test("TTL is clamped server-side: a client cannot mint a long-lived URL", async () => {
    const f = await getFixture();
    await withRole("postgres", null, async (run) => {
      // Ask for an hour; the gate must clamp, not obey.
      const { path, error } = await mintAs(run, f.opA, f.evidenceA, 3600);
      expect(error).toBeUndefined();
      expect(path).not.toBeNull();

      // And a nonsense 1-second request is floored to 30. (Both rows share
      // created_at — now() is fixed inside a transaction — so assert on the
      // multiset of logged TTLs, not on "latest".)
      await mintAs(run, f.opA, f.evidenceA, 1);
      const ttls = await run(
        `select ttl_seconds from public.evidence_url_audit
          where evidence_id = '${f.evidenceA}'::uuid`,
      );
      const logged = ttls.map((r) => Number(r.ttl_seconds)).sort((a, b) => a - b);
      expect(logged).toContain(300); // the 3600s ask, clamped
      expect(logged).toContain(30);  // the 1s ask, floored
      // Nothing outside the server-side bounds was ever recorded.
      expect(logged.every((t) => t >= 30 && t <= 300)).toBe(true);
    });
  });

  test("every accepted mint appends exactly one audit row", async () => {
    const f = await getFixture();
    await withRole("postgres", null, async (run) => {
      const before = await auditCount(run, f.evidenceA);
      await mintAs(run, f.admin, f.evidenceA);
      await mintAs(run, f.admin, f.evidenceA);
      expect(await auditCount(run, f.evidenceA)).toBe(before + 2);

      // The audit rows carry the minting actor, not the definer.
      const actor = await run(
        `select actor_id from public.evidence_url_audit
          where evidence_id = '${f.evidenceA}'::uuid
          order by created_at desc, id desc limit 1`,
      );
      expect(actor[0]?.actor_id).toBe(f.admin);
    });
  });

  test("evidence_url_audit is definer-only: authenticated sees zero rows", async () => {
    const f = await getFixture();
    await withRole(
      "authenticated",
      { sub: f.admin, role: "authenticated" },
      async (run) => {
        const rows = await run(
          `select count(*) as n from public.evidence_url_audit`,
        );
        expect(Number(rows[0]?.n)).toBe(0);
      },
    );
  });

  test("the RPC is volatile (it writes audit rows) and security definer", async () => {
    const db = await getDb();
    const rows = await db.query<{ provolatile: string; prosecdef: boolean }>(
      `select provolatile, prosecdef from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'evidence_url'`,
    );
    expect(rows.rows[0]?.provolatile).toBe("v");
    expect(rows.rows[0]?.prosecdef).toBe(true);
  });
});
