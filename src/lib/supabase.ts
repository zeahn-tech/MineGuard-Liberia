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

export let supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Recovery links (Gap #4) restore their session from the URL — the token
    // exchange must run before the hash router claims the location.
    detectSessionInUrl: true,
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
  const becameReady = !authReady;
  currentUserId = id;
  authReady = true;
  if (changed || becameReady) {
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

/** TEST HOOK ONLY — src/lib/backend.ts must never call this. Lets the test
 *  harness establish an identity without a real GoTrue session. */
export function __testSetAuthUserId(id: string | null) {
  setUserId(id);
}

/** TEST HOOK ONLY — swaps the network client for a wire-protocol bridge so
 *  tests can run the real backend.ts against a local Postgres. `supabase`
 *  is a live ESM binding, so every importer sees the swap. Production code
 *  must never call either hook. */
export function __testSetSupabaseClient(client: SupabaseClient) {
  supabase = client;
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
// MFA + ACCOUNT RECOVERY — Gap Closure Directive Gap #4.
//
// Thin, typed wrappers over the GoTrue MFA API (supabase.auth.mfa.*) so the
// data layer and the UI never touch raw wire shapes. Error mapping follows
// the same stable-token convention as authErrorMessage(): the UI matches on
// message text, never on error instances.
//
// HONEST SCOPE (docs/04 gap 2): enrollment, sign-in challenge, unenroll,
// authenticator-assurance level, password reset request + set. Recovery
// CODES and WebAuthn/phone factors are NOT implemented — TOTP only, one
// factor at a time in the UI, documented as the residual.
// ---------------------------------------------------------------------------

export type MfaFactor = {
  id: string;
  factorType: string;
  status: string;
  friendlyName?: string | null;
  createdAt?: string | null;
};

export type MfaAal = {
  /** Assurance the CURRENT session has proven. */
  current: "aal1" | "aal2" | null;
  /** Assurance the account REQUIRES next (aal2 when a verified factor exists). */
  next: "aal1" | "aal2" | null;
};

export type MfaEnrollStart = {
  factorId: string;
  /** Base32 secret for manual entry into the authenticator app. */
  secret: string | null;
  /** QR image (SVG/data URL) when GoTrue provides one. */
  qr: string | null;
  /** otpauth:// URI when GoTrue provides one. */
  uri: string | null;
};

/** Map GoTrue MFA failures to the stable tokens the UI matches on. */
function mfaErrorMessage(err: { message?: string } | null | undefined): string {
  const m = (err?.message ?? "").toLowerCase();
  if (m.includes("too many") || m.includes("rate limit") || m.includes("over_request_rate_limit"))
    return "TOO_MANY_ATTEMPTS";
  if (m.includes("not found")) return "MFA_NOT_FOUND";
  if (m.includes("invalid") || m.includes("totp") || m.includes("code"))
    return "MFA_INVALID_CODE";
  if (m.includes("already verified")) return "MFA_ALREADY_VERIFIED";
  if (m.includes("unverified") || m.includes("enroll")) return "MFA_NOT_ENROLLED";
  return err?.message ?? "AUTH_FAILED";
}

/** Current vs required assurance level for the signed-in account. */
export async function mfaAal(): Promise<MfaAal> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw new Error(mfaErrorMessage(error));
  // AuthenticatorAssuranceLevels includes a (string & {}) widen branch that
  // defeats literal narrowing — cast through the stable wire literals.
  const current = (data.currentLevel ?? null) as MfaAal["current"];
  const next = (data.nextLevel ?? null) as MfaAal["next"];
  return { current, next };
}

/** Verified + unverified factors of the signed-in account. */
export async function mfaListFactors(): Promise<MfaFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw new Error(mfaErrorMessage(error));
  return (data.totp ?? []).map((f) => ({
    id: f.id,
    factorType: f.factor_type ?? "totp",
    status: f.status,
    friendlyName: f.friendly_name ?? null,
    createdAt: f.created_at ?? null,
  }));
}

/** Start TOTP enrollment: creates an UNVERIFIED factor and returns the
 *  authenticator secret (manual entry) plus QR material when provided. */
export async function mfaEnrollStart(friendlyName?: string): Promise<MfaEnrollStart> {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: friendlyName ?? "Authenticator app",
  });
  if (error) throw new Error(mfaErrorMessage(error));
  if (data.type !== "totp") throw new Error("MFA_UNSUPPORTED_FACTOR");
  return {
    factorId: data.id,
    secret: data.totp?.secret ?? null,
    qr: data.totp?.qr_code ?? null,
    uri: data.totp?.uri ?? null,
  };
}

