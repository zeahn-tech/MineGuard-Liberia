/* eslint-disable @typescript-eslint/no-explicit-any -- fake service client */
// Voice push dispatcher: three fixed payloads, honest outcomes, endpoint safety, and no user-facing door.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleVoicePushSweep, VOICE_PUSH_PAYLOADS } from "../supabase/functions/_shared/voice/push";

const ROOT = join(import.meta.dir, "..");
const row = (n: number, kind = "company", endpoint = `https://push.example.test/${n}`) => ({ outbox_id: `o${n}`, subscription_id: `s${n}`, kind, endpoint, p256dh: "k", auth: "a" });
function fakeService(rows: any[], claimError = false) {
  const records: any[] = [];
  const calls: string[] = [];
  return {
    records, calls,
    rpc: async (fn: string, args?: any) => {
      calls.push(fn);
      if (fn === "mg_voice_ageing_sweep") return { data: { companyReminded: 0 }, error: null };
      if (fn === "mg_voice_push_claim") return claimError ? { data: null, error: { message: "x" } } : { data: rows, error: null };
      if (fn === "mg_voice_push_record") { records.push(args); return { data: null, error: null }; }
      throw new Error("unexpected rpc " + fn);
    },
  };
}

describe("voice push dispatcher", () => {
  test("exactly three fixed payloads; none carries any report information", () => {
    expect(Object.keys(VOICE_PUSH_PAYLOADS).sort()).toEqual(["company", "ministry", "request"]);
    expect(Object.values(VOICE_PUSH_PAYLOADS).map((p) => JSON.parse(p))).toEqual([{ v: 1, t: "wv" }, { v: 1, t: "mv" }, { v: 1, t: "mr" }]);
  });
  test("each row sends the payload for ITS kind; the ageing sweep runs first on the same tick", async () => {
    const svc = fakeService([row(1, "company"), row(2, "ministry"), row(3, "request")]);
    const sent: string[] = [];
    const r = await handleVoicePushSweep({ service: svc, sender: async (_s, p) => { sent.push(p); return { status: 201 }; } });
    expect(sent).toEqual([VOICE_PUSH_PAYLOADS.company, VOICE_PUSH_PAYLOADS.ministry, VOICE_PUSH_PAYLOADS.request]);
    expect(r.body).toMatchObject({ ok: true, claimed: 3, sent: 3 });
    expect(svc.calls[0]).toBe("mg_voice_ageing_sweep");
  });
  test("a gone subscription is expired; transient errors retry; rejections fail; unknown kinds are never sent", async () => {
    const svc = fakeService([row(1), row(2), row(3), row(4), row(5, "surprise")]);
    const codes = [410, 503, 400, 0];
    let i = 0, calls = 0;
    await handleVoicePushSweep({ service: svc, sender: async () => { calls++; return { status: codes[i++] }; } });
    expect(svc.records.map((x) => x.p_state)).toEqual(["expired", "queued", "failed", "queued", "failed"]);
    expect(svc.records[0].p_dead_subscription).toBe("s1");
    expect(calls).toBe(4);
  });
  test("private, plain-http and loopback endpoints are never contacted", async () => {
    const svc = fakeService([row(1, "company", "http://push.example.test/x"), row(2, "company", "https://127.0.0.1/x"), row(3, "company", "https://10.0.0.5/x"), row(4, "company", "https://localhost/x")]);
    let calls = 0;
    await handleVoicePushSweep({ service: svc, sender: async () => { calls++; return { status: 201 }; } });
    expect(calls).toBe(0);
    expect(svc.records.every((x) => x.p_state === "failed")).toBe(true);
  });
  test("not configured: nothing is sent or claimed as sent; a failed claim is reported", async () => {
    const svc = fakeService([row(1)]);
    expect((await handleVoicePushSweep({ service: svc, sender: null })).body).toMatchObject({ sent: 0, not_configured: 1 });
    expect((await handleVoicePushSweep({ service: fakeService([], true), sender: async () => ({ status: 201 }) })).status).toBe(500);
  });
  test("the function has no user door and the cron sample is fully commented out", () => {
    const fn = readFileSync(join(ROOT, "supabase/functions/worker-voice-push/index.ts"), "utf8");
    expect(fn).toContain("secretsMatch"); expect(fn).toContain("WORKER_VOICE_PUSH_SECRET");
    expect(fn).not.toMatch(/Access-Control|getUser|Authorization/);
    const sql = readFileSync(join(ROOT, "supabase/cron/voice-sweep.sql"), "utf8");
    expect(sql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"))).toEqual([]);
  });
});
