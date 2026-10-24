/* eslint-disable @typescript-eslint/no-explicit-any */
// =============================================================================
// Independent-audit regression suite (migration 0023).
// Each test asserts a SECURITY PROPERTY that fails if the fix is removed.
// =============================================================================
import { describe, expect, test } from "bun:test";
import { getFixture, withRole, asUser, IDS } from "./helpers/pglite-db";
import { sanitizeEvidenceFileName } from "../src/lib/backend";

const submit = (code = "CLIENT-CHOSEN", extra = "") =>
  `select submit_community_report('${code}','pollution','desc','Bomi'${extra})`;

async function fails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

describe("F3 — submit_community_report validates server-side", () => {
  test("client-chosen tracking code is ignored; server mints 80-bit code", async () => {
    await getFixture();
    await withRole("anon", null, async (run) => {
      const r = await run(submit("X"));
      const out = (r[0] as { submit_community_report: { trackingCode: string } }).submit_community_report;
      expect(out.trackingCode).not.toBe("X");
      expect(out.trackingCode).toMatch(/^CR-([0-9A-F]{4}-){4}[0-9A-F]{4}$/);
    });
  });

  test("codes are unpredictable (no repeats in 20 draws)", async () => {
    await getFixture();
    await withRole("anon", null, async (run) => {
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const r = await run(submit(`c${i}`));
        seen.add((r[0] as any).submit_community_report.trackingCode);
      }
      expect(seen.size).toBe(20);
    });
  });

  for (const [label, sql] of [
    ["oversized description", `select submit_community_report('x','pollution', repeat('x',5001),'Bomi')`],
    ["empty description", `select submit_community_report('x','pollution','   ','Bomi')`],
    ["unknown county", `select submit_community_report('x','pollution','d','Atlantis')`],
    ["overlong phone", `select submit_community_report('x','pollution','d','Bomi',null,null,null,null, repeat('9',33))`],
    ["non-phone characters", `select submit_community_report('x','pollution','d','Bomi',null,null,null,null,'<script>')`],
    ["out-of-range coordinates", `select submit_community_report('x','pollution','d','Bomi',null,null,999,999)`],
    ["coordinates outside Liberia", `select submit_community_report('x','pollution','d','Bomi',null,null,51.5,-0.1)`],
    ["half a coordinate pair", `select submit_community_report('x','pollution','d','Bomi',null,null,6.3,null)`],
  ] as const) {
    test(`rejects ${label}`, async () => {
      await getFixture();
      await withRole("anon", null, async (run) => {
        expect(await fails(run(sql))).toMatch(/INVALID_INPUT/);
      });
    });
  }

  test("accepts 'River Cess' and 'Rivercess' spellings", async () => {
    await getFixture();
    await withRole("anon", null, async (run) => {
      await run(`select submit_community_report('x','pollution','d','River Cess')`);
      await run(`select submit_community_report('x','pollution','d','Rivercess')`);
    });
  });
});

describe("F2 — rate limiting cannot be bypassed by rotating X-Forwarded-For alone", () => {
  test("rotating spoofed XFF hits the global backstop (<=300/min total)", async () => {
    await getFixture();
    await withRole("anon", null, async (run) => {
      let ok = 0;
      let limited = 0;
      for (let i = 0; i < 330; i++) {
        await run(`select set_config('request.headers', '{"x-forwarded-for":"10.9.${i % 250}.${Math.floor(i / 250)}, 1.2.3.4"}', true)`);
        try {
          await run(submit(`s${i}`));
          ok++;
        } catch (e) {
          if (String((e as Error).message).includes("RATE_LIMITED")) limited++;
        }
      }
      expect(ok).toBeLessThanOrEqual(300);
      expect(limited).toBeGreaterThanOrEqual(30);
    });
  }, 120000);

  test("cf-connecting-ip (CDN-set) wins over a client-supplied X-Forwarded-For", async () => {
    await getFixture();
    await withRole("postgres", null, async (run) => {
      await run(`select set_config('request.headers', '{"cf-connecting-ip":"203.0.113.9","x-forwarded-for":"6.6.6.6"}', true)`);
      const r = await run(`select public.mg_client_ip() as ip`);
      expect((r[0] as any).ip).toBe("203.0.113.9");
    });
  });
});

