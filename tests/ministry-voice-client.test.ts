/* eslint-disable @typescript-eslint/no-explicit-any -- fake clients */
// ---------------------------------------------------------------------------
// Worker Voice → Ministry — frontend behaviour (migration 0050): the channel is carried through the device
// queue, the anonymous Ministry call carries nothing identifying, follow-up codes are channel-prefixed,
// copy is honest, and the routes/nav/gating are in place. Backend enforcement: tests/ministry-voice.test.ts.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetOfflineStore } from "../src/lib/offline-store";
import { __testSetSupabaseClient } from "../src/lib/supabase";
import {
  __setAnonymousClient, formatFollowUpCode, lookupFollowUp, MINISTRY_CATEGORIES, MINISTRY_MODE_INFO, MINISTRY_ROUTING_NOTICE, newFollowUpCode,
  parseAnyFollowUpCode, parseFollowUpCode, ROUTING_NOTICE, sendReport, type QueuedReport,
} from "../src/lib/voice";
import { enqueue, flushQueue, listQueue, removeFromQueue } from "../src/lib/voice-queue";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const FIELDS = { category: "wages_or_benefits", urgency: "high", description: "Nobody at the crusher has been paid for six weeks.", occurredAt: null, previouslyReported: "no", concernsReviewer: false } as const;
const item = (over: Partial<QueuedReport> = {}) => ({ id: crypto.randomUUID(), channel: "ministry" as const, mode: "anonymous" as const, siteCode: "ABCDE12345", fields: { ...FIELDS }, code: newFollowUpCode(), ...over });
const fakeClient = (log: any[], reply: any = { data: { status: "received" }, error: null }) => ({ rpc: async (fn: string, args: any) => { log.push({ fn, args }); return reply; }, auth: { getUser: async () => { throw new Error("must not be read"); }, getSession: async () => { throw new Error("must not be read"); } } }) as any;

beforeEach(async () => {
  __resetOfflineStore();
  for (const q of await listQueue()) await removeFromQueue(q.id);
});

describe("follow-up codes name their channel", () => {
  test("Ministry codes display as MV-, company codes as WV-, and both round-trip", () => {
    const c = newFollowUpCode();
    expect(formatFollowUpCode(c, "ministry")).toMatch(/^MV-([0-9A-F]{4}-){5}[0-9A-F]{4}$/);
    expect(formatFollowUpCode(c)).toMatch(/^WV-/);
    expect(parseAnyFollowUpCode(formatFollowUpCode(c, "ministry"))).toEqual({ code: c, channel: "ministry" });
    expect(parseAnyFollowUpCode(` ${formatFollowUpCode(c).toLowerCase()} `)).toEqual({ code: c, channel: "company" });
    expect(parseAnyFollowUpCode(c)).toEqual({ code: c, channel: null });
    for (const bad of ["", "MV-1234", c + "0", "XV-" + c, "'; drop table x; --"]) expect(parseAnyFollowUpCode(bad)).toBeNull();
    // the company parser is unchanged and does not accept an MV code
    expect(parseFollowUpCode(formatFollowUpCode(c))).toBe(c);
    expect(parseFollowUpCode(formatFollowUpCode(c, "ministry"))).toBeNull();
  });

  test("status lookup goes to the channel the prefix names; no prefix tries company, then Ministry", async () => {
    const c = newFollowUpCode();
    const log: any[] = [];
    __setAnonymousClient(fakeClient(log, { data: { found: true, stage: "Received" }, error: null }));
    await lookupFollowUp(formatFollowUpCode(c, "ministry"));
    await lookupFollowUp(formatFollowUpCode(c));
    expect(log.map((l) => l.fn)).toEqual(["mg_mv_status", "mg_wv_status"]);
    const log2: any[] = [];
    __setAnonymousClient({ rpc: async (fn: string, args: any) => { log2.push({ fn, args }); return { data: { found: fn === "mg_mv_status" }, error: null }; } } as any);
    expect((await lookupFollowUp(c)).found).toBe(true);
    expect(log2.map((l) => l.fn)).toEqual(["mg_wv_status", "mg_mv_status"]);
    expect(log2.every((l) => Object.keys(l.args).join() === "p_code")).toBe(true);
    __setAnonymousClient(null);
  });
});

