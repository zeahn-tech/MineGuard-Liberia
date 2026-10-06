// ---------------------------------------------------------------------------
// SESSION 4 — OFFLINE RELIABILITY ACCEPTANCE (OFF-1…7, EVD-1)
//
// The five acceptance scenarios, exercised through the REAL layers:
//   1. QUOTA EXHAUSTION      — a storage that refuses writes rejects every
//                              enqueue with NotSavedError (NOT_SAVED); the
//                              queue does not contain the item, so no UI can
//                              claim it was saved.
//   2. MID-SYNC CRASH        — an item stranded in "syncing" is recovered on
//                              the next load and replayed safely.
//   3. DUPLICATE REPLAY      — a response lost after the server committed
//                              replays against the clientRef dedupe: exactly
//                              one record ever exists.
//   4. 409 CONFLICT          — row_version mismatch through the real data
//                              layer parks the item with the server snapshot;
//                              the human resolution path then lands it.
//   5. PARENT-CREATED-OFFLINE EVIDENCE — evidence queued against a local
//                              parent waits, resolves the server id after the
//                              parent syncs, then uploads.
// Plus EVD-1: sha256 recorded + verified (mismatch refused, corrupted queued
// bytes refused), parents extended to community_report and corrective_action,
// OFF-3: backoff/jitter/max-attempts/classification, and scheduler/queue
// manager source contracts.
//
// Storage note: Bun has no IndexedDB, so these run on the offline-store
// localStorage backend — the same durability contract (verified write or
// NotSavedError) the IndexedDB backend implements in the browser.
// ---------------------------------------------------------------------------

import { beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api, type QueryHandle } from "../src/lib/backend";
import { __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import {
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";
import {
  ensureOfflineReady,
  enqueueCaResponse,
  enqueueIncidentReport,
  readQueue,
  retryQueueItem,
  resolveConflictKeepMine,
  syncQueue,
  upsertDraft,
  __resetOfflineQueue,
} from "../src/lib/offline-queue";
import {
  enqueuePendingEvidence,
  pendingEvidenceCount,
  readPendingEvidence,
  syncEvidenceQueue,
  updatePendingEvidence,
  __resetEvidenceQueueForTests,
  __testSetEvidenceWriteError,
  type EvidenceUploader,
} from "../src/lib/offline-evidence";
import {
  NotSavedError,
  resolveLocalRef,
} from "../src/lib/offline-store";
import {
  classifyFailure,
  computeBackoffMs,
  MAX_BACKOFF_MS,
  MAX_SYNC_ATTEMPTS,
} from "../src/lib/offline-retry";
import { startSyncScheduler, type SchedulerResult } from "../src/lib/offline-sync";
import { sha256Hex } from "../src/lib/sha256";

// ---------------------------------------------------------------------------
// ENVIRONMENT: localStorage shim with an injectable write failure (quota),
// unique fixture ids, edge-client binding.
// ---------------------------------------------------------------------------

const QUEUE_KEY = "mg.offline.queue.v1";
const CA_ID = "eeeeeeee-0000-4000-8000-000000000014"; // dedicated respond fixture
const CR_ID = "99999999-0000-4000-8000-000000000010"; // seeded community report

const testStore = new Map<string, string>();
let failWrite: ((key: string) => boolean) | null = null;
const shim = {
  getItem: (k: string) => testStore.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (failWrite && failWrite(k)) {
      const e = new Error(
        "QuotaExceededError: The quota has been exceeded.",
      );
      e.name = "QuotaExceededError";
      throw e;
    }
    testStore.set(k, v);
  },
  removeItem: (k: string) => void testStore.delete(k),
  key: (i: number) => [...testStore.keys()][i] ?? null,
  get length() {
    return testStore.size;
  },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
const prevLocalStorage = g.localStorage;

function setIdentity(uid: string | null) {
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}

/** First value from a live() subscription (or undefined if it errored). */
function first<T>(q: QueryHandle<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      unsub();
      resolve(v);
    });
  });
}

