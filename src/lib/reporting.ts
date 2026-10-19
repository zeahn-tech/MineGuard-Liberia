// ---------------------------------------------------------------------------
// COMMAND-CENTER TRENDS + SUMMARY REPORT (Session 9, §19 / §1).
//
// Pure helpers shared by the data layer, the Trends panel and the printable
// report page: metric catalogue, strict mappers for the SQL payloads
// (mg_trend_series / mg_trend_geo / mg_summary_report), and the report's CSV
// serialization and disclaimer text.
//
// The figures come from SECURITY INVOKER SQL, so every number is limited to
// rows the caller's RLS already shows. The report is a SUMMARY OF THAT VIEW —
// not an official document: the disclaimer below is rendered on screen, in
// print and in the CSV, and tests fail if any of the three drops it.
// ---------------------------------------------------------------------------

import { toCsv, type ExportColumn } from "./export-csv";

export const TREND_METRICS = [
  { key: "incidents", label: "Incidents" },
  { key: "fatalities", label: "Fatalities" },
  { key: "inspections", label: "Inspections submitted" },
  { key: "findings", label: "Findings" },
  { key: "critical_findings", label: "Critical findings" },
  { key: "observations", label: "Environmental observations" },
  { key: "community_reports", label: "Community reports" },
] as const;
export type TrendMetric = (typeof TREND_METRICS)[number]["key"];
export type TrendBucket = "day" | "week" | "month";

export function trendMetricLabel(key: string): string {
  return TREND_METRICS.find((m) => m.key === key)?.label ?? key;
}

export type TrendSeries = {
  metric: string;
  bucket: TrendBucket;
  from: string;
  to: string;
  total: number;
  points: { bucket: string; value: number }[];
};

export type TrendGeoRow = {
  county: string;
  value: number;
  previous: number;
  delta: number;
  /** null when the previous period had none (no meaningful percentage). */
  changePct: number | null;
};
export type TrendGeo = {
  metric: string;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  rows: TrendGeoRow[];
};

export type SummaryReport = {
  generatedAt: string;
  scope: string;
  period: { from: string; to: string };
  activity: Record<string, number>;
  position: Record<string, number>;
  byCounty: {
    county: string;
    sites: number;
    incidents: number;
    fatalities: number;
    criticalFindings: number;
    overdueCorrectiveActions: number;
  }[];
  topRiskSites: {
    siteId: string;
    code: string;
    name: string;
    county: string;
    score: number;
    configVersion: number | null;
  }[];
};

const num = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numMap = (v: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, num(x)]));

export function mapTrendSeries(raw: unknown): TrendSeries {
  const r = obj(raw);
  const bucket = r.bucket === "day" || r.bucket === "week" ? r.bucket : "month";
  return {
    metric: str(r.metric),
    bucket,
    from: str(r.from),
    to: str(r.to),
    total: num(r.total),
    points: arr(r.points).map((p) => ({ bucket: str(obj(p).bucket), value: num(obj(p).value) })),
  };
}

export function mapTrendGeo(raw: unknown): TrendGeo {
  const r = obj(raw);
  return {
    metric: str(r.metric),
    from: str(r.from),
    to: str(r.to),
    previousFrom: str(r.previousFrom),
    previousTo: str(r.previousTo),
    rows: arr(r.rows).map((x) => {
      const o = obj(x);
      return {
        county: str(o.county),
        value: num(o.value),
        previous: num(o.previous),
        delta: num(o.delta),
        changePct: o.changePct == null ? null : num(o.changePct),
      };
    }),
  };
}

