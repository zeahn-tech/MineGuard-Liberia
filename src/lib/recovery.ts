// ---------------------------------------------------------------------------
// PASSWORD-RECOVERY LANDING STATE
//
// A Supabase reset email links back to the app with a one-time session in the
// URL (implicit flow: `#access_token=…&type=recovery`). supabase-js turns that
// into an ordinary signed-in session, so without special handling the person
// is simply "signed in" and dropped on the landing page / portal — they are
// never asked for a new password. This module remembers that the session came
// from a recovery link so the app can hold the person on the set-password
// screen until they finish (or cancel).
//
// It is deliberately dependency-free (no React, no supabase import) so the URL
// parsing is unit-testable and the state can be captured at module load,
// BEFORE the hash router rewrites the location.
// ---------------------------------------------------------------------------

/** sessionStorage key — survives a reload mid-flow, dies with the tab. */
export const RECOVERY_STORAGE_KEY = "mg.auth.recovery.v1";

export type RecoveryLinkError = {
  /** GoTrue error code, e.g. "otp_expired". */
  code: string | null;
  /** Message safe to show the person. */
  message: string;
};

export type RecoveryState = {
  /** The current session came from a recovery link and no new password has
   *  been set yet. */
  pending: boolean;
  /** supabase-js has finished reading the URL (the session, if any, exists). */
  ready: boolean;
  /** The link was invalid/expired — nothing was signed in. */
  linkError: RecoveryLinkError | null;
};

export type ParsedAuthCallback = {
  recovery: boolean;
  error: RecoveryLinkError | null;
};

const EXPIRED_MESSAGE =
  "That reset link has expired or was already used. Enter your email to get a new one.";
const GENERIC_LINK_MESSAGE =
  "That reset link could not be used. Enter your email to get a new one.";

function paramsOf(raw: string): URLSearchParams {
  return new URLSearchParams(raw.replace(/^[#?]/, ""));
}

/** Read an auth callback out of a location's hash and query string. Pure.
 *  Router paths (`#/auth?mode=reset`) are not auth callbacks and are ignored. */
export function parseAuthCallback(hash: string, search: string): ParsedAuthCallback {
  const sources: URLSearchParams[] = [];
  if (hash && !hash.startsWith("#/")) sources.push(paramsOf(hash));
  if (search) sources.push(paramsOf(search));

  let recovery = false;
  let error: RecoveryLinkError | null = null;
  for (const p of sources) {
    if (p.get("type") === "recovery") recovery = true;
    const code = p.get("error_code");
    const description = p.get("error_description");
    if (!error && (code || p.get("error"))) {
      const expired = code === "otp_expired" || /expired|invalid/i.test(description ?? "");
      error = {
        code,
        message: expired ? EXPIRED_MESSAGE : GENERIC_LINK_MESSAGE,
      };
    }
  }
  // An error callback never carries a usable session.
  return { recovery: recovery && !error, error };
}

// ------------------------------------------------------------------ store

let state: RecoveryState = { pending: false, ready: false, linkError: null };
const listeners = new Set<() => void>();

function set(patch: Partial<RecoveryState>) {
  const next = { ...state, ...patch };
  if (
    next.pending === state.pending &&
    next.ready === state.ready &&
    next.linkError === state.linkError
  )
    return;
  state = next;
  for (const l of listeners) l();
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null; // storage blocked (private mode / policy)
  }
}

function persist(pending: boolean) {
  const s = storage();
  try {
    if (pending) s?.setItem(RECOVERY_STORAGE_KEY, "1");
    else s?.removeItem(RECOVERY_STORAGE_KEY);
  } catch {
    /* best effort — the in-memory flag still holds for this page load */
  }
}

export function getRecoveryState(): RecoveryState {
  return state;
}

export function subscribeRecovery(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The session now in use was issued by a recovery link (also called from the
 *  PASSWORD_RECOVERY auth event, which covers every flow type). */
export function markRecoveryPending() {
  persist(true);
  set({ pending: true, linkError: null });
}

/** The person finished or abandoned recovery. */
export function clearRecovery() {
  persist(false);
  set({ pending: false });
}

export function dismissRecoveryLinkError() {
  set({ linkError: null });
}

/** supabase-js has processed the URL. `hasSession` says whether it produced
 *  (or restored) a session; a "pending" recovery with no session means the
 *  link was already used or expired, so don't trap the person on a screen
 *  that cannot work. */
export function markRecoveryReady(hasSession: boolean) {
  if (state.pending && !hasSession) {
    persist(false);
    set({ ready: true, pending: false, linkError: { code: "otp_expired", message: EXPIRED_MESSAGE } });
    return;
  }
  set({ ready: true });
}

/** Capture a recovery callback from the current URL. Called once at module
 *  load by supabase.ts, before supabase-js and the router touch the URL. */
export function captureRecoveryFromLocation(): void {
  if (typeof window === "undefined") return;
  const { recovery, error } = parseAuthCallback(window.location.hash, window.location.search);

  // Reload during the set-password step: keep holding the person there.
  const resumed = storage()?.getItem(RECOVERY_STORAGE_KEY) === "1";

  if (recovery || resumed) {
    persist(true);
    state = { ...state, pending: true };
  }
  if (error) {
    state = { ...state, pending: false, linkError: error };
    persist(false);
    // Drop the error fragment so the router doesn't treat it as a route.
    try {
      const { pathname } = window.location;
      window.history.replaceState(null, "", pathname);
    } catch {
      /* ignore */
    }
  }
}

/** TEST HOOK ONLY. */
export function __resetRecoveryForTests() {
  state = { pending: false, ready: false, linkError: null };
  listeners.clear();
  try {
    storage()?.removeItem(RECOVERY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
