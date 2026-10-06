// ---------------------------------------------------------------------------
// OFFLINE FIELD QUEUE (Session 4 rewrite — OFF-1…6)
// Field inspectors work where connectivity is unreliable. All field writes go
// through this queue: they are persisted durably FIRST (IndexedDB via
// offline-store, read-back verified), then synced. Rules:
//  - Nothing is ever silently dropped. Failed items stay queued with retry
//    info, classified retryable / permanent / conflict (offline-retry.ts).
//  - Nothing is ever silently KEPT either: a write that cannot be persisted
//    throws NotSavedError (OFF-2) so the caller blocks any "saved" UI.
//  - Local drafts live in their own key, keyed by a clientRef that the server
//    uses for idempotent dedupe on sync (replays after crashes cannot
//    duplicate records).
//  - A local file (blob:) URI is NEVER treated as a permanent media reference;
//    evidence bytes must be uploaded before the evidence record exists
//    (evidence upload is online-only by contract, doc 05).
//  - Conflicts: updates that carry row_version surface CONFLICT:{json} from
//    the data layer (HTTP 409); the item parks as status "conflict" with the
//    server's snapshot for the human resolution screen (OFF-4).
//  - Successful syncs record clientRef → server id (local parent refs, OFF-6)
//    so evidence queued against an offline-created parent can follow it.
// ---------------------------------------------------------------------------

import {
  storeGet,
  storeSet,
  recordLocalRef,
  readLocalRefs,
  NotSavedError,
  __resetOfflineStore,
} from "./offline-store";
import {
  classifyFailure,
  MAX_SYNC_ATTEMPTS,
  nextRetryAt,
} from "./offline-retry";

export type QueueKind =
  | "inspectionDraft"
  | "inspectionSubmit"
  | "incidentReport"
  | "observationReport"
  | "caResponse";

export type QueueStatus = "pending" | "syncing" | "failed" | "done" | "conflict" | "dead";

export type QueueItem = {
  id: string; // queue id (uuid)
  kind: QueueKind;
  clientRef: string; // idempotency key shared with server
  createdAt: number;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: number;
  status: QueueStatus;
  /** Classified failure (offline-retry) — drives the queue manager UI. */
  failureKind?: "retryable" | "permanent" | "conflict";
  /** Earliest ts an automatic run may retry this item (backoff + jitter). */
  nextRetryAt?: number;
  /** Server row snapshot captured on a 409 conflict (OFF-4). */
  serverSnapshot?: Record<string, unknown>;
  // Inspection payload (inspectionSubmit kind); templateId/answers are
  // omitted on the other kinds.
  siteId: string;
  siteCode: string;
  templateId?: string;
  answers?: Record<string, unknown>;
  notes?: string;
  latitude?: number;
  longitude?: number;
  gpsAccuracyM?: number;
  capturedAt?: number;
  // Incident / observation payload
  payload?: {
    type?: string;
    category?: string;
    severity?: string;
    verification?: string;
    description?: string;
    occurredAt?: number;
    observedAt?: number;
    fatalities?: number;
    injured?: number;
  };
  // Corrective-action response payload (caResponse kind). expectedRowVersion
  // is the row_version the operator was looking at; the server compares it
  // and answers CONFLICT if someone else bumped the row first.
  ca?: {
    caId: string;
    operatorNote: string;
    expectedRowVersion?: number;
  };
};

export type LocalDraft = {
  clientRef: string;
  siteId: string;
  siteCode: string;
  templateId: string;
  answers: Record<string, unknown>;
  notes?: string;
  latitude?: number;
  longitude?: number;
  gpsAccuracyM?: number;
  updatedAt: number;
};

const QUEUE_KEY = "mg.offline.queue.v1";
const DRAFTS_KEY = "mg.offline.drafts.v1";

// Synchronous mirrors of the durable store (loaded once, mutated only after
// a verified durable write). null = not loaded yet.
let queueCache: QueueItem[] | null = null;
let draftsCache: LocalDraft[] | null = null;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emitQueue() {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* listener errors never break persistence */
    }
  }
}

