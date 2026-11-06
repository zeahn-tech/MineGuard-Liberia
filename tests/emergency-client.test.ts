// ---------------------------------------------------------------------------
// Emergency alerts — client side: offline acknowledgment queue, status wording rules,
// push dispatcher logic and the service worker's push handling.
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  __resetOfflineQueue,
  enqueueEmergencyAck,
  ensureOfflineReady,
  readQueue,
  syncQueue,
} from "../src/lib/offline-queue";
import {
  ackView,
  clientNeedsReload,
  confirmationMatches,
  describeFreshness,
  explainEmergencyError,
  EMERGENCY_API_VERSION,
  STALE_AFTER_MS,
  urlBase64ToUint8Array,
} from "../src/lib/emergency";
import {
  buildPayload,
  classifyPushStatus,
  endpointAllowed,
  handleDispatch,
  type Claimed,
  type DispatchDeps,
} from "../supabase/functions/_shared/emergency/dispatch";

const store = new Map<string, string>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
beforeEach(async () => {
  store.clear();
  await __resetOfflineQueue();
  await ensureOfflineReady();
});

const A = "11111111-1111-4111-8111-111111111111";

describe("offline acknowledgment queue", () => {
  const item = { clientRef: `ack-${A}-1`, siteId: "s1", siteCode: "LR-1", alertId: A, revision: 1 };

  test("an acknowledgment tapped offline is persisted first and is not lost", async () => {
    await enqueueEmergencyAck(item);
    const q = readQueue();
    expect(q).toHaveLength(1);
    expect(q[0].kind).toBe("emergencyAck");
    expect(q[0].status).toBe("pending");
    expect(q[0].emergencyAck).toMatchObject({ alertId: A, revision: 1 });
    expect(JSON.stringify(q[0])).not.toMatch(/user_?id/i); // nothing in the payload names who
  });

  test("double-tap / replay produces a single queue entry", async () => {
    await enqueueEmergencyAck(item);
    await enqueueEmergencyAck(item);
    expect(readQueue()).toHaveLength(1);
  });

  test("on reconnect it syncs through the handler with the original client time and ref", async () => {
    await enqueueEmergencyAck({ ...item, seenAt: 1_700_000_000_000 });
    const calls: unknown[] = [];
    const r = await syncQueue({ acknowledgeEmergency: async (a) => void calls.push(a) }, { force: true });
    expect(r.synced).toBe(1);
    expect(calls[0]).toEqual({ alertId: A, revision: 1, clientRef: item.clientRef, seenAt: 1_700_000_000_000 });
  });

  test("with no handler bound the acknowledgment is kept for a later run, never silently dropped", async () => {
    await enqueueEmergencyAck(item);
    await syncQueue({}, { force: true });
    expect(readQueue().filter((q) => q.kind === "emergencyAck")).toHaveLength(1);
  });

  test("a refusal (e.g. membership revoked) parks the item instead of retrying forever", async () => {
    await enqueueEmergencyAck(item);
    const r = await syncQueue({ acknowledgeEmergency: async () => { throw new Error("FORBIDDEN: this alert is not addressed to you"); } }, { force: true });
    expect(r.dead).toBe(1);
    expect(readQueue()[0].status).toBe("dead");
  });

  test("a network failure is retried with backoff", async () => {
    await enqueueEmergencyAck(item);
    const r = await syncQueue({ acknowledgeEmergency: async () => { throw new Error("Failed to fetch"); } }, { force: true });
    expect(r.failed).toBe(1);
    expect(readQueue()[0].status).not.toBe("dead");
  });
});

describe("what the screen is allowed to claim", () => {
  const now = 10_000_000;
  test("offline or failed checks say the information may be out of date and point to physical systems", () => {
    const off = describeFreshness(now - 5 * 60_000, now, false, false);
    expect(off.level).toBe("stale");
    expect(off.message).toMatch(/may be out of date/);
    expect(off.message).toMatch(/radio, sirens and your site's procedure/);
    expect(describeFreshness(now - 1000, now, true, true).level).toBe("stale");
  });
  test("recent online check is live; an old one is stale; never-checked is unknown", () => {
    expect(describeFreshness(now - 1000, now, true, false).level).toBe("live");
    expect(describeFreshness(now - STALE_AFTER_MS - 1, now, true, false).level).toBe("stale");
    expect(describeFreshness(null, now, true, false).level).toBe("unknown");
  });
  test("acknowledgment state: saved-on-device is not shown as acknowledged; an update re-opens it", () => {
    const base = { revision: 2, status: "active" as const };
    expect(ackView({ ...base, my_ack_revision: null }, null).state).toBe("needed");
    expect(ackView({ ...base, my_ack_revision: null }, 2).state).toBe("saved_on_device");
    expect(ackView({ ...base, my_ack_revision: 2 }, null).state).toBe("acknowledged");
    expect(ackView({ ...base, my_ack_revision: 1 }, null).state).toBe("needed_after_update");
  });
  test("confirmation words are exact; error tokens become plain language", () => {
    expect(confirmationMatches("activate", "ACTIVATE")).toBe(true);
    expect(confirmationMatches("activate", "activate")).toBe(false);
    expect(confirmationMatches("cancel", "RESOLVE")).toBe(false);
    expect(explainEmergencyError(new Error("CONFLICT: STALE_REVISION (current 3)"))).toMatch(/changed by someone else/);
    expect(explainEmergencyError(new Error("FORBIDDEN: nope"))).toMatch(/not authorized/);
  });
  test("a cached app older than the server is told to reload", () => {
    expect(clientNeedsReload(EMERGENCY_API_VERSION)).toBe(false);
    expect(clientNeedsReload(EMERGENCY_API_VERSION + 1)).toBe(true);
  });
  test("VAPID key decoding", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
  });
});