/** The queue's evidence replay target: the real upload path over the bridge. */
const bridgeUpload: EvidenceUploader = (args) =>
  api.evidence.upload({
    file: args.file,
    fileName: args.fileName,
    mimeType: args.mimeType,
    parentType: args.parentType,
    parentId: args.parentId,
    siteId: args.siteId,
    caption: args.caption,
    capturedAt: args.capturedAt,
    sha256: args.sha256,
  });

let clientSwapped = false;

beforeAll(async () => {
  await getEdgeDb();
  if (!clientSwapped) {
    __testSetSupabaseClient(createEdgeClient());
    clientSwapped = true;
  }
  // Dedicated corrective action for the conflict tests (siteA = opA tenant).
  await adminSql(
    `insert into public.corrective_actions
       (id, finding_id, site_id, description, due_at, opened_by_id)
     values ('${CA_ID}', '${f.findingA}', '${f.siteA}',
             'mgoff4: replace guard rail on the crusher', now() + interval '7 days',
             '${f.admin}')
     on conflict (id) do nothing`,
  );
});

afterAll(async () => {
  // Remove everything these tests committed so later suites see the fixture
  // they expect (audit first — its entity ids reference the rows below).
  await adminSql(
    `delete from public.audit_log
      where entity_id = '${CA_ID}'
         or entity_id in (select id::text from public.incidents where client_ref like 'mgoff4-%')
         or entity_id in (select id::text from public.evidence where file_name like 'mgoff4-%')`,
  );
  await adminSql(`delete from public.evidence where file_name like 'mgoff4-%'`);
  await adminSql(
    `delete from public.incidents where client_ref like 'mgoff4-%'`,
  );
  await adminSql(`delete from public.corrective_actions where id = '${CA_ID}'`);
  await adminSql(
    `delete from storage.objects where bucket_id = 'evidence' and name like '%mgoff4%'`,
  );
  setIdentity(null);
  failWrite = null;
  g.localStorage = prevLocalStorage;
});

beforeEach(async () => {
  g.localStorage = shim;
  testStore.clear();
  failWrite = null;
  __resetEvidenceQueueForTests();
  __testSetEvidenceWriteError(null);
  await __resetOfflineQueue();
  await ensureOfflineReady();
});

// ---------------------------------------------------------------------------
// 1. QUOTA EXHAUSTION
// ---------------------------------------------------------------------------