/** Subscribe to queue/draft mutations (layouts refresh counts through this). */
export function subscribeQueue(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function interrupt(q: QueueItem): QueueItem {
  if (q.status !== "syncing") return q;
  // Mid-sync crash recovery: an item left "syncing" means the app died
  // between the status write and the handler completing. The server MAY or
  // MAY NOT have applied it — the clientRef dedupe makes the replay safe,
  // so park it as retryable rather than guessing.
  return {
    ...q,
    status: "failed",
    failureKind: "retryable",
    lastError: "Interrupted mid-sync — will retry (server dedupe prevents duplicates)",
    lastAttemptAt: Date.now(),
    nextRetryAt: undefined,
  };
}

/**
 * Load the durable queue + drafts into memory (idempotent). Called by every
 * async entry point; layouts call it on mount so sync readers see data.
 * Also recovers items stranded in "syncing" by a crash (OFF: mid-sync crash).
 */
export async function ensureOfflineReady(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const q = (await storeGet<QueueItem[]>(QUEUE_KEY)) ?? [];
    const d = (await storeGet<LocalDraft[]>(DRAFTS_KEY)) ?? [];
    const recovered = q.map(interrupt);
    queueCache = recovered;
    draftsCache = d;
    const drifted = recovered.some((r, i) => r !== q[i]);
    if (drifted) {
      try {
        await storeSet(QUEUE_KEY, recovered);
      } catch (e) {
        // The mirror already shows the recoverable state; if storage itself
        // is broken the next real write surfaces NotSavedError to the UI.
        console.warn("offline queue: could not persist crash recovery", e);
      }
    }
  })();
  return loadPromise;
}

// ---------------------------------------------------------------------------
// SYNC READS (mirror) — safe from render paths after ensureOfflineReady().
// ---------------------------------------------------------------------------

export function readQueue(): QueueItem[] {
  return queueCache ? [...queueCache] : [];
}

export function readDrafts(): LocalDraft[] {
  return draftsCache ? [...draftsCache] : [];
}

export function readDraft(clientRef: string): LocalDraft | undefined {
  return draftsCache?.find((d) => d.clientRef === clientRef);
}

