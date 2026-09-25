// ---------------------------------------------------------------------------
// SUPABASE INITIALIZATION — MineGuard Liberia backend
//
// The Supabase URL and anon key are public client identifiers by design
// (equivalent to the former Firebase web config). All access control is
// enforced by Postgres Row Level Security + security-definer RPCs (see
// supabase/migrations/0001_initial_schema.sql), never by secrecy of these
// values.
// ---------------------------------------------------------------------------

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://ewukneoblhogtreeekqc.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_g_SOzhE21n76m1-FAx-c5Q_CzUi7VMi";

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: "mg.supabase.auth.v1",
  },
  realtime: {
    params: { eventsPerSecond: 8 },
  },
});

// ---------------------------------------------------------------------------
// AUTH STATE STORE — mirrors the previous Firebase onAuthStateChanged shape so
// backend-react.ts and use-auth.ts keep their semantics.
// ---------------------------------------------------------------------------

type AuthListener = (userId: string | null) => void;
type ProfileListener = () => void;

let currentUserId: string | null = null;
let authReady = false;
let profileVersion = 0; // bumped after profile writes so queries re-derive
const listeners = new Set<AuthListener>();
const profileListeners = new Set<ProfileListener>();

function setUserId(id: string | null) {
  const changed = id !== currentUserId;
  currentUserId = id;
  authReady = true;
  if (changed) {
    // A different signed-in identity invalidates every auth-bound cache entry.
    profileVersion = 0;
    for (const l of listeners) l(id);
  }
}

export function onAuthStateChangedSupabase(cb: AuthListener): () => void {
  listeners.add(cb);
  // Emit the current state immediately (mirrors Firebase's behavior of firing
  // with the restored session on startup).
  if (authReady) cb(currentUserId);
  return () => listeners.delete(cb);
}

// Subscribe once at module load.
supabase.auth.onAuthStateChange((event, session: Session | null) => {
  setUserId(session?.user?.id ?? null);
});

export function authUserId(): string | null {
  return currentUserId;
}

export function isAuthReady(): boolean {
  return authReady;
}

/** Bumped when the signed-in user's profile row changes so auth-bound
 *  subscriptions re-derive scope/role without a full sign-out/in. */
export function bumpProfileVersion() {
  profileVersion++;
  // Notify epoch observers (backend-react.ts) so the React cache re-derives
  // auth-bound subscriptions — role/scope changes surface without a reload.
  for (const l of profileListeners) l();
}

/** Observe profile-version changes (used by the React cache epoch). */
export function onProfileVersionChanged(cb: ProfileListener): () => void {
  profileListeners.add(cb);
  return () => profileListeners.delete(cb);
}

export function getProfileVersion(): number {
  return profileVersion;
}

export async function getSessionToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// ---------------------------------------------------------------------------
// ERROR SHAPING — maps Postgres/Supabase errors to the stable message tokens
// the UI already understands (FORBIDDEN, NOT_FOUND, RATE_LIMITED, …).
// ---------------------------------------------------------------------------

export function backendError(err: unknown): Error {
  // PostgREST/Supabase errors arrive as PLAIN OBJECTS ({ code, message,
  // details, hint }), not Error instances — String(err) on those yields
  // "[object Object]", which is the literal bug users saw in every toast.
  // The call sites in backend.ts do `error.message`, which is undefined on
  // them, so the token mapping below never fired. Extract the message from
  // whatever shape arrived BEFORE the instanceof branch.
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message ?? "")
        : typeof err === "string"
          ? err
          : "";

  if (message) {
    if (
      message.includes("FORBIDDEN_ROLE_CHANGE") ||
      message.includes("row-level security") ||
      message.includes("42501")
    ) {
      return new Error("FORBIDDEN");
    }
    if (message.includes("RATE_LIMITED")) return new Error("RATE_LIMITED");
    if (message.includes("NOT_FOUND")) return new Error("NOT_FOUND");
    if (message.includes("UNAUTHENTICATED")) return new Error("UNAUTHENTICATED");
    if (message.includes("UNREGISTERED_USER"))
      return new Error(
        "Your account has no profile row yet — reload the page and try again.",
      );
    if (message.includes("GUEST_ACCOUNT")) return new Error(message);
    if (message.includes("USER_NOT_FOUND"))
      return new Error(
        "No account with that email — the person must sign up first.",
      );
    if (message.includes("PGRST116") || message.includes("No rows")) {
      return new Error("NOT_FOUND");
    }
  }
  if (err instanceof Error) return err;
  // Last resort: never emit the literal "[object Object]" — JSON round-trip
  // whatever we got so the user sees the server's actual code/hint.
  if (typeof err === "object" && err !== null) {
    try {
      return new Error(JSON.stringify(err));
    } catch {
      /* fall through */
    }
  }
  return new Error(String(err) || "Unknown backend error");
}
