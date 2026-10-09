// ---------------------------------------------------------------------------
// SHARED DOMAIN TYPES + AUTHORIZATION MODEL (client-side mirror)
//
// These types and helpers mirror the server-side authorization rules that are
// enforced in Firestore security rules (firestore.rules). The client-side
// checks exist only to shape the UI and give immediate feedback; the RULES
// are the real authorization boundary.
// ---------------------------------------------------------------------------

export const ROLES = {
  ADMIN: "admin",
  SUPERVISOR: "supervisor",
  INSPECTOR: "inspector",
  OPERATOR: "operator",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export type Scope =
  | "national"
  | "regional"
  | "county"
  | "district"
  | "site"
  | "operator";

export interface UserProfile {
  uid: string;
  email: string | null;
  name: string | null;
  role?: Role;
  jobTitle?: string;
  organization?: string;
  scope?: Scope;
  county?: string;
  operatorName?: string;
  /** Tenant key (migration 0010): organization UUID. operatorName is the
   *  display/compatibility mirror of organizations.name. */
  organizationId?: string;
  profileComplete?: boolean;
  createdAt: number;
}

export interface Site {
  _id: string;
  code: string;
  name: string;
  operatorName: string;
  /** Tenant key (migration 0010): isolation keys on this UUID, never on the
   *  display string. */
  organizationId?: string;
  mineralType?: string;
  county: string;
  district?: string;
  community?: string;
  status: "active" | "suspended" | "closed" | "pending_verification";
  latitude?: number;
  longitude?: number;
  notes?: string;
  createdBy: string;
  createdAt: number;
  // Computed client-side for the registry view:
  openActions?: number;
  // GIS fields (Session 6): authoritative geo is PostGIS/GeoJSON boundary
  // tables; these point-sized fields are the legacy registry-only fallback
  // and exist only when a boundary polygon has not been authored.
  geoSource?: string;
  geoAccuracyM?: number;
  geoVerified?: boolean;
}

export type GeoLayer =
  | "sites"
  | "site_boundaries"
  | "admin_boundaries"
  | "incidents"
  | "inspections"
  | "observations"
  | "community_reports"
  | "risk_indicators";

export interface MapLayerConfig {
  id: GeoLayer;
  label: string;
  /** Defaults drive the legend + initial toggles; the UI may override per session. */
  defaultVisible: boolean;
  /** False for point layers only; used by the cluster path. */
  supportsClustering: boolean;
}

/** One feature shown on the map. Point features use lng/lat; polygon
 *  features use their own geometry; both carry the same trust metadata so the
 *  legend and styling can be driven from real data. */
export interface MapFeature {
  id: string;
  layer: GeoLayer;
  label: string;
  lng: number;
  lat: number;
  /** For point features with no boundary geometry, the site this feature
   *  belongs to (if any) so boundary layers can be toggled alongside it. */
  siteId?: string;
  /** Verification metadata for the GEOGRAPHIC claim, distinct from record
   *  lifecycle status. A site can be "active" but its coordinates still
   *  "unverified" until an authoritative source is attached. */
  geoSource?: string;
  geoAccuracyM?: number;
  geoVerified?: boolean;
  /** Optional GeoJSON geometry for polygon layers (admin/site boundaries).
   *  Stored as GeoJSON on the row; rendered directly, never inferred. */
  geometryGeoJson?: string;
  /** Mutable per-session UI state (NOT persisted). */
  visible?: boolean;
}

export interface AdminBoundary {
  _id: string;
  name: string;
  level: "national" | "county" | "district" | "community";
  parentId?: string;
  geometryGeoJson: string;
  source: string;
  accuracyM?: number;
  geoVerified: boolean;
  createdAt: number;
}

export interface SiteBoundary {
  _id: string;
  siteId: string;
  geometryGeoJson: string;
  source: string;
  accuracyM?: number;
  geoVerified: boolean;
  createdAt: number;
}

export interface TemplateQuestion {
  label: string;
  answerType: "boolean" | "text" | "select" | "number";
  options?: string[];
  required: boolean;
}

export interface TemplateSection {
  title: string;
  questions: TemplateQuestion[];
}

export interface InspectionTemplate {
  _id: string;
  name: string;
  description?: string;
  active: boolean;
  sections: TemplateSection[];
  createdBy: string;
  createdAt: number;
}

export type InspectionStatus =
  | "draft"
  | "submitted"
  | "under_review"
  | "approved"
  | "rejected";

export interface Inspection {
  _id: string;
  siteId: string;
  templateId: string;
  inspectorId: string;
  status: InspectionStatus;
  answers?: Record<string, unknown>;
  notes?: string;
  latitude?: number;
  longitude?: number;
  gpsAccuracyM?: number;
  clientRef?: string;
  submittedAt?: number;
  reviewedAt?: number;
  reviewerId?: string;
  reviewNote?: string;
  createdAt: number;
}

export type Severity = "low" | "medium" | "high" | "critical";

export interface Finding {
  _id: string;
  inspectionId: string;
  siteId: string;
  title: string;
  description?: string;
  severity: Severity;
  status: "open" | "acknowledged" | "resolved" | "verified";
  createdById: string;
  createdAt: number;
}

export interface CorrectiveAction {
  _id: string;
  findingId: string;
  siteId: string;
  description: string;
  status:
    | "open"
    | "in_progress"
    | "submitted"
    | "verified"
    | "closed"
    | "escalated";
  dueAt: number;
  openedById: string;
  operatorNote?: string;
  verifiedById?: string;
  closedAt?: number;
  createdAt: number;
  /** Optimistic-concurrency token (migration 0009, server-maintained).
   *  Writes that pass it get 409 CONFLICT detection when another user
   *  changed the row first (OFF-4). */
  rowVersion?: number;
}

export type IncidentType =
  | "fatality"
  | "injury"
  | "near_miss"
  | "equipment_accident"
  | "vehicle_accident"
  | "fire"
  | "structural_failure"
  | "chemical_exposure"
  | "environmental"
  | "other";

export interface Incident {
  _id: string;
  siteId: string;
  type: IncidentType;
  severity: Severity;
  description: string;
  occurredAt: number;
  fatalities?: number;
  injured?: number;
  status: "reported" | "investigating" | "closed";
  reportedById: string;
  reportSource: "inspector" | "operator";
  createdAt: number;
  // Joined client-side:
  siteCode?: string;
  siteName?: string;
  county?: string;
}

export type EnvCategory =
  | "water_pollution"
  | "river_disturbance"
  | "river_diversion"
  | "deforestation"
  | "soil_degradation"
  | "waste"
  | "tailings"
  | "chemical_handling"
  | "rehabilitation"
  | "land_impact";

export type Verification =
  | "observed"
  | "measured"
  | "verified"
  | "unverified"
  | "alleged";

export interface EnvironmentalObservation {
  _id: string;
  siteId: string;
  category: EnvCategory;
  verification: Verification;
  description: string;
  observedAt: number;
  latitude?: number;
  longitude?: number;
  status: "open" | "monitoring" | "resolved";
  reportedById: string;
  createdAt: number;
  // Joined client-side:
  siteCode?: string;
  siteName?: string;
  county?: string;
}

export type ReportCategory =
  | "suspected_illegal_mining"
  | "pollution"
  | "environmental_damage"
  | "safety_concern"
  | "land_concern"
  | "unauthorized_activity";

export type ReportStatus =
  | "submitted"
  | "under_review"
  | "verified"
  | "dismissed"
  | "referred";

export interface CommunityReport {
  _id: string;
  trackingCode: string;
  category: ReportCategory;
  description: string;
  county: string;
  district?: string;
  community?: string;
  latitude?: number;
  longitude?: number;
  contactPhone?: string;
  status: ReportStatus;
  triageNote?: string;
  reviewedById?: string;
  reviewedAt?: number;
  createdAt: number;
}

export interface AuditEntry {
  _id: string;
  actorId?: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId?: string;
  summary: string;
  createdAt: number;
}

export type EvidenceKind = "photo" | "video" | "audio" | "document";

/** Records evidence may attach to. community_report / corrective_action were
 *  added by migration 0013 (EVD-1): staff triage attachments for public
 *  reports (site-less) and operator documents on a CA response. */
export type EvidenceParentType =
  | "inspection"
  | "incident"
  | "observation"
  | "community_report"
  | "corrective_action";

export interface Evidence {
  _id: string;
  storagePath: string;
  parentType: EvidenceParentType;
  parentId: string;
  siteId?: string;
  kind: EvidenceKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
  capturedAt?: number;
  uploadedById: string;
  createdAt: number;
  /** Lowercase-hex SHA-256 of the bytes (EVD-1), null for legacy rows. */
  sha256?: string;
}

// ---------------------------------------------------------------------------
// Client-side mirror of the rule logic (UI shaping only — rules enforce it).
// ---------------------------------------------------------------------------

export function isStaffRole(role?: Role | string | null): boolean {
  return (
    role === ROLES.ADMIN || role === ROLES.SUPERVISOR || role === ROLES.INSPECTOR
  );
}

/**
 * The single source of truth for per-user LIST scoping. Firestore evaluates
 * `list` rules per returned document AND rejects a query whose safety it
 * cannot prove — so the data layer must constrain its queries with exactly the
 * constraint this returns (doc 04 gap 5: county/operator list scoping is now
 * enforced by the rules, not merely by client-side filtering).
 *
 *   "all"      admin / national scope — unconstrained (rules allow any doc)
 *   { field }  county-scoped staff (county) or operator (operatorName)
 *   "none"     unassigned / scope-less account — no readable records
 */
export type ScopeConstraint =
  | "all"
  | { field: "county" | "operatorName"; value: string }
  | "none";

export function scopeConstraintForUser(
  user: Pick<UserProfile, "role" | "scope" | "county" | "operatorName">,
): ScopeConstraint {
  if (user.role === ROLES.ADMIN) return "all";
  if (isStaffRole(user.role)) {
    if (user.scope === "national") return "all";
    if (user.scope === "county" && user.county)
      return { field: "county", value: user.county };
    return "none";
  }
  if (user.role === ROLES.OPERATOR && user.operatorName) {
    return { field: "operatorName", value: user.operatorName };
  }
  return "none";
}

/** Denormalized scope fields stamped on every site-scoped record at write
 *  time. They are what makes rules-level list scoping possible (doc 04 gap 5). */
export function siteScopeStamp(site: {
  county?: string;
  operatorName?: string;
}): { county: string; operatorName: string } {
  return {
    county: site.county ?? "Unknown",
    operatorName: site.operatorName ?? "Unknown",
  };
}

export function canAccessSite(
  user: Pick<UserProfile, "role" | "scope" | "county" | "operatorName" | "organizationId">,
  site: Pick<Site, "county" | "operatorName" | "organizationId">,
): boolean {
  if (user.role === ROLES.ADMIN) return true;
  if (user.role === ROLES.OPERATOR) {
    // Tenancy keys on organization UUIDs (migration 0010); the name compare
    // is the legacy fallback for rows not yet bound to an organization.
    if (user.organizationId && site.organizationId)
      return user.organizationId === site.organizationId;
    return !!user.operatorName && site.operatorName === user.operatorName;
  }
  if (user.scope === "national") return true;
  if (user.scope === "county") return user.county === site.county;
  // regional / district / site scopes are resolved server-side (region
  // hierarchy, site_assignments) — the client mirror cannot evaluate them,
  // and every row reaching the client was already filtered by the RLS
  // policy that can. Fail open here rather than hiding authorized rows.
  if (user.scope === "regional" || user.scope === "district" || user.scope === "site")
    return true;
  return false;
}

// Public community-report tracking code. Uniqueness matters: the code is the
// ONLY key a reporter has to look up their report, so a collision would expose
// the wrong record's status. Time component (base36 ms) + 8 high-entropy
// characters (crypto-backed when available) keeps collisions negligible.
export function makeTrackingCode(): string {
  const t = Date.now().toString(36).toUpperCase();
  const c = globalThis.crypto as Crypto | undefined;
  const r =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()
      : Math.random().toString(36).slice(2, 10).toUpperCase();
  return `CR-${t}${r}`;
}

export function nextSiteCodeFrom(county: string, existingCodes: string[]): string {
  const prefix = `MGL-${county.replace(/[^A-Za-z]/g, "").slice(0, 6).toUpperCase() || "XX"}-`;
  let max = 0;
  for (const code of existingCodes) {
    if (code.startsWith(prefix)) {
      const n = parseInt(code.slice(prefix.length), 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}
