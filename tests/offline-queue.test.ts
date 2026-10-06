// ---------------------------------------------------------------------------
// MINEGUARD LIBERIA — OFFLINE QUEUE SUITE (doc 13 test strategy)
// Runner: `bun test` (bun:test). Covers the pure logic helpers and the
// offline queue sync engine — the highest-risk, fully local units.
//
// Session 4 (OFF-1…4): the queue is now durable-first (IndexedDB via
// offline-store, localStorage fallback here — Bun has no IndexedDB), every
// mutation is async and surfaced, failures carry a classification and a
// backoff window, and 409 conflicts park for human resolution. The tests
// below exercise exactly those semantics.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "bun:test";
import {
  enqueueInspectionSubmission,
  enqueueIncidentReport,
  enqueueObservationReport,
  enqueueCaResponse,
  ensureOfflineReady,
  newClientRef,
  readDrafts,
  readQueue,
  syncQueue,
  upsertDraft,
  deleteDraft,
  readDraft,
  pendingCount,
  removeQueueItem,
  updateQueueItem,
  retryQueueItem,
  resolveConflictKeepMine,
  buildQueueExport,
  __resetOfflineQueue,
} from "../src/lib/offline-queue";
import { NotSavedError } from "../src/lib/offline-store";

// Minimal localStorage for the bun runtime (browser provides it natively).
const store = new Map<string, string>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

// Flush each test so queue state never leaks between cases (the durable
// store caches an in-memory mirror — reset BOTH layers).
beforeEach(async () => {
  store.clear();
  await __resetOfflineQueue();
  await ensureOfflineReady();
});

describe("site code generator (types.ts)", () => {
  test("nextSiteCodeFrom increments per-county sequence", async () => {
    const { nextSiteCodeFrom } = await import("../src/lib/types");
    expect(nextSiteCodeFrom("Nimba", [])).toBe("MGL-NIMBA-0001");
    expect(nextSiteCodeFrom("Nimba", ["MGL-NIMBA-0001"])).toBe("MGL-NIMBA-0002");
    expect(
      nextSiteCodeFrom("Nimba", ["MGL-NIMBA-0007", "MGL-LOFA-0002"]),
    ).toBe("MGL-NIMBA-0008");
    expect(nextSiteCodeFrom("Grand Cape Mount", [])).toBe("MGL-GRANDC-0001");
  });
});

describe("tracking code format", () => {
  test("makeTrackingCode yields CR-prefixed unique codes", async () => {
    const { makeTrackingCode } = await import("../src/lib/types");
    const a = makeTrackingCode();
    const b = makeTrackingCode();
    expect(a).toMatch(/^CR-[A-Z0-9]+$/);
    expect(a).not.toEqual(b);
  });
});

describe("authorization mirror (canAccessSite)", () => {
  test("admin sees everything; operator is tenant-locked", async () => {
    const { canAccessSite, ROLES } = await import("../src/lib/types");
    const site = { county: "Nimba", operatorName: "Nimba Aggregates Demo" };
    expect(canAccessSite({ role: ROLES.ADMIN }, site)).toBe(true);
    expect(
      canAccessSite(
        { role: ROLES.OPERATOR, operatorName: "Nimba Aggregates Demo" },
        site,
      ),
    ).toBe(true);
    expect(
      canAccessSite(
        { role: ROLES.OPERATOR, operatorName: "Other Operator" },
        site,
      ),
    ).toBe(false);
    expect(canAccessSite({ role: ROLES.OPERATOR }, site)).toBe(false);
    expect(
      canAccessSite({ role: ROLES.INSPECTOR, scope: "national" }, site),
    ).toBe(true);
    expect(
      canAccessSite(
        { role: ROLES.INSPECTOR, scope: "county", county: "Nimba" },
        site,
      ),
    ).toBe(true);
    expect(
      canAccessSite(
        { role: ROLES.INSPECTOR, scope: "county", county: "Lofa" },
        site,
      ),
    ).toBe(false);
    expect(canAccessSite({ role: ROLES.INSPECTOR }, site)).toBe(false);
  });
});

describe("offline queue: inspection submissions", () => {
  test("enqueue persists before sync and dedupes by clientRef", async () => {
    const ref = newClientRef();
    await enqueueInspectionSubmission({
      clientRef: ref,
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: { "0:0": true },
    });
    await enqueueInspectionSubmission({
      clientRef: ref,
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: { "0:0": true },
    });
    expect(readQueue()).toHaveLength(1);
    expect(pendingCount()).toBe(1);
    // The durable layer holds it, not just the mirror (OFF-1).
    const raw = store.get("mg.offline.queue.v1");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toHaveLength(1);
  });

  test("drafts persist and delete cleanly", async () => {
    await upsertDraft({
      clientRef: "d1",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: {},
      updatedAt: Date.now(),
    });
    expect(readDraft("d1")?.siteId).toBe("s1");
    await deleteDraft("d1");
    expect(readDraft("d1")).toBeUndefined();
    expect(readDrafts()).toHaveLength(0);
  });
});

