// ---------------------------------------------------------------------------
// INCIDENT INSIGHTS (Implementation Phase 3) — deterministic, no model.
//
//   incident_trend_summary  counts, categories, repeated findings, outstanding
//                           corrective actions and period-over-period change.
//   risk_patterns           recurring patterns for HUMAN investigation.
//
// Rules this file keeps (asserted in tests/ai-insights.test.ts):
//   * every number is computed here, from rows read through the caller's own
//     RLS-bound client — a model never produces or alters a figure;
//   * only non-sensitive columns are selected: no incident description, no
//     reporter id, no phone, no community/anonymous report is ever read;
//   * no writes of any kind;
//   * no legal conclusion, no "safe/unsafe" verdict, no risk score, and every
//     pattern states that it is NOT a prediction of an accident;
//   * too little data => abstain with the reason, never a thin guess.
// ---------------------------------------------------------------------------

import { AiError, type Claim, type ScopedDb } from "./contract.ts";
import { assertUuid, cite, idsOf, read, ROW_CAP, tally, type Draft, type Query, type Row } from "./capabilities.ts";
import { sanitizeUntrusted } from "./injection.ts";

const DAY = 86_400_000;
const d10 = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const label = (s: unknown): string => String(s ?? "unknown").replace(/_/g, " ");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const fmt = (t: [string, number][]): string => t.map(([k, n]) => `${label(k)} ${n}`).join(", ");

/** Documented thresholds — surfaced to the user in `data.thresholds`. */
export const PATTERN_THRESHOLDS = {
  minIncidentsInWindow: 10,
  minHistoryDays: 90,
  recurrenceMinCount: 3,
  recurrenceWindowDays: 90,
  risePeriodDays: 90,
  riseMinCurrent: 3,
  riseMinRatio: 2,
  maxPatterns: 5,
} as const;

function clampInt(raw: unknown, name: string, dflt: number, min: number, max: number): number {
  if (raw == null) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new AiError("BAD_REQUEST", `${name} must be an integer`);
  return Math.min(Math.max(n, min), max);
}

const isOutstanding = (r: Row): boolean => r.status !== "closed" && r.status !== "verified";

// --------------------------------------------------- incident trend summary

