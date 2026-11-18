// ---------------------------------------------------------------------------
// VAPID key handling shared by emergency-dispatch and worker-voice-push.
// Reads nothing from the environment itself (callers pass the raw values) and NEVER logs or returns key
// material: diagnostics carry only a reason code and decoded byte lengths.
//
// Expected formats (what `npx web-push generate-vapid-keys` prints):
//   VAPID_PUBLIC_KEY   base64url, 65 bytes decoded (87 chars)  - uncompressed P-256 point
//   VAPID_PRIVATE_KEY  base64url, 32 bytes decoded (43 chars)  - raw P-256 scalar
// The web-push library throws "Vapid private key should be 32 bytes long when decoded" at module load when
// the private key is any other length, which used to take the whole function down at boot.
// ---------------------------------------------------------------------------
import { Buffer } from "node:buffer"; // not a global in the Supabase edge runtime
import { createECDH } from "node:crypto";

export type VapidReason =
  | "NOT_CONFIGURED"
  | "PRIVATE_KEY_PEM_FORMAT"
  | "PRIVATE_KEY_NOT_BASE64URL"
  | "PRIVATE_KEY_SAME_AS_PUBLIC_KEY"
  | "PRIVATE_KEY_LENGTH"
  | "PUBLIC_KEY_NOT_BASE64URL"
  | "PUBLIC_KEY_LENGTH"
  | "KEY_PAIR_MISMATCH";

export interface VapidDiagnostics {
  reason: VapidReason;
  /** decoded byte length of the private key (never the key itself); expected 32 */
  privateBytes?: number;
  /** decoded byte length of the public key; expected 65 */
  publicBytes?: number;
}

export type VapidResolution =
  | { ok: true; subject: string; publicKey: string; privateKey: string }
  | { ok: false; diagnostics: VapidDiagnostics };

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Canonicalises how a key was pasted into a secret store: trims whitespace/newlines, drops one pair of
 * wrapping quotes, removes interior whitespace, converts standard base64 (+ /) to base64url (- _) and strips
 * "=" padding. It never changes the decoded bytes.
 */
export function normalizeVapidKey(raw: string | null | undefined): string {
  let s = (raw ?? "").trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) s = s.slice(1, -1).trim();
  return s.replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const decodedLength = (k: string) => Buffer.from(k, "base64url").length;

/** Pure validation: returns the first problem found, or null. Safe to log the result. */
export function checkVapidKeys(publicRaw: string | null | undefined, privateRaw: string | null | undefined): VapidDiagnostics | null {
  const pubRaw = (publicRaw ?? "").trim();
  const privRaw = (privateRaw ?? "").trim();
  if (!pubRaw || !privRaw) return { reason: "NOT_CONFIGURED" };
  if (privRaw.includes("-----BEGIN")) return { reason: "PRIVATE_KEY_PEM_FORMAT" };

  const pub = normalizeVapidKey(pubRaw);
  const priv = normalizeVapidKey(privRaw);
  if (!B64URL.test(pub)) return { reason: "PUBLIC_KEY_NOT_BASE64URL" };
  if (!B64URL.test(priv)) return { reason: "PRIVATE_KEY_NOT_BASE64URL" };

  const publicBytes = decodedLength(pub);
  const privateBytes = decodedLength(priv);
  if (publicBytes !== 65) return { reason: "PUBLIC_KEY_LENGTH", publicBytes, privateBytes };
  if (pub === priv) return { reason: "PRIVATE_KEY_SAME_AS_PUBLIC_KEY", publicBytes, privateBytes };
  if (privateBytes !== 32) return { reason: "PRIVATE_KEY_LENGTH", publicBytes, privateBytes };

  // The private key must be the one that produces the published public key; a mismatched pair is accepted by
  // the library but every push service then rejects the notification (401/403).
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(priv, "base64url"));
    if (ecdh.getPublicKey().toString("base64url") !== pub) return { reason: "KEY_PAIR_MISMATCH", publicBytes, privateBytes };
  } catch {
    return { reason: "KEY_PAIR_MISMATCH", publicBytes, privateBytes };
  }
  return null;
}

/** Normalises and validates the three VAPID settings. Never throws, never exposes key material. */
export function resolveVapidConfig(env: { subject?: string | null; publicKey?: string | null; privateKey?: string | null }): VapidResolution {
  const subject = (env.subject ?? "").trim();
  if (!subject) return { ok: false, diagnostics: { reason: "NOT_CONFIGURED" } };
  const problem = checkVapidKeys(env.publicKey, env.privateKey);
  if (problem) return { ok: false, diagnostics: problem };
  return { ok: true, subject, publicKey: normalizeVapidKey(env.publicKey), privateKey: normalizeVapidKey(env.privateKey) };
}

/** One safe log line: reason code and decoded lengths only. */
export function describeVapidProblem(fn: string, d: VapidDiagnostics): string {
  const len = [d.privateBytes !== undefined ? `privateBytes=${d.privateBytes}(expected 32)` : "", d.publicBytes !== undefined ? `publicBytes=${d.publicBytes}(expected 65)` : ""].filter(Boolean).join(" ");
  return `[${fn}] VAPID configuration rejected: ${d.reason}${len ? " " + len : ""}. Push delivery is disabled until the secrets are corrected.`;
}
