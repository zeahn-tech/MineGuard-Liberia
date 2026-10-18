// ---------------------------------------------------------------------------
// RISK MODEL — single source of truth for the explainable site risk indicator.
//
// Extracted from sites.riskScores when the §18 AI risk explanation was added:
// the AI layer must describe the REAL computation, so the computation and
// its explanation must read from the same weights. This module is PURE —
// no DB access, no network, no provider calls. backend.ts (inside the
// authorization core) assembles the caller-scoped inputs and calls it;
// anything computed here is therefore restricted to the caller's scope by
// construction.
//
// Weights are configurable by the program owner (doc 04) — never hardcoded
// law; a score is decision support only and never determines guilt or
// triggers enforcement (doc 08 hard prohibition 3).
//
// SESSION 7 (RSK-1/RSK-2): the weights now live in the database
// (risk_config_versions, migration 0019) and the SCORE IS COMPUTED THERE
// (mg_risk_build). This module remains for two jobs only:
//   * the fallback path of a deployment that has not applied 0019, which
//     scores with LEGACY_RISK_CONFIG (= version 1), and
//   * mapping the database's already-built factors onto record-id citations.
// Both paths keep the invariant score ≡ Σ factor points under ANY config.
// ---------------------------------------------------------------------------

import { canAccessSite } from "./types";
import { LEGACY_RISK_CONFIG, type RiskConfigSettings } from "./risk-config";
import type {
  CorrectiveAction,
  EnvironmentalObservation,
  Finding,
  Incident,
  Site,
  UserProfile,
} from "./types";

/** Version 1's weights (the pre-configurable constants). NOT consulted when
 *  the database computes the score — kept as the legacy fallback's source and
 *  as the named reference the version-1 regression tests compare against. */
export const RISK_WEIGHTS = {
  criticalFinding: LEGACY_RISK_CONFIG.weights.criticalFinding,
  highFinding: LEGACY_RISK_CONFIG.weights.highFinding,
  mediumFinding: LEGACY_RISK_CONFIG.weights.mediumFinding,
  lowFinding: LEGACY_RISK_CONFIG.weights.lowFinding,
  repeatFinding: LEGACY_RISK_CONFIG.weights.repeatFinding,
  overdueCA: LEGACY_RISK_CONFIG.weights.overdueCA,
  fatality: LEGACY_RISK_CONFIG.weights.fatality,
  seriousIncident: LEGACY_RISK_CONFIG.weights.seriousIncident,
  envAlert: LEGACY_RISK_CONFIG.weights.envAlert,
} as const;

export type RiskFactor = {
  label: string;
  points: number;
  /** Record IDs this factor is grounded in — the cite-or-abstain anchors (doc 08). */
  recordIds: string[];
};

// ---------------------------------------------------------------------------
// SEC-4 v2 — the aggregation boundary. The risk model's inputs can arrive two
// ways: as raw record lists (the fallback path — the client pages every
// input table) or as per-site COUNT AGGREGATES computed in Postgres by the
// SECURITY INVOKER RPC mg_risk_scores (migration 0014). Both MUST yield the
// identical factor breakdown — so the factor construction (labels, weights,
// ordering, the score ≡ Σ points invariant) lives in ONE function that
// consumes counts only, and the list path is just a reduction to counts plus
// record-id attachment.
// ---------------------------------------------------------------------------

/** The exact count aggregates the risk model consumes per site — the shape
 *  mg_risk_scores returns (key names match the RPC payload). */
export type RiskInputCounts = {
  findingsTotal: number;
  low: number;
  medium: number;
  high: number;
  critical: number;
  overdueCAs: number;
  fatalityIncidents: number;
  seriousIncidents: number;
  envAlerts: number;
  /** Corrective actions closed after their due date, within the config's
   *  look-back window (the historical-compliance input). */
  lateClosedCAs: number;
};

/** Which recorded kind a factor grounds in — internal tag used to attach the
 *  record IDs on the list path (the counts path carries none). */
type FactorKind =
  | "criticalFindings"
  | "highFindings"
  | "mediumFindings"
  | "lowFindings"
  | "repeatFindings"
  | "overdueCAs"
  | "fatalities"
  | "seriousIncidents"
  | "envAlerts"
  | "lateClosedCAs";

