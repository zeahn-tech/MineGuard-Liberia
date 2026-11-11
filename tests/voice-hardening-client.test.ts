/* eslint-disable @typescript-eslint/no-explicit-any -- fake clients and loosely typed RPC results */
// ---------------------------------------------------------------------------
// Worker Voice hardening — frontend behaviour: photo cleaning, per-channel codes, replies, honest wording,
// routing away from the company when a concern is about its management, and the wiring of the new screens.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetOfflineStore } from "../src/lib/offline-store";
import { __testSetSupabaseClient } from "../src/lib/supabase";
import {
  __setAnonymousClient, ABOUT_MANAGEMENT_NOTICE, memberSiteCode, MINISTRY_OPTION_NOTICE, newFollowUpCode, PHOTO_NOTICE, replyMine,
  replyWithCode, sendReport, siteInfoByCode, SMALL_SITE_NOTICE, type QueuedReport,
} from "../src/lib/voice";
import { bytesToBase64, sanitizeJpeg } from "../src/lib/voice-image";
import { enqueue, flushQueue, listQueue, removeFromQueue } from "../src/lib/voice-queue";
import { explainRequestError, REQUEST_TOPICS } from "../src/lib/ministry-voice-review";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const rpcLog = (log: any[], reply: any = { data: { status: "received" }, error: null }) => ({ rpc: async (fn: string, args: any) => { log.push({ fn, args }); return reply; } }) as any;
const FIELDS = { category: "unsafe_condition", urgency: "high", description: "The berm at the north haul road has collapsed.", occurredAt: null, previouslyReported: "no", concernsReviewer: false } as const;
const item = (over: Partial<QueuedReport> = {}) => ({ id: crypto.randomUUID(), channel: "company" as const, mode: "anonymous" as const, siteCode: "ABCDE12345", fields: { ...FIELDS }, code: newFollowUpCode(), savedAt: "x", state: "saved_on_device" as const, attempts: 0, ...over }) as QueuedReport;

beforeEach(async () => {
  __resetOfflineStore();
  for (const q of await listQueue()) await removeFromQueue(q.id);
});

// ---- a synthetic JPEG with the structure the server checks -----------------------------------------------
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const seg = (m: number, d: number[]) => [0xff, m, ...u16(d.length + 2), ...d];
const JFIF16 = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const EXIF = seg(0xe1, [...Buffer.from("Exif\0\0"), 1, 2, 3, 4, 5, 6, 7, 8]);
const jpg = (before: number[] = [], o: { w?: number; after?: number[]; eoi?: boolean } = {}) => Uint8Array.from([
  0xff, 0xd8, ...before,
  ...seg(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => 1 + (i % 7))]),
  ...seg(0xc0, [8, ...u16(480), ...u16(o.w ?? 640), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  ...seg(0xc4, [0, ...Array.from({ length: 28 }, (_, i) => i % 5)]),
  ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
  ...Array.from({ length: 200 }, (_, i) => (i * 37 + 11) % 250), ...(o.after ?? []), ...(o.eoi === false ? [] : [0xff, 0xd9]),
]);
const has = (b: Uint8Array, m: number) => { for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === m) return true; return false; };

describe("photo cleaning on the device", () => {
  test("EXIF, comments, ICC and thumbnails are removed; the picture data is kept intact", () => {
    const dirty = jpg([...JFIF16, ...EXIF, ...seg(0xfe, [...Buffer.from("taken by Wale")]), ...seg(0xe2, [...Buffer.from("ICC_PROFILE\0"), 1, 1])]);
    const r = sanitizeJpeg(dirty);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const m of [0xe1, 0xe2, 0xfe]) expect(has(r.bytes, m)).toBe(false);
    expect(Buffer.from(r.bytes).includes(Buffer.from("Wale"))).toBe(false);
    expect(Buffer.from(r.bytes).includes(Buffer.from("Exif"))).toBe(false);
    const tail = (b: Uint8Array) => Buffer.from(b.subarray(b.length - 150)).toString("hex");
    expect(tail(r.bytes)).toBe(tail(dirty));
  });
  test("refused: not a JPEG, too large in pixels, incomplete, or hiding metadata after the scan", () => {
    expect(sanitizeJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...Array(200).fill(1)])).ok).toBe(false);
    expect(sanitizeJpeg(jpg([], { w: 5000 })).ok).toBe(false);
    expect(sanitizeJpeg(jpg([], { eoi: false })).ok).toBe(false);
    expect(sanitizeJpeg(jpg([], { after: EXIF })).ok).toBe(false);
    expect(sanitizeJpeg(new Uint8Array(10)).ok).toBe(false);
  });
  test("base64 round-trips large files", () => {
    const big = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) % 256);
    expect(Buffer.from(bytesToBase64(big), "base64").equals(Buffer.from(big))).toBe(true);
  });
  test("photos travel in the same submission on both channels; none means null", async () => {
    const calls: any[] = [];
    __setAnonymousClient(rpcLog(calls));
    const r = sanitizeJpeg(jpg([...EXIF]));
    if (!r.ok) throw new Error("x");
    await sendReport(item({ attachments: [bytesToBase64(r.bytes)] }));
    await sendReport(item({ channel: "ministry", fields: { ...FIELDS, category: "working_hours" as any } }));
    await sendReport(item({ channel: "ministry", attachments: [bytesToBase64(r.bytes)], fields: { ...FIELDS, category: "working_hours" as any } }));
    expect(calls.map((c) => c.fn)).toEqual(["mg_wv_submit_anonymous", "mg_mv_submit_anonymous", "mg_mv_submit_anonymous"]);
    expect(calls[0].args.p_attachments).toHaveLength(1);
    expect(calls[1].args.p_attachments).toBeNull();
    expect(calls[2].args.p_attachments).toHaveLength(1);
  });
});