describe("offline queue: incident + observation submissions", () => {
  test("incident report persists payload and dedupes by clientRef", async () => {
    const ref = newClientRef();
    const item = {
      clientRef: ref,
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      type: "injury",
      severity: "medium",
      description: "Laceration from screen mesh",
      occurredAt: Date.now() - 1000,
      injured: 1,
    };
    await enqueueIncidentReport(item);
    await enqueueIncidentReport(item); // same clientRef again must not duplicate
    expect(readQueue()).toHaveLength(1);
    const q = readQueue()[0];
    expect(q.kind).toBe("incidentReport");
    expect(q.payload?.type).toBe("injury");
    expect(q.payload?.injured).toBe(1);
  });

  test("observation report persists payload including GPS", async () => {
    await enqueueObservationReport({
      clientRef: "obs-1",
      siteId: "s2",
      siteCode: "MGL-LOFA-0001",
      category: "water_pollution",
      verification: "measured",
      description: "Turbidity elevated downstream",
      observedAt: Date.now(),
      latitude: 7.6067,
      longitude: 9.4236,
    });
    const item = readQueue().find((q) => q.clientRef === "obs-1");
    expect(item?.kind).toBe("observationReport");
    expect(item?.payload?.category).toBe("water_pollution");
    expect(item?.latitude).toBeCloseTo(7.6067);
    expect(item?.longitude).toBeCloseTo(9.4236);
  });
});

