// ---------------------------------------------------------------------------
// SITE STATUS (Phase 1 — National Mining Intelligence Dashboard)
//
// Pure, framework-free, unit-testable. Every figure is derived from rows the
// caller's session already received through Postgres RLS — nothing here
// authorizes, widens or fetches. SCOPING is the database's job (see
// backend.ts `stats.siteStatusFeed`); these functions only classify what the
// caller is already allowed to see.
//
// DOCUMENTED RULES (this is the whole methodology; there is deliberately NO
// composite compliance score — the project has no approved scoring method):
//
//   primary status (first match wins):
//     1. review_now         an OPEN CRITICAL finding exists, or a non-closed
//                           incident with a fatality or critical severity.
//     2. action_overdue     at least one corrective action is outstanding and
//                           past its due date.
//     3. insufficient       no approved inspection on record at all.
//     4. stale              latest approved inspection is older than
//                           STALE_AFTER_DAYS.
//     5. recent_information latest approved inspection is within
//                           STALE_AFTER_DAYS.
//
//   There is NO "safe" / "compliant" / "low risk" status. "recent_information"
//   only says an approved inspection exists within the window; it says nothing
//   about the site being safe, and it never hides the flags below.
//
//   flags (always reported, independent of the primary status): open critical
//   findings, overdue corrective actions, open serious incidents. A critical
//   finding therefore stays visible even when every other figure is favorable.
//
// STALE_AFTER_DAYS = 180 is the APPROVED policy (approved by the project owner,
// 2026-11-01): roughly one inspection every six months. It only controls when a
// site moves between "Recent information available" and "Data stale"; it never
// changes access, risk scores or incident counts, and never hides a finding.
// It is a single exported constant so a future change is a one-line edit plus a
// test update. Callers may also pass their own threshold.
// ---------------------------------------------------------------------------

import type { Severity } from "./types";

export const DAY_MS = 86_400_000;

/** Default staleness window for the latest approved inspection (days). */
export const STALE_AFTER_DAYS = 180;

export type SiteStatusKey =
  | "review_now"
  | "action_overdue"
  | "recent_information"
  | "stale"
  | "insufficient";

/** Ordered most → least urgent. Used for sorting; never a "score". */
export const STATUS_ORDER: readonly SiteStatusKey[] = [
  "review_now",
  "action_overdue",
  "insufficient",
  "stale",
  "recent_information",
];

export interface StatusMeta {
  label: string;
  /** Plain-language meaning; shown to users so colour is never the only cue. */
  description: string;
  /** Glyph that accompanies the label (non-colour cue). */
  glyph: string;
}

export const STATUS_META: Record<SiteStatusKey, StatusMeta> = {
  review_now: {
    label: "Requires immediate review",
    description:
      "An open critical finding or a serious open incident is on record.",
    glyph: "▲",
  },
  action_overdue: {
    label: "Corrective action overdue",
    description: "At least one outstanding corrective action is past its due date.",
    glyph: "◆",
  },
  insufficient: {
    label: "Information insufficient",
    description:
      "No approved inspection is on record. Absence of reports is not evidence of safety.",
    glyph: "?",
  },
  stale: {
    label: "Data stale",
    description:
      "The latest approved inspection is older than the staleness window.",
    glyph: "◔",
  },
  recent_information: {
    label: "Recent information available",
    description:
      "An approved inspection exists within the window. This is not a safety or compliance verdict.",
    glyph: "●",
  },
};

// ----------------------------------------------------------------- inputs
// Deliberately minimal rows: no descriptions, notes, answers, reporter or
// inspector identities, or evidence ever enter this module (data
// minimization for an aggregate surface).

export interface StatusSite {
  id: string;
  code: string;
  name: string;
  operatorName: string;
  organizationId?: string;
  county: string;
  district?: string;
  /** Registry status of the site itself (active / suspended / …). */
  registryStatus: string;
  latitude?: number;
  longitude?: number;
}

export interface StatusInspection {
  siteId: string;
  status: "draft" | "submitted" | "under_review" | "approved" | "rejected";
  submittedAt?: number;
  reviewedAt?: number;
  createdAt: number;
}

export interface StatusFinding {
  siteId: string;
  severity: Severity;
  status: "open" | "acknowledged" | "resolved" | "verified";
}

export interface StatusAction {
  siteId: string;
  status:
    | "open"
    | "in_progress"
    | "submitted"
    | "verified"
    | "closed"
    | "escalated";
  dueAt: number;
}

export interface StatusIncident {
  siteId: string;
  severity: Severity;
  status: "reported" | "investigating" | "closed";
  occurredAt: number;
  fatalities?: number;
  createdAt: number;
}

export interface SiteStatusInputs {
  sites: StatusSite[];
  inspections: StatusInspection[];
  findings: StatusFinding[];
  actions: StatusAction[];
  incidents: StatusIncident[];
  /** When this snapshot was read from the database (ms). This is the time of
   *  the last successful READ by this device — not a field-sync time. */
  loadedAt: number;
}