type TaggedFactor = RiskFactor & { kind: FactorKind };

/** Historical-compliance predicate — mirrors mg_risk_scores: closed/verified,
 *  closed after the due date, inside the look-back window. */
function isLateClosed(c: CorrectiveAction, windowStart: number, now: number): boolean {
  return (
    (c.status === "closed" || c.status === "verified") &&
    typeof c.closedAt === "number" &&
    c.closedAt > c.dueAt &&
    c.closedAt >= windowStart &&
    c.closedAt <= now
  );
}

/** Reduce the raw record lists (one site's inputs) to the count aggregates. */
export function countsFromInputs(
  siteId: string,
  inputs: {
    findings: Finding[];
    correctiveActions: CorrectiveAction[];
    incidents: Incident[];
    observations: EnvironmentalObservation[];
  },
  now: number,
  lookbackDays: number = LEGACY_RISK_CONFIG.lookbackDays,
): RiskInputCounts {
  const siteFindings = inputs.findings.filter((f) => f.siteId === siteId);
  const counts: RiskInputCounts = {
    findingsTotal: siteFindings.length,
    low: 0, medium: 0, high: 0, critical: 0,
    overdueCAs: 0,
    fatalityIncidents: 0,
    seriousIncidents: 0,
    envAlerts: 0,
    lateClosedCAs: 0,
  };
  for (const f of siteFindings) {
    if (f.severity === "critical") counts.critical += 1;
    else if (f.severity === "high") counts.high += 1;
    else if (f.severity === "medium") counts.medium += 1;
    else counts.low += 1;
  }
  for (const c of inputs.correctiveActions) {
    if (
      c.siteId === siteId &&
      c.status !== "closed" &&
      c.status !== "verified" &&
      c.dueAt < now
    )
      counts.overdueCAs += 1;
  }
  const windowStart = now - lookbackDays * 86_400_000;
  for (const c of inputs.correctiveActions) {
    if (c.siteId === siteId && isLateClosed(c, windowStart, now))
      counts.lateClosedCAs += 1;
  }
  for (const i of inputs.incidents) {
    if (i.siteId !== siteId) continue;
    if (i.type === "fatality") counts.fatalityIncidents += 1;
    else if (i.severity === "critical" || i.severity === "high")
      counts.seriousIncidents += 1;
  }
  for (const o of inputs.observations) {
    if (
      o.siteId === siteId &&
      o.status !== "resolved" &&
      (o.verification === "measured" || o.verification === "verified")
    )
      counts.envAlerts += 1;
  }
  return counts;
}

/** Build the explainable factor breakdown from COUNT aggregates — the single
 *  place the weights turn into factors. Factor order is fixed (critical,
 *  high, medium, low, repeat, overdue, fatality, serious, environmental) and
 *  zero-count factors never materialize. Record IDs are NOT known here: the
 *  counts path leaves them empty; the list path attaches them by kind. */