describe("F4 — tracking codes are not enumerable", () => {
  test("anon cannot SELECT report_tracking", async () => {
    await getFixture();
    await withRole("anon", null, async (run) => {
      expect(await fails(run(`select * from report_tracking`))).toMatch(/permission denied/i);
    });
  });

  test("an anonymous-sign-in guest (role-less authenticated) sees zero tracking rows", async () => {
    const f = await getFixture();
    void f;
    await asUser(IDS.guest, async (run) => {
      const r = await run(`select count(*)::int as n from report_tracking`);
      expect((r[0] as any).n).toBe(0);
    });
  });

  test("staff can still read the table; operators cannot", async () => {
    await getFixture();
    await asUser(IDS.national, async (run) => {
      const r = await run(`select count(*)::int as n from report_tracking`);
      expect((r[0] as any).n).toBeGreaterThan(0);
    });
    await asUser(IDS.opA, async (run) => {
      const r = await run(`select count(*)::int as n from report_tracking`);
      expect((r[0] as any).n).toBe(0);
    });
  });

  test("lookup RPC answers one code; unknown / short / junk are indistinguishable nulls", async () => {
    await getFixture();
    await withRole("anon", null, async (run) => {
      const made = await run(submit());
      const code = (made[0] as any).submit_community_report.trackingCode as string;
      const hit = await run(`select track_community_report('${code.toLowerCase().replace(/-/g, " - ")}') as t`);
      expect((hit[0] as any).t.status).toBe("submitted");
      for (const bad of ["CR-DOESNOTEXIST", "x", "", "' or 1=1 --"]) {
        const r = await run(`select track_community_report($1) as t`, [bad]);
        expect((r[0] as any).t).toBeNull();
      }
    });
  });

  test("lookup RPC is rate-limited (brute force of codes is throttled)", async () => {
    await getFixture();
    await withRole("anon", null, async (run) => {
      await run(`select set_config('request.headers', '{"cf-connecting-ip":"198.51.100.77"}', true)`);
      let limited = 0;
      for (let i = 0; i < 30; i++) {
        try {
          await run(`select track_community_report('CR-GUESS-${i}-AAAA')`);
        } catch (e) {
          if (String((e as Error).message).includes("RATE_LIMITED")) limited++;
        }
      }
      expect(limited).toBeGreaterThanOrEqual(10);
    });
  });
});

describe("F11 — anonymous stats refresh is throttled; internal recompute is not callable", () => {
  test("mg_recompute_public_stats is not executable by anon/authenticated", async () => {
    await getFixture();
    await withRole("anon", null, async (run) => {
      expect(await fails(run(`select mg_recompute_public_stats()`))).toMatch(/permission denied/i);
    });
    await asUser(IDS.national, async (run) => {
      expect(await fails(run(`select mg_recompute_public_stats()`))).toMatch(/permission denied/i);
    });
  });
});

describe("F8 — evidence bucket MIME allow-list", () => {
  test("no SVG / HTML / JS types are allowed; documents/media are", async () => {
    await getFixture();
    await withRole("postgres", null, async (run) => {
      const r = await run(`select allowed_mime_types as a from storage.buckets where id = 'evidence'`);
      const allowed = (r[0] as any).a as string[];
      expect(allowed).toContain("image/jpeg");
      expect(allowed).toContain("application/pdf");
      for (const bad of ["image/svg+xml", "text/html", "application/javascript", "application/x-msdownload"]) {
        expect(allowed).not.toContain(bad);
      }
    });
  });
});

describe("F8 — evidence filename sanitiser", () => {
  test("strips paths, traversal and control characters", () => {
    expect(sanitizeEvidenceFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeEvidenceFileName("a/b\\c.jpg")).toBe("c.jpg");
    expect(sanitizeEvidenceFileName("x\u0000y<script>.png")).toBe("x_y_script_.png");
    expect(sanitizeEvidenceFileName("...")).toBe("file");
    expect(sanitizeEvidenceFileName("photo 1 (2).jpg")).toBe("photo 1 (2).jpg");
    expect(sanitizeEvidenceFileName("a".repeat(500) + ".jpg").length).toBeLessThanOrEqual(120);
  });
});