export function newClientRef(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// DURABLE MUTATIONS — persist first, mirror second, surface failures (OFF-2).
//
// Every mutation is a read-modify-write against the FRESHEST stored value
// (not the in-memory mirror), so a second tab (or a scheduler run) that
// wrote in between cannot have its changes clobbered by a stale mirror.
// The mirror updates only after the durable write verifies.
// ---------------------------------------------------------------------------

async function transactQueue(fn: (cur: QueueItem[]) => QueueItem[]): Promise<void> {
  await ensureOfflineReady();
  const fresh = (await storeGet<QueueItem[]>(QUEUE_KEY)) ?? [];
  const next = fn(fresh);
  await storeSet(QUEUE_KEY, next); // throws NotSavedError — nothing swallowed
  queueCache = next;
  emitQueue();
}

async function transactDrafts(fn: (cur: LocalDraft[]) => LocalDraft[]): Promise<void> {
  await ensureOfflineReady();
  const fresh = (await storeGet<LocalDraft[]>(DRAFTS_KEY)) ?? [];
  const next = fn(fresh);
  await storeSet(DRAFTS_KEY, next);
  draftsCache = next;
  emitQueue();
}

export async function upsertDraft(draft: LocalDraft): Promise<void> {
  await transactDrafts((cur) => [
    ...cur.filter((d) => d.clientRef !== draft.clientRef),
    { ...draft, updatedAt: Date.now() },
  ]);
}

export async function deleteDraft(clientRef: string): Promise<void> {
  await transactDrafts((cur) => cur.filter((d) => d.clientRef !== clientRef));
}

async function enqueue(entry: Omit<QueueItem, "id" | "createdAt" | "attempts" | "status">): Promise<QueueItem> {
  await ensureOfflineReady();
  const fresh = (await storeGet<QueueItem[]>(QUEUE_KEY)) ?? [];
  const existing = fresh.find((q) => q.clientRef === entry.clientRef);
  if (existing) {
    queueCache = fresh;
    return existing;
  }
  const full: QueueItem = {
    ...entry,
    id: newClientRef(),
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
  };
  await transactQueue((cur) => [...cur, full]);
  return full;
}

/** Enqueue an inspection submission. Persists BEFORE any network attempt. */
export function enqueueInspectionSubmission(item: {
  clientRef: string;
  siteId: string;
  siteCode: string;
  templateId: string;
  answers: Record<string, unknown>;
  notes?: string;
  latitude?: number;
  longitude?: number;
  gpsAccuracyM?: number;
  capturedAt?: number;
}): Promise<QueueItem> {
  return enqueue({ kind: "inspectionSubmit", ...item });
}

/** Enqueue an incident report. Persists BEFORE any network attempt. */
export function enqueueIncidentReport(item: {
  clientRef: string;
  siteId: string;
  siteCode: string;
  type: string;
  severity: string;
  description: string;
  occurredAt: number;
  fatalities?: number;
  injured?: number;
}): Promise<QueueItem> {
  const { clientRef, siteId, siteCode, ...payload } = item;
  return enqueue({
    kind: "incidentReport",
    clientRef,
    siteId,
    siteCode,
    payload,
  });
}

/** Enqueue an environmental observation. Persists BEFORE any network attempt. */
export function enqueueObservationReport(item: {
  clientRef: string;
  siteId: string;
  siteCode: string;
  category: string;
  verification: string;
  description: string;
  observedAt: number;
  latitude?: number;
  longitude?: number;
}): Promise<QueueItem> {
  const { clientRef, siteId, siteCode, latitude, longitude, ...payload } = item;
  return enqueue({
    kind: "observationReport",
    clientRef,
    siteId,
    siteCode,
    latitude,
    longitude,
    payload,
  });
}

/**
 * Enqueue an operator corrective-action response (offline CA response +
 * 409 conflict detection through row_version, OFF-4 / operator parity).
 * Persists BEFORE any network attempt.
 */
export function enqueueCaResponse(item: {
  clientRef: string;
  siteId: string;
  siteCode: string;
  caId: string;
  operatorNote: string;
  expectedRowVersion?: number;
}): Promise<QueueItem> {
  const { clientRef, siteId, siteCode, caId, operatorNote, expectedRowVersion } = item;
  return enqueue({
    kind: "caResponse",
    clientRef,
    siteId,
    siteCode,
    ca: { caId, operatorNote, expectedRowVersion },
  });
}

export async function updateQueueItem(id: string, patch: Partial<QueueItem>): Promise<void> {
  await transactQueue((cur) =>
    cur.map((q) => (q.id === id ? { ...q, ...patch } : q)),
  );
}

export async function removeQueueItem(id: string): Promise<void> {
  await transactQueue((cur) => cur.filter((q) => q.id !== id));
}

export function pendingCount(): number {
  return readQueue().filter((q) => q.status !== "done").length;
}

/** Earliest automatic-retry timestamp across parked items — the scheduler
 *  arms its backoff timer from this (conflict/dead items are excluded:
 *  they only move through explicit human actions). */
export function peekNextRetryAt(): number | null {
  let min: number | null = null;
  for (const q of queueCache ?? []) {
    if (q.status === "conflict" || q.status === "dead" || q.status === "done")
      continue;
    if (q.nextRetryAt && (min === null || q.nextRetryAt < min)) min = q.nextRetryAt;
  }
  return min;
}

// ---------------------------------------------------------------------------
// QUEUE MANAGER operations (OFF-5): manual retry / discard / JSON export.
// ---------------------------------------------------------------------------

/** Manual retry: clear the parking (conflict/dead/backoff) and let the next
 *  sync attempt the item again. Attempts history is kept — honesty about how
 *  many times a submission has been tried. */
export async function retryQueueItem(id: string): Promise<void> {
  await updateQueueItem(id, {
    status: "pending",
    nextRetryAt: undefined,
    failureKind: undefined,
    serverSnapshot: undefined,
  });
}

/** Discard is durable-or-throws: a discard that did not persist throws
 *  NotSavedError instead of pretending the item is gone. */
export const discardQueueItem = removeQueueItem;

/** Resolve a 409: apply the user's version over the server row they were
 *  shown (expectedRowVersion moves to the server's current version). */
export async function resolveConflictKeepMine(id: string): Promise<void> {
  const item = readQueue().find((q) => q.id === id);
  if (!item) return;
  const serverRow = item.serverSnapshot as { rowVersion?: number } | undefined;
  await updateQueueItem(id, {
    status: "pending",
    failureKind: undefined,
    serverSnapshot: undefined,
    nextRetryAt: undefined,
    ...(item.ca && serverRow?.rowVersion != null
      ? { ca: { ...item.ca, expectedRowVersion: serverRow.rowVersion } }
      : {}),
  });
}

/** Resolve a 409: the server wins — drop the local attempt (explicit human
 *  decision in the queue manager, never automatic). */
export async function resolveConflictKeepServer(id: string): Promise<void> {
  await removeQueueItem(id);
}

export interface QueueExport {
  exportedAt: string;
  queue: QueueItem[];
  drafts: LocalDraft[];
  localRefs: Record<string, { table: string; id: string }>;
}

/** JSON export for support/debugging (queue manager, OFF-5). */
export async function buildQueueExport(): Promise<QueueExport> {
  await ensureOfflineReady();
  return {
    exportedAt: new Date().toISOString(),
    queue: readQueue(),
    drafts: readDrafts(),
    localRefs: await readLocalRefs(),
  };
}

// ---------------------------------------------------------------------------
// SYNC ENGINE (OFF-3: backoff, jitter, max attempts, classification;
// single-flight so startup+online firing together can't double-send)
// ---------------------------------------------------------------------------

// Kept structurally loose: callers bind backend mutations whose ID types are
// opaque strings. Every handler is optional — a caller binds only what it
// needs. A queued item whose handler is missing is treated as a per-item
// retryable failure, never a silent drop (NO_SYNC_HANDLER).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = {
  createDraft?: (args: {
    siteId: any;
    templateId: any;
    clientRef: string;
  }) => Promise<string>;
  updateDraft?: (args: {
    inspectionId: any;
    answers?: Record<string, unknown>;
    notes?: string;
    latitude?: number;
    longitude?: number;
    gpsAccuracyM?: number;
  }) => Promise<any>;
  submit?: (args: { inspectionId: any }) => Promise<any>;
  reportIncident?: (args: Record<string, unknown>) => Promise<any>;
  reportObservation?: (args: Record<string, unknown>) => Promise<any>;
  respondCorrectiveAction?: (args: {
    caId: string;
    operatorNote: string;
    expectedRowVersion?: number;
  }) => Promise<any>;
};

