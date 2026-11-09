/* eslint-disable @typescript-eslint/no-explicit-any -- fake clients */
// ---------------------------------------------------------------------------
// Worker Voice — frontend behaviour (Phase 4): the anonymous path carries nothing identifying, the device
// queue never claims "sent" early, codes resist guessing, copy is honest, and the routes/nav are in place.
// Backend enforcement is in tests/worker-voice.test.ts; a hidden button is never the control.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetOfflineStore } from "../src/lib/offline-store";
import { __testSetSupabaseClient } from "../src/lib/supabase";
import {
  __setAnonymousClient, formatFollowUpCode, MODE_INFO, newFollowUpCode, parseFollowUpCode, PERSONAL_INFO_NOTICE, RETALIATION_NOTICE,
  ROUTING_NOTICE, sendReport, type QueuedReport, type SendOutcome,
} from "../src/lib/voice";
import { describeItem, enqueue, flushQueue, listQueue, removeFromQueue } from "../src/lib/voice-queue";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const FIELDS = { category: "unsafe_condition", urgency: "high", description: "The berm at the north haul road has collapsed.", occurredAt: null, previouslyReported: "no", concernsReviewer: false } as const;
const item = (over: Partial<QueuedReport> = {}) => ({ id: crypto.randomUUID(), mode: "anonymous" as const, siteCode: "ABCDE12345", fields: { ...FIELDS }, code: newFollowUpCode(), ...over });

beforeEach(async () => {
  __resetOfflineStore();
  // other test files in the same process may leave a shimmed store behind; start each test empty
  for (const q of await listQueue()) await removeFromQueue(q.id);
});

describe("follow-up codes", () => {
  test("96 random bits, 24 hex characters, never repeated, never low-entropy", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = newFollowUpCode();
      expect(c).toMatch(/^[0-9A-F]{24}$/);
      expect(new Set(c).size).toBeGreaterThanOrEqual(8);
      seen.add(c);
    }
    expect(seen.size).toBe(2000);
  });
  test("a broken random source cannot produce a weak code", () => {
    expect(() => newFollowUpCode((b) => b.fill(0))).toThrow();
    let n = 0;
    const c = newFollowUpCode((b) => (n++ < 3 ? b.fill(7) : crypto.getRandomValues(b)));
    expect(new Set(c).size).toBeGreaterThanOrEqual(8);
  });
  test("display and entry round-trip; junk is rejected", () => {
    const c = newFollowUpCode();
    const shown = formatFollowUpCode(c);
    expect(shown).toMatch(/^WV-([0-9A-F]{4}-){5}[0-9A-F]{4}$/);
    expect(parseFollowUpCode(shown)).toBe(c);
    expect(parseFollowUpCode(` ${shown.toLowerCase()} `)).toBe(c);
    for (const bad of ["", "WV-1234", c.slice(1), c + "0", "G".repeat(24), "WV-" + "Z".repeat(24), "'; drop table x; --"]) expect(parseFollowUpCode(bad)).toBeNull();
  });
});