export async function incidentTrendSummary(db: ScopedDb, args: { siteId?: unknown; days?: unknown }, now: Date): Promise<Draft> {
  const siteId = args.siteId == null ? null : assertUuid(args.siteId, "siteId");
  const days = clampInt(args.days, "days", 90, 7, 365);
  const end = now.getTime();
  const curStart = end - days * DAY;
  const prevStart = curStart - days * DAY;
  const scope = (q: Query) => (siteId ? q.eq("site_id", siteId) : q);

  const retrieved = new Set<string>();
  const notices: string[] = [];

  const [inc, fin, cas, sites] = await Promise.all([
    read(db, "incidents", "id,site_id,type,severity,status,occurred_at", (q) =>
      scope(q).gte("occurred_at", new Date(prevStart).toISOString()).lte("occurred_at", now.toISOString()).order("occurred_at", { ascending: false })),
    read(db, "findings", "id,site_id,title,severity,created_at", (q) =>
      scope(q).gte("created_at", new Date(curStart).toISOString()).order("created_at", { ascending: false })),
    read(db, "corrective_actions", "id,site_id,status,due_at", (q) =>
      scope(q).neq("status", "closed").neq("status", "verified").order("due_at", { ascending: true })),
    read(db, "sites", "id,code,name", (q) => (siteId ? q.eq("id", siteId) : q)),
  ]);
  for (const t of [inc, fin, cas, sites]) for (const id of idsOf(t.rows)) retrieved.add(id);
  const capped = [inc, fin, cas].some((t) => t.capped);
  if (capped) notices.push(`Some lists were capped at ${ROW_CAP} rows, so counts may be understated and period-over-period change is not reported.`);

  if (siteId && sites.rows.length === 0) {
    return { claims: [], data: null, retrieved, notices, abstainReason: "No site with that identifier is available to you." };
  }

  const cur = inc.rows.filter((r) => Date.parse(String(r.occurred_at)) >= curStart);
  const prev = inc.rows.filter((r) => Date.parse(String(r.occurred_at)) < curStart);
  const outstanding = cas.rows.filter(isOutstanding);
  const overdue = outstanding.filter((r) => Date.parse(String(r.due_at)) < end);

  if (cur.length + prev.length + fin.rows.length + outstanding.length === 0) {
    return { claims: [], data: null, retrieved, notices, abstainReason: "No incidents, findings or outstanding corrective actions are recorded for this period within your access, so there is nothing to summarise." };
  }

  const claims: Claim[] = [];
  const periodText = `${d10(curStart)} to ${d10(end)}`;
  const siteCode = new Map(sites.rows.map((s) => [String(s.id), `${String(s.code)}`]));

  // Volume + change
  let change: { absolute: number; percent: number | null } | null = null;
  if (cur.length + prev.length > 0) {
    let text = `${plural(cur.length, "incident")} with an occurrence date in ${periodText}`;
    if (!capped) {
      const abs = cur.length - prev.length;
      const pct = prev.length > 0 ? Math.round((abs / prev.length) * 100) : null;
      change = { absolute: abs, percent: pct };
      const dir = abs === 0 ? "unchanged" : abs > 0 ? `up ${abs}` : `down ${-abs}`;
      text += `, versus ${prev.length} in the preceding ${days} days (${d10(prevStart)} to ${d10(curStart)}): ${dir}${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ", with no earlier baseline to compare against"}.`;
      if (cur.length < 5 && prev.length < 5) notices.push("Counts are small (under 5 in both periods), so the change may reflect normal variation rather than a real shift.");
    } else {
      text += ".";
    }
    claims.push({ text, citations: cite(idsOf([...cur, ...prev])) });
  }

  // Categories and severity
  const byType = tally(cur, "type");
  const bySeverity = tally(cur, "severity");
  if (cur.length > 0) {
    claims.push({ text: `Incident categories in the period: ${fmt(byType)}.`, citations: cite(idsOf(cur)) });
    claims.push({ text: `Incident severity in the period: ${fmt(bySeverity)}.`, citations: cite(idsOf(cur)) });
  }

  // Repeatedly recorded findings (same site + same normalised title)
  const groups = new Map<string, { title: string; siteId: string; rows: Row[] }>();
  for (const r of fin.rows) {
    const title = sanitizeUntrusted(String(r.title ?? ""), 80);
    if (!title) continue;
    const key = `${String(r.site_id)}|${title.toLowerCase()}`;
    const g = groups.get(key) ?? { title, siteId: String(r.site_id), rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const repeated = [...groups.values()].filter((g) => g.rows.length >= 2).sort((a, b) => b.rows.length - a.rows.length || a.title.localeCompare(b.title)).slice(0, 3);
  for (const g of repeated) {
    const where = siteCode.get(g.siteId) ?? "a site in your scope";
    claims.push({ text: `A finding titled "${g.title}" was recorded ${g.rows.length} times at ${where} in the period.`, citations: cite(idsOf(g.rows)) });
  }

  // Outstanding corrective actions
  if (outstanding.length > 0) {
    const oldest = overdue.length ? Math.max(...overdue.map((r) => Math.floor((end - Date.parse(String(r.due_at))) / DAY))) : 0;
    claims.push({
      text: `${plural(outstanding.length, "corrective action")} not yet closed or verified (${fmt(tally(outstanding, "status"))}); ${overdue.length} past their due date${overdue.length ? `, the longest by ${oldest} day${oldest === 1 ? "" : "s"}` : ""}.`,
      citations: cite(idsOf(outstanding)),
    });
  }

  notices.push(
    "Figures are computed by MineGuard from the records your account can see; no AI model produced them.",
    "Counts use each incident's occurrence date. Reports synced late from the field can raise recent figures after the fact.",
    "Anonymous community reports are not included in this summary.",
    "These are counts for human review, not a determination about any person, company, or site. Potential patterns are assessed separately under risk patterns.",
  );

  return {
    claims,
    retrieved,
    notices,
    abstainReason: null,
    data: {
      period: { start: d10(curStart), end: d10(end), days, previousStart: d10(prevStart) },
      siteId,
      incidents: { current: cur.length, previous: capped ? null : prev.length, change, byType, bySeverity },
      outstandingActions: { total: outstanding.length, overdue: overdue.length, byStatus: tally(outstanding, "status") },
      repeatedFindings: repeated.map((g) => ({ title: g.title, siteId: g.siteId, siteCode: siteCode.get(g.siteId) ?? null, count: g.rows.length })),
      computedBy: "deterministic",
    },
  };
}

// ------------------------------------------------------------ risk patterns

export interface RiskPattern {
  kind: "recurrence" | "rising_volume";
  siteId: string;
  siteCode: string | null;
  incidentType: string | null;
  count: number;
  comparisonCount: number | null;
  periodStart: string;
  periodEnd: string;
  evidenceIds: string[];
  limitations: string[];
  whyReview: string;
  statement: string;
}

const NOT_A_PREDICTION = "This is not a prediction of an accident.";

export async function riskPatterns(db: ScopedDb, args: { siteId?: unknown; months?: unknown }, now: Date): Promise<Draft> {
  const T = PATTERN_THRESHOLDS;
  const siteId = args.siteId == null ? null : assertUuid(args.siteId, "siteId");
  const months = clampInt(args.months, "months", 12, 3, 24);
  const end = now.getTime();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  const start = startDate.getTime();
  const scope = (q: Query) => (siteId ? q.eq("site_id", siteId) : q);

  const retrieved = new Set<string>();
  const notices: string[] = [NOT_A_PREDICTION + " Patterns are prompts for a qualified person to investigate, not findings."];

  const [inc, sites] = await Promise.all([
    read(db, "incidents", "id,site_id,type,severity,occurred_at", (q) =>
      scope(q).gte("occurred_at", startDate.toISOString()).lte("occurred_at", now.toISOString()).order("occurred_at", { ascending: true })),
    read(db, "sites", "id,code,name", (q) => (siteId ? q.eq("id", siteId) : q)),
  ]);
  for (const t of [inc, sites]) for (const id of idsOf(t.rows)) retrieved.add(id);
  if (inc.capped) notices.push(`The incident list was capped at ${ROW_CAP} rows; counts may be understated.`);

  const thresholds = { ...T };
  const rows = inc.rows;
  const times = rows.map((r) => Date.parse(String(r.occurred_at))).filter((t) => Number.isFinite(t));
  const spanDays = times.length ? Math.floor((Math.max(...times) - Math.min(...times)) / DAY) : 0;

  // Data sufficiency gate — no thin-data output, no score.
  if (rows.length < T.minIncidentsInWindow || spanDays < T.minHistoryDays) {
    return {
      claims: [], retrieved, notices,
      data: { sufficient: false, incidentsInWindow: rows.length, historyDays: spanDays, thresholds },
      abstainReason: `Not enough history to look for patterns: ${plural(rows.length, "incident")} recorded over ${spanDays} day${spanDays === 1 ? "" : "s"} within your access (at least ${T.minIncidentsInWindow} incidents spanning ${T.minHistoryDays} days are needed). No pattern or score is reported. This does not mean there is no risk.`,
    };
  }

  const siteInfo = new Map(sites.rows.map((s) => [String(s.id), { code: String(s.code), name: String(s.name) }]));
  const where = (id: string): string => { const s = siteInfo.get(id); return s ? `${s.code} ${s.name}` : "a site in your scope"; };
  const bySite = new Map<string, Row[]>();
  for (const r of rows) (bySite.get(String(r.site_id)) ?? bySite.set(String(r.site_id), []).get(String(r.site_id))!).push(r);

  const baseLimits = [
    `Based on ${plural(rows.length, "incident")} reported ${d10(start)} to ${d10(end)} within your access.`,
    "Counts reflect what was reported, not necessarily what occurred; reporting habits and late field sync affect them.",
  ];
  const found: RiskPattern[] = [];

  // R1 — same site + same category recurring inside a rolling window.
  for (const [sid, list] of bySite) {
    const byType = new Map<string, Row[]>();
    for (const r of list) (byType.get(String(r.type)) ?? byType.set(String(r.type), []).get(String(r.type))!).push(r);
    for (const [type, tl] of byType) {
      let best: Row[] = [];
      let lo = 0;
      for (let hi = 0; hi < tl.length; hi++) {
        while (Date.parse(String(tl[hi].occurred_at)) - Date.parse(String(tl[lo].occurred_at)) > T.recurrenceWindowDays * DAY) lo++;
        if (hi - lo + 1 > best.length) best = tl.slice(lo, hi + 1);
      }
      if (best.length >= T.recurrenceMinCount) {
        const a = d10(Date.parse(String(best[0].occurred_at)));
        const b = d10(Date.parse(String(best[best.length - 1].occurred_at)));
        found.push({
          kind: "recurrence", siteId: sid, siteCode: siteInfo.get(sid)?.code ?? null, incidentType: type,
          count: best.length, comparisonCount: null, periodStart: a, periodEnd: b,
          evidenceIds: idsOf(best).slice(0, 25),
          limitations: baseLimits,
          whyReview: "Repeated reports of the same category at one site can indicate an underlying hazard that has not been addressed.",
          statement: `${plural(best.length, `${label(type)} incident`)} were recorded at ${where(sid)} between ${a} and ${b} (within ${T.recurrenceWindowDays} days).`,
        });
      }
    }
  }

  // R2 — a site's incident volume rising against the preceding equal period.
  if (months >= 6) {
    const curStart = end - T.risePeriodDays * DAY;
    const prevStart = curStart - T.risePeriodDays * DAY;
    for (const [sid, list] of bySite) {
      const cur = list.filter((r) => Date.parse(String(r.occurred_at)) >= curStart);
      const prev = list.filter((r) => { const t = Date.parse(String(r.occurred_at)); return t >= prevStart && t < curStart; });
      if (prev.length >= 1 && cur.length >= T.riseMinCurrent && cur.length >= T.riseMinRatio * prev.length) {
        found.push({
          kind: "rising_volume", siteId: sid, siteCode: siteInfo.get(sid)?.code ?? null, incidentType: null,
          count: cur.length, comparisonCount: prev.length, periodStart: d10(curStart), periodEnd: d10(end),
          evidenceIds: idsOf([...cur, ...prev]).slice(0, 25),
          limitations: [...baseLimits, "A rise can also reflect improved reporting rather than more incidents."],
          whyReview: "A sustained rise in reported incidents at a site may warrant a conversation with the site team about what has changed.",
          statement: `${where(sid)} had ${cur.length} reported incidents in the last ${T.risePeriodDays} days (${d10(curStart)} to ${d10(end)}) versus ${prev.length} in the ${T.risePeriodDays} days before.`,
        });
      }
    }
  } else {
    notices.push("Rising-volume comparison needs a window of at least 6 months and was skipped.");
  }

  found.sort((a, b) => b.count - a.count || a.statement.localeCompare(b.statement));
  const top = found.slice(0, T.maxPatterns);
  if (found.length > top.length) notices.push(`Showing the ${top.length} strongest of ${found.length} patterns.`);

  if (top.length === 0) {
    return {
      claims: [], retrieved, notices,
      data: { sufficient: true, incidentsInWindow: rows.length, historyDays: spanDays, patterns: [], thresholds },
      abstainReason: `No recurring pattern met the review thresholds in ${d10(start)} to ${d10(end)} (${plural(rows.length, "incident")} examined). This does not mean there is no risk.`,
    };
  }

  const claims: Claim[] = top.map((p) => ({
    text: `${p.statement} Limitations: ${p.limitations.join(" ")} Why review: ${p.whyReview} ${NOT_A_PREDICTION}`,
    citations: p.evidenceIds,
  }));
  return {
    claims, retrieved, notices, abstainReason: null,
    data: { sufficient: true, incidentsInWindow: rows.length, historyDays: spanDays, window: { start: d10(start), end: d10(end), months }, patterns: top, thresholds, notAPrediction: NOT_A_PREDICTION, computedBy: "deterministic" },
  };
}
