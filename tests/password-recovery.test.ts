// Password-recovery landing: a reset link must lead to the set-new-password
// screen, never to a silent sign-in.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetRecoveryForTests,
  clearRecovery,
  dismissRecoveryLinkError,
  getRecoveryState,
  markRecoveryPending,
  markRecoveryReady,
  parseAuthCallback,
  subscribeRecovery,
} from "../src/lib/recovery";

describe("parseAuthCallback", () => {
  test("recognises an implicit-flow recovery link", () => {
    const r = parseAuthCallback("#access_token=abc&refresh_token=def&expires_in=3600&type=recovery", "");
    expect(r.recovery).toBe(true);
    expect(r.error).toBeNull();
  });

  test("a normal sign-in / magic-link fragment is not a recovery", () => {
    expect(parseAuthCallback("#access_token=abc&type=signup", "").recovery).toBe(false);
    expect(parseAuthCallback("#access_token=abc&type=magiclink", "").recovery).toBe(false);
  });

  test("router paths are never read as auth callbacks", () => {
    const r = parseAuthCallback("#/auth?mode=reset&type=recovery", "");
    expect(r.recovery).toBe(false);
    expect(r.error).toBeNull();
  });

  test("an expired link yields a friendly error and no recovery", () => {
    const r = parseAuthCallback(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      "",
    );
    expect(r.recovery).toBe(false);
    expect(r.error?.code).toBe("otp_expired");
    expect(r.error?.message).toContain("expired");
  });

  test("errors in the query string are handled too", () => {
    const r = parseAuthCallback("", "?error=access_denied&error_code=otp_expired");
    expect(r.error?.code).toBe("otp_expired");
  });

  test("no callback parameters → nothing", () => {
    expect(parseAuthCallback("", "")).toEqual({ recovery: false, error: null });
    expect(parseAuthCallback("#/portal", "?x=1")).toEqual({ recovery: false, error: null });
  });
});

describe("recovery state", () => {
  beforeEach(() => __resetRecoveryForTests());

  test("PASSWORD_RECOVERY marks pending and notifies subscribers", () => {
    let calls = 0;
    const off = subscribeRecovery(() => calls++);
    markRecoveryPending();
    expect(getRecoveryState().pending).toBe(true);
    expect(calls).toBe(1);
    off();
  });

  test("finishing or abandoning recovery releases the hold", () => {
    markRecoveryPending();
    clearRecovery();
    expect(getRecoveryState().pending).toBe(false);
  });

  test("a pending recovery with no session becomes an expired-link error (no dead-end screen)", () => {
    markRecoveryPending();
    markRecoveryReady(false);
    const s = getRecoveryState();
    expect(s.pending).toBe(false);
    expect(s.ready).toBe(true);
    expect(s.linkError?.code).toBe("otp_expired");
    dismissRecoveryLinkError();
    expect(getRecoveryState().linkError).toBeNull();
  });

  test("a pending recovery WITH a session stays pending once ready", () => {
    markRecoveryPending();
    markRecoveryReady(true);
    expect(getRecoveryState()).toMatchObject({ pending: true, ready: true, linkError: null });
  });

  test("an ordinary session never looks like a recovery", () => {
    markRecoveryReady(true);
    expect(getRecoveryState().pending).toBe(false);
  });
});

describe("wiring (source contracts)", () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();

  test("the auth listener flags PASSWORD_RECOVERY and clears on sign-out", async () => {
    const src = await read("../src/lib/supabase.ts");
    expect(src).toContain('event === "PASSWORD_RECOVERY"');
    expect(src).toContain("markRecoveryPending()");
    expect(src).toContain('event === "SIGNED_OUT"');
    expect(src).toContain("captureRecoveryFromLocation()");
  });

  test("the router is wrapped in the recovery gate", async () => {
    const src = await read("../src/main.tsx");
    expect(src).toContain("<RecoveryGate>");
  });

  test("the sign-in redirect does not fire during a recovery", async () => {
    const src = await read("../src/pages/Auth.tsx");
    expect(src).toContain("isAuthenticated && !isRecovery");
    expect(src).toContain("cancelRecovery");
  });

  test("setting a new password releases the hold and signs out other devices", async () => {
    const src = await read("../src/lib/backend.ts");
    expect(src).toContain("clearRecovery();");
    expect(src).toContain('signOut({ scope: "others" })');
  });
});
