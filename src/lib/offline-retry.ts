// ---------------------------------------------------------------------------
// OFFLINE RETRY POLICY (OFF-3) — one classification + backoff ruleset shared
// by the field queue, the evidence queue, and the sync scheduler.
//
// FAILURE CLASSES:
//  * conflict  — the server refused because someone else changed the row
//                first (row_version mismatch, surfaced as CONFLICT:{json} /
//                HTTP 409). Retrying blindly would clobber a human's work:
//                the item parks as status "conflict" until a person
//                resolves it in the queue manager.
//  * permanent — the server understood and will never accept this item
//                (FORBIDDEN, NOT_FOUND, validation, size caps, integrity
//                mismatch). Retrying can't help; the item parks as "dead"
//                so it stops consuming attempts but is never dropped.
//  * retryable — everything else (network failures, 5xx, rate limits,
//                missing handlers that a later render will bind). These get
//                exponential backoff with jitter until MAX_SYNC_ATTEMPTS,
//                then park as "dead" pending a manual retry.
//
// BACKOFF: attempt n waits in [base·2^(n-1) / 2, base·2^(n-1)] — half the
// window is always committed (no live-lock under a dead clock), the other
// half is jittered so a herd of queued devices doesn't retry in lockstep.
// Capped at MAX_BACKOFF_MS so a long-offline device never waits longer
// than 5 minutes once connectivity returns.
// ---------------------------------------------------------------------------

export const MAX_SYNC_ATTEMPTS = 8;
export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

export type FailureKind = "conflict" | "permanent" | "retryable";

export interface ClassifiedFailure {
  kind: FailureKind;
  message: string;
  /** Parsed `server` snapshot for conflict failures (what the other side has). */
  server?: Record<string, unknown>;
}

export const CONFLICT_PREFIX = "CONFLICT:";

/** Backoff window for the given attempt count (1-based AFTER the failure). */
export function computeBackoffMs(
  attempts: number,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
  );
  const half = exp / 2;
  return Math.round(half + rand() * half);
}

const PERMANENT_PATTERNS = [
  "FORBIDDEN",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "EVIDENCE_REQUIRES_SITE",
  "EVIDENCE_HASH_MISMATCH",
  "EVIDENCE_CORRUPT",
  "GUEST_ACCOUNT",
  "NOT_REVIEWABLE",
  "NOT_EDITABLE",
  "ARCHIVE_ONLY",
  "TEMPLATE_INVALID",
];

const RETRYABLE_PATTERNS = [
  "NO_SYNC_HANDLER", // a later render binds the handler — retry, don't kill
  "UNAUTHENTICATED", // the user can sign back in and the item will go
  "RATE_LIMITED",
  "network",
  "fetch",
  "offline",
  "timeout",
  "timed out",
  "ECONN",
  "socket",
  "aborted",
  "HTTP 408",
  "HTTP 425",
  "HTTP 429",
  " 500",
  " 502",
  " 503",
  " 504",
  "statusCode\":5",
  "statusCode\": 5",
];

/** Map a thrown sync failure to its class (+ the server snapshot on 409). */
export function classifyFailure(err: unknown): ClassifiedFailure {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message ?? "")
        : String(err);
  const msg = raw || "unknown error";

  // Conflict first: our data layer raises CONFLICT:{json} (HTTP 409) with a
  // snapshot of the server row so the resolution screen can show both sides.
  if (msg.startsWith(CONFLICT_PREFIX) || /"statusCode":\s*409\b/.test(msg)) {
    let server: Record<string, unknown> | undefined;
    const payload = msg.startsWith(CONFLICT_PREFIX)
      ? msg.slice(CONFLICT_PREFIX.length)
      : msg;
    try {
      const parsed = JSON.parse(payload) as { server?: Record<string, unknown> };
      server = parsed?.server;
    } catch {
      server = undefined;
    }
    return { kind: "conflict", message: msg, server };
  }

  for (const p of PERMANENT_PATTERNS) {
    if (msg.includes(p)) return { kind: "permanent", message: msg };
  }
  // Raw 4xx from an unexpected surface (except the retryable ones above).
  const status = /(?:statusCode"?:\s*|HTTP\s*|status\s+)(4\d\d)/i.exec(msg);
  if (status) {
    const code = Number(status[1]);
    if (code === 408 || code === 425 || code === 429) {
      return { kind: "retryable", message: msg };
    }
    return { kind: "permanent", message: msg };
  }

  for (const p of RETRYABLE_PATTERNS) {
    if (msg.toLowerCase().includes(p.toLowerCase()))
      return { kind: "retryable", message: msg };
  }
  // Safe default: keep trying until MAX_SYNC_ATTEMPTS parks it — an
  // unclassified failure is more likely a transient than a verdict.
  return { kind: "retryable", message: msg };
}

/** nextRetryAt timestamp for a failure at `attempts` total attempts. */
export function nextRetryAt(
  attempts: number,
  rand: () => number = Math.random,
): number {
  return Date.now() + computeBackoffMs(attempts, rand);
}
