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
// ---------------------------------------------------------------------------

import { canAccessSite } from "./types";
import type {
  CorrectiveAction,
  EnvironmentalObservation,
  Finding,
  Incident,
  Site,
  UserProfile,
} from "./types";

/** Configurable weights — tuned by the program owner, not hardcoded law. */
export const RISK_WEIGHTS = {
  criticalFinding: 10,
  highFinding: 6,
  mediumFinding: 3,
  lowFinding: 1,
  repeatFinding: 4,
  overdueCA: 8,
  fatality: 15,
  seriousIncident: 7,
  envAlert: 5,
} as const;

export type RiskFactor = {
  label: string;
  points: number;
  /** Record IDs this factor is grounded in — the cite-or-abstain anchors (doc 08). */
  recordIds: string[];
};

const severityPoints = (sev: string): number =>
  sev === "critical" ? RISK_WEIGHTS.criticalFinding
  : sev === "high" ? RISK_WEIGHTS.highFinding
  : sev === "medium" ? RISK_WEIGHTS.mediumFinding
  : RISK_WEIGHTS.lowFinding;

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
  | "envAlerts";

type TaggedFactor = RiskFactor & { kind: FactorKind };

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
): RiskInputCounts {
  const siteFindings = inputs.findings.filter((f) => f.siteId === siteId);
  const counts: RiskInputCounts = {
    findingsTotal: siteFindings.length,
    low: 0, medium: 0, high: 0, critical: 0,
    overdueCAs: 0,
    fatalityIncidents: 0,
    seriousIncidents: 0,
    envAlerts: 0,
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
): { score: number; factors: TaggedFactor[] } {
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
    push("criticalFindings", `${c.critical} critical finding(s)`, c.critical * RISK_WEIGHTS.criticalFinding);
  if (c.high)
    push("highFindings", `${c.high} high finding(s)`, c.high * RISK_WEIGHTS.highFinding);
  if (c.medium)
    push("mediumFindings", `${c.medium} medium finding(s)`, c.medium * RISK_WEIGHTS.mediumFinding);
  if (c.low)
    push("lowFindings", `${c.low} low finding(s)`, c.low * RISK_WEIGHTS.lowFinding);

  const repeatFactor =
    c.findingsTotal > 3
      ? RISK_WEIGHTS.repeatFinding * Math.floor(c.findingsTotal / 4)
      : 0;
  if (repeatFactor) push("repeatFindings", "Repeat findings at site", repeatFactor);

  if (c.overdueCAs)
    push("overdueCAs", `${c.overdueCAs} overdue corrective action(s)`, c.overdueCAs * RISK_WEIGHTS.overdueCA);

  if (c.fatalityIncidents)
    push("fatalities", `${c.fatalityIncidents} fatality incident(s)`, c.fatalityIncidents * RISK_WEIGHTS.fatality);

  if (c.seriousIncidents)
    push("seriousIncidents", `${c.seriousIncidents} serious incident(s)`, c.seriousIncidents * RISK_WEIGHTS.seriousIncident);

  if (c.envAlerts)
    push("envAlerts", `${c.envAlerts} verified environmental alert(s)`, c.envAlerts * RISK_WEIGHTS.envAlert);

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
  },
): { score: number; factors: RiskFactor[] } {
  const { score, factors } = buildFactorsFromCounts(c);
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

/** Public (counts-path) build: the same factors without the internal kind tag
 *  and without record IDs — mg_risk_scores feeds this directly. */
export function factorsFromCounts(c: RiskInputCounts): {
  score: number;
  factors: RiskFactor[];
} {
  const { score, factors } = buildFactorsFromCounts(c);
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
): { score: number; factors: RiskFactor[] } {
  const siteId = site._id;
  const siteFindings = inputs.findings.filter((f) => f.siteId === siteId);
  const { score, factors } = buildFactorsFromCounts(
    countsFromInputs(siteId, inputs, now),
  );

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
