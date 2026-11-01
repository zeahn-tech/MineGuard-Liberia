// ---------------------------------------------------------------------------
// FORM RULES — per-form validation, as pure functions returning one inline
// message per bad field. Each message says what to do, not merely that the
// field is wrong. The server still enforces everything; these exist so the
// person is told which field, right at the field, before anything is sent.
// ---------------------------------------------------------------------------

import {
  chooseProblem,
  countProblem,
  emailProblem,
  requiredProblem,
  type FieldErrors,
} from "./validation";

/** Today as YYYY-MM-DD in the device's local time (what <input type="date"> uses). */
export function localDateString(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** A date-only field that must be a real date, not in the future. */
export function pastDateProblem(value: string, what: string, today: string = localDateString()): string | undefined {
  if (!value) return `Enter the date ${what}.`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00`))) {
    return "Enter a valid date, like 2026-11-01.";
  }
  if (value > today) return `That date is in the future — enter the day ${what}.`;
  return undefined;
}

function compact<K extends string>(e: FieldErrors<K>): FieldErrors<K> {
  const out: FieldErrors<K> = {};
  for (const [k, v] of Object.entries(e) as [K, string | undefined][]) if (v) out[k] = v;
  return out;
}

// ---- incident report (staff and operator) ---------------------------------

export type IncidentField = "siteId" | "description" | "occurredAt" | "fatalities" | "injured";
export const INCIDENT_FIELD_ORDER: readonly IncidentField[] = ["siteId", "description", "occurredAt", "fatalities", "injured"];

export function validateIncident(
  f: { siteId: string; description: string; occurredAt: string; fatalities: string; injured: string },
  today?: string,
): FieldErrors<IncidentField> {
  return compact<IncidentField>({
    siteId: chooseProblem(f.siteId, "the site where it happened"),
    description: requiredProblem(f.description, "a short, factual account of what happened"),
    occurredAt: pastDateProblem(f.occurredAt, "it happened", today),
    fatalities: countProblem(f.fatalities, "Fatalities"),
    injured: countProblem(f.injured, "Injured"),
  });
}

// ---- email invitations ----------------------------------------------------

export type InviteField = "email";
export function validateInvite(f: { email: string }): FieldErrors<InviteField> {
  return compact<InviteField>({ email: emailProblem(f.email) });
}

// ---- company registration -------------------------------------------------

export type CompanyField = "name";
export function validateCompanyName(f: { name: string }): FieldErrors<CompanyField> {
  const name = f.name.trim();
  return compact<CompanyField>({
    name: !name
      ? "Enter the company's registered name, for example ArcelorMittal Liberia."
      : name.length < 2
        ? "That name is too short — enter the company's full registered name."
        : undefined,
  });
}