describe("sync engine", () => {
  test("successful incident sync removes the item and reports synced", async () => {
    await enqueueIncidentReport({
      clientRef: "inc-1",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      type: "fire",
      severity: "high",
      description: "Fuel storage fire",
      occurredAt: Date.now(),
    });
    const calls: string[] = [];
    const { synced, failed } = await syncQueue({
      reportIncident: async (args) => {
        calls.push(`incident:${(args as { clientRef?: string }).clientRef}`);
        return "srv-inc-1";
      },
    });
    expect(synced).toBe(1);
    expect(failed).toBe(0);
    expect(readQueue()).toHaveLength(0);
    expect(calls).toEqual(["incident:inc-1"]);
    // OFF-6: the clientRef → server id mapping is recorded for local-parent
    // evidence resolution.
    const { resolveLocalRef } = await import("../src/lib/offline-store");
    expect(await resolveLocalRef("inc-1")).toBe("srv-inc-1");
  });

  test("failed sync keeps the item queued with retry info (never drops)", async () => {
    await enqueueIncidentReport({
      clientRef: "inc-2",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      type: "fire",
      severity: "high",
      description: "Fuel storage fire",
      occurredAt: Date.now(),
    });
    const { synced, failed } = await syncQueue({
      reportIncident: async () => {
        throw new Error("network down");
      },
    });
    expect(synced).toBe(0);
    expect(failed).toBe(1);
    const item = readQueue()[0];
    expect(item.status).toBe("failed");
    expect(item.lastError).toBe("network down");
    expect(item.failureKind).toBe("retryable");
    // OFF-3: a backoff window is armed for the next AUTOMATIC attempt.
    expect(item.nextRetryAt).toBeGreaterThan(Date.now());
    // The failed item stays — nothing is silently dropped.
    expect(pendingCount()).toBe(1);
  });

  test("automatic sync respects the backoff window; force ignores it", async () => {
    await enqueueIncidentReport({
      clientRef: "inc-backoff",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      type: "fire",
      severity: "high",
      description: "Fuel storage fire",
      occurredAt: Date.now(),
    });
    const api = {
      reportIncident: async () => {
        throw new Error("boom");
      },
    };
    await syncQueue(api); // attempt 1 → arms nextRetryAt
    const again = await syncQueue(api); // still inside the window → waiting
    expect(again.synced).toBe(0);
    expect(again.failed).toBe(0);
    expect(again.waiting).toBe(1);
    const forced = await syncQueue(api, { force: true }); // manual retry
    expect(forced.failed).toBe(1);
    expect(readQueue()[0].attempts).toBe(2);
  });

  test("observation sync passes clientRef through for server-side dedupe", async () => {
    await enqueueObservationReport({
      clientRef: "obs-2",
      siteId: "s2",
      siteCode: "MGL-LOFA-0001",
      category: "tailings",
      verification: "observed",
      description: "New tailings pile",
      observedAt: Date.now(),
    });
    let got: Record<string, unknown> | null = null;
    await syncQueue({
      reportObservation: async (args) => {
        got = args as Record<string, unknown>;
        return "obs-id";
      },
    });
    expect(got).not.toBeNull();
    expect(got?.clientRef).toBe("obs-2");
    expect(got?.category).toBe("tailings");
  });

  test("missing handler fails the item without throwing (NO_SYNC_HANDLER)", async () => {
    await enqueueIncidentReport({
      clientRef: "inc-3",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      type: "other",
      severity: "low",
      description: "Misc",
      occurredAt: Date.now(),
    });
    const { synced, failed } = await syncQueue({});
    expect(synced).toBe(0);
    expect(failed).toBe(1);
    expect(readQueue()[0].lastError).toBe("NO_SYNC_HANDLER");
    // Still queued: a later render may bind the handler — retryable, not dead.
    expect(readQueue()[0].status).toBe("failed");
    expect(readQueue()[0].failureKind).toBe("retryable");
  });

  test("permanent failures park as dead without burning retries", async () => {
    await enqueueIncidentReport({
      clientRef: "inc-403",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      type: "other",
      severity: "low",
      description: "Misc",
      occurredAt: Date.now(),
    });
    const r = await syncQueue({
      reportIncident: async () => {
        throw new Error("FORBIDDEN");
      },
    });
    expect(r.dead).toBe(1);
    const item = readQueue()[0];
    expect(item.status).toBe("dead");
    expect(item.failureKind).toBe("permanent");
    expect(item.attempts).toBe(1);
    // Parked items are skipped by later automatic runs…
    const again = await syncQueue({
      reportIncident: async () => "should-not-run",
    });
    expect(again.synced).toBe(0);
    expect(again.dead).toBe(1);
    // …until a human retries them explicitly from the queue manager.
    await retryQueueItem(item.id);
    const retried = await syncQueue({
      reportIncident: async () => "srv-ok",
    });
    expect(retried.synced).toBe(1);
    expect(readQueue()).toHaveLength(0);
  });

  test("inspection sync runs draft → update → submit in order", async () => {
    await enqueueInspectionSubmission({
      clientRef: "insp-1",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: { "0:0": true },
      notes: "ok",
      latitude: 7.0,
    });
    const order: string[] = [];
    const { synced } = await syncQueue({
      createDraft: async () => {
        order.push("createDraft");
        return "insp-id";
      },
      updateDraft: async () => {
        order.push("updateDraft");
        return undefined;
      },
      submit: async () => {
        order.push("submit");
        return undefined;
      },
    });
    expect(synced).toBe(1);
    expect(order).toEqual(["createDraft", "updateDraft", "submit"]);
    expect(readQueue()).toHaveLength(0);
    // Draft is cleaned up after successful sync.
    expect(readDrafts()).toHaveLength(0);
    // The inspection's server id became the local parent reference.
    const { resolveLocalRef } = await import("../src/lib/offline-store");
    expect(await resolveLocalRef("insp-1")).toBe("insp-id");
  });

  test("409 conflict parks the item with the server snapshot (OFF-4)", async () => {
    await enqueueCaResponse({
      clientRef: "ca-1",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      caId: "ca-row",
      operatorNote: "Repaired the guard",
      expectedRowVersion: 3,
    });
    const r = await syncQueue({
      respondCorrectiveAction: async () => {
        const e = new Error(
          `CONFLICT:${JSON.stringify({
            server: {
              status: "submitted",
              operatorNote: "earlier response",
              rowVersion: 5,
            },
          })}`,
        ) as Error & { code?: string };
        e.code = "409";
        throw e;
      },
    });
    expect(r.conflicts).toBe(1);
    const item = readQueue()[0];
    expect(item.status).toBe("conflict");
    expect(item.failureKind).toBe("conflict");
    expect(item.serverSnapshot).toEqual({
      status: "submitted",
      operatorNote: "earlier response",
      rowVersion: 5,
    });
    // Automatic runs never touch a parked conflict.
    const again = await syncQueue({
      respondCorrectiveAction: async () => "should-not-run",
    });
    expect(again.synced).toBe(0);
    expect(again.conflicts).toBe(1);

    // Human resolution: "apply mine" re-arms row_version to the server's
    // current version, then the retry succeeds.
    await resolveConflictKeepMine(item.id);
    const resolved = readQueue()[0];
    expect(resolved.status).toBe("pending");
    expect(resolved.ca?.expectedRowVersion).toBe(5);
    const seen: number[] = [];
    const ok = await syncQueue({
      respondCorrectiveAction: async (args) => {
        seen.push(args.expectedRowVersion ?? -1);
        return undefined;
      },
    });
    expect(ok.synced).toBe(1);
    expect(seen).toEqual([5]);
  });
});

describe("queue hygiene + export (OFF-5)", () => {
  test("updateQueueItem patches status; removeQueueItem deletes", async () => {
    const item = await enqueueInspectionSubmission({
      clientRef: "h1",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: {},
    });
    await updateQueueItem(item.id, { status: "syncing" });
    expect(readQueue()[0].status).toBe("syncing");
    await removeQueueItem(item.id);
    expect(readQueue()).toHaveLength(0);
  });

  test("buildQueueExport snapshots queue, drafts and local refs as JSON", async () => {
    await enqueueIncidentReport({
      clientRef: "exp-1",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      type: "fire",
      severity: "high",
      description: "Export me",
      occurredAt: Date.now(),
    });
    await upsertDraft({
      clientRef: "exp-d",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: { a: 1 },
      updatedAt: Date.now(),
    });
    const dump = await buildQueueExport();
    expect(dump.queue).toHaveLength(1);
    expect(dump.drafts).toHaveLength(1);
    expect(dump.exportedAt).toBeTruthy();
    // Must be serializable for the download.
    expect(() => JSON.stringify(dump)).not.toThrow();
  });
});
