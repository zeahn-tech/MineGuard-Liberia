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

// ---- environmental observation --------------------------------------------

/** A coordinate that is optional, but if present must be a number in range. */
export function coordinateProblem(value: string, axis: "latitude" | "longitude"): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  const n = Number(v);
  const [lo, hi, hint] =
    axis === "latitude"
      ? [-90, 90, "Liberia is roughly 4 to 9"]
      : [-180, 180, "Liberia is roughly -12 to -7"];
  if (!Number.isFinite(n)) return `Enter ${axis} as a number like ${axis === "latitude" ? "6.43" : "-9.43"}.`;
  if (n < lo || n > hi) return `${axis[0].toUpperCase()}${axis.slice(1)} must be between ${lo} and ${hi}. ${hint}.`;
  return undefined;
}

export type ObservationField = "siteId" | "description" | "observedAt" | "latitude" | "longitude";
export const OBSERVATION_FIELD_ORDER: readonly ObservationField[] = [
  "siteId",
  "description",
  "observedAt",
  "latitude",
  "longitude",
];

export function validateObservation(
  f: { siteId: string; description: string; observedAt: string; latitude: string; longitude: string },
  today?: string,
): FieldErrors<ObservationField> {
  const lat = coordinateProblem(f.latitude, "latitude");
  const lng = coordinateProblem(f.longitude, "longitude");
  return compact<ObservationField>({
    siteId: chooseProblem(f.siteId, "the site where you made the observation"),
    description: requiredProblem(f.description, "what was observed, including how it was measured if it was"),
    observedAt: pastDateProblem(f.observedAt, "it was observed", today),
    latitude: lat ?? (!f.latitude.trim() && f.longitude.trim() ? "Add the latitude too, or clear the longitude." : undefined),
    longitude: lng ?? (f.latitude.trim() && !f.longitude.trim() ? "Add the longitude too, or clear the latitude." : undefined),
  });
}
