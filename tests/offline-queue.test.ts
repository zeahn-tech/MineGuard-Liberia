// ---------------------------------------------------------------------------
// MINEGUARD LIBERIA — FIRST AUTOMATED TEST SUITE (doc 13 test strategy)
// Runner: `bun test` (bun:test). Covers the pure logic and the offline queue
// sync engine — the highest-risk, fully local, dependency-free units.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from "bun:test";
import {
  enqueueInspectionSubmission,
  enqueueIncidentReport,
  enqueueObservationReport,
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
} from "../src/lib/offline-queue";

// Minimal localStorage for the bun runtime (browser provides it natively).
const store = new Map<string, string>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

// Flush each test so queue state never leaks between cases.
beforeEach(() => {
  store.clear();
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
  test("enqueue persists before sync and dedupes by clientRef", () => {
    const ref = newClientRef();
    enqueueInspectionSubmission({
      clientRef: ref,
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: { "0:0": true },
    });
    enqueueInspectionSubmission({
      clientRef: ref,
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: { "0:0": true },
    });
    expect(readQueue()).toHaveLength(1);
    expect(pendingCount()).toBe(1);
  });

  test("drafts persist and delete cleanly", () => {
    upsertDraft({
      clientRef: "d1",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: {},
      updatedAt: Date.now(),
    });
    expect(readDraft("d1")?.siteId).toBe("s1");
    deleteDraft("d1");
    expect(readDraft("d1")).toBeUndefined();
    expect(readDrafts()).toHaveLength(0);
  });
});

describe("offline queue: incident + observation submissions", () => {
  test("incident report persists payload and dedupes by clientRef", () => {
    const ref = newClientRef();
    enqueueIncidentReport({
      clientRef: ref,
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      type: "injury",
      severity: "medium",
      description: "Laceration from screen mesh",
      occurredAt: Date.now() - 1000,
      injured: 1,
    });
    // Same clientRef again must not duplicate.
    enqueueIncidentReport({
      clientRef: ref,
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      type: "injury",
      severity: "medium",
      description: "Laceration from screen mesh",
      occurredAt: Date.now() - 1000,
      injured: 1,
    });
    expect(readQueue()).toHaveLength(1);
    const item = readQueue()[0];
    expect(item.kind).toBe("incidentReport");
    expect(item.payload?.type).toBe("injury");
    expect(item.payload?.injured).toBe(1);
  });

  test("observation report persists payload including GPS", () => {
    enqueueObservationReport({
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
    enqueueIncidentReport({
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
        return "id";
      },
    });
    expect(synced).toBe(1);
    expect(failed).toBe(0);
    expect(readQueue()).toHaveLength(0);
    expect(calls).toEqual(["incident:inc-1"]);
  });

  test("failed sync keeps the item queued with retry info (never drops)", async () => {
    enqueueIncidentReport({
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
    // The failed item stays — nothing is silently dropped.
    expect(pendingCount()).toBe(1);
  });

  test("observation sync passes clientRef through for server-side dedupe", async () => {
    enqueueObservationReport({
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
        return "id";
      },
    });
    expect(got).not.toBeNull();
    expect(got?.clientRef).toBe("obs-2");
    expect(got?.category).toBe("tailings");
  });

  test("missing handler fails the item without throwing (NO_SYNC_HANDLER)", async () => {
    enqueueIncidentReport({
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
  });

  test("inspection sync runs draft → update → submit in order", async () => {
    enqueueInspectionSubmission({
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
  });
});

describe("queue hygiene", () => {
  test("updateQueueItem patches status; removeQueueItem deletes", () => {
    const item = enqueueInspectionSubmission({
      clientRef: "h1",
      siteId: "s1",
      siteCode: "MGL-NIMBA-0001",
      templateId: "t1",
      answers: {},
    });
    updateQueueItem(item.id, { status: "syncing" });
    expect(readQueue()[0].status).toBe("syncing");
    removeQueueItem(item.id);
    expect(readQueue()).toHaveLength(0);
  });
});
