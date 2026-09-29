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

/** Compute the explainable risk factor breakdown for one site. Every factor
 *  carries the record IDs behind it so explanations can cite-or-abstain. */
export function computeRiskFactors(
  site: Site,
  inputs: {
    findings: Finding[];
    correctiveActions: CorrectiveAction[];
    incidents: Incident[];
    observations: EnvironmentalObservation[];
  },
  now: number = Date.now(),
): { score: number; factors: RiskFactor[] } {
  const siteFindings = inputs.findings.filter((f) => f.siteId === site._id);
  const factors: RiskFactor[] = [];
  let points = 0;
  // INVARIANT: score ≡ Σ factor points. Finding-severity points are
  // accumulated HERE (per finding) and their aggregated factors are pushed
  // WITHOUT re-adding; every other factor adds its points exactly once via
  // push(). (Regression note 2026-09-29: the §18 refactor first DROPPED the
  // non-finding factors from the total, then a naive fix double-counted
  // severity points — both caught by the AI explanation-consistency test.)
  const sevCount: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of siteFindings) {
    points += severityPoints(f.severity);
    sevCount[f.severity] = (sevCount[f.severity] ?? 0) + 1;
  }
  const push = (label: string, pts: number, ids: string[], alreadyCounted = false) => {
    if (pts > 0) {
      factors.push({ label, points: pts, recordIds: ids });
      if (!alreadyCounted) points += pts;
    }
  };
  const idsFor = (rows: { _id: string }[]) => rows.map((r) => r._id);

  if (sevCount.critical)
    push(`${sevCount.critical} critical finding(s)`, sevCount.critical * RISK_WEIGHTS.criticalFinding, idsFor(siteFindings.filter((f) => f.severity === "critical")), true);
  if (sevCount.high)
    push(`${sevCount.high} high finding(s)`, sevCount.high * RISK_WEIGHTS.highFinding, idsFor(siteFindings.filter((f) => f.severity === "high")), true);
  if (sevCount.medium)
    push(`${sevCount.medium} medium finding(s)`, sevCount.medium * RISK_WEIGHTS.mediumFinding, idsFor(siteFindings.filter((f) => f.severity === "medium")), true);
  if (sevCount.low)
    push(`${sevCount.low} low finding(s)`, sevCount.low * RISK_WEIGHTS.lowFinding, idsFor(siteFindings.filter((f) => f.severity === "low")), true);

  const repeatFactor =
    siteFindings.length > 3
      ? RISK_WEIGHTS.repeatFinding * Math.floor(siteFindings.length / 4)
      : 0;
  if (repeatFactor) push("Repeat findings at site", repeatFactor, siteFindings.map((f) => f._id));

  const overdue = inputs.correctiveActions.filter(
    (c) => c.siteId === site._id && c.status !== "closed" && c.status !== "verified" && c.dueAt < now,
  );
  if (overdue.length)
    push(`${overdue.length} overdue corrective action(s)`, overdue.length * RISK_WEIGHTS.overdueCA, idsFor(overdue));

  const fatalities = inputs.incidents.filter((i) => i.siteId === site._id && i.type === "fatality");
  if (fatalities.length)
    push(`${fatalities.length} fatality incident(s)`, fatalities.length * RISK_WEIGHTS.fatality, idsFor(fatalities));

  const serious = inputs.incidents.filter(
    (i) => i.siteId === site._id && i.type !== "fatality" && (i.severity === "critical" || i.severity === "high"),
  );
  if (serious.length)
    push(`${serious.length} serious incident(s)`, serious.length * RISK_WEIGHTS.seriousIncident, idsFor(serious));

  const envAlerts = inputs.observations.filter(
    (o) => o.siteId === site._id && o.status !== "resolved" && (o.verification === "measured" || o.verification === "verified"),
  );
  if (envAlerts.length)
    push(`${envAlerts.length} verified environmental alert(s)`, envAlerts.length * RISK_WEIGHTS.envAlert, idsFor(envAlerts));

  return { score: points, factors };
}

/** The scope-filtered view of the risk inputs: does this caller see this
 *  site through the same authorization core every other surface uses? */
export function canViewSiteRisk(
  user: Pick<UserProfile, "role" | "scope" | "county" | "operatorName">,
  site: Pick<Site, "county" | "operatorName">,
): boolean {
  return canAccessSite(user, site);
}