describe("the anonymous path carries nothing identifying", () => {
  const fakeClient = (log: any[], reply: any = { data: { status: "received" }, error: null }) => ({ rpc: async (fn: string, args: any) => { log.push({ fn, args }); return reply; }, auth: { getUser: async () => { throw new Error("must not be read"); }, getSession: async () => { throw new Error("must not be read"); } } }) as any;

  test("anonymous reports go through the session-less client, with exactly the report fields", async () => {
    const anon: any[] = [], main: any[] = [];
    __setAnonymousClient(fakeClient(anon));
    __testSetSupabaseClient(fakeClient(main));
    const i = { ...item(), savedAt: "x", state: "saved_on_device", attempts: 0 } as QueuedReport;
    expect((await sendReport(i)).kind).toBe("received");
    expect(main).toEqual([]); // the signed-in client was never touched
    expect(anon.length).toBe(1);
    expect(anon[0].fn).toBe("mg_wv_submit_anonymous");
    expect(Object.keys(anon[0].args).sort()).toEqual(["p_category", "p_code", "p_concerns", "p_description", "p_occurred", "p_previously", "p_site_code", "p_urgency"]);
    expect(JSON.stringify(anon[0].args)).not.toMatch(/user|email|employee|member|profile|session|token|device|agent|organization/i);
  });
  test("named and confidential reports use the signed-in client and say which mode", async () => {
    const anon: any[] = [], main: any[] = [];
    __setAnonymousClient(fakeClient(anon));
    __testSetSupabaseClient(fakeClient(main));
    await sendReport({ ...item({ mode: "confidential", siteId: "site-1", siteCode: undefined }), savedAt: "x", state: "saved_on_device", attempts: 0 } as QueuedReport);
    expect(anon).toEqual([]);
    expect(main[0].fn).toBe("mg_wv_submit");
    expect(main[0].args.p_mode).toBe("confidential");
  });
  test("server answers map to honest outcomes; transport failure is 'network', never 'received'", async () => {
    const run = async (reply: any) => { __setAnonymousClient({ rpc: async () => reply } as any); return (await sendReport({ ...item(), savedAt: "x", state: "saved_on_device", attempts: 0 } as QueuedReport)).kind; };
    expect(await run({ data: { status: "duplicate" }, error: null })).toBe("duplicate");
    expect(await run({ data: { status: "rate_limited" }, error: null })).toBe("rate_limited");
    expect(await run({ data: { status: "invalid_site_code" }, error: null })).toBe("invalid_site_code");
    expect(await run({ data: { status: "invalid", message: "x" }, error: null })).toBe("invalid");
    expect(await run({ data: null, error: { message: "Failed to fetch" } })).toBe("network");
    expect(await run({ data: null, error: null })).toBe("network");
    expect(await run({ data: {}, error: null })).toBe("network");
    __setAnonymousClient({ rpc: async () => { throw new TypeError("offline"); } } as any);
    expect((await sendReport({ ...item(), savedAt: "x", state: "saved_on_device", attempts: 0 } as QueuedReport)).kind).toBe("network");
  });
  test("the queue stores no account data: only what was typed plus the code", async () => {
    await enqueue(item());
    const stored = JSON.stringify(await listQueue());
    expect(stored).not.toMatch(/user|email|employee|session|token|profile|organization|member/i);
  });
});

