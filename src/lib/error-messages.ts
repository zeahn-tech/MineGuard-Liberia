// ---------------------------------------------------------------------------
// ERROR DESCRIPTIONS — one place that turns a thrown value into the three
// things a person needs from an error: WHAT went wrong, WHOSE side it is on
// (so they know whether to retry, change something, or ask someone), and HOW
// to fix it. Pure (no React, no network) so it is unit-testable.
//
// Example of the register we write in:
//   what: "Your session has ended."
//   whose: "For your safety, sessions end after a period of inactivity."
//   fix:  "Sign in again — your saved work is kept."
//
// Rules:
//  * Never show a raw code, SQL text, "[object Object]" or a stack trace as
//    the message. A code may appear as a short `reference` for support.
//  * A readable message that the backend wrote on purpose (a domain rule such
//    as "That invitation has expired.") is kept as the `what` — it is more
//    specific than anything generic we could say.
//  * Say honestly when the problem is the connection, the device, the account
//    or the service. Do not blame the person when it is not theirs.
// ---------------------------------------------------------------------------

export type ErrorCause =
  /** Something the person can change (input, a duplicate, a missing step). */
  | "you"
  /** The connection (offline, timeout, unstable signal). */
  | "network"
  /** Their account or session (role, scope, signed out). */
  | "account"
  /** This device (storage full or blocked). */
  | "device"
  /** The service (our side, or something we could not classify). */
  | "service";

export interface ErrorDescription {
  cause: ErrorCause;
  /** What went wrong, one plain sentence. */
  what: string;
  /** Whose side it is on, one plain sentence. */
  whose: string;
  /** What to do next, one plain sentence. */
  fix: string;
  /** True when trying the same thing again may succeed without any change. */
  retryable: boolean;
  /** Short code for support, when one was recognised. Never shown as the message. */
  reference?: string;
}

export interface DescribeOptions {
  /** Override connectivity (tests). Defaults to navigator.onLine. */
  online?: boolean;
  /** The work was saved on this device and will be sent later (queued flows). */
  queued?: boolean;
  /** Phrase for the failed action, e.g. "save the incident". Used in the fallback. */
  action?: string;
}

interface Extracted {
  message: string;
  name: string;
  code: string;
  status: number | null;
}

/** Pull every field we can classify on out of whatever was thrown. */
function extract(err: unknown): Extracted {
  const out: Extracted = { message: "", name: "", code: "", status: null };
  if (typeof err === "string") {
    out.message = err;
    return out;
  }
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string") out.message = o.message;
    if (typeof o.name === "string") out.name = o.name;
    if (typeof o.code === "string") out.code = o.code;
    else if (typeof o.code === "number") out.code = String(o.code);
    if (typeof o.status === "number") out.status = o.status;
    else if (typeof o.statusCode === "number") out.status = o.statusCode;
  }
  // "[object Object]" is what String(plainObject) gives: never show it.
  if (out.message === "[object Object]") out.message = "";
  return out;
}

const OFFLINE_RE = /failed to fetch|networkerror|network request failed|load failed|network error|err_internet|err_network|fetch failed/i;
const TIMEOUT_RE = /did not answer|timed out|timeout|aborterror|aborted|took too long/i;
const SESSION_RE = /unauthenticated|jwt expired|invalid jwt|invalid refresh token|refresh token|session (has )?expired|not authenticated|auth session missing|signed out/i;
const FORBIDDEN_RE = /forbidden|row-level security|permission denied|not allowed|insufficient[_ ]privilege|not authori[sz]ed/i;
const NOT_FOUND_RE = /not[_ ]found|no rows|does not exist|no longer exists/i;
const DUPLICATE_RE = /duplicate key|already exists|already registered|unique constraint|already a member/i;
const INVALID_RE = /invalid input|violates (check|not-null|foreign key)|null value in column|invalid (value|format)|out of range|malformed/i;
const RATE_RE = /too many (requests|attempts)|rate limit|over_request_rate_limit|too_many/i;
const SERVICE_RE = /internal server|service unavailable|bad gateway|gateway timeout|server error|unexpected|upstream|database error|connection (refused|reset)|(relation|function|column|schema) .*does not exist|could not find the function/i;
const STORAGE_RE = /not[_ ]saved|quota|storage (is )?full|private (mode|browsing)|indexeddb/i;

/** A message the backend wrote for people (sentence case, spaces, no SQL/code noise). */
function isReadableSentence(m: string): boolean {
  if (m.length < 12 || m.length > 220) return false;
  if (!/\s/.test(m)) return false;
  if (!/^[A-Z]/.test(m)) return false;
  // Looks like machine text: contains SQL/driver vocabulary or a bare code.
  if (/\b(relation|column|constraint|function|schema|syntax|postgres|pgrst|sqlstate|violates|undefined|null|stack)\b/i.test(m)) return false;
  if (/^[A-Z0-9_]{3,}(:|\s|$)/.test(m)) return false;
  return true;
}

/** A leading ERROR_CODE token ("TEMPLATE_IN_USE: ..."), used as the support reference. */
function codeToken(e: Extracted): string | undefined {
  const m = e.message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
  if (m) return m[0];
  return e.code || undefined;
}