export function mapSummaryReport(raw: unknown): SummaryReport {
  const r = obj(raw);
  const period = obj(r.period);
  return {
    generatedAt: str(r.generatedAt),
    scope: str(r.scope) || "national",
    period: { from: str(period.from), to: str(period.to) },
    activity: numMap(r.activity),
    position: numMap(r.position),
    byCounty: arr(r.byCounty).map((x) => {
      const o = obj(x);
      return {
        county: str(o.county),
        sites: num(o.sites),
        incidents: num(o.incidents),
        fatalities: num(o.fatalities),
        criticalFindings: num(o.criticalFindings),
        overdueCorrectiveActions: num(o.overdueCorrectiveActions),
      };
    }),
    topRiskSites: arr(r.topRiskSites).map((x) => {
      const o = obj(x);
      return {
        siteId: str(o.siteId),
        code: str(o.code),
        name: str(o.name),
        county: str(o.county),
        score: num(o.score),
        configVersion: o.configVersion == null ? null : num(o.configVersion),
      };
    }),
  };
}

/** Rendered on screen, in print, and as the last row of the CSV. */
export const REPORT_BANNER = "NOT AN OFFICIAL DOCUMENT";
export const REPORT_DISCLAIMER =
  "NOT AN OFFICIAL DOCUMENT. This summary was generated by MineGuard Liberia, a pilot platform that is not a system of the Government of Liberia. " +
  "Figures describe only the records visible to the generating account at the time shown; they have not been reviewed, certified or approved by any government authority " +
  "and must not be cited as official statistics.";

export const ACTIVITY_LABELS: Record<string, string> = {
  incidents: "Incidents",
  fatalities: "Fatalities",
  inspectionsSubmitted: "Inspections submitted",
  findings: "Findings raised",
  criticalFindings: "Critical findings raised",
  observations: "Environmental observations",
  communityReports: "Community reports received",
};
export const POSITION_LABELS: Record<string, string> = {
  sites: "Registered sites",
  activeSites: "Active sites",
  openCorrectiveActions: "Open corrective actions",
  overdueCorrectiveActions: "Overdue corrective actions",
  openCriticalFindings: "Open critical findings",
  unresolvedVerifiedEnvAlerts: "Unresolved measured/verified environmental alerts",
  reportsAwaitingTriage: "Community reports awaiting triage",
};

type CsvRow = { section: string; item: string; value: string | number; extra?: string };
const CSV_COLS: ExportColumn<CsvRow>[] = [
  { header: "section", value: (r) => r.section },
  { header: "item", value: (r) => r.item },
  { header: "value", value: (r) => r.value },
  { header: "detail", value: (r) => r.extra ?? "" },
];

export function reportToCsv(rep: SummaryReport): string {
  const rows: CsvRow[] = [
    { section: "report", item: "title", value: "MineGuard Liberia summary report" },
    { section: "report", item: "period_from", value: rep.period.from },
    { section: "report", item: "period_to", value: rep.period.to },
    { section: "report", item: "generated_at", value: rep.generatedAt },
    { section: "report", item: "account_scope", value: rep.scope },
    ...Object.entries(rep.activity).map(([k, v]) => ({
      section: "activity_in_period", item: ACTIVITY_LABELS[k] ?? k, value: v,
    })),
    ...Object.entries(rep.position).map(([k, v]) => ({
      section: "position_now", item: POSITION_LABELS[k] ?? k, value: v,
    })),
    ...rep.byCounty.flatMap((c) => [
      { section: "county", item: `${c.county} — sites`, value: c.sites },
      { section: "county", item: `${c.county} — incidents`, value: c.incidents },
      { section: "county", item: `${c.county} — fatalities`, value: c.fatalities },
      { section: "county", item: `${c.county} — critical findings`, value: c.criticalFindings },
      { section: "county", item: `${c.county} — overdue corrective actions`, value: c.overdueCorrectiveActions },
    ]),
    ...rep.topRiskSites.map((s) => ({
      section: "top_risk_sites",
      item: `${s.code} ${s.name}`,
      value: s.score,
      extra: `${s.county}${s.configVersion != null ? `; risk config v${s.configVersion}` : ""}`,
    })),
    { section: "disclaimer", item: REPORT_BANNER, value: "", extra: REPORT_DISCLAIMER },
  ];
  return toCsv(rows, CSV_COLS);
}

export function reportFileName(rep: SummaryReport): string {
  return `mineguard-summary-${rep.period.from}_to_${rep.period.to}.csv`;
}
