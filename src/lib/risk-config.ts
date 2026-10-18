// ---------------------------------------------------------------------------
// RISK CONFIG — the shape, validation and diff of a versioned weight set.
//
// PURE: no DB, no network. The authoritative copy of the weights lives in
// public.risk_config_versions (migration 0019); this module only
//   * describes that shape,
//   * validates a candidate exactly the way the database guard does (so the
//     editor can refuse early — the database still refuses again),
//   * diffs two versions for the history view,
//   * carries LEGACY_RISK_CONFIG: the pre-Session-7 weights = version 1. It is
//     the fallback ONLY for a deployment that has not applied migration 0019
//     (the client-side computation path) — never a second source of truth for
//     a migrated database.
// ---------------------------------------------------------------------------

export const RISK_WEIGHT_KEYS = [
  "criticalFinding",
  "highFinding",
  "mediumFinding",
  "lowFinding",
  "repeatFinding",
  "overdueCA",
  "fatality",
  "seriousIncident",
  "envAlert",
  "lateClosedCA",
] as const;

export type RiskWeightKey = (typeof RISK_WEIGHT_KEYS)[number];
export type RiskWeights = Record<RiskWeightKey, number>;

/** Human labels for the editor and the diff (the factor labels the score
 *  shows are produced by the builder, not here). */
export const RISK_WEIGHT_LABELS: Record<RiskWeightKey, string> = {
  criticalFinding: "Critical finding",
  highFinding: "High finding",
  mediumFinding: "Medium finding",
  lowFinding: "Low finding",
  repeatFinding: "Repeat findings (per 4 findings at a site)",
  overdueCA: "Overdue corrective action",
  fatality: "Fatality incident",
  seriousIncident: "Serious incident",
  envAlert: "Verified environmental alert",
  lateClosedCA: "Corrective action closed late (historical compliance)",
};

export const MAX_WEIGHT = 1000;
export const MIN_LOOKBACK_DAYS = 1;
export const MAX_LOOKBACK_DAYS = 3650;

/** The settings a version carries (everything the builder needs). */
export type RiskConfigSettings = {
  weights: RiskWeights;
  /** How far back a late-closed corrective action still counts. */
  lookbackDays: number;
};

/** One published version (a risk_config_versions row, mapped). */
export type RiskConfigVersion = RiskConfigSettings & {
  id: string;
  version: number;
  effectiveFrom: number; // epoch ms
  changeNote: string;
  createdBy: string | null;
  createdAt: number; // epoch ms
};

/** Version 1: the weights in force before configurable risk, historical
 *  compliance off — so adopting 0019 changes no score. */
export const LEGACY_RISK_CONFIG: RiskConfigSettings = {
  weights: {
    criticalFinding: 10,
    highFinding: 6,
    mediumFinding: 3,
    lowFinding: 1,
    repeatFinding: 4,
    overdueCA: 8,
    fatality: 15,
    seriousIncident: 7,
    envAlert: 5,
    lateClosedCA: 0,
  },
  lookbackDays: 365,
};

/** Mirror of the database guard (mg_valid_risk_weights + the lookback CHECK).
 *  Returns a human-readable problem, or null when the settings are valid. */
export function validateRiskSettings(input: unknown): string | null {
  if (!input || typeof input !== "object") return "Settings are required.";
  const s = input as { weights?: unknown; lookbackDays?: unknown };
  const w = s.weights;
  if (!w || typeof w !== "object" || Array.isArray(w)) return "Weights are required.";
  const rec = w as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (!(RISK_WEIGHT_KEYS as readonly string[]).includes(k)) return `Unknown weight “${k}”.`;
  }
  for (const k of RISK_WEIGHT_KEYS) {
    const v = rec[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return `${RISK_WEIGHT_LABELS[k]} must be a number.`;
    if (!Number.isInteger(v)) return `${RISK_WEIGHT_LABELS[k]} must be a whole number.`;
    if (v < 0 || v > MAX_WEIGHT)
      return `${RISK_WEIGHT_LABELS[k]} must be between 0 and ${MAX_WEIGHT}.`;
  }
  const d = s.lookbackDays;
  if (typeof d !== "number" || !Number.isInteger(d) || d < MIN_LOOKBACK_DAYS || d > MAX_LOOKBACK_DAYS)
    return `Look-back must be a whole number of days between ${MIN_LOOKBACK_DAYS} and ${MAX_LOOKBACK_DAYS}.`;
  return null;
}

export type RiskConfigChange = {
  /** weight key, or "lookbackDays" */
  key: RiskWeightKey | "lookbackDays";
  label: string;
  from: number;
  to: number;
};

/** What changed between two settings, in the canonical key order. Empty when
 *  the two are identical. */
export function diffRiskSettings(
  prev: RiskConfigSettings,
  next: RiskConfigSettings,
): RiskConfigChange[] {
  const out: RiskConfigChange[] = [];
  for (const k of RISK_WEIGHT_KEYS) {
    if (prev.weights[k] !== next.weights[k]) {
      out.push({ key: k, label: RISK_WEIGHT_LABELS[k], from: prev.weights[k], to: next.weights[k] });
    }
  }
  if (prev.lookbackDays !== next.lookbackDays) {
    out.push({
      key: "lookbackDays",
      label: "Historical look-back (days)",
      from: prev.lookbackDays,
      to: next.lookbackDays,
    });
  }
  return out;
}

/** The history view: every version paired with its diff against the version
 *  before it (the first version diffs against nothing). Newest first. */
export function versionHistory(
  versions: RiskConfigVersion[],
): { version: RiskConfigVersion; changes: RiskConfigChange[] | null }[] {
  const asc = [...versions].sort((a, b) => a.version - b.version);
  const rows = asc.map((v, i) => ({
    version: v,
    changes: i === 0 ? null : diffRiskSettings(asc[i - 1], v),
  }));
  return rows.reverse();
}

/** The version in force at `at` (epoch ms): the latest effective one. Mirrors
 *  mg_risk_config_at. */
export function versionInForce(
  versions: RiskConfigVersion[],
  at: number,
): RiskConfigVersion | null {
  let best: RiskConfigVersion | null = null;
  for (const v of versions) {
    if (v.effectiveFrom > at) continue;
    if (
      !best ||
      v.effectiveFrom > best.effectiveFrom ||
      (v.effectiveFrom === best.effectiveFrom && v.version > best.version)
    )
      best = v;
  }
  return best;
}
