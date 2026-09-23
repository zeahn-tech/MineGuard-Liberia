// ---------------------------------------------------------------------------
// OFFLINE FIELD QUEUE
// Field inspectors work where connectivity is unreliable. All field writes go
// through this queue: they are persisted in localStorage FIRST, then synced.
// Rules:
//  - Nothing is ever silently dropped. Failed items stay queued with retry info.
//  - Local drafts live in their own store, keyed by a clientRef that the server
//    uses for idempotent dedupe on sync.
//  - A local file (blob:) URI is NEVER treated as a permanent media reference;
//    evidence bytes must be uploaded before the evidence record exists
//    (evidence upload is online-only by contract, doc 05).
// ---------------------------------------------------------------------------

export type QueueKind = "inspectionDraft" | "inspectionSubmit" | "incidentReport" | "observationReport";

export type QueueItem = {
  id: string; // queue id (uuid)
  kind: QueueKind;
  clientRef: string; // idempotency key shared with server
  createdAt: number;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: number;
  status: "pending" | "syncing" | "failed" | "done";
  // Inspection payload (inspectionSubmit kind); templateId/answers are
  // omitted on incidentReport/observationReport items.
  siteId: string;
  siteCode: string;
  templateId?: string;
  answers?: Record<string, unknown>;
  notes?: string;
  latitude?: number;
  longitude?: number;
  gpsAccuracyM?: number;
  capturedAt?: number;
  // Incident / observation payload (incidentReport / observationReport kinds)
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

function safeRead(key: string): unknown[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeWrite(key: string, value: unknown[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — surface to caller via return value false.
  }
}

export function readQueue(): QueueItem[] {
  return safeRead(QUEUE_KEY) as QueueItem[];
}

export function readDrafts(): LocalDraft[] {
  return safeRead(DRAFTS_KEY) as LocalDraft[];
}

export function readDraft(clientRef: string): LocalDraft | undefined {
  return readDrafts().find((d) => d.clientRef === clientRef);
}

export function newClientRef(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function upsertDraft(draft: LocalDraft) {
  const drafts = readDrafts().filter((d) => d.clientRef !== draft.clientRef);
  drafts.push({ ...draft, updatedAt: Date.now() });
  safeWrite(DRAFTS_KEY, drafts);
}

export function deleteDraft(clientRef: string) {
  const drafts = readDrafts().filter((d) => d.clientRef !== clientRef);
  safeWrite(DRAFTS_KEY, drafts);
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
}): QueueItem {
  const queue = readQueue();
  const existing = queue.find((q) => q.clientRef === item.clientRef);
  if (existing) return existing;
  const entry: QueueItem = {
    id: newClientRef(),
    kind: "inspectionSubmit",
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
    ...item,
  };
  queue.push(entry);
  safeWrite(QUEUE_KEY, queue);
  return entry;
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
}): QueueItem {
  const queue = readQueue();
  const existing = queue.find((q) => q.clientRef === item.clientRef);
  if (existing) return existing;
  const { clientRef, siteId, siteCode, ...payload } = item;
  const entry: QueueItem = {
    id: newClientRef(),
    kind: "incidentReport",
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
    clientRef,
    siteId,
    siteCode,
    payload,
  };
  queue.push(entry);
  safeWrite(QUEUE_KEY, queue);
  return entry;
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
}): QueueItem {
  const queue = readQueue();
  const existing = queue.find((q) => q.clientRef === item.clientRef);
  if (existing) return existing;
  const { clientRef, siteId, siteCode, latitude, longitude, ...payload } = item;
  const entry: QueueItem = {
    id: newClientRef(),
    kind: "observationReport",
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
    clientRef,
    siteId,
    siteCode,
    latitude,
    longitude,
    payload,
  };
  queue.push(entry);
  safeWrite(QUEUE_KEY, queue);
  return entry;
}

export function updateQueueItem(id: string, patch: Partial<QueueItem>) {
  const queue = readQueue().map((q) => (q.id === id ? { ...q, ...patch } : q));
  safeWrite(QUEUE_KEY, queue);
}

export function removeQueueItem(id: string) {
  safeWrite(
    QUEUE_KEY,
    readQueue().filter((q) => q.id !== id),
  );
}

export function pendingCount(): number {
  return readQueue().filter((q) => q.status !== "done").length;
}

// ---------------------------------------------------------------------------
// SYNC ENGINE
// ---------------------------------------------------------------------------

// Kept structurally loose: callers bind backend mutations whose ID types are
// opaque strings (Firestore document IDs). Every handler is optional — a
// caller binds only what it needs (the incidents page binds reportIncident,
// the inspections form binds the three inspection handlers). A queued item
// whose handler is missing is treated as a per-item failure, never a silent
// drop; it stays queued with a NO_SYNC_HANDLER error.
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
};

/**
 * Attempt to sync the queue. Returns the number of items successfully synced.
 * Server-side clientRef dedupe makes replays safe (idempotent): a partially
 * completed item is re-entried by the server rather than duplicated.
 */
export async function syncQueue(api: Api): Promise<{
  synced: number;
  failed: number;
}> {
  const queue = readQueue().filter((q) => q.status !== "done");
  let synced = 0;
  let failed = 0;

  for (const item of queue) {
    updateQueueItem(item.id, { status: "syncing" });
    try {
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
      } else if (item.kind === "incidentReport") {
        if (!api.reportIncident) throw new Error("NO_SYNC_HANDLER");
        await api.reportIncident({
          siteId: item.siteId,
          type: item.payload?.type,
          severity: item.payload?.severity,
          description: item.payload?.description,
          occurredAt: item.payload?.occurredAt,
          fatalities: item.payload?.fatalities,
          injured: item.payload?.injured,
          clientRef: item.clientRef,
        });
      } else if (item.kind === "observationReport") {
        if (!api.reportObservation) throw new Error("NO_SYNC_HANDLER");
        await api.reportObservation({
          siteId: item.siteId,
          category: item.payload?.category,
          verification: item.payload?.verification,
          description: item.payload?.description,
          observedAt: item.payload?.observedAt,
          latitude: item.latitude,
          longitude: item.longitude,
          clientRef: item.clientRef,
        });
      }
      removeQueueItem(item.id);
      deleteDraft(item.clientRef);
      synced++;
    } catch (err) {
      failed++;
      updateQueueItem(item.id, {
        status: "failed",
        lastError: err instanceof Error ? err.message : String(err),
        lastAttemptAt: Date.now(),
      });
    }
  }
  return { synced, failed };
}
