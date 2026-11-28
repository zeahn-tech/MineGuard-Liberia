// Pure helpers for the Ministry licence grace period card (migration 0067). No React, no network: unit-testable.
import { format } from "date-fns";

export const GRACE_MAX_DAYS = 365; // mirrors c_max_grace_days in migration 0067; the database is the real limit
export const GRACE_MIN_REASON = 5;
export const GRACE_MAX_REASON = 300;

/** "2027-01-31" -> "31 January 2027" (parsed as a calendar date, never shifted by time zone) */
export function formatGraceDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return format(new Date(y, m - 1, d), "d MMMM yyyy");
}

export function graceReasonProblem(reason: string): string | undefined {
  const n = reason.trim().length;
  if (n < GRACE_MIN_REASON) return `Give a reason of at least ${GRACE_MIN_REASON} characters. It is recorded in the audit log.`;
  if (n > GRACE_MAX_REASON) return `Keep the reason to ${GRACE_MAX_REASON} characters or fewer.`;
  return undefined;
}

export function graceConfirmText(untilIso: string): string {
  return `Companies without a licence number can request new sites until ${formatGraceDate(untilIso)}. After that they cannot until a licence number is recorded. Existing sites are not affected.`;
}

export const GRACE_OFF_CONFIRM_TEXT =
  "Companies without a licence number will no longer be able to request new sites until a licence number is recorded. Existing sites are not affected.";