/** Complete enrollment: challenge the fresh factor, verify the code, and
 *  (on success) leave the session at aal2. */
export async function mfaEnrollVerify(factorId: string, code: string): Promise<void> {
  const challenge = await supabase.auth.mfa.challenge({ factorId });
  if (challenge.error) throw new Error(mfaErrorMessage(challenge.error));
  const { error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.data.id,
    code: code.replace(/\s+/g, ""),
  });
  if (error) throw new Error(mfaErrorMessage(error));
}

/** Remove a factor entirely (requires an aal2 session in GoTrue). */
export async function mfaUnenroll(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw new Error(mfaErrorMessage(error));
}

// ---------------------------------------------------------------------------
// BYTE-PROGRESS STORAGE UPLOAD — §10 camera capture + batch evidence upload.
//
// supabase-js's storage.upload() exposes no upload progress. The wire
// equivalent is POST {url}/storage/v1/object/{bucket}/{path} with the
// caller's JWT — implemented here over XMLHttpRequest, the only browser
// primitive that surfaces per-byte upload progress events. auth-js sets the
// SAME path/key format, so objects written through either path are identical
// and the storage RLS policies (first folder = uid) apply unchanged.
// ---------------------------------------------------------------------------

export type UploadProgress = {
  /** Bytes sent so far (approximate — includes HTTP overhead). */
  loaded: number;
  /** Total bytes to send. */
  total: number;
};

/** Upload one blob with progress. Resolves when the object is stored;
 *  rejects on HTTP error or network failure (the caller decides whether a
 *  failure is queueable). No polling, no fake progress: every update is a
 *  real XMLHttpRequest progress event. */
export function uploadWithProgress(
  bucket: string,
  storagePath: string,
  file: Blob,
  mimeType: string,
  onProgress?: (p: UploadProgress) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const token = await getSessionToken();
        if (!token) {
          reject(new Error("UNAUTHENTICATED"));
          return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURI(storagePath)}`, true);
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.setRequestHeader("apikey", SUPABASE_ANON_KEY);
        xhr.setRequestHeader("x-upsert", "false");
        xhr.setRequestHeader("cache-control", "3600");
        xhr.setRequestHeader("content-type", mimeType);
        if (onProgress) {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
          };
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            let message = `Storage upload failed (${xhr.status})`;
            try {
              const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
              message = body.message ?? body.error ?? message;
            } catch {
              /* keep the status-code message */
            }
            reject(new Error(message));
          }
        };
        xhr.onerror = () => reject(new Error("Failed to fetch: network error during upload"));
        xhr.ontimeout = () => reject(new Error("Failed to fetch: upload timed out"));
        xhr.send(file);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
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

  // PostgREST puts the SQLSTATE in the `code` field, separate from the
  // message — capture both before matching (a bare 42501 object whose message
  // is e.g. "permission denied for table sites" must map to FORBIDDEN too).
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code ?? "")
      : "";

  if (message || code) {
    // ORDER MATTERS: specific tokens BEFORE generic substrings they contain.
    // "USER_NOT_FOUND" contains "NOT_FOUND" — the generic branch used to
    // swallow it and the UI showed NOT_FOUND instead of the human text.
    if (message.includes("USER_NOT_FOUND"))
      return new Error(
        "No account with that email — the person must sign up first.",
      );
    if (message.includes("UNREGISTERED_USER"))
      return new Error(
        "Your account has no profile row yet — reload the page and try again.",
      );
    if (message.includes("GUEST_ACCOUNT")) return new Error(message);
    if (message.includes("RATE_LIMITED")) return new Error("RATE_LIMITED");
    if (message.includes("UNAUTHENTICATED")) return new Error("UNAUTHENTICATED");
    // Guard-trigger raises (code P0001) carry these exact stable tokens in
    // their message text (see mg_guard_* in 0001_initial_schema.sql) — map
    // them instead of JSON-round-tripping the whole object at the caller.
    if (message.includes("NOT_REVIEWABLE")) return new Error("NOT_REVIEWABLE");
    if (message.includes("NOT_EDITABLE")) return new Error("NOT_EDITABLE");
    if (
      message.includes("FORBIDDEN_ROLE_CHANGE") ||
      message.includes("FORBIDDEN") ||
      message.includes("row-level security") ||
      message.includes("42501") ||
      code === "42501"
    ) {
      return new Error("FORBIDDEN");
    }
    if (
      message.includes("NOT_FOUND") ||
      message.includes("PGRST116") ||
      message.includes("No rows")
    ) {
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
