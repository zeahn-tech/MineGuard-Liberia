// ---------------------------------------------------------------------------
// LIVE DATABASE ANON PROBE — runs against the real Supabase project using
// ONLY the public anon key (no session, no secrets; this key ships in the
// client bundle by design).
//
// This is the always-on regression net for forensic re-audit §0.1: if anyone
// ever re-grants anon on public.profiles or recreates a permissive
// "profiles read" policy on the live project, the first test here fails —
// no manual audit needed.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

const SUPABASE_URL = "https://ewukneoblhogtreeekqc.supabase.co";
const ANON_KEY = "sb_publishable_g_SOzhE21n76m1-FAx-c5Q_CzUi7VMi"; // public by design

async function rest(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.text() };
}

const SENSITIVE_TABLES = [
  "profiles",
  "sites",
  "inspection_templates",
  "inspections",
  "findings",
  "corrective_actions",
  "incidents",
  "environmental_observations",
  "community_reports",
  "evidence",
  "audit_log",
  "rate_limits",
];

describe("live DB: anonymous client (anon key, no session)", () => {
  test("reads zero rows from every sensitive table", async () => {
    for (const table of SENSITIVE_TABLES) {
      const { status, body } = await rest(`${table}?select=*&limit=10`);
      expect([200, 401, 406], `${table}: unexpected HTTP ${status} ${body}`)
        .toContain(status);
      if (status === 200) {
        expect(JSON.parse(body), `anon leaked rows from ${table}`).toEqual([]);
      } else {
        // 401/406 carry an RLS or privilege error — equally acceptable.
        expect(body).toContain("42501");
      }
    }
  });

  test("profiles is privilege-denied (0003 hard revoke), not merely filtered", async () => {
    const { status, body } = await rest("profiles?select=*");
    expect(status).toBe(401);
    expect(body).toContain("permission denied for table profiles");
  });

  test("cannot insert into profiles (0001's permissive insert path stays closed)", async () => {
    const { status, body } = await rest("profiles", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000001" }),
    });
    expect(status).toBe(401);
    expect(body).toContain("permission denied for table profiles");
  });

  test("public mirrors remain readable (landing page + tracking)", async () => {
    const meta = await rest("meta?select=key");
    expect(meta.status).toBe(200);
    expect(JSON.parse(meta.body).length).toBeGreaterThan(0);

    const tracking = await rest("report_tracking?select=tracking_code");
    expect(tracking.status).toBe(200);
    expect(JSON.parse(tracking.body).length).toBeGreaterThan(0);
  });
});
