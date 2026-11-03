// ---------------------------------------------------------------------------
// UX STATES — the pure logic behind the error, search and session-expiry states.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { describeError, errorSentence } from "../src/lib/error-messages";
import { closestWord, editDistance, normalizeSearch, suggestFromList, suggestQuery, vocabularyOf } from "../src/lib/did-you-mean";
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

import {
  validateSite,
  COMMUNITY_FIELD_ORDER,
  missingMinusProblem,
  phoneProblem,
  validateCommunityReport,
  INCIDENT_FIELD_ORDER,
  OBSERVATION_FIELD_ORDER,
  coordinateProblem,
  validateObservation,
  localDateString,
  pastDateProblem,
  validateCompanyName,
  validateIncident,
  validateInvite,
} from "../src/lib/form-rules";
import {
  chooseProblem,
  confirmProblem,
  countProblem,
  emailProblem,
  firstInvalid,
  hasErrors,
  passwordProblem,
  requiredProblem,
} from "../src/lib/validation";

describe("form validation — exact field, with how to fix it", () => {
  test("messages say what to do, not just that something is wrong", () => {
    expect(requiredProblem("", "a short account", "rockfall at the north pit")).toBe(
      "Enter a short account, for example rockfall at the north pit.",
    );
    expect(requiredProblem("   ", "a name")).toBe("Enter a name.");
    expect(requiredProblem("ok", "a name")).toBeUndefined();
    expect(chooseProblem("", "the site")).toBe("Choose the site from the list.");
    expect(chooseProblem("s1", "the site")).toBeUndefined();
  });

  test("email: empty, missing @, incomplete, valid", () => {
    expect(emailProblem("")).toMatch(/Enter an email address/);
    expect(emailProblem("worker.company.com")).toMatch(/needs an @/);
    expect(emailProblem("worker@company")).toMatch(/incomplete/);
    expect(emailProblem("worker@company.com")).toBeUndefined();
    expect(emailProblem("  worker@company.com  ")).toBeUndefined();
  });

  test("password: says how many characters are missing; confirmation names the second field", () => {
    expect(passwordProblem("")).toMatch(/at least 6/);
    expect(passwordProblem("abc")).toBe("Use at least 6 characters — you have 3.");
    expect(passwordProblem("abcdef")).toBeUndefined();
    expect(confirmProblem("abcdef", "")).toMatch(/again/);
    expect(confirmProblem("abcdef", "abcdeg")).toMatch(/don't match/);
    expect(confirmProblem("abcdef", "abcdef")).toBeUndefined();
  });

  test("counts: optional, whole numbers only, sanity ceiling", () => {
    expect(countProblem("", "Injured")).toBeUndefined();
    expect(countProblem("3", "Injured")).toBeUndefined();
    expect(countProblem("-1", "Injured")).toMatch(/whole number/);
    expect(countProblem("2.5", "Injured")).toMatch(/whole number/);
    expect(countProblem("1e3", "Injured")).toMatch(/whole number/);
    expect(countProblem("999999", "Injured")).toMatch(/too large/);
  });

  test("dates: required, real, and not in the future", () => {
    expect(pastDateProblem("", "it happened", "2026-11-01")).toMatch(/Enter the date it happened/);
    expect(pastDateProblem("11/01/2026", "it happened", "2026-11-01")).toMatch(/valid date/);
    expect(pastDateProblem("2026-13-45", "it happened", "2026-11-01")).toMatch(/valid date/);
    expect(pastDateProblem("2026-11-02", "it happened", "2026-11-01")).toMatch(/in the future/);
    expect(pastDateProblem("2026-11-01", "it happened", "2026-11-01")).toBeUndefined();
    expect(pastDateProblem("2025-01-31", "it happened", "2026-11-01")).toBeUndefined();
    expect(localDateString(new Date(2026, 10, 1))).toBe("2026-11-01");
  });

  test("incident form: flags EACH bad field separately, in on-screen order", () => {
    const e = validateIncident(
      { siteId: "", description: "", occurredAt: "2999-01-01", fatalities: "-2", injured: "x" },
      "2026-11-01",
    );
    expect(Object.keys(e).sort()).toEqual(["description", "fatalities", "injured", "occurredAt", "siteId"]);
    expect(e.siteId).toMatch(/Choose the site/);
    expect(e.description).toMatch(/Enter a short, factual account/);
    expect(e.occurredAt).toMatch(/future/);
    expect(firstInvalid(e, INCIDENT_FIELD_ORDER)).toBe("siteId");
    expect(hasErrors(e)).toBe(true);
  });

  test("incident form: a valid form has no errors; only the bad field is flagged", () => {
    const ok = validateIncident(
      { siteId: "s1", description: "Rockfall", occurredAt: "2026-10-30", fatalities: "", injured: "" },
      "2026-11-01",
    );
    expect(hasErrors(ok)).toBe(false);
    const one = validateIncident(
      { siteId: "s1", description: "Rockfall", occurredAt: "2026-10-30", fatalities: "", injured: "1.5" },
      "2026-11-01",
    );
    expect(Object.keys(one)).toEqual(["injured"]);
    expect(firstInvalid(one, INCIDENT_FIELD_ORDER)).toBe("injured");
  });

  test("invitation and company forms", () => {
    expect(validateInvite({ email: "nope" }).email).toMatch(/@/);
    expect(hasErrors(validateInvite({ email: "a@b.co" }))).toBe(false);
    expect(validateCompanyName({ name: "" }).name).toMatch(/registered name/);
    expect(validateCompanyName({ name: "A" }).name).toMatch(/too short/);
    expect(hasErrors(validateCompanyName({ name: "Bomi Gold" }))).toBe(false);
  });
});

describe("observation form rules", () => {
  const ok = { siteId: "s1", description: "Brown water downstream", observedAt: "2026-10-30", latitude: "", longitude: "" };
  test("a valid observation, with or without coordinates, has no errors", () => {
    expect(hasErrors(validateObservation(ok, "2026-11-01"))).toBe(false);
    expect(hasErrors(validateObservation({ ...ok, latitude: "6.43", longitude: "-9.43" }, "2026-11-01"))).toBe(false);
  });
  test("each bad field is flagged on its own", () => {
    const e = validateObservation({ siteId: "", description: " ", observedAt: "", latitude: "", longitude: "" }, "2026-11-01");
    expect(Object.keys(e).sort()).toEqual(["description", "observedAt", "siteId"]);
    expect(firstInvalid(e, OBSERVATION_FIELD_ORDER)).toBe("siteId");
  });
  test("coordinates: numeric, in range, and given as a pair", () => {
    expect(coordinateProblem("abc", "latitude")).toMatch(/as a number/);
    expect(coordinateProblem("200", "latitude")).toMatch(/between -90 and 90/);
    expect(coordinateProblem("-200", "longitude")).toMatch(/between -180 and 180/);
    expect(coordinateProblem("", "longitude")).toBeUndefined();
    expect(validateObservation({ ...ok, latitude: "6.4" }, "2026-11-01").longitude).toMatch(/Add the longitude/);
    expect(validateObservation({ ...ok, longitude: "-9.4" }, "2026-11-01").latitude).toMatch(/Add the latitude/);
    expect(validateObservation({ ...ok, latitude: "91", longitude: "-9.4" }, "2026-11-01").latitude).toMatch(/Liberia is roughly 4 to 9/);
  });
});

describe("community report rules and the missing-minus longitude check", () => {
  test("a Liberian latitude with a positive longitude suggests the minus sign", () => {
    expect(missingMinusProblem("7.4", "9.5")).toBe("Longitude in Liberia is negative (west of the meridian). Did you mean -9.5?");
    expect(missingMinusProblem("7.4", "-9.5")).toBeUndefined();
    expect(missingMinusProblem("51.5", "9.5")).toBeUndefined(); // not a Liberian latitude: no opinion
    expect(missingMinusProblem("", "9.5")).toBeUndefined();
    expect(missingMinusProblem("7.4", "x")).toBeUndefined();
  });

  test("phone is optional, but if given must look like a phone number", () => {
    expect(phoneProblem("")).toBeUndefined();
    expect(phoneProblem("+231 77 000 0000")).toBeUndefined();
    expect(phoneProblem("(231) 77-000-0000")).toBeUndefined();
    expect(phoneProblem("12345")).toMatch(/country code/);
    expect(phoneProblem("call me")).toMatch(/country code/);
    expect(phoneProblem("+231 77 000 0000 0000 0000")).toMatch(/country code/);
  });

  test("a valid public report passes; each missing required field is flagged separately", () => {
    const ok = { category: "pollution", county: "Nimba", description: "Brown water in the creek", phone: "", latitude: "", longitude: "" };
    expect(hasErrors(validateCommunityReport(ok))).toBe(false);
    const bad = validateCommunityReport({ ...ok, category: "", county: "", description: "" });
    expect(Object.keys(bad).sort()).toEqual(["category", "county", "description"]);
    expect(firstInvalid(bad, COMMUNITY_FIELD_ORDER)).toBe("category");
  });

  test("the observation form gets the same minus-sign suggestion at the longitude field", () => {
    const e = validateObservation(
      { siteId: "s1", description: "x", observedAt: "2026-10-30", latitude: "6.4", longitude: "9.4" },
      "2026-11-01",
    );
    expect(e.longitude).toMatch(/Did you mean -9.4/);
    expect(Object.keys(e)).toEqual(["longitude"]);
  });
});

import { normalizeTrackingCode, suggestTrackingCode, trackingCodeProblem } from "../src/lib/tracking-code";
import { makeTrackingCode } from "../src/lib/types";

describe("tracking codes — tolerant entry for the public lookup", () => {
  test("a freshly generated code is already normal and passes the format check", () => {
    for (let i = 0; i < 20; i++) {
      const c = makeTrackingCode();
      expect(normalizeTrackingCode(c)).toBe(c);
      expect(trackingCodeProblem(c)).toBeUndefined();
    }
  });

  test("lower case, spaces, a missing prefix and stray punctuation are fixed silently", () => {
    const c = "CR-MH1ABC23DEF45678";
    expect(normalizeTrackingCode("cr-mh1abc23def45678")).toBe(c);
    expect(normalizeTrackingCode("  CR MH1A BC23 DEF4 5678 ")).toBe(c);
    expect(normalizeTrackingCode("MH1ABC23DEF45678")).toBe(c);
    expect(normalizeTrackingCode("cr_mh1abc23def45678.")).toBe(c);
    expect(normalizeTrackingCode("")).toBe("");
    expect(normalizeTrackingCode(" - ")).toBe("");
  });

  test("problems say what is wrong and what a code looks like", () => {
    expect(trackingCodeProblem("")).toMatch(/Enter the tracking code/);
    expect(trackingCodeProblem("CR-ABC")).toMatch(/too short/);
    expect(trackingCodeProblem("CR-MH1ABC23DEF45678")).toBeUndefined();
  });

  test("suggests the lookalike fix only in the hex-only tail (O->0, I/L->1), never elsewhere", () => {
    // tail "DEF45O78" has an O that cannot be hex
    expect(suggestTrackingCode("CR-MH1ABC23DEF45O78")).toBe("CR-MH1ABC23DEF45078");
    expect(suggestTrackingCode("CR-MH1ABC23DEF4I678")).toBe("CR-MH1ABC23DEF41678");
    // an O in the base-36 timestamp part is legitimate: leave it alone
    expect(suggestTrackingCode("CR-MHOABC23DEF45678")).toBeNull();
    expect(suggestTrackingCode("CR-MH1ABC23DEF45678")).toBeNull();
    expect(suggestTrackingCode("CR-")).toBeNull();
  });
});

import { CAMERA_REASON_TEXT, cameraReason } from "../src/lib/camera-reason";

describe("camera permission reasons", () => {
  test("maps getUserMedia failures to a cause a person can act on", () => {
    expect(cameraReason({ name: "NotAllowedError" })).toBe("denied");
    expect(cameraReason({ name: "SecurityError" })).toBe("denied");
    expect(cameraReason({ name: "NotFoundError" })).toBe("none");
    expect(cameraReason({ name: "NotReadableError" })).toBe("busy");
    expect(cameraReason(new Error("boom"))).toBe("unavailable");
    expect(cameraReason(null)).toBe("unavailable");
  });
  test("every non-denied reason has plain-language text with a next step or a clear cause", () => {
    for (const text of Object.values(CAMERA_REASON_TEXT)) expect(text.length).toBeGreaterThan(20);
    expect(CAMERA_REASON_TEXT.busy).toMatch(/Close that app/);
  });
});

describe("list-based suggestions and site rules", () => {
  const COUNTIES = ["Bomi", "Bong", "Grand Cape Mount", "Montserrado", "Nimba", "River Cess"];
  test("points a county typo at the real county, in its own spelling", () => {
    expect(suggestFromList("nimbaa", COUNTIES)).toBe("Nimba");
    expect(suggestFromList("grand cpae mount", COUNTIES)).toBe("Grand Cape Mount");
    expect(suggestFromList("Montserado", COUNTIES)).toBe("Montserrado");
  });
  test("no suggestion for an exact match (any case), empty input, or something unrelated", () => {
    expect(suggestFromList("NIMBA", COUNTIES)).toBeNull();
    expect(suggestFromList("river cess", COUNTIES)).toBeNull();
    expect(suggestFromList("", COUNTIES)).toBeNull();
    expect(suggestFromList("zzzzzz", COUNTIES)).toBeNull();
  });
  test("site form: each missing field is flagged with what to enter", () => {
    const e = validateSite({ name: "", operatorName: "", county: "" });
    expect(Object.keys(e).sort()).toEqual(["county", "name", "operatorName"]);
    expect(e.name).toMatch(/Zorzor Corridor Operation/);
    expect(e.operatorName).toMatch(/Choose the operating company/);
    expect(hasErrors(validateSite({ name: "A", operatorName: "B", county: "Nimba" }))).toBe(false);
  });
});