describe("OFF-1/2: quota exhaustion surfaces as NOT_SAVED (blocks saved UI)", () => {
  test("queue enqueue rejects NotSavedError and the queue stays empty", async () => {
    failWrite = (k) => k.startsWith("mg.offline.");

    let err: unknown;
    try {
      await enqueueIncidentReport({
        clientRef: "mgoff4-quota",
        siteId: f.siteA,
        siteCode: "LB-BOM-0001",
        type: "near_miss",
        severity: "low",
        description: "Should never be reported as saved",
        occurredAt: Date.now(),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotSavedError);
    expect((err as NotSavedError).code).toBe("NOT_SAVED");
    // The item never entered the queue — a "saved" toast would be a lie.
    expect(readQueue()).toHaveLength(0);
    expect(testStore.get(QUEUE_KEY)).toBeUndefined();

    // Drafts surface the same way.
    let draftErr: unknown;
    try {
      await upsertDraft({
        clientRef: "mgoff4-draft",
        siteId: f.siteA,
        siteCode: "LB-BOM-0001",
        templateId: f.template,
        answers: {},
        updatedAt: Date.now(),
      });
    } catch (e) {
      draftErr = e;
    }
    expect(draftErr).toBeInstanceOf(NotSavedError);
  });

  test("evidence enqueue rejects NotSavedError and stores nothing", async () => {
    __testSetEvidenceWriteError(new Error("QuotaExceededError: storage full"));
    let err: unknown;
    try {
      await enqueuePendingEvidence({
        parentType: "incident",
        parentId: f.incidentA,
        siteId: f.siteA,
        fileName: "mgoff4-quota.jpg",
        mimeType: "image/jpeg",
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotSavedError);
    expect(await pendingEvidenceCount()).toBe(0);
    __testSetEvidenceWriteError(null);
  });

  test("the UI paths await every enqueue and narrate NOT_SAVED", () => {
    const src = (p: string) =>
      readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
    // Every enqueue call site awaits, so a rejection reaches its catch.
    expect(src("pages/Incidents.tsx")).toContain("await enqueueIncidentReport");
    expect(src("pages/Environment.tsx")).toContain(
      "await enqueueObservationReport",
    );
    expect(src("pages/Inspections.tsx")).toContain(
      "await enqueueInspectionSubmission",
    );
    expect(src("pages/operate/OperatorIncidents.tsx")).toContain(
      "await enqueueIncidentReport",
    );
    // …and the inspection form distinguishes NOT_SAVED from "queued offline".
    expect(src("pages/Inspections.tsx")).toMatch(/NOT_SAVED/);
    expect(src("pages/Inspections.tsx")).toMatch(
      /not saved on this device/i,
    );
    // The draft form keeps a persistent banner until the next good write.
    expect(src("pages/Inspections.tsx")).toMatch(/not saved on this device/i);
    // EvidenceSection marks the file failed when the queue refuses it.
    expect(src("components/EvidenceSection.tsx")).toMatch(
      /Not saved on this device/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. MID-SYNC CRASH
// ---------------------------------------------------------------------------

describe("OFF-3: mid-sync crash recovery", () => {
  test("an item stranded in 'syncing' recovers and replays without duplicates", async () => {
    await enqueueIncidentReport({
      clientRef: "mgoff4-crash",
      siteId: f.siteA,
      siteCode: "LB-BOM-0001",
      type: "fire",
      severity: "high",
      description: "Crash mid-sync",
      occurredAt: Date.now(),
    });

    // Arm a failure that lets the FIRST queue write (status=syncing) through
    // but kills every later one — i.e. the app dies between the status write
    // and the local removal, AFTER the server applied the report.
    let queueWrites = 0;
    failWrite = (k) => k === QUEUE_KEY && ++queueWrites > 1;

    const server = new Map<string, string>();
    let rejected = false;
    try {
      await syncQueue({
        reportIncident: async (args) => {
          const ref = String((args as { clientRef?: string }).clientRef ?? "");
          if (!server.has(ref)) server.set(ref, `srv-${server.size + 1}`);
          return server.get(ref); // server committed…
        },
      });
    } catch {
      rejected = true; // …but the local bookkeeping write died: CRASH
    }
    expect(rejected).toBe(true);
    expect(server.size).toBe(1);

    // App restart: disarm storage, reload the durable store.
    failWrite = null;
    await __resetOfflineQueue();
    await ensureOfflineReady();

    const recovered = readQueue()[0];
    expect(recovered.status).toBe("failed");
    expect(recovered.lastError).toContain("Interrupted mid-sync");
    expect(recovered.failureKind).toBe("retryable");

    // Replay: the handler runs again with the SAME clientRef — the server's
    // dedupe returns the existing record, so still exactly one.
    const replay = await syncQueue({
      reportIncident: async (args) => {
        const ref = String((args as { clientRef?: string }).clientRef ?? "");
        if (!server.has(ref)) server.set(ref, `srv-${server.size + 1}`);
        return server.get(ref);
      },
    });
    expect(replay.synced).toBe(1);
    expect(server.size).toBe(1); // NO duplicate record
    expect(readQueue()).toHaveLength(0);
  });

  test("a failure on item N leaves item N-1 synced and item N queued", async () => {
    await enqueueIncidentReport({
      clientRef: "mgoff4-first",
      siteId: f.siteA,
      siteCode: "LB-BOM-0001",
      type: "fire",
      severity: "low",
      description: "first",
      occurredAt: Date.now(),
    });
    await enqueueIncidentReport({
      clientRef: "mgoff4-second",
      siteId: f.siteA,
      siteCode: "LB-BOM-0001",
      type: "fire",
      severity: "low",
      description: "second",
      occurredAt: Date.now(),
    });
    const r = await syncQueue({
      reportIncident: async (args) => {
        if ((args as { clientRef?: string }).clientRef === "mgoff4-second") {
          throw new Error("network fell over mid-loop");
        }
        return "srv-first";
      },
    });
    expect(r.synced).toBe(1);
    expect(r.failed).toBe(1);
    const rest = readQueue();
    expect(rest).toHaveLength(1);
    expect(rest[0].clientRef).toBe("mgoff4-second");
    expect(rest[0].status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// 3. DUPLICATE REPLAY
// ---------------------------------------------------------------------------

describe("duplicate replay after a lost response", () => {
  test("replaying a commit whose response was lost never creates two records", async () => {
    await enqueueIncidentReport({
      clientRef: "mgoff4-replay",
      siteId: f.siteA,
      siteCode: "LB-BOM-0001",
      type: "near_miss",
      severity: "medium",
      description: "Committed server-side, response lost",
      occurredAt: Date.now(),
    });

    // Server contract: create dedupes on clientRef (the real reportIncident
    // shape). The first call applies, then the RESPONSE is lost.
    const serverByRef = new Map<string, string>();
    let attempts = 0;
    const handler = async (args: Record<string, unknown>) => {
      const ref = String(args.clientRef ?? "");
      if (!serverByRef.has(ref)) serverByRef.set(ref, `srv-${serverByRef.size + 1}`);
      attempts++;
      if (attempts === 1) throw new Error("Failed to fetch"); // lost response
      return serverByRef.get(ref);
    };

    const r1 = await syncQueue({ reportIncident: handler });
    expect(r1.failed).toBe(1); // the item is still queued…
    expect(serverByRef.size).toBe(1); // …while the server already has it

    const r2 = await syncQueue({ reportIncident: handler }, { force: true });
    expect(r2.synced).toBe(1);
    expect(serverByRef.size).toBe(1); // still exactly ONE record
    expect(readQueue()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. 409 CONFLICT (row_version) — through the real data layer
// ---------------------------------------------------------------------------

describe("OFF-4: 409 conflict detection and human resolution", () => {
  test("stale row_version → CONFLICT with snapshot; queue parks; resolution lands it", async () => {
    setIdentity(f.opA);
    const before = await adminSql(
      `select row_version from public.corrective_actions where id = '${CA_ID}'`,
    );
    expect(Number(before[0].row_version)).toBe(1);

    // Direct call with a stale version: refused, server row in the payload.
    let err: unknown;
    try {
      await api.inspections.respondCorrectiveAction({
        caId: CA_ID,
        operatorNote: "stale attempt",
        expectedRowVersion: 99,
      });
    } catch (e) {
      err = e;
    }
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg.startsWith("CONFLICT:")).toBe(true);
    expect((err as { code?: string }).code).toBe("409");
    const snapshot = JSON.parse(msg.slice("CONFLICT:".length)) as {
      server: { rowVersion: number; status: string };
    };
    expect(snapshot.server.rowVersion).toBe(1);
    expect(snapshot.server.status).toBe("open");

    // Same flow through the offline queue (what the operator's device does).
    await enqueueCaResponse({
      clientRef: "mgoff4-conflict",
      siteId: f.siteA,
      siteCode: "LB-BOM-0001",
      caId: CA_ID,
      operatorNote: "Guard rail replaced, photos attached",
      expectedRowVersion: 99, // stale: someone else has the row
    });
    const parked = await syncQueue({
      respondCorrectiveAction: (a) => api.inspections.respondCorrectiveAction(a),
    });
    expect(parked.conflicts).toBe(1);
    const item = readQueue()[0];
    expect(item.status).toBe("conflict");
    expect(item.serverSnapshot).toEqual(
      expect.objectContaining({ rowVersion: 1, status: "open" }),
    );

    // Human picks "apply my version" → row_version re-armed to the server's
    // current version → retry succeeds.
    await resolveConflictKeepMine(item.id);
    expect(readQueue()[0].ca?.expectedRowVersion).toBe(1);
    const resolved = await syncQueue({
      respondCorrectiveAction: (a) => api.inspections.respondCorrectiveAction(a),
    });
    expect(resolved.synced).toBe(1);
    expect(readQueue()).toHaveLength(0);

    const after = await adminSql(
      `select status, operator_note, row_version from public.corrective_actions
        where id = '${CA_ID}'`,
    );
    expect(after[0].status).toBe("submitted");
    expect(after[0].operator_note).toBe("Guard rail replaced, photos attached");
    expect(Number(after[0].row_version)).toBe(2);

    // Idempotent replay of the SAME note on an already-submitted action
    // (crash between commit and local removal) reports success, not a guard
    // error — the queue drains instead of parking a phantom failure.
    await api.inspections.respondCorrectiveAction({
      caId: CA_ID,
      operatorNote: "Guard rail replaced, photos attached",
      expectedRowVersion: 2,
    });
    setIdentity(null);
  });

  test("retryQueueItem re-arms a parked conflict item for a manual retry", async () => {
    await enqueueCaResponse({
      clientRef: "mgoff4-conflict-2",
      siteId: f.siteA,
      siteCode: "LB-BOM-0001",
      caId: CA_ID,
      operatorNote: "manual retry check",
    });
    await syncQueue({
      respondCorrectiveAction: async () => {
        const e = new Error(
          `CONFLICT:${JSON.stringify({ server: { rowVersion: 7, status: "open" } })}`,
        ) as Error & { code?: string };
        e.code = "409";
        throw e;
      },
    });
    expect(readQueue()[0].status).toBe("conflict");
    await retryQueueItem(readQueue()[0].id);
    expect(readQueue()[0].status).toBe("pending");
    expect(readQueue()[0].serverSnapshot).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. PARENT-CREATED-OFFLINE EVIDENCE
// ---------------------------------------------------------------------------

describe("OFF-6: evidence queued against an offline-created parent", () => {
  test("waits for the parent, resolves its server id, then uploads", async () => {
    setIdentity(f.opA);
    const clientRef = "mgoff4-offparent";

    // Device is offline: the incident is queued, the photo queued against
    // the LOCAL parent reference (no server id exists yet).
    await enqueueIncidentReport({
      clientRef,
      siteId: f.siteA,
      siteCode: "LB-BOM-0001",
      type: "environmental",
      severity: "medium",
      description: "Discoloured discharge seen offline",
      occurredAt: Date.now(),
    });
    await enqueuePendingEvidence({
      parentType: "incident",
      parentId: "", // no server id yet…
      parentRef: clientRef, // …only the local reference
      siteId: f.siteA,
      fileName: "mgoff4-offline.jpg",
      mimeType: "image/jpeg",
      blob: new Blob([new Uint8Array([9, 9, 9])], { type: "image/jpeg" }),
      caption: "Captured offline",
    });

    // Evidence syncs FIRST: unresolved parent → a WAIT, not a failure.
    const r1 = await syncEvidenceQueue(bridgeUpload);
    expect(r1).toEqual({ synced: 0, failed: 0, waiting: 1, dead: 0 });
    expect(await pendingEvidenceCount()).toBe(1);

    // The parent syncs and records clientRef → server id.
    const rs = await syncQueue({
      reportIncident: (a) => api.records.reportIncident(a),
    });
    expect(rs.synced).toBe(1);
    const serverId = await resolveLocalRef(clientRef);
    expect(serverId).toBeTruthy();

    // Now the evidence resolves and uploads against the REAL id.
    const r2 = await syncEvidenceQueue(bridgeUpload);
    expect(r2).toEqual({ synced: 1, failed: 0, waiting: 0, dead: 0 });
    expect(await pendingEvidenceCount()).toBe(0);

    const rows = await adminSql(
      `select parent_id, parent_type, sha256 from public.evidence
        where file_name = 'mgoff4-offline.jpg'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].parent_id).toBe(serverId);
    expect(rows[0].parent_type).toBe("incident");
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    setIdentity(null);
  });
});

// ---------------------------------------------------------------------------
// EVD-1: SHA-256 RECORDED AND VERIFIED
// ---------------------------------------------------------------------------

describe("EVD-1: evidence integrity (sha256)", () => {
  test("upload records the digest and refuses a mismatched declaration", async () => {
    setIdentity(f.opA);
    const blob = new Blob([new Uint8Array(48).fill(7)], { type: "image/jpeg" });
    const sha = await sha256Hex(blob);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);

    const id = await api.evidence.upload({
      file: blob,
      fileName: "mgoff4-sha.jpg",
      mimeType: "image/jpeg",
      parentType: "incident",
      parentId: f.incidentA,
      siteId: f.siteA,
      sha256: sha ?? undefined,
    });
    const rows = await adminSql(
      `select sha256 from public.evidence where id = '${id}'`,
    );
    expect(rows[0].sha256).toBe(sha);

    // Declared digest that does not match the bytes → refused, no row.
    const wrong = (sha ?? "").replace(/^./, (c) => (c === "0" ? "1" : "0"));
    let err: unknown;
    try {
      await api.evidence.upload({
        file: blob,
        fileName: "mgoff4-sha-bad.jpg",
        mimeType: "image/jpeg",
        parentType: "incident",
        parentId: f.incidentA,
        siteId: f.siteA,
        sha256: wrong,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("EVIDENCE_HASH_MISMATCH");
    const bad = await adminSql(
      `select id from public.evidence where file_name = 'mgoff4-sha-bad.jpg'`,
    );
    expect(bad).toHaveLength(0);
    setIdentity(null);
  });

  test("queued replay re-hashes the bytes: corruption is refused, never uploaded", async () => {
    const entry = await enqueuePendingEvidence({
      parentType: "incident",
      parentId: f.incidentA,
      siteId: f.siteA,
      fileName: "mgoff4-corrupt.jpg",
      mimeType: "image/jpeg",
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/jpeg" }),
    });
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The stored bytes decay (or the record was tampered with) AFTER enqueue.
    await updatePendingEvidence(entry.id, {
      blob: new Blob([new Uint8Array([9, 9, 9, 9])], { type: "image/jpeg" }),
    });

    let uploads = 0;
    const r = await syncEvidenceQueue(async () => {
      uploads++;
      return "should-not-happen";
    });
    expect(uploads).toBe(0);
    expect(r.dead).toBe(1);
    const items = await readPendingEvidence();
    expect(items).toHaveLength(1);
    expect(items[0].lastError).toContain("EVIDENCE_CORRUPT");
    expect(items[0].status).toBe("dead"); // parked, bytes kept, never sent
  });
});

// ---------------------------------------------------------------------------
// EVD-1: EVIDENCE PARENTS — community_report + corrective_action (0013)
// ---------------------------------------------------------------------------

describe("EVD-1: extended evidence parents", () => {
  test("community_report: staff attach site-less evidence; operators are refused", async () => {
    // Staff (admin) uploads WITHOUT a site — the 0013 nullable-site path.
    setIdentity(f.admin);
    const id = await api.evidence.upload({
      file: new Blob([new Uint8Array([5, 5])], { type: "image/jpeg" }),
      fileName: "mgoff4-triage.jpg",
      mimeType: "image/jpeg",
      parentType: "community_report",
      parentId: CR_ID,
    });
    const rows = await adminSql(
      `select site_id, parent_type from public.evidence where id = '${id}'`,
    );
    expect(rows[0].parent_type).toBe("community_report");
    expect(rows[0].site_id).toBeNull();

    // The scoped list RPC returns it for staff…
    const list = await first(
      api.evidence.listForParent({ parentType: "community_report", parentId: CR_ID }),
    );
    expect((list ?? []).some((e) => e.fileName === "mgoff4-triage.jpg")).toBe(true);

    // …while an operator (not staff) cannot upload or see site-less rows.
    setIdentity(f.opA);
    let err: unknown;
    try {
      await api.evidence.upload({
        file: new Blob([new Uint8Array([6])], { type: "image/jpeg" }),
        fileName: "mgoff4-triage-op.jpg",
        mimeType: "image/jpeg",
        parentType: "community_report",
        parentId: CR_ID,
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("FORBIDDEN");
    const opList = await first(
      api.evidence.listForParent({ parentType: "community_report", parentId: CR_ID }),
    );
    expect((opList ?? []).filter((e) => e.fileName === "mgoff4-triage.jpg")).toHaveLength(0);
    setIdentity(null);
  });

  test("corrective_action: the operator uploads a response document", async () => {
    setIdentity(f.opA);
    const id = await api.evidence.upload({
      file: new Blob([new Uint8Array([3, 1, 4])], { type: "application/pdf" }),
      fileName: "mgoff4-ca-receipt.pdf",
      mimeType: "application/pdf",
      parentType: "corrective_action",
      parentId: CA_ID,
      siteId: f.siteA,
      caption: "Invoice for the guard rail",
    });
    const rows = await adminSql(
      `select parent_type, site_id, kind from public.evidence where id = '${id}'`,
    );
    expect(rows[0].parent_type).toBe("corrective_action");
    expect(rows[0].kind).toBe("document");
    const list = await first(
      api.evidence.listForParent({ parentType: "corrective_action", parentId: CA_ID }),
    );
    expect((list ?? []).some((e) => e.fileName === "mgoff4-ca-receipt.pdf")).toBe(true);
    setIdentity(null);
  });
});

// ---------------------------------------------------------------------------
// OFF-3: BACKOFF / CLASSIFICATION / MAX ATTEMPTS
// ---------------------------------------------------------------------------

describe("OFF-3: retry policy", () => {
  test("backoff grows exponentially, is jittered, and caps", () => {
    expect(computeBackoffMs(1, () => 0)).toBe(500); // half window, no jitter
    expect(computeBackoffMs(1, () => 1)).toBe(1000);
    expect(computeBackoffMs(4, () => 0)).toBe(4000); // 2^3 * 1000 / 2
    expect(computeBackoffMs(4, () => 1)).toBe(8000);
    expect(computeBackoffMs(1, () => 0.5)).toBe(750); // jitter inside the window
    expect(computeBackoffMs(60, () => 1)).toBe(MAX_BACKOFF_MS); // capped at 5 min
    // Monotonic in attempts (at the jitter floor).
    expect(computeBackoffMs(5, () => 0)).toBeGreaterThan(computeBackoffMs(4, () => 0));
  });

  test("classification: conflict / permanent / retryable", () => {
    expect(classifyFailure(new Error("FORBIDDEN")).kind).toBe("permanent");
    expect(classifyFailure(new Error("FILE_TOO_LARGE")).kind).toBe("permanent");
    expect(classifyFailure(new Error("EVIDENCE_HASH_MISMATCH")).kind).toBe(
      "permanent",
    );
    expect(
      classifyFailure(new Error(`{"statusCode":422,"message":"bad"}`)).kind,
    ).toBe("permanent");
    expect(classifyFailure(new Error("network request failed")).kind).toBe(
      "retryable",
    );
    expect(classifyFailure(new Error("NO_SYNC_HANDLER")).kind).toBe(
      "retryable",
    );
    expect(classifyFailure(new Error(`{"statusCode":503}`)).kind).toBe(
      "retryable",
    );
    const conflict = classifyFailure(
      new Error(`CONFLICT:{"server":{"rowVersion":2}}`),
    );
    expect(conflict.kind).toBe("conflict");
    expect(conflict.server).toEqual({ rowVersion: 2 });
  });

  test("max attempts parks the item as dead — but never drops it", async () => {
    await enqueueIncidentReport({
      clientRef: "mgoff4-max",
      siteId: f.siteA,
      siteCode: "LB-BOM-0001",
      type: "fire",
      severity: "low",
      description: "Never succeeds",
      occurredAt: Date.now(),
    });
    const apiFailing = {
      reportIncident: async () => {
        throw new Error("network down");
      },
    };
    for (let i = 0; i < MAX_SYNC_ATTEMPTS; i++) {
      await syncQueue(apiFailing, { force: true });
    }
    const item = readQueue()[0];
    expect(item.attempts).toBe(MAX_SYNC_ATTEMPTS);
    expect(item.status).toBe("dead");
    expect(readQueue()).toHaveLength(1); // still there for manual retry/export
  });
});

// ---------------------------------------------------------------------------
// SCHEDULER (OFF-3) + QUEUE MANAGER (OFF-4/5) SOURCE CONTRACTS
// ---------------------------------------------------------------------------

describe("scheduler and queue manager wiring", () => {
  test("startup run syncs the queue and can be disposed", async () => {
    await enqueueIncidentReport({
      clientRef: "mgoff4-sched",
      siteId: f.siteA,
      siteCode: "LB-BOM-0001",
      type: "other",
      severity: "low",
      description: "Synced by the scheduler",
      occurredAt: Date.now(),
    });
    let done: ((r: SchedulerResult) => void) | null = null;
    const firstResult = new Promise<SchedulerResult>((resolve) => {
      done = resolve;
    });
    const scheduler = startSyncScheduler({
      api: { reportIncident: async (a) => `srv-${String(a.clientRef)}` },
      onResult: (r) => done?.(r),
    });
    try {
      const timeout = new Promise<SchedulerResult>((resolve) =>
        setTimeout(
          () => resolve({ forced: false, queue: { synced: 0, failed: 0, conflicts: 0, dead: 0, waiting: 0 } }),
          5000,
        ),
      );
      const r = await Promise.race([firstResult, timeout]);
      expect(r.queue?.synced).toBe(1);
      expect(readQueue()).toHaveLength(0);
    } finally {
      scheduler.dispose();
    }
  });

  test("the scheduler listens for startup/visibility/online and backs off", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "lib", "offline-sync.ts"),
      "utf8",
    );
    expect(src).toContain('addEventListener("online"'); // reconnect trigger
    expect(src).toContain("visibilitychange"); // tab-foreground trigger
    expect(src).toContain("ensureOfflineReady"); // startup load + crash recovery
    expect(src).toContain("peekNextRetryAt"); // backoff timer arming
    expect(src).toContain("MAX_BACKOFF_MS"); // jittered window cap
    expect(src).toContain("offline()"); // no attempts while offline
    expect(src).toContain("startSyncScheduler"); // exported entry point

    const qm = readFileSync(
      join(import.meta.dir, "..", "src", "components", "QueueManager.tsx"),
      "utf8",
    );
    // inspect / retry / export / discard-with-confirmation / conflict screen
    expect(qm).toContain("Export JSON");
    expect(qm).toContain("AlertDialog");
    expect(qm).toContain("Discard");
    expect(qm).toContain("Retry");
    expect(qm).toContain("Keep server version");
    expect(qm).toContain("Apply my version");

    const migration = readFileSync(
      join(
        import.meta.dir,
        "..",
        "supabase",
        "migrations",
        "0013_offline_reliability.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("'community_report'");
    expect(migration).toContain("'corrective_action'");
    expect(migration).toContain("sha256");
    expect(migration).toContain("drop not null");
    // Queue-manager entry points exist in both portal shells (parity).
    const portal = readFileSync(
      join(import.meta.dir, "..", "src", "pages", "PortalLayout.tsx"),
      "utf8",
    );
    expect(portal).toContain("QueueManagerButton");
    expect(portal).toContain("startSyncScheduler");
    const operate = readFileSync(
      join(import.meta.dir, "..", "src", "pages", "operate", "OperatorLayout.tsx"),
      "utf8",
    );
    expect(operate).toContain("QueueManagerButton");
    expect(operate).toContain("startSyncScheduler");
    // Operator document upload on the CA response (EVD-1).
    const ca = readFileSync(
      join(
        import.meta.dir,
        "..",
        "src",
        "pages",
        "operate",
        "OperatorCorrectiveActions.tsx",
      ),
      "utf8",
    );
    expect(ca).toContain('parentType="corrective_action"');
    expect(ca).toContain("enqueueCaResponse");
    expect(ca).toContain("expectedRowVersion");
    // Staff triage evidence on community reports.
    const community = readFileSync(
      join(import.meta.dir, "..", "src", "pages", "Community.tsx"),
      "utf8",
    );
    expect(community).toContain('parentType="community_report"');
  });

  test("offline store durability contract: verified write or NotSavedError", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "src", "lib", "offline-store.ts"),
      "utf8",
    );
    // IndexedDB is the production backend; writes read back and compare.
    expect(src).toContain("indexedDB.open");
    expect(src).toContain("read-back");
    expect(src).toContain("NotSavedError");
    // Legacy localStorage keys migrate into IndexedDB, copy-verified first.
    expect(src).toContain("migrateLegacy");
    // Queue mutations are read-modify-write against fresh storage (no
    // stale-mirror clobbering across tabs).
    const queue = readFileSync(
      join(import.meta.dir, "..", "src", "lib", "offline-queue.ts"),
      "utf8",
    );
    expect(queue).toContain("storeGet<QueueItem[]>");
    expect(queue).toContain("recordLocalRef");
  });
});