/** The handler bundle a layout binds into syncQueue (exported for the
 *  sync scheduler, offline-sync.ts). */
export type SyncApi = Api;

export interface SyncResult {
  synced: number;
  failed: number;
  /** Items parked by a 409 row_version conflict (need human resolution). */
  conflicts: number;
  /** Items parked permanently (max attempts reached or permanent failure). */
  dead: number;
  /** Items waiting out their backoff window in this run. */
  waiting: number;
}

const REF_TABLE: Partial<Record<QueueKind, "inspections" | "incidents" | "environmental_observations">> = {
  inspectionSubmit: "inspections",
  incidentReport: "incidents",
  observationReport: "environmental_observations",
};

async function runItem(item: QueueItem, api: Api): Promise<string | null> {
  if (item.kind === "inspectionSubmit") {
    if (!api.createDraft || !api.updateDraft || !api.submit)
      throw new Error("NO_SYNC_HANDLER");
    const inspectionId = await api.createDraft({
      siteId: item.siteId,
      templateId: item.templateId,
      clientRef: item.clientRef,
    });
    await api.updateDraft({
      inspectionId,
      answers: item.answers,
      notes: item.notes,
      latitude: item.latitude,
      longitude: item.longitude,
      gpsAccuracyM: item.gpsAccuracyM,
    });
    await api.submit({ inspectionId });
    return inspectionId;
  }
  if (item.kind === "incidentReport") {
    if (!api.reportIncident) throw new Error("NO_SYNC_HANDLER");
    const id = await api.reportIncident({
      siteId: item.siteId,
      type: item.payload?.type,
      severity: item.payload?.severity,
      description: item.payload?.description,
      occurredAt: item.payload?.occurredAt,
      fatalities: item.payload?.fatalities,
      injured: item.payload?.injured,
      clientRef: item.clientRef,
    });
    return typeof id === "string" ? id : null;
  }
  if (item.kind === "observationReport") {
    if (!api.reportObservation) throw new Error("NO_SYNC_HANDLER");
    const id = await api.reportObservation({
      siteId: item.siteId,
      category: item.payload?.category,
      verification: item.payload?.verification,
      description: item.payload?.description,
      observedAt: item.payload?.observedAt,
      latitude: item.latitude,
      longitude: item.longitude,
      clientRef: item.clientRef,
    });
    return typeof id === "string" ? id : null;
  }
  if (item.kind === "caResponse") {
    if (!api.respondCorrectiveAction) throw new Error("NO_SYNC_HANDLER");
    await api.respondCorrectiveAction({
      caId: item.ca?.caId ?? "",
      operatorNote: item.ca?.operatorNote ?? "",
      expectedRowVersion: item.ca?.expectedRowVersion,
    });
    return null; // the CA already has a server id
  }
  throw new Error("NO_SYNC_HANDLER");
}

