// ---------------------------------------------------------------------------
// PER-SOURCE RATE LIMITING — Gap Closure Directive v1.0, Priority A, Gap #1.
//
// 0001's submit_community_report counted EVERY submission on Earth into one
// global 30/minute bucket: a single source (buggy loop, shared NAT, attacker)
// could silence the public safety reporting channel for everyone. Migration
// 0005 partitions that same capacity per client source, keyed on the client
// IP carried in the PostgREST-injected request.headers GUC (the same signal
// the platform edge controls) and persisted only as a salted SHA-256 digest.
//
// Harness realities modeled here (learned the hard way):
//   * withRole() transactions ALWAYS roll back — so every multi-step proof
//     (exhaust source A, then submit from source B) must live inside ONE
//     transaction, exactly like one wall-clock minute on the real edge.
//   * anon has no SELECT policy on rate_limits / community_reports: those
//     reads return ZERO ROWS silently (not an error). Success is therefore
//     confirmed through the world-readable report_tracking mirror; bucket
//     rows are introspected from postgres sessions.
//   * Errors raised by the RPC abort only their statement — runIn()'s
//     savepoint keeps the transaction usable afterwards.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";
import { createHash } from "node:crypto";

beforeAll(async () => {
  await getFixture();
  const { MIGRATIONS } = await import("./helpers/pglite-db");
  if (!MIGRATIONS.includes("0005_per_source_report_rate_limit.sql")) {
    throw new Error("0005 migration missing from MIGRATIONS");
  }
});

/** Deterministic probe "client addresses" (TEST-NET-3, never routed). */
const IP_A = "203.0.113.10";
const IP_B = "203.0.113.11";
const GLOBAL_BUCKET = "report:global";
const CAP = 30;

/** PostgREST-style headers: edge chain with the client first. */
function xff(ip: string): string {
  return `set local request.headers = '{"x-forwarded-for":"${ip}", "x-real-ip":"10.0.0.1"}'`;
}

function rateLimited(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)).includes("RATE_LIMITED");
}

async function submit(run: Runner, trackingCode: string): Promise<void> {
  await run(
    `select public.submit_community_report(
        '${trackingCode}', 'pollution', 'test submission', 'Bomi')`,
  );
}

/** Submits `n` reports from `run`, then returns true if #n+1 was refused. */
async function exhaust(
  run: Runner,
  prefix: string,
  n = CAP,
): Promise<boolean> {
  for (let i = 0; i < n; i++) {
    await submit(run, `${prefix}${String(i).padStart(2, "0")}`);
  }
  let refused = false;
  try {
    await submit(run, `${prefix}OVER`);
  } catch (e) {
    refused = rateLimited(e);
  }
  return refused;
}

/** The bucket key the migration derives for an IP (independently in node). */
function bucketFor(ip: string): string {
  return `report:${createHash("sha256").update(`mgliberia-v1:${ip}`).digest("hex")}`;
}

describe("mg_client_ip (source derivation, server-side only)", () => {
  test("derives the source from the PostgREST-injected headers GUC", async () => {
    await withRole("anon", null, async (run) => {
      await run(xff(IP_A));
      const rows = await run(`select public.mg_client_ip() as ip`);
      expect(rows[0]?.ip).toBe(IP_A);
    });
  });

  test("falls back to x-real-ip when no x-forwarded-for chain exists", async () => {
    await withRole("anon", null, async (run) => {
      await run(`set local request.headers = '{"x-real-ip":"198.51.100.7"}'`);
      const rows = await run(`select public.mg_client_ip() as ip`);
      expect(rows[0]?.ip).toBe("198.51.100.7");
    });
  });

  test("uses the FIRST x-forwarded-for hop (the connecting client)", async () => {
    await withRole("anon", null, async (run) => {
      await run(
        `set local request.headers = '{"x-forwarded-for":"${IP_A}, 10.0.0.9, 10.0.0.8"}'`,
      );
      const rows = await run(`select public.mg_client_ip() as ip`);
      expect(rows[0]?.ip).toBe(IP_A);
    });
  });

  test("returns empty (→ global bucket) when no headers are present", async () => {
    await withRole("anon", null, async (run) => {
      await run(`set local request.headers = ''`);
      const rows = await run(`select public.mg_client_ip() as ip`);
      expect(rows[0]?.ip === null || rows[0]?.ip === "").toBe(true);
    });
  });
});