describe("the device queue never claims 'sent' early", () => {
  const out = (kind: SendOutcome["kind"], message?: string): SendOutcome => (kind === "invalid" ? { kind, message: message ?? "bad" } : ({ kind } as SendOutcome));

  test("saved first, durable, and described as NOT received", async () => {
    const q = await enqueue(item());
    expect(q.state).toBe("saved_on_device");
    expect((await listQueue()).length).toBe(1);
    expect(describeItem(q)).toContain("has not received it");
  });
  test("offline (network failure): the item stays queued and is not reported as sent", async () => {
    const q = await enqueue(item());
    const res = await flushQueue({ signedIn: false, send: async () => out("network") });
    expect(res).toEqual([{ id: q.id, outcome: "network", sent: false }]);
    const left = await listQueue();
    expect(left.length).toBe(1);
    expect(left[0].state).toBe("saved_on_device");
    expect(left[0].attempts).toBe(1);
  });
  test("only 'received' or 'duplicate' removes it", async () => {
    for (const k of ["received", "duplicate"] as const) {
      const q = await enqueue(item());
      const res = await flushQueue({ signedIn: false, send: async () => out(k) });
      expect(res[0].sent).toBe(true);
      expect((await listQueue()).find((x) => x.id === q.id)).toBeUndefined();
    }
    for (const k of ["rate_limited", "network", "signed_out"] as const) {
      const q = await enqueue(item());
      await flushQueue({ signedIn: false, send: async () => out(k) });
      expect((await listQueue()).some((x) => x.id === q.id)).toBe(true);
      await removeFromQueue(q.id);
    }
  });
  test("a wrong site code or a rejected report needs attention and is not retried blindly", async () => {
    const q = await enqueue(item());
    await flushQueue({ signedIn: false, send: async () => out("invalid_site_code") });
    let cur = (await listQueue())[0];
    expect(cur.state).toBe("needs_attention");
    expect(describeItem(cur)).toContain("site code");
    let calls = 0;
    await flushQueue({ signedIn: false, send: async () => { calls++; return out("received"); } });
    expect(calls).toBe(0);
    await removeFromQueue(q.id);
    await enqueue(item());
    await flushQueue({ signedIn: false, send: async () => out("invalid", "Describe the concern in 10 to 4000 characters.") });
    cur = (await listQueue())[0];
    expect(cur.state).toBe("needs_attention");
    expect(describeItem(cur)).toContain("Describe the concern");
  });
  test("named/confidential items wait for a signed-in session; anonymous ones do not", async () => {
    await enqueue(item({ mode: "named", siteId: "s1", siteCode: undefined }));
    const a = await enqueue(item());
    const sent: string[] = [];
    await flushQueue({ signedIn: false, send: async (i) => { sent.push(i.mode); return out("received"); } });
    expect(sent).toEqual(["anonymous"]);
    expect((await listQueue()).map((x) => x.mode)).toEqual(["named"]);
    await flushQueue({ signedIn: true, send: async (i) => { sent.push(i.mode); return out("received"); } });
    expect(sent).toEqual(["anonymous", "named"]);
    void a;
  });
  test("concurrent flushes share one pass: an item is never posted twice at once", async () => {
    await enqueue(item());
    let posts = 0;
    const slow = async () => { posts++; await new Promise((r) => setTimeout(r, 20)); return out("received"); };
    await Promise.all([flushQueue({ signedIn: false, send: slow }), flushQueue({ signedIn: false, send: slow }), flushQueue({ signedIn: false, send: slow })]);
    expect(posts).toBe(1);
  });
  test("resending after a lost response uses the SAME code, so the server answers duplicate (no second report)", async () => {
    const q = await enqueue(item());
    const codes: string[] = [];
    await flushQueue({ signedIn: false, send: async (i) => { codes.push(i.code); return out("network"); } }); // response lost
    await flushQueue({ signedIn: false, send: async (i) => { codes.push(i.code); return out("duplicate"); } });
    expect(codes).toEqual([q.code, q.code]);
    expect(await listQueue()).toEqual([]);
  });
  test("a failed durable write surfaces instead of pretending it saved", async () => {
    const real = globalThis.localStorage;
    const idb = (globalThis as any).indexedDB;
    try {
      (globalThis as any).indexedDB = undefined;
      (globalThis as any).localStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined, key: () => null, length: 0, clear: () => undefined };
      __resetOfflineStore();
      await expect(enqueue(item())).rejects.toThrow();
    } finally {
      (globalThis as any).localStorage = real;
      (globalThis as any).indexedDB = idb;
      __resetOfflineStore();
    }
  });
});

describe("honest wording", () => {
  const all = JSON.stringify(MODE_INFO) + RETALIATION_NOTICE + ROUTING_NOTICE + PERSONAL_INFO_NOTICE;
  test("no absolute promise of anonymity or protection", () => {
    const affirmative = all.replace(/does not mean untraceable/gi, "");
    expect(affirmative).not.toMatch(/\b(100%|completely anonymous|totally anonymous|untraceable|guarantee[sd]? (your )?anonymity|cannot be traced|nobody can|no one can find)\b/i);
    expect(RETALIATION_NOTICE).toMatch(/cannot guarantee protection from retaliation/i);
    expect(MODE_INFO.anonymous.limits.join(" ")).toMatch(/not mean untraceable/i);
    expect(MODE_INFO.anonymous.limits.join(" ")).toMatch(/outside MineGuard/i);
    expect(MODE_INFO.anonymous.limits.join(" ")).toMatch(/independently certified/i);
  });
  test("each mode says who can see the identity", () => {
    expect(MODE_INFO.named.who).toMatch(/company administrator.*site manager.*safety officers/i);
    expect(MODE_INFO.confidential.who).toMatch(/Only a company administrator/);
    expect(MODE_INFO.confidential.who).toMatch(/recorded/);
    expect(MODE_INFO.anonymous.who).toMatch(/none is collected/);
  });
  test("it does not claim the Ministry or a regulator receives reports", () => {
    expect(ROUTING_NOTICE).toMatch(/not sent to the Ministry or to any regulator/);
    expect(all).not.toMatch(/regulator (will|receives)|ministry (will|receives|is notified)/i);
  });
  test("pages never describe a locally saved report as received", () => {
    const form = read("src/pages/voice/VoiceReport.tsx");
    expect(form).toContain("Saved on this device. Not yet received.");
    expect(form).toContain("Received by MineGuard");
    expect(form).toMatch(/phase === "received"/);
    expect(form).toContain("mineResult?.sent ? \"received\"");
  });
});

