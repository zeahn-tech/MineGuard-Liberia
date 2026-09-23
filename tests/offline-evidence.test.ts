// ---------------------------------------------------------------------------
// Offline evidence queue tests.
//
// Bun has no IndexedDB (typeof indexedDB === "undefined"), so offline-evidence
// exercises its in-memory fallback with the same API the browser's IndexedDB
// path uses. This covers the queue semantics that matter offline: persistence,
// per-parent scoping, retry-never-drop, and clean removal on success.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from "bun:test";
import {
  enqueuePendingEvidence,
  pendingEvidenceCount,
  readPendingEvidence,
  readPendingEvidenceForParent,
  removePendingEvidence,
  syncEvidenceQueue,
} from "../src/lib/offline-evidence";

async function clearQueue() {
  for (const item of await readPendingEvidence()) {
    await removePendingEvidence(item.id);
  }
}

function sample(overrides: Record<string, unknown> = {}) {
  return {
    parentType: "incident" as const,
    parentId: "inc-1",
    siteId: "site-1",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    blob: new Blob(["bytes"], { type: "image/jpeg" }),
    ...overrides,
  };
}

beforeEach(clearQueue);

describe("offline evidence queue", () => {
  test("enqueue persists bytes and assigns id/attempts", async () => {
    const entry = await enqueuePendingEvidence(sample());
    expect(entry.id).toBeTruthy();
    expect(entry.attempts).toBe(0);
    expect(entry.createdAt).toBeGreaterThan(0);

    const all = await readPendingEvidence();
    expect(all).toHaveLength(1);
    expect(all[0].fileName).toBe("photo.jpg");
    expect(all[0].blob).toBeInstanceOf(Blob);
    expect(await pendingEvidenceCount()).toBe(1);
  });

  test("pending items are scoped per parent", async () => {
    await enqueuePendingEvidence(sample({ parentId: "inc-1" }));
    await enqueuePendingEvidence(
      sample({ parentId: "inc-2", parentType: "observation" }),
    );

    const forIncident = await readPendingEvidenceForParent("incident", "inc-1");
    expect(forIncident).toHaveLength(1);
    expect(forIncident[0].parentId).toBe("inc-1");

    const forObservation = await readPendingEvidenceForParent(
      "observation",
      "inc-2",
    );
    expect(forObservation).toHaveLength(1);

    expect(await readPendingEvidenceForParent("inspection", "inc-1")).toHaveLength(0);
  });

  test("successful sync uploads then removes the queued item", async () => {
    await enqueuePendingEvidence(sample());
    const uploaded: string[] = [];

    const result = await syncEvidenceQueue(async (args) => {
      uploaded.push(args.fileName);
      expect(args.file).toBeInstanceOf(Blob);
      expect(args.siteId).toBe("site-1");
      return "evidence-id";
    });

    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(uploaded).toEqual(["photo.jpg"]);
    expect(await pendingEvidenceCount()).toBe(0);
  });

  test("failed sync keeps the item queued with retry info (never dropped)", async () => {
    await enqueuePendingEvidence(sample());

    const result = await syncEvidenceQueue(async () => {
      throw new Error("network request failed");
    });

    expect(result).toEqual({ synced: 0, failed: 1 });
    const all = await readPendingEvidence();
    expect(all).toHaveLength(1);
    expect(all[0].attempts).toBe(1);
    expect(all[0].lastError).toContain("network request failed");
  });

  test("removePendingEvidence deletes the item", async () => {
    const entry = await enqueuePendingEvidence(sample());
    await removePendingEvidence(entry.id);
    expect(await pendingEvidenceCount()).toBe(0);
  });
});
