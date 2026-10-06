// ---------------------------------------------------------------------------
// SYNC SCHEDULER (OFF-3) — one place that decides WHEN the queues replay.
//
// Triggers, in order of intent:
//  * STARTUP       — first run with force (a fresh app session retries items
//                    parked in a backoff window from the previous session).
//  * 'online'      — connectivity returned: attempt immediately (force).
//  * visibilitychange (visible) — the tab came back to the foreground: run
//                    respecting backoff (force only when the user can't have
//                    just failed a second ago).
//  * BACKOFF TIMER — after every run, the earliest nextRetryAt across both
//                    queues schedules the next automatic pass (exponential
//                    backoff + jitter computed offline-retry.ts).
//  * QUEUE MUTATION — a newly enqueued item that is due runs at once; store
//                    events re-arm the timer.
//
// Runs are skipped entirely while the platform reports offline — an attempt
// that cannot leave the device would only burn retry budget.
//
// Single-flight: syncQueue and syncEvidenceQueue are each single-flight, and
// this scheduler never overlaps its own passes (running flag), so startup +
// online + visibility firing together still produce exactly one send per
// queued item.
// ---------------------------------------------------------------------------

import {
  ensureOfflineReady,
  readQueue,
  subscribeQueue,
  syncQueue,
  peekNextRetryAt,
  type SyncApi,
  type SyncResult,
} from "./offline-queue";
import {
  readPendingEvidence,
  syncEvidenceQueue,
  type EvidenceSyncResult,
  type EvidenceUploader,
} from "./offline-evidence";
import { subscribeStore } from "./offline-store";
import { MAX_BACKOFF_MS } from "./offline-retry";

export interface SchedulerResult {
  queue?: SyncResult;
  evidence?: EvidenceSyncResult;
  /** True when this pass ignored backoff windows (startup / online /
   *  manual sync) — callers toast failures from those passes only. */
  forced: boolean;
}

export interface SyncSchedulerOptions {
  api: SyncApi;
  /** Evidence uploader; omit to let the evidence queue replay elsewhere. */
  upload?: EvidenceUploader;
  onResult?: (r: SchedulerResult) => void;
  onError?: (e: unknown) => void;
}

export interface SyncScheduler {
  /** Manual "Sync now": ignores backoff windows (parked conflict/dead items
   *  only move through explicit retry/discard in the queue manager). */
  syncNow(): Promise<SchedulerResult>;
  dispose(): void;
}

function offline(): boolean {
  return (
    typeof navigator !== "undefined" && navigator.onLine === false
  );
}

/** True when a queued field submission is due right now (no future window). */
function queueDueNow(): boolean {
  const now = Date.now();
  return readQueue().some(
    (q) =>
      (q.status === "pending" || q.status === "failed") &&
      (!q.nextRetryAt || q.nextRetryAt <= now),
  );
}

export function startSyncScheduler(opts: SyncSchedulerOptions): SyncScheduler {
  let disposed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  async function run(force: boolean): Promise<SchedulerResult | null> {
    if (disposed || running) return null;
    if (offline()) return null; // an attempt that cannot leave only burns budget
    running = true;
    clearTimer();
    const out: SchedulerResult = { forced: force };
    try {
      out.queue = await syncQueue(opts.api, { force });
      if (opts.upload) out.evidence = await syncEvidenceQueue(opts.upload, { force });
      opts.onResult?.(out);
    } catch (e) {
      opts.onError?.(e);
    } finally {
      running = false;
      if (!disposed) schedule();
    }
    return out;
  }

  function schedule() {
    if (disposed) return;
    if (queueDueNow()) {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void run(false);
      }, 0);
      return;
    }
    const candidates: number[] = [];
    const nq = peekNextRetryAt();
    if (nq) candidates.push(nq);
    // Evidence windows are read asynchronously — collect them in an effect
    // pass that re-arms the timer when it lands.
    void readPendingEvidence().then((items) => {
      if (disposed || timer !== null) return;
      for (const e of items) {
        if (e.status === "dead" || !e.nextRetryAt) continue;
        candidates.push(e.nextRetryAt);
      }
      if (candidates.length === 0) return;
      const earliest = Math.min(...candidates);
      const delay = Math.max(
        250,
        Math.min(earliest - Date.now(), MAX_BACKOFF_MS),
      );
      timer = setTimeout(() => {
        timer = null;
        void run(false);
      }, delay);
    });
  }

  const onOnline = () => void run(true);
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden")
      return;
    void run(false);
  };
  const offQueue = subscribeQueue(() => {
    if (!disposed && !running) schedule();
  });
  const offStore = subscribeStore(() => {
    if (!disposed && !running) schedule();
  });

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("online", onOnline);
  }
  if (
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function"
  ) {
    document.addEventListener("visibilitychange", onVisible);
  }

  // STARTUP: load the durable queue (recovering any mid-sync crash stranded
  // in "syncing") and make the first attempt.
  void ensureOfflineReady().then(() => run(true));

  return {
    async syncNow(): Promise<SchedulerResult> {
      const out = await run(true);
      return out ?? { forced: true };
    },
    dispose() {
      disposed = true;
      clearTimer();
      offQueue();
      offStore();
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("online", onOnline);
      }
      if (
        typeof document !== "undefined" &&
        typeof document.removeEventListener === "function"
      ) {
        document.removeEventListener("visibilitychange", onVisible);
      }
    },
  };
}