describe("wiring: nothing tracks, nothing leaks, everything reachable", () => {
  const files = ["src/lib/voice.ts", "src/lib/voice-queue.ts", "src/lib/voice-review.ts", "src/pages/voice/VoiceReport.tsx", "src/pages/voice/VoiceStatus.tsx", "src/pages/voice/VoicePublic.tsx", "src/pages/voice/VoiceReview.tsx"];
  test("no analytics, beacons, console logging or third-party anti-abuse services", () => {
    for (const f of files) {
      const s = read(f);
      expect(s).not.toMatch(/gtag|analytics|sentry|plausible|posthog|sendBeacon|recaptcha|hcaptcha|turnstile|fingerprint|navigator\.userAgent|navigator\.sendBeacon|console\.(log|info|debug)/i);
    }
  });
  test("the anonymous client persists nothing and the anonymous call never reads auth state", () => {
    const s = read("src/lib/voice.ts");
    expect(s).toContain("persistSession: false");
    expect(s).toContain("autoRefreshToken: false");
    const anonBranch = s.slice(s.indexOf('if (item.mode === "anonymous")'), s.indexOf("const { data, error } = await supabase.rpc(\"mg_wv_submit\""));
    expect(anonBranch).not.toMatch(/supabase\.(auth|rpc|from)|getUser|getSession/);
  });
  test("the public pages are public; the review queue and member form are inside the operator shell", () => {
    const m = read("src/main.tsx");
    expect(m).toContain('path="/voice" element={<VoicePublic />}');
    expect(m).toContain('path="/voice/status" element={<VoiceStatus />}');
    const operate = m.slice(m.indexOf('path="/operate"'), m.indexOf('path="/operate"') + 3500);
    expect(operate).toContain('path="voice" element={<VoiceReport />}');
    expect(operate).toContain('path="voice-review" element={<VoiceReview />}');
    expect(m.slice(0, m.indexOf('path="/operate"'))).not.toContain("VoiceReview />");
  });
  test("it is easy to find: operator navigation and the public landing page link to it", () => {
    expect(read("src/pages/operate/OperatorLayout.tsx")).toContain('"/operate/voice"');
    expect(read("src/pages/operate/OperatorLayout.tsx")).toContain('"/operate/voice-review"');
    expect(read("src/pages/Landing.tsx")).toContain('to="/voice"');
  });
  test("the review page never asks for, or renders, a confidential identity in its list", () => {
    const s = read("src/pages/voice/VoiceReview.tsx");
    expect(s).not.toMatch(/worker_voice_identity/);
    expect(read("src/lib/voice-review.ts")).not.toMatch(/worker_voice_identity/);
  });
  test("every form control has a label", () => {
    const s = read("src/pages/voice/VoiceReport.tsx");
    for (const id of ["wv-cat", "wv-urg", "wv-desc", "wv-when", "wv-site-code"]) expect(s).toContain(`htmlFor="${id}"`);
  });
});

describe("Voice review is only offered to reviewers", () => {
  test("the operator menu hides Voice review until the server says the person can review, and the page says so for everyone else", () => {
    const nav = read("src/pages/operate/OperatorLayout.tsx");
    expect(nav).toMatch(/voice-review.*voiceReviewOnly: true/);
    expect(nav).toContain("reviewerSites()");
    expect(nav).toContain("if (\"voiceReviewOnly\" in i && i.voiceReviewOnly) return canReviewVoice;");
    expect(nav).toContain("useState(false)"); // hidden until known
    expect(read("src/pages/voice/VoiceReview.tsx")).toContain("Reviewer access required");
  });
});