describe("sending to the Ministry", () => {
  test("anonymous goes through the session-less client to mg_mv_submit_anonymous with exactly the report fields", async () => {
    const anon: any[] = []; const signed: any[] = [];
    __setAnonymousClient(fakeClient(anon));
    __testSetSupabaseClient(fakeClient(signed));
    const i = item();
    expect((await sendReport(i as QueuedReport)).kind).toBe("received");
    expect(signed).toEqual([]);
    expect(anon).toHaveLength(1);
    expect(anon[0].fn).toBe("mg_mv_submit_anonymous");
    expect(Object.keys(anon[0].args).sort()).toEqual(["p_category", "p_code", "p_description", "p_occurred", "p_previously", "p_site_code", "p_urgency"]);
    __setAnonymousClient(null); __testSetSupabaseClient(null);
  });

  test("named and confidential use the signed-in client and say which mode; no company-only field is sent", async () => {
    const signed: any[] = [];
    __testSetSupabaseClient(fakeClient(signed));
    await sendReport(item({ mode: "confidential", siteId: "11111111-1111-4111-8111-111111111111", siteCode: undefined }) as QueuedReport);
    expect(signed[0].fn).toBe("mg_mv_submit");
    expect(signed[0].args.p_mode).toBe("confidential");
    expect("p_concerns" in signed[0].args).toBe(false);
    __testSetSupabaseClient(null);
  });

  test("an item with no channel is a company report, as before (items saved before this change keep working)", async () => {
    const signed: any[] = [];
    __testSetSupabaseClient(fakeClient(signed));
    const old = item({ mode: "named", siteId: "11111111-1111-4111-8111-111111111111", siteCode: undefined });
    delete (old as any).channel;
    await sendReport({ ...old, fields: { ...FIELDS, category: "unsafe_condition" } } as QueuedReport);
    expect(signed[0].fn).toBe("mg_wv_submit");
    __testSetSupabaseClient(null);
  });

  test("the queue keeps the channel, never claims 'sent' early, and removes an item only on received or duplicate", async () => {
    const q = await enqueue(item());
    expect(q.channel).toBe("ministry");
    expect(q.state).toBe("saved_on_device");
    const sent: string[] = [];
    await flushQueue({ signedIn: false, send: async (i) => { sent.push(i.channel ?? "company"); return { kind: "network" }; } });
    expect((await listQueue())[0].state).toBe("saved_on_device");
    await flushQueue({ signedIn: false, send: async (i) => { sent.push(i.channel ?? "company"); return { kind: "received" }; } });
    expect(await listQueue()).toEqual([]);
    expect(sent).toEqual(["ministry", "ministry"]);
  });
});

