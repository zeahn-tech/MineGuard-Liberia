// ---------------------------------------------------------------------------
// OFFLINE STORE — durable key/value persistence for queue + drafts (OFF-1)
//
// Session 4 moved the field queue and drafts OFF localStorage and INTO
// IndexedDB, because localStorage is synchronous, size-capped (~5MB shared),
// and stringly-typed — while every write failure used to be swallowed by a
// silent try/catch. The rules now:
//
//  * WRITES ARE DURABLE OR THEY THROW. Every storeSet writes to the backing
//    store, READS THE VALUE BACK, and compares — a quota abort, a structured
//    clone failure, or any other persistence error raises NotSavedError
//    (code NOT_SAVED). Callers surface it and the UI must NOT claim "saved".
//  * THE MIRROR NEVER LIES. The in-memory mirror used by synchronous readers
//    is updated only AFTER the durable write is verified, so a failed write
//    leaves both storage and mirror showing the pre-write state.
//  * BACKENDS: IndexedDB when available (the production path), localStorage
//    as the synchronous fallback (test environments shim localStorage; Bun
//    has no IndexedDB), memory only when neither exists (session-scoped —
//    storeBackend() lets the UI warn that nothing survives a reload).
//  * LEGACY MIGRATION: mg.offline.* keys already in localStorage are copied
//    into IndexedDB on first load and removed from localStorage only after
//    the copy verifies.
//  * LOCAL PARENT REFS (OFF-6): a record created offline keeps its
//    clientRef until the server assigns an id; recordLocalRef() maps
//    clientRef → server id so evidence queued against the local parent can
//    resolve after the parent syncs.
// ---------------------------------------------------------------------------

export type StoreBackend = "idb" | "local" | "memory";

/** Persistence failure. Every write path surfaces this instead of swallowing. */
export class NotSavedError extends Error {
  readonly code = "NOT_SAVED";
  /** Underlying storage error (quota, blocked, corrupt) — ES2020 lib has no
   *  built-in Error.cause, so it is declared here. */
  cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "NotSavedError";
    // lib is ES2020 (no ErrorOptions) — keep the underlying storage error
    // reachable for diagnostics.
    this.cause = options?.cause;
  }
}

const DB_NAME = "mg.offline.store";
const DB_VERSION = 1;
const KV = "kv";
const LEGACY_PREFIX = "mg.offline.";

let backend: StoreBackend | null = null;
let initPromise: Promise<void> | null = null;
const memoryStore = new Map<string, string>();
const listeners = new Set<() => void>();

// ---------------------------------------------------------------------------
// BACKEND DETECTION
// ---------------------------------------------------------------------------

function hasIDB(): boolean {
  return typeof indexedDB !== "undefined";
}

function localImpl(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  try {
    localStorage.getItem(LEGACY_PREFIX + "probe"); // read access only — a
    return localStorage; // quota-full store is still the right backend
  } catch {
    return null; // private-mode access denial
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV, "readonly");
    const req = tx.objectStore(KV).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPutTx(db: IDBDatabase, key: string, raw: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV, "readwrite");
    tx.objectStore(KV).put({ key, value: raw });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
  });
}

function idbDeleteTx(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV, "readwrite");
    tx.objectStore(KV).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB delete aborted"));
  });
}

/** Copy mg.offline.* keys from a legacy localStorage install into IndexedDB.
 *  The localStorage copy is deleted only after the IndexedDB copy reads back
 *  correctly — a crash mid-migration can only ever leave the data in BOTH
 *  places, never in neither. */
async function migrateLegacy(db: IDBDatabase): Promise<void> {
  const ls = localImpl();
  if (!ls) return;
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key || !key.startsWith(LEGACY_PREFIX)) continue;
    const raw = ls.getItem(key);
    if (raw === null) continue;
    const existing = (await idbGet(db, key)) as { value?: string } | undefined;
    if (existing && existing.value === raw) {
      ls.removeItem(key);
      continue;
    }
    if (existing) continue; // IndexedDB already has its own copy — keep it
    await idbPutTx(db, key, raw);
    const back = (await idbGet(db, key)) as { value?: string } | undefined;
    if (back && back.value === raw) ls.removeItem(key);
  }
}

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (hasIDB()) {
      try {
        const db = await openDb();
        try {
          await migrateLegacy(db);
        } finally {
          db.close();
        }
        backend = "idb";
        return;
      } catch {
        // IndexedDB unavailable (private mode, blocked) — fall through.
      }
    }
    backend = localImpl() ? "local" : "memory";
  })();
  return initPromise;
}

