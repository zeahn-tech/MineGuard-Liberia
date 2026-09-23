// ---------------------------------------------------------------------------
// OFFLINE EVIDENCE QUEUE (IndexedDB-backed)
//
// Evidence BYTES must reach Storage before the metadata doc exists (docs 05/
// 07), so an upload that cannot complete while offline is never dropped: the
// Blob is persisted locally and replayed by syncEvidenceQueue() when
// connectivity returns. A device-local blob: URI is never treated as a
// permanent media reference — the queue holds bytes only until the real upload
// succeeds, then deletes them.
//
// IndexedDB (not localStorage) because the queue stores binary Blobs. Where
// IndexedDB is unavailable (private modes, some test environments) it degrades
// to an in-memory store with the same API, so the UI never throws.
// ---------------------------------------------------------------------------

export type PendingEvidence = {
  id: string;
  parentType: "inspection" | "incident" | "observation";
  parentId: string;
  siteId: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  caption?: string;
  capturedAt?: number;
  createdAt: number;
  attempts: number;
  lastError?: string;
};

export type EvidenceUploader = (args: {
  file: Blob;
  fileName: string;
  mimeType: string;
  parentType: "inspection" | "incident" | "observation";
  parentId: string;
  siteId: string;
  caption?: string;
  capturedAt?: number;
}) => Promise<unknown>;

const DB_NAME = "mg.offline.evidence";
const DB_VERSION = 1;
const STORE = "pending";

let memory: PendingEvidence[] = [];

function hasIDB(): boolean {
  return typeof indexedDB !== "undefined";
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

export async function enqueuePendingEvidence(
  item: Omit<PendingEvidence, "id" | "createdAt" | "attempts">,
): Promise<PendingEvidence> {
  const entry: PendingEvidence = {
    ...item,
    id: newId(),
    createdAt: Date.now(),
    attempts: 0,
  };
  if (!hasIDB()) {
    memory.push(entry);
    return entry;
  }
  await withStore("readwrite", (s) => s.put(entry));
  return entry;
}

async function putPending(entry: PendingEvidence): Promise<void> {
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

export async function removePendingEvidence(id: string): Promise<void> {
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

/**
 * Replay queued evidence uploads. Never drops an item: a failed upload stays
 * queued with incremented attempt count and the error message, so nothing is
 * silently lost. Returns how many items synced and how many remain failed.
 */
export async function syncEvidenceQueue(
  upload: EvidenceUploader,
): Promise<{ synced: number; failed: number }> {
  const items = await readPendingEvidence();
  let synced = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await upload({
        file: item.blob,
        fileName: item.fileName,
        mimeType: item.mimeType,
        parentType: item.parentType,
        parentId: item.parentId,
        siteId: item.siteId,
        caption: item.caption,
        capturedAt: item.capturedAt,
      });
      await removePendingEvidence(item.id);
      synced++;
    } catch (err) {
      failed++;
      await updatePendingEvidence(item.id, {
        attempts: item.attempts + 1,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { synced, failed };
}
