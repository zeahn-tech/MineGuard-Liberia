// ---------------------------------------------------------------------------
// TRACKING CODES — tolerant entry for the public status lookup.
//
// A code is "CR-" + a base-36 timestamp + 8 hex characters (see makeTrackingCode
// in types.ts). People read it off a screen or a text message and type it on a
// phone, so the usual mistakes are: lower case, spaces, a missing "CR-" prefix,
// and letter/number lookalikes (O/0, I/1). We fix the harmless ones silently and
// only ever SUGGEST the lookalike fix — we never guess a different code behind
// someone's back, because the code is the only key to a report's status.
// ---------------------------------------------------------------------------

const PREFIX = "CR-";
/** The generated body is about 16 characters; anything much shorter is a typo. */
const MIN_BODY = 10;

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Upper-case, drop spaces and punctuation, and make sure the "CR-" prefix is there. */
export function normalizeTrackingCode(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (!t) return "";
  // An explicit "CR-" / "CR " prefix is stripped; without one, "CR…" is part of the code.
  const body = alnum(/^CR[-\s_]/.test(t) ? t.slice(3) : t);
  return body ? `${PREFIX}${body}` : "";
}

/** An inline message for the field, or undefined when the code looks plausible. */
export function trackingCodeProblem(raw: string): string | undefined {
  const code = normalizeTrackingCode(raw);
  if (!code) return "Enter the tracking code you were given when you sent the report, like CR-MH1ABC23DEF45678.";
  if (code.length - PREFIX.length < MIN_BODY) {
    return "That code looks too short. Tracking codes have about 16 letters and numbers after CR- \u2014 check for missing characters.";
  }
  return undefined;
}

/**
 * A corrected code when the usual lookalike slips are present in the part of
 * the code that can only be hexadecimal (its last 8 characters: 0-9 and A-F, so
 * O, I and L can only be mistakes for 0 and 1). Null when there is nothing to fix.
 */
export function suggestTrackingCode(raw: string): string | null {
  const code = normalizeTrackingCode(raw);
  if (code.length < PREFIX.length + 8) return null;
  const head = code.slice(0, code.length - 8);
  const tail = code.slice(-8);
  const fixed = tail.replace(/O/g, "0").replace(/[IL]/g, "1");
  return fixed === tail ? null : `${head}${fixed}`;
}
