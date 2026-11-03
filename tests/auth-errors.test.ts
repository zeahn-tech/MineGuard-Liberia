// ---------------------------------------------------------------------------
// SIGN-IN FAILURES — a deleted account, a closed account and a failing sign-in
// service each get honest, professional words, and the raw service message
// (e.g. "Database error querying schema") never reaches the screen.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authFailure } from "../src/lib/auth-errors";
import { authErrorMessage, signInEmailMfaAware } from "../src/lib/backend";
import { __testSetSupabaseClient } from "../src/lib/supabase";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("the backend names the failure instead of passing the service's text on", () => {
  test("the exact failure seen for a deleted account is recognised as a service error", () => {
    expect(authErrorMessage({ message: "Database error querying schema", status: 500, code: "unexpected_failure" })).toBe(
      "AUTH_SERVICE_ERROR",
    );
    // …by text alone, by code alone, and by status alone
    expect(authErrorMessage({ message: "Database error querying schema" })).toBe("AUTH_SERVICE_ERROR");
    expect(authErrorMessage({ message: "x", code: "unexpected_failure" })).toBe("AUTH_SERVICE_ERROR");
    expect(authErrorMessage({ message: "x", status: 503 })).toBe("AUTH_SERVICE_ERROR");
  });

  test("a closed (banned) login and wrong credentials keep their own codes", () => {
    expect(authErrorMessage({ message: "User is banned" })).toBe("ACCOUNT_DISABLED");
    expect(authErrorMessage({ message: "x", code: "user_banned" })).toBe("ACCOUNT_DISABLED");
    expect(authErrorMessage({ message: "Invalid login credentials", status: 400 })).toBe("INCORRECT_CREDENTIALS");
  });

  test("existing mappings are untouched", () => {
    expect(authErrorMessage({ message: "Email not confirmed" })).toBe("EMAIL_NOT_CONFIRMED");
    expect(authErrorMessage({ message: "Too many requests" })).toBe("TOO_MANY_ATTEMPTS");
    expect(authErrorMessage({ message: "something unrecognised" })).toBe("something unrecognised");
    expect(authErrorMessage(null)).toBe("AUTH_FAILED");
  });
});

describe("the words a person sees", () => {
  test("no account matches: says so, doesn't reveal which half was wrong, offers to create one", () => {
    const f = authFailure("INCORRECT_CREDENTIALS")!;
    expect(f.message).toContain("couldn't find an account with that email and password");
    expect(f.message).toContain("create an account");
    expect(f.offerSignUp).toBe(true);
    // account-enumeration safety: never confirm an email is (or isn't) registered
    expect(f.message).not.toMatch(/no account (exists )?(for|with) that email/i);
    expect(f.message).not.toMatch(/password is (wrong|incorrect)/i);
  });

  test("the sign-in service failing: honest about both possibilities, never shows internals", () => {
    for (const raw of ["AUTH_SERVICE_ERROR", "Database error querying schema", "unexpected_failure"]) {
      const f = authFailure(raw)!;
      expect(f.message).toMatch(/couldn't sign you in just now/);
      expect(f.message).toMatch(/yours was deleted/);
      expect(f.message).toMatch(/try again in a moment/);
      expect(f.message).not.toMatch(/schema|database|unexpected/i);
      expect(f.offerSignUp).toBe(true);
    }
  });

  test("a closed account: says it is closed and that a new one can be created", () => {
    const f = authFailure("ACCOUNT_DISABLED")!;
    expect(f.message).toMatch(/has been closed/);
    expect(f.message).toMatch(/create a new account/);
    expect(authFailure("User is banned")?.message).toBe(f.message);
  });

  test("anything else is left to the caller's own handling", () => {
    expect(authFailure("")).toBeNull();
    expect(authFailure("EMAIL_RATE_LIMIT")).toBeNull();
    expect(authFailure("TOO_MANY_ATTEMPTS")).toBeNull();
    expect(authFailure("Passwords do not match")).toBeNull();
  });
});

describe("end to end through the real sign-in function", () => {
  const fake = (error: unknown) =>
    ({ auth: { signInWithPassword: async () => ({ data: {}, error }) } }) as never;
  beforeAll(() => {
    /* each test installs its own fake client */
  });
  afterAll(() => {
    __testSetSupabaseClient({ auth: { signInWithPassword: async () => ({ error: { message: "reset" } }) } } as never);
  });

  test("a sign-in answered with 'Database error querying schema' surfaces only the code, not the text", async () => {
    __testSetSupabaseClient(fake({ message: "Database error querying schema", status: 500, code: "unexpected_failure" }));
    const err = await signInEmailMfaAware("deleted@example.com", "password").then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err!.message).toBe("AUTH_SERVICE_ERROR");
    expect(err!.message).not.toContain("schema");
    expect(authFailure(err!.message)!.message).toContain("create a new one");
  });

  test("a sign-in for an unknown (deleted) email surfaces the credentials code", async () => {
    __testSetSupabaseClient(fake({ message: "Invalid login credentials", status: 400, code: "invalid_credentials" }));
    const err = await signInEmailMfaAware("deleted@example.com", "password").then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toBe("INCORRECT_CREDENTIALS");
  });
});

describe("the sign-in screen and the pages around it", () => {
  test("Auth uses the shared copy, offers 'Create an account', and its tabs can be switched from code", () => {
    const a = read("src/pages/Auth.tsx");
    expect(a).toContain("authFailure(");
    expect(a).toContain("Create an account");
    expect(a).toContain("<Tabs value={tab}");
    // the old terse messages are gone
    expect(a).not.toContain('return "Incorrect email or password."');
    expect(a).not.toContain('return "No account with that email."');
  });

  test("invitation and join pages never show a raw exception message", () => {
    for (const f of ["src/pages/Invitation.tsx", "src/pages/Join.tsx"]) {
      const src = read(f);
      expect(src).not.toMatch(/setError\(\s*\w+ instanceof Error \? \w+\.message/);
      expect(src).toContain("errorSentence(");
    }
  });
});
