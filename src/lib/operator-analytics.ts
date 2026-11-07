// ---------------------------------------------------------------------------
// OPERATOR SAFETY ANALYTICS — pure aggregation over records the signed-in
// company administrator can already read (RLS-scoped incidents and JSAs).
// No new data path: nothing here can reveal another company's records.
// ---------------------------------------------------------------------------
import type { Incident } from "@/lib/types";

export const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface IncidentLite {
  severity: Incident["severity"];
  siteName?: string;
  occurredAt: number;
  reportedById: string;
}
export interface JsaLite {
  prepared_by: string;
  created_at: string;
  submitted_at: string | null;
}
export interface Member {
  userId: string;
  name: string | null;
}
export interface ReporterRow {
  userId: string;
  name: string;
  reports: number;
  jsas: number;
  lastActive: number;
}

export function bySeverity(incidents: IncidentLite[]) {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    count: incidents.filter((i) => i.severity === severity).length,
  }));
}

export function byLocation(incidents: IncidentLite[]) {
  const m = new Map<string, number>();
  for (const i of incidents) {
    const k = i.siteName?.trim() || "Unknown site";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([location, count]) => ({ location, count }))
    .sort((a, b) => b.count - a.count || a.location.localeCompare(b.location));
}

/** Incidents in the calendar month of `now`, counted per weekday (local time). */
export function byWeekdayThisMonth(incidents: IncidentLite[], now: number) {
  const ref = new Date(now);
  const counts = WEEKDAYS.map((day) => ({ day, count: 0 }));
  for (const i of incidents) {
    const d = new Date(i.occurredAt);
    if (d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth()) {
      counts[d.getDay()].count += 1;
    }
  }
  return counts;
}

export function topReporters(
  incidents: IncidentLite[],
  jsas: JsaLite[],
  members: Member[],
  limit = 10,
): ReporterRow[] {
  const names = new Map(members.map((m) => [m.userId, m.name?.trim() || "Team member"]));
  const rows = new Map<string, ReporterRow>();
  const row = (id: string): ReporterRow => {
    let r = rows.get(id);
    if (!r) {
      r = { userId: id, name: names.get(id) ?? "Team member", reports: 0, jsas: 0, lastActive: 0 };
      rows.set(id, r);
    }
    return r;
  };
  for (const i of incidents) {
    const r = row(i.reportedById);
    r.reports += 1;
    r.lastActive = Math.max(r.lastActive, i.occurredAt);
  }
  for (const j of jsas) {
    const r = row(j.prepared_by);
    r.jsas += 1;
    const t = Date.parse(j.submitted_at ?? j.created_at);
    if (!Number.isNaN(t)) r.lastActive = Math.max(r.lastActive, t);
  }
  return [...rows.values()]
    .sort((a, b) => b.reports + b.jsas - (a.reports + a.jsas) || b.lastActive - a.lastActive)
    .slice(0, limit);
}