export function describeError(err: unknown, opts: DescribeOptions = {}): ErrorDescription {
  const e = extract(err);
  const msg = e.message;
  const online =
    opts.online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const reference = codeToken(e);

  // 1. No connection at all — the most common field failure.
  if (!online) {
    return {
      cause: "network",
      what: "You're offline.",
      whose: "This is your connection, not something you did.",
      fix: opts.queued
        ? "Your work is saved on this device and will be sent when you're back online."
        : "Reconnect and try again — nothing was changed.",
      retryable: true,
    };
  }

  // 2. Slow / unreachable network while the browser still thinks it's online.
  if (e.name === "ReadTimeoutError" || e.name === "AbortError" || TIMEOUT_RE.test(msg)) {
    return {
      cause: "network",
      what: "The server took too long to answer.",
      whose: "This is usually a slow or unstable connection, not a problem with your entry.",
      fix: "Try again in a moment, or move to a spot with a better signal.",
      retryable: true,
    };
  }
  if (OFFLINE_RE.test(msg)) {
    return {
      cause: "network",
      what: "We couldn't reach the server.",
      whose: "This is a connection problem, not something you did.",
      fix: opts.queued
        ? "Your work is saved on this device and will be sent when the connection returns."
        : "Check your connection and try again.",
      retryable: true,
    };
  }

  // 3. Session / account.
  if (e.status === 401 || SESSION_RE.test(msg)) {
    return {
      cause: "account",
      what: "Your session has ended.",
      whose: "For your safety, sessions end after a period of inactivity or when sign-in expires.",
      fix: "Sign in again — work you had saved is kept.",
      retryable: false,
      reference: "UNAUTHENTICATED",
    };
  }
  if (e.status === 403 || e.code === "42501" || FORBIDDEN_RE.test(msg)) {
    return {
      cause: "account",
      what: "Your account isn't allowed to do this.",
      whose: "Your role or area doesn't include this action. It isn't a fault with your entry.",
      fix: "Ask an administrator to change your role if you need access.",
      retryable: false,
      reference: "FORBIDDEN",
    };
  }

  // 4. The device.
  if (e.name === "NotSavedError" || e.code === "NOT_SAVED" || STORAGE_RE.test(msg)) {
    return {
      cause: "device",
      what: "This device couldn't keep your work.",
      whose: "Its storage is full or blocked (private browsing can do this).",
      fix: "Free up space or leave private mode, then try again. What's on screen is still there.",
      retryable: true,
      reference: "NOT_SAVED",
    };
  }

  // 5. Things the person can change.
  if (e.status === 404 || e.code === "PGRST116" || (NOT_FOUND_RE.test(msg) && !SERVICE_RE.test(msg))) {
    return {
      cause: "you",
      what: "That record no longer exists or isn't visible to your account.",
      whose: "It may have been removed or moved while you were working.",
      fix: "Go back to the list and refresh it.",
      retryable: false,
      reference: "NOT_FOUND",
    };
  }
  if (e.code === "23505" || DUPLICATE_RE.test(msg)) {
    return {
      cause: "you",
      what: "That already exists.",
      whose: "A record with the same details was already saved.",
      fix: "Open the existing record, or change the value that must be unique.",
      retryable: false,
      reference: "DUPLICATE",
    };
  }
  if (/^2[23]/.test(e.code) || INVALID_RE.test(msg)) {
    return {
      cause: "you",
      what: "Some of the information isn't valid.",
      whose: "One or more fields don't match what is expected.",
      fix: "Check the fields marked in the form and try again.",
      retryable: false,
      reference: reference ?? "INVALID_INPUT",
    };
  }
  if (e.status === 429 || RATE_RE.test(msg)) {
    return {
      cause: "you",
      what: "Too many attempts in a short time.",
      whose: "This is a safety limit, not a fault.",
      fix: "Wait a minute, then try again.",
      retryable: true,
      reference: "RATE_LIMITED",
    };
  }

  // 6. The service.
  if ((e.status !== null && e.status >= 500) || SERVICE_RE.test(msg)) {
    return {
      cause: "service",
      what: "The service had a problem.",
      whose: "This is on our side, not yours.",
      fix: "Try again shortly. If it keeps happening, contact your administrator.",
      retryable: true,
      reference,
    };
  }

  // 7. A readable message written on purpose by the backend: keep it.
  if (isReadableSentence(msg)) {
    return {
      cause: "you",
      what: /[.!?]$/.test(msg) ? msg : `${msg}.`,
      whose: "This was rejected by the platform's rules.",
      fix: "Review what you entered and try again. If it still fails, contact your administrator.",
      retryable: false,
      reference,
    };
  }

  // 8. Unknown. Be honest that we don't know, and still give a way forward.
  const action = opts.action ? `${opts.action}` : "complete that";
  return {
    cause: "service",
    what: `We couldn't ${action}.`,
    whose: "We don't yet know why — it is not necessarily something you did.",
    fix: "Try again. If it keeps happening, tell your administrator and quote the reference below.",
    retryable: true,
    reference,
  };
}

/** One line for inline use ("what + fix"), e.g. under a field or in a banner. */
export function errorSentence(err: unknown, opts?: DescribeOptions): string {
  const d = describeError(err, opts);
  return `${d.what} ${d.fix}`;
}
