/* eslint-disable @typescript-eslint/no-explicit-any -- fake service client */
// Worker Voice push: the payload is fixed and carries nothing; outcomes are recorded honestly; the
// service worker shows only the generic notice; the function has no user-facing door.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleVoicePushSweep, VOICE_PUSH_PAYLOAD } from "../supabase/functions/_shared/voice/push";

const ROOT = join(import.meta.dir, "..");
const row = (n: number, endpoint = `https://push.example.test/${n}`) => ({ outbox_id: `o${n}`, subscription_id: `s${n}`, endpoint, p256dh: "k", auth: "a" });
function fakeService(rows: any[], claimError = false) {
  const records: any[] = [];
  return {
    records,
    rpc: async (fn: string, args?: any) => {
      if (fn === "mg_wv_push_claim") return claimError ? { data: null, error: { message: "x" } } : { data: rows, error: null };
      if (fn === "mg_wv_push_record") { records.push(args); return { data: null, error: null }; }
      throw new Error("unexpected rpc " + fn);
    },
  };
}

describe("worker voice push dispatcher", () => {
  test("the payload is fixed and carries no report information", () => {
    expect(JSON.parse(VOICE_PUSH_PAYLOAD)).toEqual({ v: 1, t: "wv" });
    expect(VOICE_PUSH_PAYLOAD.length).toBeLessThan(30);
  });
  test("accepted -> sent; every send uses exactly the fixed payload", async () => {
    const svc = fakeService([row(1), row(2)]);
    const payloads: string[] = [];
    const r = await handleVoicePushSweep({ service: svc, sender: async (_s, p) => { payloads.push(p); return { status: 201 }; } });
    expect(r.body).toMatchObject({ ok: true, claimed: 2, sent: 2 });
    expect(new Set(payloads)).toEqual(new Set([VOICE_PUSH_PAYLOAD]));
    expect(svc.records.map((x) => x.p_state)).toEqual(["sent", "sent"]);
  });
  test("a gone subscription is expired and stops being targeted; transient errors are retried; rejections are failed", async () => {
    const svc = fakeService([row(1), row(2), row(3), row(4)]);
    const codes = [410, 503, 400, 0];
    let i = 0;
    await handleVoicePushSweep({ service: svc, sender: async () => ({ status: codes[i++] }) });
    expect(svc.records.map((x) => x.p_state)).toEqual(["expired", "queued", "failed", "queued"]);
    expect(svc.records[0].p_dead_subscription).toBe("s1");
    expect(svc.records[1].p_dead_subscription).toBeNull();
  });
  test("a sender that throws is a retry, not a crash and not 'sent'", async () => {
    const svc = fakeService([row(1)]);
    await handleVoicePushSweep({ service: svc, sender: async () => { throw new Error("socket"); } });
    expect(svc.records[0].p_state).toBe("queued");
  });
  test("private, plain-http and loopback endpoints are never contacted", async () => {
    const svc = fakeService([row(1, "http://push.example.test/x"), row(2, "https://127.0.0.1/x"), row(3, "https://10.0.0.5/x"), row(4, "https://localhost/x")]);
    let calls = 0;
    await handleVoicePushSweep({ service: svc, sender: async () => { calls++; return { status: 201 }; } });
    expect(calls).toBe(0);
    expect(svc.records.every((x) => x.p_state === "failed")).toBe(true);
  });
  test("not configured: nothing is sent and nothing is claimed as sent", async () => {
    const svc = fakeService([row(1)]);
    const r = await handleVoicePushSweep({ service: svc, sender: null });
    expect(r.body).toMatchObject({ sent: 0, not_configured: 1 });
    expect(svc.records[0].p_state).toBe("queued");
  });
  test("a failed claim is reported, not swallowed", async () => {
    expect((await handleVoicePushSweep({ service: fakeService([], true), sender: async () => ({ status: 201 }) })).status).toBe(500);
  });
});

describe("service worker and function wiring", () => {
  const sw = readFileSync(join(ROOT, "public/sw.js"), "utf8");
  test("the generic Worker Voice notice shows no report content and opens the sign-in-gated reviewer page", () => {
    const block = sw.slice(sw.indexOf("function isWorkerVoicePush"), sw.indexOf("const p = emergencyPayload(event)"));
    expect(block).toContain('"A safety report requires review. Sign in with your authorized account to access it."');
    expect(block).toContain("#/operate/voice-review");
    expect(block).not.toMatch(/d\.(id|title|body|text|category|mode)/);
    expect(block).not.toMatch(/Emergency/);
  });
  test("an emergency push is still handled as an emergency", () => {
    expect(sw).toContain("emergencyPayload(event)");
    expect(sw).toContain("Emergency alert");
  });
  test("the function has no user door: shared secret only, constant-time compare, no CORS, no JWT user lookup", () => {
    const fn = readFileSync(join(ROOT, "supabase/functions/worker-voice-push/index.ts"), "utf8");
    expect(fn).toContain("secretsMatch");
    expect(fn).toContain("WORKER_VOICE_PUSH_SECRET");
    expect(fn).not.toMatch(/Access-Control|getUser|Authorization/);
  });
  test("the cron sample is commented out (never applied by a migration)", () => {
    const sql = readFileSync(join(ROOT, "supabase/cron/worker-voice-push-sweep.sql"), "utf8");
    expect(sql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"))).toEqual([]);
  });
});
