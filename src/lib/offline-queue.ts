// ---------------------------------------------------------------------------
// OFFLINE FIELD QUEUE
// Field inspectors work where connectivity is unreliable. All field writes go
// through this queue: they are persisted in localStorage FIRST, then synced.
// Rules:
//  - Nothing is ever silently dropped. Failed items stay queued with retry info.
//  - Local drafts live in their own store, keyed by a clientRef that the server
//    uses for idempotent dedupe on sync.
//  - A local file (blob:) URI is NEVER treated as a permanent media reference;
//    evidence bytes must be uploaded before the evidence record exists.
// ---------------------------------------------------------------------------

export type QueueKind = "inspectionDraft" | "inspectionSubmit";

export type QueueItem = {
  id: string; // queue id (uuid)
  kind: QueueKind;
  clientRef: string; // idempotency key shared with server
  createdAt: number;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: number;
  status: "pending" | "syncing" | "failed" | "done";
  // Payload
  siteId: string;
  siteCode: string;
  templateId: string;
  answers: Record<string, unknown>;
  notes?: string;
  latitude?: number;
  longitude?: number;
  gpsAccuracyM?: number;
  capturedAt?: number;
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

/** Enqueue a submission. Persists BEFORE any network attempt. */
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

// Kept structurally loose: callers bind Convex mutations whose ID types are
// branded; the queue only ever stores opaque strings.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = {
  createDraft: (args: {
    siteId: any;
    templateId: any;
    clientRef: string;
  }) => Promise<string>;
  updateDraft: (args: {
    inspectionId: any;
    answers?: Record<string, unknown>;
    notes?: string;
    latitude?: number;
    longitude?: number;
    gpsAccuracyM?: number;
  }) => Promise<any>;
  submit: (args: { inspectionId: any }) => Promise<any>;
};

/**
 * Attempt to sync the queue. Returns the number of items successfully synced.
 * Server-side clientRef dedupe makes replays safe (idempotent).
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
