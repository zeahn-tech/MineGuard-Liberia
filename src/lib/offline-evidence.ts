// ---------------------------------------------------------------------------
// OFFLINE EVIDENCE QUEUE (IndexedDB-backed — Session 4: OFF-6/7, EVD-1)
//
// Evidence BYTES must reach Storage before the metadata row exists (docs 05/
// 07), so an upload that cannot complete while offline is never dropped: the
// Blob is persisted locally and replayed by syncEvidenceQueue() when
// connectivity returns. A device-local blob: URI is never treated as a
// permanent media reference — the queue holds bytes only until the real
// upload succeeds, then deletes them.
//
// Session 4 additions:
//  * PARENTS: inspection / incident / observation / community_report /
//    corrective_action (migration 0013 added the enum values).
//  * LOCAL PARENT REFS (OFF-6): an item may carry `parentRef` — the
//    clientRef of a parent that was itself created offline. The sync order
//    is parent-first: until the parent's server id is recorded
//    (offline-store recordLocalRef), evidence for it WAITs instead of
//    failing, then resolves automatically.
//  * SHA-256 (EVD-1): the digest is computed at enqueue and RE-VERIFIED
//    against freshly hashed bytes before every replay — corrupted queued
//    bytes are refused (EVIDENCE_CORRUPT, permanent) instead of uploaded.
//  * BACKOFF + CLASSIFICATION (OFF-3): same policy module as the field
//    queue — retryable failures get exponential backoff with jitter up to
//    MAX_SYNC_ATTEMPTS, permanent failures park as "dead", nothing drops.
//
// IndexedDB (not localStorage) because the queue stores binary Blobs. Where
// IndexedDB is unavailable (private modes, some test environments) it degrades
// to an in-memory store with the same API — surface store state through
// pendingEvidenceCount() rather than throwing on read.
// ---------------------------------------------------------------------------

import { classifyFailure, MAX_SYNC_ATTEMPTS, nextRetryAt } from "./offline-retry";
import { resolveLocalRef, NotSavedError } from "./offline-store";
import { sha256Hex } from "./sha256";

export type EvidenceParentType =
  | "inspection"
  | "incident"
  | "observation"
  | "community_report"
  | "corrective_action";

export type PendingEvidence = {
  id: string;
  parentType: EvidenceParentType;
  /** Server id of the parent — empty when only `parentRef` is known yet. */
  parentId: string;
  /** clientRef of an offline-created parent (OFF-6); resolves on sync. */
  parentRef?: string;
  siteId: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  caption?: string;
  capturedAt?: number;
  /** SHA-256 (lowercase hex) of the bytes at enqueue time (EVD-1). */
  sha256?: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
  /** "pending" until it succeeds; "dead" after a permanent failure or max
   *  attempts — kept (bytes + record never silently dropped). */
  status?: "pending" | "dead";
  failureKind?: "retryable" | "permanent";
  nextRetryAt?: number;
};

export type EvidenceUploader = (args: {
  file: Blob;
  fileName: string;
  mimeType: string;
  parentType: EvidenceParentType;
  parentId: string;
  siteId: string;
  caption?: string;
  capturedAt?: number;
  /** Declared digest; the data layer re-hashes the bytes and refuses a
   *  mismatch (EVIDENCE_HASH_MISMATCH). */
  sha256?: string;
}) => Promise<unknown>;

const DB_NAME = "mg.offline.evidence";
const DB_VERSION = 1;
const STORE = "pending";

let memory: PendingEvidence[] = [];

// TEST HOOK: simulate a storage failure (e.g. QuotaExceededError) on the
// next persistence attempts — how the quota-exhaustion acceptance test
// drives the evidence path in a runtime without IndexedDB.
let writeError: Error | null = null;
export function __testSetEvidenceWriteError(err: Error | null): void {
  writeError = err;
}

function hasIDB(): boolean {
  return typeof indexedDB !== "undefined";
}