describe("per-source quota isolation (the directive's core acceptance)", () => {
  test("A exhausting its quota is refused; B is untouched; A stays refused — all in the same instant/window", async () => {
    await withRole("anon", null, async (run) => {
      // Source A burns its entire 30/minute quota…
      await run(xff(IP_A));
      expect(await exhaust(run, "CR-RL-A")).toBe(true);

      // …and the very next instant, source B sails through (same window).
      await run(xff(IP_B));
      await submit(run, "CR-RL-B-FIRST");
      // Success confirmed via the world-readable tracking mirror (anon can
      // read report_tracking; it cannot read community_reports directly).
      const mirror = await run(
        `select status from public.report_tracking
          where tracking_code = 'CR-RL-B-FIRST'`,
      );
      expect(mirror[0]?.status).toBe("submitted");

      // And B's fresh quota did not reset A's exhausted window.
      await run(xff(IP_A));
      let aStillRefused = false;
      try {
        await submit(run, "CR-RL-A-STILL");
      } catch (e) {
        aStillRefused = rateLimited(e);
      }
      expect(aStillRefused).toBe(true);
    });
  });

  test("B exhausting its quota does not unblock A either", async () => {
    await withRole("anon", null, async (run) => {
      await run(xff(IP_B));
      expect(await exhaust(run, "CR-RL-B2")).toBe(true);

      // A brand-new source is unaffected by B's exhaustion…
      await run(xff("203.0.113.12"));
      await submit(run, "CR-RL-C2-FIRST");

      // …and A (exhausted in the previous test's transaction — but buckets
      // rolled back, so exhaust A again here) is still independent of B.
      await run(xff(IP_A));
      expect(await exhaust(run, "CR-RL-A2")).toBe(true);
    });
  });
});

describe("cap and window semantics", () => {
  test("exactly CAP submissions pass; the CAP+1-th is RATE_LIMITED", async () => {
    await withRole("anon", null, async (run) => {
      await run(xff("203.0.113.20"));
      let passed = 0;
      let overMessage = "";
      for (let i = 0; i <= CAP; i++) {
        try {
          await submit(run, `CR-RL-C${String(i).padStart(2, "0")}`);
          passed++;
        } catch (e) {
          overMessage = e instanceof Error ? e.message : String(e);
        }
      }
      expect(passed).toBe(CAP);
      expect(overMessage).toContain("RATE_LIMITED");
    });
  });

  test("the window resets: an exhausted source may submit again after it lapses", async () => {
    // Run as postgres: aging the bucket row needs a plain UPDATE on
    // rate_limits (anon has no policy for it), and the postgres session can
    // still present request.headers exactly like the edge would.
    await withRole("postgres", null, async (run) => {
      await run(xff("203.0.113.21"));
      expect(await exhaust(run, "CR-RL-W")).toBe(true);

      // Age every bucket past the fixed 60-second window (clock surgery the
      // test harness can do and PostgREST cannot).
      await run(
        `update public.rate_limits
            set window_start = now() - interval '61 seconds'`,
      );

      // Same source, next "minute": accepted again.
      await submit(run, "CR-RL-W-AFTER");

      const rows = await run(
        `select count, window_start from public.rate_limits
          where bucket = '${bucketFor("203.0.113.21")}'`,
      );
      expect(rows.length).toBe(1);
      expect(Number(rows[0]?.count)).toBe(1); // fresh window, count restarted
    });
  });
});

describe("degraded mode (no forwardable client IP)", () => {
  test("sourceless calls share one global bucket — capacity stays bounded", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`set local request.headers = ''`);
      await submit(run, "CR-RL-G1");
      await submit(run, "CR-RL-G2");

      const rows = await run(
        `select count from public.rate_limits where bucket = '${GLOBAL_BUCKET}'`,
      );
      expect(rows.length).toBe(1);
      expect(Number(rows[0]?.count)).toBeGreaterThanOrEqual(2);

      // …and a sourced caller does NOT land in the global bucket.
      await run(xff("203.0.113.30"));
      await submit(run, "CR-RL-G3-SOURCED");
      const stillGlobal = await run(
        `select count from public.rate_limits where bucket = '${GLOBAL_BUCKET}'`,
      );
      expect(Number(stillGlobal[0]?.count)).toBe(2);
    });
  });
});

describe("privacy: no raw client address is persisted", () => {
  test("every persisted bucket key is a salted digest, never the raw address", async () => {
    await withRole("postgres", null, async (run) => {
      await run(xff(IP_A));
      await submit(run, "CR-RL-P1");
      await run(xff(IP_B));
      await submit(run, "CR-RL-P2");

      const rows = await run(
        `select bucket from public.rate_limits where bucket like 'report:%'`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) {
        const key = String(r.bucket);
        expect(key).not.toContain(IP_A);
        expect(key).not.toContain(IP_B);
        if (key !== GLOBAL_BUCKET) {
          expect(key.slice("report:".length)).toMatch(/^[0-9a-f]{64}$/);
        }
      }
      // The digest construction is verified independently in node, not by
      // trusting the SQL's own crypto choice.
      const keys = rows.map((r) => String(r.bucket));
      expect(keys).toContain(bucketFor(IP_A));
      expect(keys).toContain(bucketFor(IP_B));
    });
  });

  test("rate_limits stays definer-only: anon sees zero rows, not an error", async () => {
    // Mirrors the rls.test.ts pattern: no policies exist on rate_limits, so
    // anon's SELECT is silently filtered to nothing. That is the contract.
    await withRole("anon", null, async (run) => {
      const rows = await run(`select count(*) as n from public.rate_limits`);
      expect(Number(rows[0]?.n)).toBe(0);
    });
  });
});