function buildFactorsFromCounts(
  c: RiskInputCounts,
  config: RiskConfigSettings = LEGACY_RISK_CONFIG,
): { score: number; factors: TaggedFactor[] } {
  const W = config.weights;
  const factors: TaggedFactor[] = [];
  let points = 0;
  // INVARIANT: score ≡ Σ factor points. Every factor adds its points
  // exactly once via push() — the severity factors INCLUDED (the 2026-09-29
  // `alreadyCounted` variant silently dropped the entire finding-severity
  // mass from the score; caught by the AI invariant test and the scale
  // suite's score ≡ Σ sentence-points pin).
  const push = (kind: FactorKind, label: string, pts: number) => {
    if (pts > 0) {
      factors.push({ label, points: pts, recordIds: [], kind });
      points += pts;
    }
  };

  if (c.critical)
    push("criticalFindings", `${c.critical} critical finding(s)`, c.critical * W.criticalFinding);
  if (c.high)
    push("highFindings", `${c.high} high finding(s)`, c.high * W.highFinding);
  if (c.medium)
    push("mediumFindings", `${c.medium} medium finding(s)`, c.medium * W.mediumFinding);
  if (c.low)
    push("lowFindings", `${c.low} low finding(s)`, c.low * W.lowFinding);

  const repeatFactor =
    c.findingsTotal > 3
      ? W.repeatFinding * Math.floor(c.findingsTotal / 4)
      : 0;
  if (repeatFactor) push("repeatFindings", "Repeat findings at site", repeatFactor);

  if (c.overdueCAs)
    push("overdueCAs", `${c.overdueCAs} overdue corrective action(s)`, c.overdueCAs * W.overdueCA);

  if (c.fatalityIncidents)
    push("fatalities", `${c.fatalityIncidents} fatality incident(s)`, c.fatalityIncidents * W.fatality);

  if (c.seriousIncidents)
    push("seriousIncidents", `${c.seriousIncidents} serious incident(s)`, c.seriousIncidents * W.seriousIncident);

  if (c.envAlerts)
    push("envAlerts", `${c.envAlerts} verified environmental alert(s)`, c.envAlerts * W.envAlert);

  if (c.lateClosedCAs)
    push(
      "lateClosedCAs",
      `${c.lateClosedCAs} corrective action(s) closed late in the last ${config.lookbackDays} days`,
      c.lateClosedCAs * W.lateClosedCA,
    );

  return { score: points, factors };
}

/** Attach the cite-or-abstain record-id arrays (the shape the SECURITY
 *  INVOKER RPC mg_risk_explanation returns for ONE site) to the same
 *  count-built factors — the explainer's SQL path shares the builder with
 *  the list path, so factors, labels and points can never drift. */
export function factorsFromCountsAndIds(
  c: RiskInputCounts,
  ids: {
    allFindingIds: string[];
    lowIds: string[];
    mediumIds: string[];
    highIds: string[];
    criticalIds: string[];
    overdueCaIds: string[];
    fatalityIds: string[];
    seriousIncidentIds: string[];
    envAlertIds: string[];
    lateClosedCaIds?: string[];
  },
  config: RiskConfigSettings = LEGACY_RISK_CONFIG,
): { score: number; factors: RiskFactor[] } {
  const { score, factors } = buildFactorsFromCounts(c, config);
  const byKind: Record<FactorKind, string[]> = {
    criticalFindings: ids.criticalIds,
    highFindings: ids.highIds,
    mediumFindings: ids.mediumIds,
    lowFindings: ids.lowIds,
    repeatFindings: ids.allFindingIds,
    overdueCAs: ids.overdueCaIds,
    fatalities: ids.fatalityIds,
    seriousIncidents: ids.seriousIncidentIds,
    envAlerts: ids.envAlertIds,
    lateClosedCAs: ids.lateClosedCaIds ?? [],
  };
  return {
    score,
    factors: factors.map((f) => ({
      label: f.label,
      points: f.points,
      recordIds: byKind[f.kind],
    })),
  };
}

/** The factor keys the database builder (mg_risk_build) emits, mapped to the
 *  record-id array that grounds each. */
const ID_ARRAY_BY_KEY: Record<FactorKind, string> = {
  criticalFindings: "criticalIds",
  highFindings: "highIds",
  mediumFindings: "mediumIds",
  lowFindings: "lowIds",
  repeatFindings: "allFindingIds",
  overdueCAs: "overdueCaIds",
  fatalities: "fatalityIds",
  seriousIncidents: "seriousIncidentIds",
  envAlerts: "envAlertIds",
  lateClosedCAs: "lateClosedCaIds",
};

/** Adopt a score the DATABASE already built (mg_risk_scores /
 *  mg_risk_explanation): the factors are taken as computed — never
 *  re-multiplied here, so the server's config is the only weight source —
 *  with the cite-or-abstain record ids attached by factor key. */
