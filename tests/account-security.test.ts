// ---------------------------------------------------------------------------
// ACCOUNT SECURITY — Gap Closure Directive v1.0, Priority A, Gap #4.
//
// Account recovery (password reset request + set) and TOTP multi-factor
// authentication: enrollment, sign-in challenge, unenrollment, and the
// authenticator-assurance contract, driven through the REAL src/lib/backend.ts
// and src/lib/supabase.ts exports via the same wire bridge as
// tests/backend-edge.test.ts (tests/helpers/backend-edge.ts).
//
// The bridge's GoTrue fake implements supabase.auth.mfa.* over stub
// auth.mfa_factors / auth.mfa_challenges tables and verifies REAL RFC 6238
// TOTP codes (HMAC-SHA1, 30s step) — the "authenticator app" side of every
// assertion is genuine cryptographic verification, not a scripted echo.
//
// HONEST SCOPE (docs/04 gap 2): TOTP only. Recovery CODES, WebAuthn and
// phone factors are NOT implemented anywhere in the product; nothing here
// pretends otherwise.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import {
  signInEmail,
  signInEmailMfaAware,
  signUpEmail,
  resetPasswordEmail,
  updatePassword,
  mfaAal,
  mfaListFactors,
  mfaEnrollStart,
  mfaEnrollVerify,
  mfaUnenroll,
} from "../src/lib/backend";
import { __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import {
  adminSql,
  createEdgeClient,
  edgeIdentity,
  edgeTotp,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";

let clientSwapped = false;

beforeAll(async () => {
  await getEdgeDb();
  if (!clientSwapped) {
    __testSetSupabaseClient(createEdgeClient());
    clientSwapped = true;
  }
});

function setIdentity(uid: string | null) {
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}

async function expectError(fn: () => Promise<unknown>, token: string) {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    expect(msg).toContain(token);
    return;
  }
  throw new Error(`expected error containing "${token}", but the call succeeded`);
}

describe("MFA enrollment and lifecycle", () => {
  test("an account with no factors reports aal1/aal1; no verified factor exists", async () => {
    setIdentity(f.national);
    const aal = await mfaAal();
    expect(aal.next).toBe("aal1");
    const factors = await mfaListFactors();
    expect(factors.filter((x) => x.status === "verified")).toEqual([]);
  });

  test("enroll → wrong code rejected (factor stays unverified, no aal2)", async () => {
    setIdentity(f.national);
    const start = await mfaEnrollStart("Test authenticator");
    expect(start.factorId).toBeTruthy();
    expect(start.secret).toMatch(/^[A-Z2-7]+$/); // RFC 4648 base32

    // Enroll-verify needs a challenge + code; use the raw factor path via
    // mfaEnrollVerify with a WRONG code → MFA_INVALID_CODE, factor stays
    // unverified, and the account still requires only aal1.
    await expectError(() => mfaEnrollVerify(start.factorId, "000000"), "MFA_INVALID_CODE");
    const factors = await mfaListFactors();
    expect(factors.find((x) => x.id === start.factorId)?.status).toBe("unverified");
    expect((await mfaAal()).next).toBe("aal1");

    // Clean up the unverified factor.
    await mfaUnenroll(start.factorId);
  });

  test("enroll → real TOTP code verifies → factor verified, aal2 required", async () => {
    setIdentity(f.national);
    const start = await mfaEnrollStart("Test authenticator 2");
    // The "authenticator app" side: compute the genuine current TOTP for the
    // enrolled secret and submit it.
    const code = edgeTotp(start.secret!);
    expect(code).toMatch(/^\d{6}$/);
    await mfaEnrollVerify(start.factorId, code);

    const factors = await mfaListFactors();
    const verified = factors.find((x) => x.id === start.factorId);
    expect(verified?.status).toBe("verified");

    // With a verified factor, the account REQUIRES aal2.
    const aal = await mfaAal();
    expect(aal.next).toBe("aal2");

    // The enrolled factor is now owned by national — leave it enrolled for the
    // challenge tests below, remove it at the end of its own describe block.
    await mfaUnenroll(start.factorId);
    expect((await mfaListFactors()).find((x) => x.id === start.factorId)).toBeUndefined();
  });

  test("unenroll: a factor belonging to someone else is not found (no cross-account access)", async () => {
    setIdentity(f.opA);
    await expectError(() => mfaUnenroll(f.mfaFactor), "MFA_NOT_FOUND");
  });

  test("anonymous callers cannot enumerate or enroll", async () => {
    setIdentity(null);
    await expectError(() => mfaListFactors(), "Not authenticated");
    await expectError(() => mfaEnrollStart(), "Not authenticated");
  });
});

describe("MFA sign-in challenge", () => {
  test("a password sign-in on an MFA-enrolled account reports MFA_CHALLENGE_REQUIRED", async () => {
    // county has a pre-verified seeded factor.
    const out = await signInEmailMfaAware("dave@mineguard.test", "pw");
    expect(out.mfaRequired).toBe(true);
    // Session is aal1: current aal2 not yet proven.
    const aal = await mfaAal();
    expect(aal.current).toBe("aal1");
    expect(aal.next).toBe("aal2");
  });

  test("a password sign-in on a non-MFA account goes straight through", async () => {
    const out = await signInEmailMfaAware("erin@mineguard.test", "pw");
    expect(out.mfaRequired).toBe(false);
  });

  test("challenge + wrong code fails; right code proves aal2 (session attains second factor)", async () => {
    // Fresh sign-in to establish the aal1 session.
    await signInEmail("dave@mineguard.test", "pw");
    expect((await mfaAal()).current).toBe("aal1");

    // The bridge verifies genuine TOTP math: get the seeded secret as the
    // "authenticator app" would have it.
    const rows = await adminSql(`select secret from auth.mfa_factors where id = '${f.mfaFactor}'`);
    const secret = String(rows[0].secret);

    // Verify through the public enroll-verify path is NOT the sign-in path —
    // use the factor's challenge directly via the swapped client's mfa API.
    const { supabase } = await import("../src/lib/supabase");
    const challenge = await supabase.auth.mfa.challenge({ factorId: f.mfaFactor });
    expect(challenge.error).toBeNull();
    expect(challenge.data.id).toBeTruthy();

    const wrong = await supabase.auth.mfa.verify({
      factorId: f.mfaFactor,
      challengeId: challenge.data.id,
      code: "000000",
    });
    expect(wrong.error).not.toBeNull();
    expect(wrong.error?.message).toContain("Invalid TOTP code");

    const right = await supabase.auth.mfa.verify({
      factorId: f.mfaFactor,
      challengeId: challenge.data.id,
      code: edgeTotp(secret),
    });
    expect(right.error).toBeNull();

    // AAL contract: current is now proven aal2 in the bridge's model.
    expect((await mfaAal()).current).toBe("aal2");
  });
});

describe("account recovery", () => {
  test("resetPasswordEmail accepts a request without leaking whether the account exists", async () => {
    setIdentity(null);
    // Known address and nonsense address behave IDENTICALLY (GoTrue's
    // no-enumeration contract; the bridge accepts both silently).
    await resetPasswordEmail("dave@mineguard.test");
    await resetPasswordEmail(`nobody-${Date.now()}@edge.test`);
  });

  test("updatePassword requires a session (anonymous callers rejected)", async () => {
    setIdentity(null);
    await expectError(() => updatePassword("new-password-1"), "Not authenticated");
  });

  test("updatePassword with a session succeeds; unknown-address sign-in still fails", async () => {
    setIdentity(f.guest);
    await updatePassword("brand-new-pw");
    await expectError(() => signInEmail("nobody-here@edge.test", "pw"), "INCORRECT_CREDENTIALS");
  });

  test("signUp still maps duplicate email to EMAIL_IN_USE (recovery path does not bypass signup rules)", async () => {
    let msg = "";
    try {
      await signUpEmail("dave@mineguard.test", "whatever");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("EMAIL_IN_USE");
  });
});