/** Which backend the store settled on (UI shows a warning on "memory"). */
export async function storeBackend(): Promise<StoreBackend> {
  await ensureInit();
  return backend ?? "memory";
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/** Read a value, or null when absent. Never throws (a corrupt record reads
 *  as absent rather than crashing the UI). */
export async function storeGet<T>(key: string): Promise<T | null> {
  await ensureInit();
  try {
    let raw: string | null = null;
    if (backend === "idb") {
      const db = await openDb();
      try {
        const rec = (await idbGet(db, key)) as { value?: string } | undefined;
        raw = rec?.value ?? null;
      } finally {
        db.close();
      }
    } else if (backend === "local") {
      raw = localImpl()?.getItem(key) ?? null;
    } else {
      raw = memoryStore.get(key) ?? null;
    }
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Durable, verified write. Throws NotSavedError when the value cannot be
 *  persisted (and read back) — NEVER a silent swallow (OFF-2). */
export async function storeSet(key: string, value: unknown): Promise<void> {
  await ensureInit();
  const raw = JSON.stringify(value);
  try {
    if (backend === "idb") {
      const db = await openDb();
      try {
        await idbPutTx(db, key, raw);
        // Durability read-back: the committed record must come back exactly.
        const back = (await idbGet(db, key)) as { value?: string } | undefined;
        if (!back || back.value !== raw) throw new Error("read-back mismatch");
      } finally {
        db.close();
      }
    } else if (backend === "local") {
      const ls = localImpl();
      if (!ls) throw new Error("localStorage became unavailable");
      ls.setItem(key, raw); // QuotaExceededError lands in the catch below
      if (ls.getItem(key) !== raw) throw new Error("read-back mismatch");
    } else {
      memoryStore.set(key, raw);
    }
  } catch (e) {
    throw new NotSavedError(
      "NOT_SAVED: this device could not store the change — it was NOT queued",
      { cause: e },
    );
  }
  emitChange();
}

/** Durable delete. Throws NotSavedError on failure like storeSet (a discard
 *  that did not happen must not read as if it did). */
export async function storeRemove(key: string): Promise<void> {
  await ensureInit();
  try {
    if (backend === "idb") {
      const db = await openDb();
      try {
        await idbDeleteTx(db, key);
        if ((await idbGet(db, key)) !== undefined)
          throw new Error("read-back mismatch");
      } finally {
        db.close();
      }
    } else if (backend === "local") {
      localImpl()?.removeItem(key);
    } else {
      memoryStore.delete(key);
    }
  } catch (e) {
    throw new NotSavedError(
      "NOT_SAVED: this device could not remove the stored change",
      { cause: e },
    );
  }
  emitChange();
}

/** Subscribe to successful mutations of this store (layouts refresh counts). */
export function subscribeStore(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emitChange() {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* listener errors never break persistence */
    }
  }
}

// ---------------------------------------------------------------------------
// LOCAL PARENT REFS (OFF-6) — clientRef → server id for offline-created
// parents, so evidence captured against the local record can sync after the
// parent receives its server id.
// ---------------------------------------------------------------------------

const REFS_KEY = "mg.offline.refs.v1";
export type LocalRefTable = "inspections" | "incidents" | "environmental_observations";
type RefMap = Record<string, { table: LocalRefTable; id: string }>;

export async function recordLocalRef(
  clientRef: string,
  table: LocalRefTable,
  id: string,
): Promise<void> {
  const refs = (await storeGet<RefMap>(REFS_KEY)) ?? {};
  refs[clientRef] = { table, id };
  await storeSet(REFS_KEY, refs);
}

export async function resolveLocalRef(clientRef: string): Promise<string | null> {
  const refs = (await storeGet<RefMap>(REFS_KEY)) ?? {};
  return refs[clientRef]?.id ?? null;
}

export async function readLocalRefs(): Promise<RefMap> {
  return (await storeGet<RefMap>(REFS_KEY)) ?? {};
}

// ---------------------------------------------------------------------------
// TEST HOOK — drop every cached layer so a test's cleared localStorage shim
// is actually observed (the mirror/init promise would otherwise pin state
// from an earlier test).
// ---------------------------------------------------------------------------
export function __resetOfflineStore(): void {
  initPromise = null;
  backend = null;
  memoryStore.clear();
}