export function factorsFromBuilt(
  built: { score: unknown; factors: unknown },
  ids?: Record<string, string[]>,
): { score: number; factors: RiskFactor[] } {
  const list = Array.isArray(built.factors) ? built.factors : [];
  const factors: RiskFactor[] = list.map((raw) => {
    const f = raw as { key?: string; label?: string; points?: unknown };
    const arr = f.key ? ids?.[ID_ARRAY_BY_KEY[f.key as FactorKind]] : undefined;
    return {
      label: String(f.label ?? ""),
      points: Number(f.points ?? 0),
      recordIds: arr ?? [],
    };
  });
  // The identity is re-derived, not trusted: the score IS the sum of the
  // factors the caller can see.
  return { score: factors.reduce((n, f) => n + f.points, 0), factors };
}

/** Public (counts-path) build: the same factors without the internal kind tag
 *  and without record IDs — mg_risk_scores feeds this directly. */
export function factorsFromCounts(
  c: RiskInputCounts,
  config: RiskConfigSettings = LEGACY_RISK_CONFIG,
): {
  score: number;
  factors: RiskFactor[];
} {
  const { score, factors } = buildFactorsFromCounts(c, config);
  return {
    score,
    factors: factors.map(({ kind: _kind, ...f }) => f),
  };
}

/** Compute the explainable risk factor breakdown for one site from raw
 *  records (the fallback path). Every factor carries the record IDs behind
 *  it so explanations can cite-or-abstain. Shares ONE factor builder with
 *  the SQL-aggregate path — the two can never drift apart. */
export function computeRiskFactors(
  site: Pick<Site, "_id">,
  inputs: {
    findings: Finding[];
    correctiveActions: CorrectiveAction[];
    incidents: Incident[];
    observations: EnvironmentalObservation[];
  },
  now: number = Date.now(),
  config: RiskConfigSettings = LEGACY_RISK_CONFIG,
): { score: number; factors: RiskFactor[] } {
  const siteId = site._id;
  const siteFindings = inputs.findings.filter((f) => f.siteId === siteId);
  const { score, factors } = buildFactorsFromCounts(
    countsFromInputs(siteId, inputs, now, config.lookbackDays),
    config,
  );
  const windowStart = now - config.lookbackDays * 86_400_000;

  // Attach the cite-or-abstain anchors: per kind, the record IDs the factor
  // is grounded in (the exact predicates countsFromInputs reduced).
  const cite: Record<FactorKind, string[]> = {
    criticalFindings: siteFindings.filter((f) => f.severity === "critical").map((f) => f._id),
    highFindings: siteFindings.filter((f) => f.severity === "high").map((f) => f._id),
    mediumFindings: siteFindings.filter((f) => f.severity === "medium").map((f) => f._id),
    lowFindings: siteFindings.filter((f) => f.severity === "low").map((f) => f._id),
    repeatFindings: siteFindings.map((f) => f._id),
    overdueCAs: inputs.correctiveActions
      .filter(
        (c) =>
          c.siteId === siteId &&
          c.status !== "closed" &&
          c.status !== "verified" &&
          c.dueAt < now,
      )
      .map((c) => c._id),
    lateClosedCAs: inputs.correctiveActions
      .filter((c) => c.siteId === siteId && isLateClosed(c, windowStart, now))
      .map((c) => c._id),
    fatalities: inputs.incidents
      .filter((i) => i.siteId === siteId && i.type === "fatality")
      .map((i) => i._id),
    seriousIncidents: inputs.incidents
      .filter(
        (i) =>
          i.siteId === siteId &&
          i.type !== "fatality" &&
          (i.severity === "critical" || i.severity === "high"),
      )
      .map((i) => i._id),
    envAlerts: inputs.observations
      .filter(
        (o) =>
          o.siteId === siteId &&
          o.status !== "resolved" &&
          (o.verification === "measured" || o.verification === "verified"),
      )
      .map((o) => o._id),
  };

  return {
    score,
    factors: factors.map((f) => ({
      label: f.label,
      points: f.points,
      recordIds: cite[f.kind],
    })),
  };
}

/** The scope-filtered view of the risk inputs: does this caller see this
 *  site through the same authorization core every other surface uses? */
export function canViewSiteRisk(
  user: Pick<UserProfile, "role" | "scope" | "county" | "operatorName">,
  site: Pick<Site, "county" | "operatorName">,
): boolean {
  return canAccessSite(user, site);
}