export interface StatusOptions {
  now: number;
  staleAfterDays?: number;
  /** Reporting window for the incident count (ms back from `now`);
   *  null = all time. */
  periodMs?: number | null;
}

// ---------------------------------------------------------------- outputs

export interface SiteStatusRow {
  site: StatusSite;
  status: SiteStatusKey;
  /** Open critical findings (always shown, whatever the status). */
  openCriticalFindings: number;
  openFindings: number;
  overdueActions: number;
  openActions: number;
  /** Serious = non-closed incident with a fatality or critical severity. */
  openSeriousIncidents: number;
  /** Incidents that occurred inside the reporting period. */
  incidentsInPeriod: number;
  /** Latest APPROVED inspection time (reviewedAt, else submittedAt); the only
   *  timestamp that counts as "verified information". */
  lastApprovedInspectionAt: number | null;
  /** Latest inspection or incident submission of any kind (company-submitted,
   *  possibly unreviewed). Distinct from verified information. */
  lastSubmissionAt: number | null;
  /** Whole days since the latest approved inspection, or null if none. */
  approvedAgeDays: number | null;
  /** Position is plottable (valid, in-Liberia coordinates). */
  hasPosition: boolean;
}

const OPEN_FINDING = new Set(["open", "acknowledged"]);
const OUTSTANDING_ACTION = new Set([
  "open",
  "in_progress",
  "submitted",
  "escalated",
]);

function maxOrNull(values: (number | undefined | null)[]): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && (best === null || v > best))
      best = v;
  }
  return best;
}

/** Valid, in-Liberia coordinates (mirrors gis.ts `inLiberia`; duplicated as a
 *  tiny predicate so this module stays dependency-free). */
export function hasValidPosition(lat?: number, lng?: number): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= 4.3 && lat <= 8.6 && lng >= -11.6 && lng <= -7.3;
}

export function computeSiteStatuses(
  inputs: SiteStatusInputs,
  opts: StatusOptions,
): SiteStatusRow[] {
  const staleDays = opts.staleAfterDays ?? STALE_AFTER_DAYS;
  const periodFrom =
    opts.periodMs === null || opts.periodMs === undefined
      ? null
      : opts.now - opts.periodMs;

  const by = <T extends { siteId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.siteId);
      if (list) list.push(r);
      else m.set(r.siteId, [r]);
    }
    return m;
  };
  const insBy = by(inputs.inspections);
  const finBy = by(inputs.findings);
  const actBy = by(inputs.actions);
  const incBy = by(inputs.incidents);

  return inputs.sites.map((site) => {
    const ins = insBy.get(site.id) ?? [];
    const fin = finBy.get(site.id) ?? [];
    const act = actBy.get(site.id) ?? [];
    const inc = incBy.get(site.id) ?? [];

    const approved = ins.filter((i) => i.status === "approved");
    const lastApprovedInspectionAt = maxOrNull(
      approved.map((i) => i.reviewedAt ?? i.submittedAt ?? i.createdAt),
    );
    const lastSubmissionAt = maxOrNull([
      ...ins
        .filter((i) => i.status !== "draft")
        .map((i) => i.submittedAt ?? i.createdAt),
      ...inc.map((i) => i.createdAt),
    ]);

    const openFindings = fin.filter((f) => OPEN_FINDING.has(f.status));
    const openCriticalFindings = openFindings.filter(
      (f) => f.severity === "critical",
    ).length;
    const outstanding = act.filter((a) => OUTSTANDING_ACTION.has(a.status));
    const overdueActions = outstanding.filter((a) => a.dueAt < opts.now).length;
    const openSeriousIncidents = inc.filter(
      (i) =>
        i.status !== "closed" &&
        ((i.fatalities ?? 0) > 0 || i.severity === "critical"),
    ).length;
    const incidentsInPeriod = inc.filter(
      (i) => periodFrom === null || i.occurredAt >= periodFrom,
    ).length;

    const approvedAgeDays =
      lastApprovedInspectionAt === null
        ? null
        : Math.max(0, Math.floor((opts.now - lastApprovedInspectionAt) / DAY_MS));

    let status: SiteStatusKey;
    if (openCriticalFindings > 0 || openSeriousIncidents > 0) status = "review_now";
    else if (overdueActions > 0) status = "action_overdue";
    else if (lastApprovedInspectionAt === null) status = "insufficient";
    else if ((approvedAgeDays ?? 0) > staleDays) status = "stale";
    else status = "recent_information";

    return {
      site,
      status,
      openCriticalFindings,
      openFindings: openFindings.length,
      overdueActions,
      openActions: outstanding.length,
      openSeriousIncidents,
      incidentsInPeriod,
      lastApprovedInspectionAt,
      lastSubmissionAt,
      approvedAgeDays,
      hasPosition: hasValidPosition(site.latitude, site.longitude),
    };
  });
}