describe("honest wording", () => {
  const all = JSON.stringify(MINISTRY_MODE_INFO) + MINISTRY_ROUTING_NOTICE;
  test("no absolute promise of anonymity or protection", () => {
    const affirmative = all.replace(/does not mean untraceable/gi, "");
    expect(affirmative).not.toMatch(/\b(100%|completely anonymous|totally anonymous|untraceable|guarantee[sd]? (your )?anonymity|cannot be traced|nobody can|no one can find)\b/i);
    expect(MINISTRY_MODE_INFO.anonymous.limits.join(" ")).toMatch(/not mean untraceable/i);
    expect(MINISTRY_MODE_INFO.anonymous.limits.join(" ")).toMatch(/outside MineGuard/i);
    expect(MINISTRY_MODE_INFO.anonymous.limits.join(" ")).toMatch(/independently certified/i);
  });
  test("each mode says who can see the identity; the custodian of a confidential identity is a Ministry administrator", () => {
    expect(MINISTRY_MODE_INFO.named.who).toMatch(/Ministry reviewers can see who sent it/);
    expect(MINISTRY_MODE_INFO.confidential.who).toMatch(/Only a Ministry administrator/);
    expect(MINISTRY_MODE_INFO.confidential.who).toMatch(/recorded/);
    expect(MINISTRY_MODE_INFO.anonymous.who).toMatch(/none is collected/);
    expect(MINISTRY_MODE_INFO.anonymous.who).toMatch(/name your site and company/);
  });
  test("it says the company cannot see the report, and promises no outcome; the company channel still says it is not sent to the Ministry", () => {
    expect(MINISTRY_ROUTING_NOTICE).toMatch(/company.s administrators and managers cannot see it/);
    expect(MINISTRY_ROUTING_NOTICE).toMatch(/does not start an investigation by itself/);
    expect(ROUTING_NOTICE).toMatch(/not sent to the Ministry or to any regulator/);
  });
  test("the categories cover labour practices, unsafe work practices and work habits", () => {
    expect(new Set(MINISTRY_CATEGORIES.map((c) => c.group))).toEqual(new Set(["labour", "safety", "conduct", "other"]));
    expect(MINISTRY_CATEGORIES.map((c) => c.value)).toContain("wages_or_benefits");
    expect(MINISTRY_CATEGORIES.map((c) => c.value)).toContain("bad_work_habit");
  });
});

describe("wiring", () => {
  test("nothing tracks or logs in the Ministry files", () => {
    for (const f of ["src/lib/ministry-voice-review.ts", "src/pages/voice/MinistryVoiceReview.tsx"]) {
      expect(read(f)).not.toMatch(/gtag|analytics|sentry|plausible|posthog|sendBeacon|recaptcha|hcaptcha|turnstile|fingerprint|navigator\.userAgent|console\.(log|info|debug)/i);
    }
  });
  test("the Ministry review page is inside the staff portal and gated; it is not in the operator (company) shell", () => {
    const m = read("src/main.tsx");
    const portal = m.slice(m.indexOf('path="/portal"'));
    expect(portal).toContain('path="voice-ministry" element={<MinistryVoiceReview />}');
    expect(m.slice(0, m.indexOf('path="/portal"'))).not.toContain("<MinistryVoiceReview />");
    expect(read("src/pages/PortalLayout.tsx")).toMatch(/"\/portal\/voice-ministry".*reviewerOnly: true/);
    expect(read("src/pages/operate/OperatorLayout.tsx")).not.toContain("voice-ministry");
  });
  test("the company review page does not call any Ministry function, and the Ministry page calls no company one", () => {
    expect(read("src/lib/voice-review.ts")).not.toMatch(/mg_mv_|ministry_voice/);
    expect(read("src/lib/ministry-voice-review.ts")).not.toMatch(/mg_wv_|worker_voice/);
  });
  test("the Ministry review lib never reads the identity table, and opening an identity is a separate action", () => {
    const lib = read("src/lib/ministry-voice-review.ts");
    expect(lib).not.toMatch(/ministry_voice_identity/);
    expect(lib).toContain('"mg_mv_identity"');
    expect(read("src/pages/voice/MinistryVoiceReview.tsx")).not.toMatch(/ministry_voice_identity/);
  });
  test("the report form offers the channel choice and labels the controls", () => {
    const s = read("src/pages/voice/VoiceReport.tsx");
    expect(s).toContain("Who should receive this?");
    expect(s).toContain('name="wv-channel"');
    expect(s).toContain("MINISTRY_ROUTING_NOTICE");
    expect(s).toContain("Saved on this device. Not yet received.");
    expect(s).toContain('mineResult?.sent ? "received"');
  });
});
