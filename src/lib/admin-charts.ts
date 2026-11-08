// ---------------------------------------------------------------------------
// ADMIN DASHBOARD CHART DATA — pure aggregation over figures the admin
// dashboards already hold (site-status rows, command-center stats, community
// reports). Nothing here reads anything new, so scope/RLS is unchanged.
// ---------------------------------------------------------------------------
import type { CommunityReport, Severity } from "./types";
import {
  STATUS_ORDER,
  type SiteStatusKey,
  type SiteStatusRow,
  type StatusIncident,
} from "./site-status";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export const prettify = (key: string) => {
  const s = key.replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Unknown";
};

/** Sites per primary status, in urgency order (zeros kept so the scale is honest). */
export function statusCounts(rows: SiteStatusRow[]): { status: SiteStatusKey; count: number }[] {
  return STATUS_ORDER.map((status) => ({ status, count: rows.filter((r) => r.status === status).length }));
}

export interface CountyRow {
  county: string;
  openCritical: number;
  overdue: number;
  incidents: number;
}

/** Per-county load: open critical findings, overdue actions, incidents in the period. */
export function countyLoad(rows: SiteStatusRow[], limit = 6): CountyRow[] {
  const m = new Map<string, CountyRow>();
  for (const r of rows) {
    const county = r.site.county?.trim() || "Unknown";
    const c = m.get(county) ?? { county, openCritical: 0, overdue: 0, incidents: 0 };
    c.openCritical += r.openCriticalFindings;
    c.overdue += r.overdueActions;
    c.incidents += r.incidentsInPeriod;
    m.set(county, c);
  }
  return [...m.values()]
    .filter((c) => c.openCritical + c.overdue + c.incidents > 0)
    .sort(
      (a, b) =>
        b.openCritical + b.overdue + b.incidents - (a.openCritical + a.overdue + a.incidents) ||
        a.county.localeCompare(b.county),
    )
    .slice(0, limit);
}

/** Sites with the most incidents in the reporting period. */
export function topIncidentSites(rows: SiteStatusRow[], limit = 5) {
  return rows
    .filter((r) => r.incidentsInPeriod > 0)
    .sort((a, b) => b.incidentsInPeriod - a.incidentsInPeriod || a.site.name.localeCompare(b.site.name))
    .slice(0, limit)
    .map((r) => ({ label: r.site.name, value: r.incidentsInPeriod }));
}

/** Incidents inside the period, by severity, for the sites currently in view. */
export function incidentSeverityInPeriod(
  incidents: StatusIncident[],
  siteIds: Set<string>,
  now: number,
  periodMs: number | null,
) {
  const inView = incidents.filter(
    (i) => siteIds.has(i.siteId) && (periodMs === null || (i.occurredAt <= now && i.occurredAt >= now - periodMs)),
  );
  return SEVERITIES.map((severity) => ({ severity, count: inView.filter((i) => i.severity === severity).length }));
}

/** A {key: count} record → bars, largest first (stable on ties). */
export function recordBars(rec: Record<string, number> | undefined, limit = 8) {
  return Object.entries(rec ?? {})
    .map(([k, v]) => ({ label: prettify(k), value: Number(v) || 0 }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function communityBy(reports: CommunityReport[], key: "status" | "category") {
  const m = new Map<string, number>();
  for (const r of reports) m.set(r[key], (m.get(r[key]) ?? 0) + 1);
  return recordBars(Object.fromEntries(m));
}

/** Share of sites with / without an approved inspection, from the stats %. */
export function coverageSplit(pct: number) {
  const covered = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  return { covered, notCovered: 100 - covered };
}