// ---------------------------------------------------------------- filters

export type FreshnessFilter = "any" | "fresh" | "stale" | "none";

export interface BoardFilters {
  counties: string[]; // empty = all
  organizations: string[]; // organizationId, or `name:<operatorName>`; empty = all
  statuses: SiteStatusKey[]; // empty = all
  freshness: FreshnessFilter;
  /** Only sites with at least one open critical finding. */
  criticalOnly: boolean;
  text: string;
}

export const NO_BOARD_FILTERS: BoardFilters = {
  counties: [],
  organizations: [],
  statuses: [],
  freshness: "any",
  criticalOnly: false,
  text: "",
};

export const orgKey = (s: StatusSite): string =>
  s.organizationId ?? `name:${s.operatorName}`;

export function applyBoardFilters(
  rows: SiteStatusRow[],
  f: BoardFilters,
  staleAfterDays: number = STALE_AFTER_DAYS,
): SiteStatusRow[] {
  const q = f.text.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.counties.length && !f.counties.includes(r.site.county)) return false;
    if (f.organizations.length && !f.organizations.includes(orgKey(r.site)))
      return false;
    if (f.statuses.length && !f.statuses.includes(r.status)) return false;
    if (f.criticalOnly && r.openCriticalFindings === 0) return false;
    if (f.freshness === "none" && r.lastApprovedInspectionAt !== null) return false;
    if (f.freshness === "fresh") {
      if (r.approvedAgeDays === null || r.approvedAgeDays > staleAfterDays)
        return false;
    }
    if (f.freshness === "stale") {
      if (r.approvedAgeDays === null || r.approvedAgeDays <= staleAfterDays)
        return false;
    }
    if (
      q &&
      !`${r.site.name} ${r.site.code} ${r.site.operatorName}`
        .toLowerCase()
        .includes(q)
    )
      return false;
    return true;
  });
}

/** Most urgent first; ties by critical count, then name. Stable and total. */
export function sortByUrgency(rows: SiteStatusRow[]): SiteStatusRow[] {
  const rank = (k: SiteStatusKey) => STATUS_ORDER.indexOf(k);
  return [...rows].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      b.openCriticalFindings - a.openCriticalFindings ||
      b.overdueActions - a.overdueActions ||
      a.site.name.localeCompare(b.site.name),
  );
}

// ----------------------------------------------------------------- summary

export interface BoardSummary {
  sites: number;
  /** Sites with a valid, plottable position. */
  withPosition: number;
  /** Sites with NO approved inspection ever ("missing" verified data). */
  noApprovedInspection: number;
  recentApproved: number;
  stale: number;
  sitesWithOpenCritical: number;
  openCriticalFindings: number;
  sitesWithOverdueActions: number;
  overdueActions: number;
  incidentsInPeriod: number;
}

export function summarize(
  rows: SiteStatusRow[],
  staleAfterDays: number = STALE_AFTER_DAYS,
): BoardSummary {
  const s: BoardSummary = {
    sites: rows.length,
    withPosition: 0,
    noApprovedInspection: 0,
    recentApproved: 0,
    stale: 0,
    sitesWithOpenCritical: 0,
    openCriticalFindings: 0,
    sitesWithOverdueActions: 0,
    overdueActions: 0,
    incidentsInPeriod: 0,
  };
  for (const r of rows) {
    if (r.hasPosition) s.withPosition++;
    // Age-based, independent of the primary status: a site flagged for
    // review is still counted here by how old its verified information is.
    if (r.approvedAgeDays === null) s.noApprovedInspection++;
    else if (r.approvedAgeDays > staleAfterDays) s.stale++;
    else s.recentApproved++;
    if (r.openCriticalFindings > 0) {
      s.sitesWithOpenCritical++;
      s.openCriticalFindings += r.openCriticalFindings;
    }
    if (r.overdueActions > 0) {
      s.sitesWithOverdueActions++;
      s.overdueActions += r.overdueActions;
    }
    s.incidentsInPeriod += r.incidentsInPeriod;
  }
  return s;
}

// ------------------------------------------------------------------ period

export const PERIODS = [
  { key: "30d", label: "Last 30 days", ms: 30 * DAY_MS },
  { key: "90d", label: "Last 90 days", ms: 90 * DAY_MS },
  { key: "365d", label: "Last 12 months", ms: 365 * DAY_MS },
  { key: "all", label: "All time", ms: null },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];

export function periodMsOf(key: PeriodKey): number | null {
  return PERIODS.find((p) => p.key === key)?.ms ?? null;
}

/** "3 days ago" style text; null → "never". Pure so it is testable. */
export function ageText(ts: number | null, now: number): string {
  if (ts === null) return "never";
  const days = Math.max(0, Math.floor((now - ts) / DAY_MS));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 60) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months < 24 ? `${months} months ago` : `${Math.floor(days / 365)} years ago`;
}
