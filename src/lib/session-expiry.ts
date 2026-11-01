// ---------------------------------------------------------------------------
// SESSION EXPIRY — pure timing rules and the "you were signed out" notice.
//
// People are signed out after IDLE_LIMIT_MS without activity. Before that
// happens they get a WARNING_MS countdown with a way to stay signed in, and
// when it does happen the sign-in screen tells them what happened, why, and
// that their work is kept (see use-form-draft / the offline queue).
//
// Deliberately React-free so the rules are unit-testable and the notice can be
// written from outside any component (e.g. the auth listener).
// ---------------------------------------------------------------------------

/** Inactivity before sign-out. */
export const IDLE_LIMIT_MS = 30 * 60 * 1000;
/** Countdown shown before the sign-out. */
export const WARNING_MS = 60 * 1000;
/** localStorage key shared between tabs: last activity, epoch ms. */
export const ACTIVITY_KEY = "mg.session.lastActive.v1";
/** sessionStorage key for the notice shown on the sign-in screen. */
export const NOTICE_KEY = "mg.session.signedOutNotice.v1";

export type IdlePhase = "active" | "warning" | "expired";

export interface IdleState {
  phase: IdlePhase;
  /** Milliseconds until sign-out (0 once expired). */
  msLeft: number;
}

/** Where a person stands in the idle countdown. */
export function idleState(
  lastActiveAt: number,
  now: number,
  limitMs: number = IDLE_LIMIT_MS,
  warnMs: number = WARNING_MS,
): IdleState {
  const idleFor = Math.max(0, now - lastActiveAt);
  const msLeft = Math.max(0, limitMs - idleFor);
  if (msLeft === 0) return { phase: "expired", msLeft: 0 };
  if (msLeft <= warnMs) return { phase: "warning", msLeft };
  return { phase: "active", msLeft };
}

export type SignedOutReason = "idle" | "ended";

/** Remember why the person was signed out, for the sign-in screen. */
export function setSignedOutNotice(reason: SignedOutReason): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, reason);
  } catch {
    /* storage unavailable — the sign-in screen simply shows no notice */
  }
}

/** Read the notice without clearing it. Pure, so it is safe in a React state
 *  initializer (StrictMode runs those twice). Pair with clearSignedOutNotice(). */
export function peekSignedOutNotice(): SignedOutReason | null {
  try {
    const v = sessionStorage.getItem(NOTICE_KEY);
    return v === "idle" || v === "ended" ? v : null;
  } catch {
    return null;
  }
}

/** Forget the notice so it is shown once (call from an effect). */
export function clearSignedOutNotice(): void {
  try {
    sessionStorage.removeItem(NOTICE_KEY);
  } catch {
    /* ignore */
  }
}

/** Read and clear in one step. */
export function takeSignedOutNotice(): SignedOutReason | null {
  const v = peekSignedOutNotice();
  if (v) clearSignedOutNotice();
  return v;
}

/** The words on the sign-in screen: what happened, why, and what is safe. */
export function signedOutCopy(reason: SignedOutReason): { title: string; body: string } {
  if (reason === "idle") {
    return {
      title: "You were signed out.",
      body: "For your safety we sign you out after 30 minutes of inactivity. Work you had saved or queued, and report forms you were filling in, are kept on this device — sign in to carry on.",
    };
  }
  return {
    title: "You were signed out.",
    body: "Your sign-in expired or was ended on another device. Work you had saved or queued, and report forms you were filling in, are kept on this device — sign in to carry on.",
  };
}

/** Whole minutes and seconds for a countdown, e.g. 59_000 -> "0:59". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// DELIBERATE vs. UNREQUESTED sign-out. The auth listener sees every SIGNED_OUT;
// only the ones nobody asked for (an expired or revoked sign-in, or a sign-out
// from another tab) deserve a "you were signed out" notice. Code that signs the
// person out on purpose raises this flag first.
// ---------------------------------------------------------------------------

let deliberateSignOut = false;

export function markDeliberateSignOut(): void {
  deliberateSignOut = true;
}

/** Read and clear the flag. */
export function consumeDeliberateSignOut(): boolean {
  const v = deliberateSignOut;
  deliberateSignOut = false;
  return v;
}