describe("each channel has its own code, replies and site information", () => {
  test("a member's app asks for the CHANNEL's code, not the company's code for both", async () => {
    const calls: any[] = [];
    __testSetSupabaseClient(rpcLog(calls, { data: "ABCDE12345", error: null }));
    expect(await memberSiteCode("company", "s1")).toBe("ABCDE12345");
    expect(await memberSiteCode("ministry", "s1")).toBe("ABCDE12345");
    expect(calls.map((c) => c.fn)).toEqual(["mg_wv_site_code", "mg_mv_site_code"]);
  });
  test("site information comes from the matching channel through the session-less client", async () => {
    const anon: any[] = [], main: any[] = [];
    __setAnonymousClient(rpcLog(anon, { data: { valid: true, smallSite: true, paused: false }, error: null }));
    __testSetSupabaseClient(rpcLog(main));
    expect(await siteInfoByCode("abcde-12345", "ministry")).toMatchObject({ valid: true, smallSite: true });
    await siteInfoByCode("abcde-12345", "company");
    expect(anon.map((c) => c.fn)).toEqual(["mg_mv_site_info", "mg_wv_site_info"]);
    expect(anon[0].args).toEqual({ p_site_code: "ABCDE12345" });
    expect(main).toEqual([]);
  });
  test("replying with a code uses the session-less client, sends only the code and text, and maps every answer honestly", async () => {
    const calls: any[] = [];
    const code = newFollowUpCode();
    __testSetSupabaseClient({ rpc: async () => { throw new Error("signed-in client must not be used"); } } as any);
    __setAnonymousClient(rpcLog(calls));
    expect(await replyWithCode(`WV-${code}`, "More detail", "company")).toBe("received");
    expect(await replyWithCode(`MV-${code}`, "More detail", "ministry")).toBe("received");
    expect(calls.map((c) => c.fn)).toEqual(["mg_wv_reply", "mg_mv_reply"]);
    expect(Object.keys(calls[0].args).sort()).toEqual(["p_code", "p_text"]);
    for (const st of ["rate_limited", "invalid", "not_found", "closed"] as const) { __setAnonymousClient(rpcLog([], { data: { status: st }, error: null })); expect(await replyWithCode(`WV-${code}`, "x", "company")).toBe(st); }
    __setAnonymousClient(rpcLog([], { data: null, error: { message: "Failed to fetch" } })); expect(await replyWithCode(`WV-${code}`, "x", "company")).toBe("network");
    __setAnonymousClient(rpcLog([], { data: { status: "surprise" }, error: null })); expect(await replyWithCode(`WV-${code}`, "x", "company")).toBe("network");
    expect(await replyWithCode("not a code", "x", "company")).toBe("not_found");
  });
  test("a signed-in reporter replies from their own list, per channel", async () => {
    const calls: any[] = [];
    __testSetSupabaseClient(rpcLog(calls, { data: null, error: null }));
    await replyMine("r1", "hello", "company"); await replyMine("r2", "hello", "ministry");
    expect(calls.map((c) => c.fn)).toEqual(["mg_wv_reply_mine", "mg_mv_reply_mine"]);
  });
  test("a paused site stops the queued report and says why, instead of retrying forever", async () => {
    await enqueue(item());
    await flushQueue({ signedIn: false, send: async () => ({ kind: "anonymous_paused" }) });
    const q = (await listQueue())[0];
    expect(q.state).toBe("needs_attention");
    expect(q.attention).toMatch(/paused/i);
  });
});