describe("push dispatcher", () => {
  const claimed = (over: Partial<Claimed> = {}): Claimed => ({
    delivery_id: "d1", alert_id: A, event: "activated", revision: 1, title: "Pit wall", severity: "critical",
    endpoint: "https://fcm.googleapis.com/send/abc", p256dh: "k", auth: "a", ...over,
  });
  function deps(over: { allowed?: boolean; rows?: Claimed[]; sender?: DispatchDeps["sender"] } = {}) {
    const recorded: Array<Record<string, unknown>> = [];
    let claimCalls = 0;
    const d: DispatchDeps = {
      caller: { rpc: async () => ({ data: over.allowed ?? true, error: null }) },
      service: {
        rpc: async (fn, args) => {
          if (fn === "mg_emergency_claim_push") { claimCalls++; return { data: over.rows ?? [claimed()], error: null }; }
          recorded.push(args ?? {});
          return { data: null, error: null };
        },
      },
      sender: over.sender === undefined ? async () => ({ status: 201 }) : over.sender,
    };
    return { d, recorded, claimCalls: () => claimCalls };
  }

  test("an unauthorized caller reaches no privileged action", async () => {
    const x = deps({ allowed: false });
    const r = await handleDispatch(x.d, { alertId: A });
    expect(r.status).toBe(403);
    expect(x.claimCalls()).toBe(0);
  });
  test("malformed input is refused before anything else", async () => {
    expect((await handleDispatch(deps().d, { alertId: "x" })).status).toBe(400);
    expect((await handleDispatch(deps().d, null)).status).toBe(400);
  });
  test("a 201 is recorded as service-accepted and the response says that is not receipt", async () => {
    const x = deps();
    const r = await handleDispatch(x.d, { alertId: A });
    expect(x.recorded[0]).toMatchObject({ p_outcome: "accepted" });
    expect(String(r.body.detail)).toMatch(/do not confirm any device received/);
  });
  test("without VAPID nothing is sent and rows say not_configured", async () => {
    const x = deps({ sender: null });
    const r = await handleDispatch(x.d, { alertId: A });
    expect(x.recorded[0]).toMatchObject({ p_outcome: "not_configured" });
    expect(r.body.ok).toBe(false);
    expect(String(r.body.detail)).toMatch(/not configured/);
  });
  test("expired, throttled, refused and unreachable are told apart", () => {
    expect(classifyPushStatus(201)).toBe("accepted");
    expect(classifyPushStatus(410)).toBe("expired");
    expect(classifyPushStatus(404)).toBe("expired");
    expect(classifyPushStatus(429)).toBe("retry");
    expect(classifyPushStatus(503)).toBe("retry");
    expect(classifyPushStatus(400)).toBe("rejected");
  });
  test("a network error is retried, not recorded as delivered", async () => {
    const x = deps({ sender: async () => { throw new Error("socket"); } });
    await handleDispatch(x.d, { alertId: A });
    expect(x.recorded[0]).toMatchObject({ p_outcome: "retry" });
  });
  test("non-https, loopback and private endpoints are never contacted", async () => {
    for (const e of ["http://x.test/a", "https://localhost/a", "https://127.0.0.1/a", "https://10.0.0.5/a", "https://169.254.169.254/a", "https://[::1]/a", "https://svc.internal/a"]) {
      expect(endpointAllowed(e)).toBe(false);
    }
    expect(endpointAllowed("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    let sent = 0;
    const x = deps({ rows: [claimed({ endpoint: "https://10.0.0.5/a" })], sender: async () => { sent++; return { status: 201 }; } });
    await handleDispatch(x.d, { alertId: A });
    expect(sent).toBe(0);
    expect(x.recorded[0]).toMatchObject({ p_outcome: "rejected" });
  });
  test("the push payload carries no instructions or location detail", () => {
    const p = JSON.parse(buildPayload({ alert_id: A, event: "activated", revision: 1, title: "T", severity: "critical", ...({ instructions: "SECRET", assembly_point: "Gate 2" } as object) }));
    expect(Object.keys(p).sort()).toEqual(["event", "id", "revision", "severity", "title", "v"]);
    expect(JSON.stringify(p)).not.toMatch(/SECRET|Gate 2/);
  });
});

describe("service worker push handling", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  test("handles push, notification click and subscription change", () => {
    expect(sw).toMatch(/addEventListener\("push"/);
    expect(sw).toMatch(/addEventListener\("notificationclick"/);
    expect(sw).toMatch(/addEventListener\("pushsubscriptionchange"/);
  });
  test("always shows a visible notification and never puts instructions in it", () => {
    const push = sw.slice(sw.indexOf('addEventListener("push"'), sw.indexOf('addEventListener("notificationclick"'));
    expect(push).toMatch(/showNotification/);
    expect(sw).not.toMatch(/\b(?:d|p)\.(?:instructions|assembly)/); // payload fields are never read
    expect(push).not.toMatch(/assembly/);
    expect(push).toMatch(/siren/i); // reminds workers physical systems come first
  });
  test("payload fields are validated and the cache never stores API responses", () => {
    expect(sw).toMatch(/\[0-9a-f-\]\{36\}/);
    expect(sw).toMatch(/endsWith\("supabase\.co"\)[\s\S]{0,120}return;/); // backend traffic is never cached
  });
  test("the cache version was bumped so devices pick up the new worker", () => {
    expect(sw).not.toMatch(/VERSION = "v1\.3\.2"/);
  });
});
