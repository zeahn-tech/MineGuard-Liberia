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

export type Scope = "national" | "county" | "site";

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
  profileComplete?: boolean;
  createdAt: number;
}

export interface Site {
  _id: string;
  code: string;
  name: string;
  operatorName: string;
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

export interface Evidence {
  _id: string;
  storagePath: string;
  parentType: "inspection" | "incident" | "observation";
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
}

// ---------------------------------------------------------------------------
// Client-side mirror of the rule logic (UI shaping only — rules enforce it).
// ---------------------------------------------------------------------------

export function isStaffRole(role?: Role | string | null): boolean {
  return (
    role === ROLES.ADMIN || role === ROLES.SUPERVISOR || role === ROLES.INSPECTOR
  );
}

export function canAccessSite(
  user: Pick<UserProfile, "role" | "scope" | "county" | "operatorName">,
  site: Pick<Site, "county" | "operatorName">,
): boolean {
  if (user.role === ROLES.ADMIN) return true;
  if (user.role === ROLES.OPERATOR) {
    return !!user.operatorName && site.operatorName === user.operatorName;
  }
  if (user.scope === "national") return true;
  if (user.scope === "county") return user.county === site.county;
  return false;
}

export function makeTrackingCode(): string {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.floor(Math.random() * 36).toString(36).toUpperCase();
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