let activeSync: Promise<SyncResult> | null = null;

/**
 * Attempt to sync the queue. Returns counts by outcome. Server-side
 * clientRef dedupe makes replays safe (idempotent): an item whose handler
 * succeeded but whose local removal was interrupted re-applies rather than
 * duplicates. Single-flight: concurrent triggers share one run.
 *
 * `force` (manual "retry now") ignores backoff windows AND parked
 * conflict/dead items; automatic runs respect both.
 */
export function syncQueue(
  api: Api,
  opts: { force?: boolean } = {},
): Promise<SyncResult> {
  if (activeSync) return activeSync;
  activeSync = runSync(api, opts).finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function runSync(api: Api, opts: { force?: boolean }): Promise<SyncResult> {
  await ensureOfflineReady();
  const now = Date.now();
  const items = readQueue().filter((q) => q.status !== "done");
  const out: SyncResult = { synced: 0, failed: 0, conflicts: 0, dead: 0, waiting: 0 };

  for (const item of items) {
    if (item.status === "conflict" && !opts.force) {
      out.conflicts++;
      continue;
    }
    if (item.status === "dead" && !opts.force) {
      out.dead++;
      continue;
    }
    if (!opts.force && item.nextRetryAt && item.nextRetryAt > now) {
      out.waiting++;
      continue;
    }
    // Persist "syncing" BEFORE the network attempt: a crash from here on is
    // visible (and recoverable) instead of silent.
    await updateQueueItem(item.id, { status: "syncing", nextRetryAt: undefined });
    try {
      const serverId = await runItem(item, api);
      const table = REF_TABLE[item.kind];
      if (serverId && table) {
        await recordLocalRef(item.clientRef, table, serverId);
      }
      await removeQueueItem(item.id);
      await deleteDraft(item.clientRef);
      out.synced++;
    } catch (err) {
      const c = classifyFailure(err);
      const attempts = item.attempts + 1;
      const common = {
        attempts,
        lastError: c.message,
        lastAttemptAt: Date.now(),
        failureKind: c.kind === "conflict" ? ("conflict" as const) : c.kind,
      };
      if (c.kind === "conflict") {
        await updateQueueItem(item.id, {
          ...common,
          status: "conflict",
          nextRetryAt: undefined,
          ...(c.server ? { serverSnapshot: c.server } : {}),
        });
        out.conflicts++;
      } else if (c.kind === "permanent" || attempts >= MAX_SYNC_ATTEMPTS) {
        await updateQueueItem(item.id, {
          ...common,
          status: "dead",
          nextRetryAt: undefined,
        });
        out.dead++;
      } else {
        await updateQueueItem(item.id, {
          ...common,
          status: "failed",
          nextRetryAt: nextRetryAt(attempts),
        });
        out.failed++;
      }
    }
  }
  return out;
}

export { NotSavedError };

/** TEST ONLY: drop every in-memory mirror + store cache so a test that
 *  cleared its localStorage shim actually observes the cleared state. */
export function __resetOfflineQueue(): void {
  queueCache = null;
  draftsCache = null;
  loadPromise = null;
  __resetOfflineStore();
}