function throwIfWriteFails(): void {
  if (writeError) {
    throw new NotSavedError(
      "NOT_SAVED: this device could not store the file — it was NOT queued",
      { cause: writeError },
    );
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run one request against the store, closing the connection afterwards. */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Enqueue bytes for later upload. The SHA-256 is computed BEFORE the write
 *  (EVD-1) and the persistence itself either verifies or throws
 *  NotSavedError — a file the device could not store is never reported as
 *  saved on it (OFF-2). */
export async function enqueuePendingEvidence(
  item: Omit<PendingEvidence, "id" | "createdAt" | "attempts" | "sha256"> & {
    sha256?: string;
  },
): Promise<PendingEvidence> {
  throwIfWriteFails();
  const digest = item.sha256 ?? (await sha256Hex(item.blob)) ?? undefined;
  const entry: PendingEvidence = {
    ...item,
    sha256: digest,
    id: newId(),
    createdAt: Date.now(),
    attempts: 0,
    status: "pending",
  };
  if (!hasIDB()) {
    memory.push(entry);
    return entry;
  }
  await withStore("readwrite", (s) => s.put(entry));
  return entry;
}

async function putPending(entry: PendingEvidence): Promise<void> {
  throwIfWriteFails();
  if (!hasIDB()) {
    memory = memory.map((e) => (e.id === entry.id ? entry : e));
    return;
  }
  await withStore("readwrite", (s) => s.put(entry));
}

export async function readPendingEvidence(): Promise<PendingEvidence[]> {
  if (!hasIDB()) return [...memory].sort((a, b) => a.createdAt - b.createdAt);
  const all = await withStore<PendingEvidence[]>("readonly", (s) => s.getAll());
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function readPendingEvidenceForParent(
  parentType: PendingEvidence["parentType"],
  parentId: string,
): Promise<PendingEvidence[]> {
  const all = await readPendingEvidence();
  return all.filter(
    (e) => e.parentType === parentType && e.parentId === parentId,
  );
}

/** Pending items queued against a parent that only exists locally (OFF-6). */
export async function readPendingEvidenceForParentRef(
  parentRef: string,
): Promise<PendingEvidence[]> {
  const all = await readPendingEvidence();
  return all.filter((e) => e.parentRef === parentRef);
}

export async function removePendingEvidence(id: string): Promise<void> {
  throwIfWriteFails();
  if (!hasIDB()) {
    memory = memory.filter((e) => e.id !== id);
    return;
  }
  await withStore("readwrite", (s) => s.delete(id));
}

export async function updatePendingEvidence(
  id: string,
  patch: Partial<PendingEvidence>,
): Promise<void> {
  const all = await readPendingEvidence();
  const cur = all.find((e) => e.id === id);
  if (!cur) return;
  await putPending({ ...cur, ...patch, id });
}

export async function pendingEvidenceCount(): Promise<number> {
  return (await readPendingEvidence()).length;
}

export interface EvidenceSyncResult {
  synced: number;
  failed: number;
  /** Items waiting for their offline parent to get a server id (OFF-6). */
  waiting: number;
  /** Items parked permanently (integrity mismatch, denial, max attempts). */
  dead: number;
}

/**
 * Replay queued evidence uploads. Never drops an item: a failed upload stays
 * queued with incremented attempt count and the error message, classified
 * through the shared offline-retry policy (backoff + jitter + max attempts).
 * Order of guarantees per item:
 *   1. integrity — freshly hashed bytes must equal the recorded SHA-256;
 *      a mismatch parks the item as EVIDENCE_CORRUPT (permanent) instead of
 *      uploading bytes the record no longer describes.
 *   2. parent resolution — an item with only a local parentRef waits until
 *      the parent's server id exists (resolveParent defaults to the shared
 *      local-ref map), then uploads against the real id.
 *   3. backoff — items inside their retry window are counted as waiting,
 *      not failed, unless `force` (manual retry) is set.
 */
export async function syncEvidenceQueue(
  upload: EvidenceUploader,
  opts: {
    force?: boolean;
    /** Override parent resolution (defaults to the shared local-ref map). */
    resolveParent?: (parentRef: string) => string | null;
  } = {},
): Promise<EvidenceSyncResult> {
  const items = await readPendingEvidence();
  const out: EvidenceSyncResult = { synced: 0, failed: 0, waiting: 0, dead: 0 };
  const now = Date.now();

  for (const item of items) {
    if (item.status === "dead" && !opts.force) {
      out.dead++;
      continue;
    }
    if (!opts.force && item.nextRetryAt && item.nextRetryAt > now) {
      out.waiting++;
      continue;
    }

    // 1. Integrity (EVD-1): hash NOW, compare with what was recorded.
    if (item.sha256) {
      const actual = await sha256Hex(item.blob);
      if (actual && actual !== item.sha256) {
        await updatePendingEvidence(item.id, {
          status: "dead",
          failureKind: "permanent",
          attempts: item.attempts + 1,
          lastError: "EVIDENCE_CORRUPT: stored bytes no longer match the recorded SHA-256",
          nextRetryAt: undefined,
        });
        out.dead++;
        continue;
      }
    }

    // 2. Parent resolution (OFF-6): offline parent first, evidence after.
    let parentId = item.parentId;
    if (!parentId && item.parentRef) {
      const resolver = opts.resolveParent ?? ((ref: string) => resolveLocalRef(ref));
      parentId = (await resolver(item.parentRef)) ?? "";
      if (!parentId) {
        out.waiting++;
        continue; // parent hasn't synced yet — a wait, not a failure
      }
    }
    if (!parentId) {
      await updatePendingEvidence(item.id, {
        status: "dead",
        failureKind: "permanent",
        attempts: item.attempts + 1,
        lastError: "EVIDENCE_REQUIRES_PARENT: no parent id or local parent reference",
        nextRetryAt: undefined,
      });
      out.dead++;
      continue;
    }

    try {
      await upload({
        file: item.blob,
        fileName: item.fileName,
        mimeType: item.mimeType,
        parentType: item.parentType,
        parentId,
        siteId: item.siteId,
        caption: item.caption,
        capturedAt: item.capturedAt,
        sha256: item.sha256,
      });
      await removePendingEvidence(item.id);
      out.synced++;
    } catch (err) {
      const c = classifyFailure(err);
      const attempts = item.attempts + 1;
      const common = {
        attempts,
        lastError: c.message,
        failureKind: c.kind === "retryable" ? ("retryable" as const) : ("permanent" as const),
      };
      if (c.kind === "permanent" || attempts >= MAX_SYNC_ATTEMPTS) {
        await updatePendingEvidence(item.id, {
          ...common,
          status: "dead",
          nextRetryAt: undefined,
        });
        out.dead++;
      } else {
        await updatePendingEvidence(item.id, {
          ...common,
          status: "pending",
          nextRetryAt: nextRetryAt(attempts),
        });
        out.failed++;
      }
    }
  }
  return out;
}

/** TEST ONLY: drop every queued item (memory path) between test cases. */
export function __resetEvidenceQueueForTests(): void {
  memory = [];
  writeError = null;
}
