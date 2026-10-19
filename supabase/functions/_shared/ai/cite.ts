// ---------------------------------------------------------------------------
// CITE-OR-ABSTAIN (docs/08 design constraint).
//
// A statement survives only if EVERY identifier it cites is in the set of
// records this request actually retrieved under the caller's RLS. A statement
// that cites nothing, cites something outside the set, or mentions a UUID in
// its prose that is not in the set is DROPPED whole (never trimmed — a
// half-cited sentence is still an unsupported sentence). If nothing survives
// the caller abstains.
// ---------------------------------------------------------------------------

import type { Claim } from "./contract.ts";

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface CiteResult<T extends Claim> {
  kept: T[];
  /** How many statements were dropped for failing the check. */
  dropped: number;
  /** Identifiers that were cited but are not in the retrieved set (for the log's counters only). */
  foreign: string[];
}

export function enforceCiteOrAbstain<T extends Claim>(claims: T[], allowed: ReadonlySet<string>): CiteResult<T> {
  const kept: T[] = [];
  const foreign = new Set<string>();
  let dropped = 0;
  for (const c of claims) {
    const cited = c.citations ?? [];
    const prose = (c.text.match(UUID_RE) ?? []).map((s) => s.toLowerCase());
    const bad = [...cited, ...prose].filter((id) => !allowed.has(id) && !allowed.has(id.toLowerCase()));
    if (cited.length === 0 || bad.length > 0) {
      dropped++;
      for (const b of bad) foreign.add(b);
      continue;
    }
    kept.push(c);
  }
  return { kept, dropped, foreign: [...foreign] };
}

/** Prohibition 2: the assistant never declares guilt, violation or legal status. */
const LEGAL_CONCLUSION =
  /\b(guilty|liable|liability|illegal(ly)?|unlawful(ly)?|violat(e|es|ed|ing|ion|ions)|breach(es|ed)?|offen[cs]e|criminal|negligen(t|ce)|culpable|in contempt|non-?complian(t|ce)|should be (fined|prosecuted|sanctioned|suspended|closed)|must be (fined|prosecuted|sanctioned|suspended|closed))\b/i;

export function containsLegalConclusion(text: string): boolean {
  return LEGAL_CONCLUSION.test(text);
}

/** Digits-only tokens of a string, e.g. "4 incidents (+2)" -> ["4","2"]. */
export function numbersIn(text: string): string[] {
  return text.match(/\d+(?:[.,]\d+)?/g) ?? [];
}