describe("honest wording", () => {
  test("small-site, photo and routing notices say what they should", () => {
    expect(SMALL_SITE_NOTICE).toMatch(/fewer than 10/); expect(SMALL_SITE_NOTICE).toMatch(/only the day/);
    expect(PHOTO_NOTICE).toMatch(/What the picture shows is not removed/); expect(PHOTO_NOTICE).toMatch(/not scanned for viruses/); expect(PHOTO_NOTICE).toMatch(/never through a link/);
    expect(ABOUT_MANAGEMENT_NOTICE).toMatch(/Ministry/); expect(ABOUT_MANAGEMENT_NOTICE).toMatch(/cannot see the Ministry channel/);
    expect(MINISTRY_OPTION_NOTICE).toMatch(/not linked/); expect(MINISTRY_OPTION_NOTICE).toMatch(/will not see the Ministry one/);
  });
  test("the form no longer calls a concern about a company administrator a dead end, and blocks sending it to the company", () => {
    const f = read("src/pages/voice/VoiceReport.tsx");
    expect(f).not.toMatch(/no higher route/);
    expect(f).toContain("ABOUT_MANAGEMENT_NOTICE");
    expect(f).toContain("Send it to the Ministry instead");
    expect(f).toMatch(/!ministry && about === "management"/);
  });
  test("the status page offers the Ministry channel to an unresolved or closed company report without linking them", () => {
    const f = read("src/pages/voice/VoiceStatus.tsx");
    expect(f).toContain("res.ministryOption");
    expect(f).toContain("MINISTRY_OPTION_NOTICE");
  });
  test("the company page tells company reviewers the Ministry code is not theirs, and the Ministry page says the converse", () => {
    expect(read("src/pages/voice/VoiceReview.tsx")).toMatch(/Reports to the Ministry use a separate code that only the Ministry controls/);
    expect(read("src/components/voice/MinistryExtras.tsx")).toMatch(/a company cannot see them in its review pages, rotate them or pause them/);
  });
  test("request errors are plain, and the topic list contains no child or forced labour template", () => {
    expect(explainRequestError(new Error("TOO_FEW: x"))).toMatch(/without risking identifying a reporter/);
    expect(explainRequestError(new Error("CONFLICT: this company was already asked"))).toMatch(/30 days/);
    expect(REQUEST_TOPICS.map((t) => t.value).join(" ")).not.toMatch(/child|forced/);
  });
  test("the requests screens warn that nothing from a report belongs in a request, and the company is not told whether reports exist", () => {
    expect(read("src/components/voice/MinistryExtras.tsx")).toMatch(/Do not put anything in the note that came from a report/);
    expect(read("src/components/voice/MinistryExtras.tsx")).toMatch(/at least three reports on that topic/);
    expect(read("src/pages/voice/MinistryRequests.tsx")).toMatch(/does not tell you whether anyone has reported anything/);
  });
});

describe("wiring", () => {
  test("no tracking or third-party services in any new screen or library", () => {
    for (const f of ["src/components/voice/VoiceBits.tsx", "src/components/voice/MinistryExtras.tsx", "src/pages/voice/MinistryRequests.tsx", "src/lib/voice-image.ts", "src/pages/voice/VoiceReport.tsx", "src/pages/voice/VoiceStatus.tsx"]) {
      expect(read(f)).not.toMatch(/gtag|analytics|sentry|plausible|posthog|sendBeacon|recaptcha|hcaptcha|turnstile|fingerprint|navigator\.userAgent|console\.(log|info|debug)/i);
    }
  });
  test("the Ministry-only panels are shown only to a Ministry administrator, and requests are gated like the review page", () => {
    const m = read("src/pages/voice/MinistryVoiceReview.tsx");
    expect(m).toMatch(/user\?\.role === "admin" && <CodesPanel/);
    expect(m).toMatch(/user\?\.role === "admin" && <RequestsPanel/);
    expect(read("src/pages/operate/OperatorLayout.tsx")).toMatch(/ministry-requests"[^}]*voiceReviewOnly: true/);
    expect(read("src/main.tsx")).toContain('path="ministry-requests" element={<MinistryRequests />}');
  });
  test("the service worker handles exactly three fixed payload kinds and shows only generic text", () => {
    const sw = read("public/sw.js");
    const block = sw.slice(sw.indexOf("const VOICE_PUSH"), sw.indexOf("const p = emergencyPayload(event)"));
    for (const k of ['wv:', 'mv:', 'mr:']) expect(block).toContain(k);
    expect(block).toContain("Sign in with your authorized account");
    expect(block).not.toMatch(/d\.(id|title|body|text|category|mode)/);
    expect(sw).toContain("emergencyPayload(event)");
  });
  test("the device queue is still disclosed in the cookie policy, including photos", () => {
    expect(read("src/pages/Cookies.tsx")).toMatch(/any photos you attached \(with camera and location data already removed\)/);
  });
});
