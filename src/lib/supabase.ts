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

let currentUserId: string | null = null;
let authReady = false;
let profileVersion = 0; // bumped after profile writes so queries re-derive
const listeners = new Set<AuthListener>();

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
  if (err instanceof Error) {
    const msg = err.message;
    if (
      msg.includes("FORBIDDEN_ROLE_CHANGE") ||
      msg.includes("row-level security") ||
      msg.includes("42501")
    ) {
      return new Error("FORBIDDEN");
    }
    if (msg.includes("RATE_LIMITED")) return new Error("RATE_LIMITED");
    if (msg.includes("NOT_FOUND")) return new Error("NOT_FOUND");
    if (msg.includes("UNAUTHENTICATED")) return new Error("UNAUTHENTICATED");
    if (msg.includes("GUEST_ACCOUNT")) return new Error(msg);
    if (msg.includes("USER_NOT_FOUND")) return new Error(msg);
    if (msg.includes("PGRST116") || msg.includes("No rows")) {
      return new Error("NOT_FOUND");
    }
    return err;
  }
  return new Error(String(err));
}
