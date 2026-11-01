// ---------------------------------------------------------------------------
// UX STATES — the pure logic behind the error, search and session-expiry states.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { describeError, errorSentence } from "../src/lib/error-messages";
import { closestWord, editDistance, normalizeSearch, suggestQuery, vocabularyOf } from "../src/lib/did-you-mean";
import {
  IDLE_LIMIT_MS,
  WARNING_MS,
  formatCountdown,
  idleState,
  signedOutCopy,
} from "../src/lib/session-expiry";

const ON = { online: true };

describe("describeError — what went wrong, whose side, how to fix", () => {
  test("every description has all three parts, and none is empty", () => {
    const samples: unknown[] = [
      new Error("FORBIDDEN"),
      new Error("UNAUTHENTICATED"),
      new Error("Failed to fetch"),
      new Error("The server did not answer within 8 seconds."),
      { code: "23505", message: "duplicate key value violates unique constraint" },
      { code: "42501", message: "new row violates row-level security policy" },
      new Error("NOT_FOUND"),
      new Error("something truly odd"),
      "plain string",
      {},
      null,
      undefined,
    ];
    for (const s of samples) {
      const d = describeError(s, ON);
      expect(d.what.length).toBeGreaterThan(5);
      expect(d.whose.length).toBeGreaterThan(5);
      expect(d.fix.length).toBeGreaterThan(5);
    }
  });

  test("never surfaces raw codes, SQL or [object Object] as the message", () => {
    const bad = [
      new Error("FORBIDDEN"),
      new Error("[object Object]"),
      { code: "23505", message: 'duplicate key value violates unique constraint "sites_code_key"' },
      new Error('relation "mg_x" does not exist'),
      new Error("PGRST301"),
    ];
    for (const e of bad) {
      const text = errorSentence(e, ON);
      expect(text).not.toContain("[object Object]");
      expect(text).not.toMatch(/relation|constraint|sites_code_key|PGRST|23505/);
      expect(text).not.toMatch(/^[A-Z_]{4,}$/);
    }
  });

  test("offline: names the connection as the cause and reassures about saved work when queued", () => {
    const d = describeError(new Error("anything"), { online: false, queued: true });
    expect(d.cause).toBe("network");
    expect(d.what).toMatch(/offline/i);
    expect(d.whose).toMatch(/connection/i);
    expect(d.fix).toMatch(/saved on this device/i);
    expect(d.retryable).toBe(true);
    // Not queued: do not claim anything was saved.
    expect(describeError(new Error("x"), { online: false }).fix).not.toMatch(/saved/i);
  });

  test("slow network: a read timeout is the connection's fault and retryable", () => {
    const e = Object.assign(new Error("The server did not answer within 8 seconds."), { name: "ReadTimeoutError" });
    const d = describeError(e, ON);
    expect(d.cause).toBe("network");
    expect(d.what).toMatch(/too long/i);
    expect(d.retryable).toBe(true);
  });

  test("session: UNAUTHENTICATED and 401 say the session ended and that saved work is kept", () => {
    for (const e of [new Error("UNAUTHENTICATED"), { status: 401, message: "x" }, new Error("JWT expired")]) {
      const d = describeError(e, ON);
      expect(d.cause).toBe("account");
      expect(d.what).toMatch(/session has ended/i);
      expect(d.fix).toMatch(/sign in again/i);
      expect(d.fix).toMatch(/kept/i);
      expect(d.retryable).toBe(false);
    }
  });

  test("permission: FORBIDDEN / 42501 / RLS are about the account, with who to ask", () => {
    for (const e of [new Error("FORBIDDEN"), { code: "42501", message: "x" }, new Error("new row violates row-level security policy")]) {
      const d = describeError(e, ON);
      expect(d.cause).toBe("account");
      expect(d.what).toMatch(/isn't allowed/i);
      expect(d.fix).toMatch(/administrator/i);
    }
  });

  test("a missing relation (migration not applied) is OUR fault, not 'record not found'", () => {
    const d = describeError(new Error('relation "mg_things" does not exist'), ON);
    expect(d.cause).toBe("service");
    expect(d.whose).toMatch(/our side/i);
  });

  test("duplicate and invalid input are things the person can change", () => {
    expect(describeError({ code: "23505", message: "x" }, ON).cause).toBe("you");
    expect(describeError({ code: "23505", message: "x" }, ON).what).toMatch(/already exists/i);
    expect(describeError({ code: "22P02", message: "invalid input syntax" }, ON).fix).toMatch(/fields/i);
  });

  test("device storage failure says the screen is intact and what to free up", () => {
    const e = Object.assign(new Error("Quota exceeded"), { name: "NotSavedError", code: "NOT_SAVED" });
    const d = describeError(e, ON);
    expect(d.cause).toBe("device");
    expect(d.fix).toMatch(/still there/i);
  });

  test("rate limits and 5xx", () => {
    expect(describeError({ status: 429, message: "x" }, ON).fix).toMatch(/wait/i);
    const s = describeError({ status: 503, message: "x" }, ON);
    expect(s.cause).toBe("service");
    expect(s.whose).toMatch(/our side/i);
  });

  test("a readable backend message is kept as the 'what' (it is more specific)", () => {
    const d = describeError(new Error("That invitation has expired — ask your administrator to send a new one"), ON);
    expect(d.what).toContain("That invitation has expired");
    expect(d.what.endsWith(".")).toBe(true);
  });

  test("unknown errors are honest and keep a support reference when a code exists", () => {
    const d = describeError(new Error("WEIRD_THING_HAPPENED"), { ...ON, action: "save the report" });
    expect(d.what).toBe("We couldn't save the report.");
    expect(d.reference).toBe("WEIRD_THING_HAPPENED");
    expect(d.whose).toMatch(/don't yet know/i);
  });
});

describe("did-you-mean — typo-tolerant suggestions for empty searches", () => {
  test("edit distance counts a swapped pair of letters as one edit", () => {
    expect(editDistance("recieve", "receive")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });

  test("normalizeSearch strips accents, punctuation and case", () => {
    expect(normalizeSearch("  Bomi-County, Gold!  ")).toBe("bomi-county gold");
    expect(normalizeSearch("Café")).toBe("cafe");
  });

  test("suggests the real word for a typo, using only words that exist in the data", () => {
    const vocab = vocabularyOf(["Bomi Gold Works", "Nimba Iron Ore", "Grand Cape Mount"]);
    expect(suggestQuery("nimbaa iron", vocab)).toBe("nimba iron");
    expect(suggestQuery("bomy gold", vocab)).toBe("bomi gold");
    expect(suggestQuery("grand cpae mount", vocab)).toBe("grand cape mount");
  });

  test("returns null when the query is already fine, or nothing is close", () => {
    const vocab = vocabularyOf(["Bomi Gold Works", "Nimba Iron Ore"]);
    expect(suggestQuery("bomi gold", vocab)).toBeNull();
    expect(suggestQuery("zzzzzzzz", vocab)).toBeNull();
    expect(suggestQuery("", vocab)).toBeNull();
    expect(suggestQuery("bomy", [])).toBeNull();
  });

  test("short words are corrected conservatively: never 1-2 letters, and 3-4 letters only keep their first letter", () => {
    expect(closestWord("ab", ["ac"])).toBeNull(); // too short to judge
    expect(closestWord("dog", ["fog"])).toBeNull(); // first letter changed: a different word
    expect(closestWord("blu", ["blue"])).toBe("blue"); // missing letter
    expect(closestWord("iron", ["ironx"])).toBe("ironx");
  });

  test("keeps the words that are fine and fixes only the misspelled one", () => {
    const vocab = vocabularyOf(["Blue Shoes", "Red Shoes"]);
    expect(suggestQuery("blu shoes", vocab)).toBe("blue shoes");
  });
});

describe("session expiry — idle countdown rules", () => {
  const T0 = 1_000_000;
  test("active until the final minute, then warning, then expired", () => {
    expect(idleState(T0, T0 + 5 * 60_000).phase).toBe("active");
    expect(idleState(T0, T0 + IDLE_LIMIT_MS - WARNING_MS - 1).phase).toBe("active");
    const w = idleState(T0, T0 + IDLE_LIMIT_MS - WARNING_MS + 1);
    expect(w.phase).toBe("warning");
    expect(w.msLeft).toBeLessThanOrEqual(WARNING_MS);
    expect(idleState(T0, T0 + IDLE_LIMIT_MS).phase).toBe("expired");
    expect(idleState(T0, T0 + IDLE_LIMIT_MS + 99_999).msLeft).toBe(0);
  });

  test("a clock that moved backwards never produces a negative or early expiry", () => {
    expect(idleState(T0, T0 - 5_000).phase).toBe("active");
  });

  test("the limit is 30 minutes, with a 60 second warning", () => {
    expect(IDLE_LIMIT_MS).toBe(1_800_000);
    expect(WARNING_MS).toBe(60_000);
  });

  test("countdown formatting", () => {
    expect(formatCountdown(59_000)).toBe("0:59");
    expect(formatCountdown(60_000)).toBe("1:00");
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });

  test("the sign-in notice says what happened, why, and that work is kept", () => {
    const idle = signedOutCopy("idle");
    expect(idle.title).toMatch(/signed out/i);
    expect(idle.body).toMatch(/30 minutes/);
    expect(idle.body).toMatch(/kept on this device/i);
    const ended = signedOutCopy("ended");
    expect(ended.body).toMatch(/expired|ended/i);
    expect(ended.body).toMatch(/kept on this device/i);
  });
});
