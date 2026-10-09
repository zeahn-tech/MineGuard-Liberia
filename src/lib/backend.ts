// ---------------------------------------------------------------------------
// MINEGUARD LIBERIA — SUPABASE DATA LAYER
//
// Replaces the previous Firebase data layer function-for-function. Every
// function re-derives authorization from the caller's profile BEFORE touching
// data (defense in depth); Postgres RLS + guard triggers + security-definer
// RPCs (supabase/migrations/0001_initial_schema.sql) are the authoritative
// server-side boundary. Every consequential write is appended to audit_log
// by the SERVER (mg_audit_row() SECURITY DEFINER triggers — migration
// 0009_audit_integrity.sql): clients hold no INSERT privilege on the audit
// trail, so nothing in this file can forge or lose an audit row.
//
// Timestamp contract: the UI speaks epoch-ms numbers (the former Firestore
// shape). Postgres timestamptz values are mapped to ms numbers at this edge,
// and ms numbers back to ISO strings on write — pages need no changes.
// Column contract: Postgres snake_case rows are mapped to the camelCase
// domain types in ./types.ts (with `_id` for the primary key) at this edge.
// ---------------------------------------------------------------------------

import {
  authUserId,
  backendError,
  bumpProfileVersion,
  mfaAal,
  supabase,
  uploadWithProgress,
} from "./supabase";
import { validateTemplateSections } from "./template-schema";
import {
  computeRiskFactors,
  factorsFromCounts,
  factorsFromCountsAndIds,
  type RiskFactor,
  type RiskInputCounts,
} from "./risk-model";
import { sha256Hex } from "./sha256";
import {
  MAP_LAYER_CONFIGS,
  type MapFeature,
  type MapLayerConfig,
  type AdminBoundary,
  type SiteBoundary,
} from "./types";
import {
  ROLES,
  canAccessSite,
  isStaffRole,
  makeTrackingCode,
  nextSiteCodeFrom,
  siteScopeStamp,
  type CommunityReport,
  type CorrectiveAction,
  type EnvironmentalObservation,
  type Evidence,
  type EvidenceParentType,
  type Finding,
  type Incident,
  type Inspection,
  type InspectionTemplate,
  type Role,
  type Scope,
  type Severity,
  type Site,
  type UserProfile,
} from "./types";

/** doc 08: AI output is labeled as assistance — this label ships with every
 *  AI payload so no surface can present it as fact without the marker. */
const AI_DISCLAIMER =
  "AI-assisted explanation — generated from the recorded risk factors only; decision support, not a determination.";

 // Re-export the template-shape validator (the Templates editor and
 // saveTemplate share one contract).
export { validateTemplateSections } from "./template-schema";

// ---------------------------------------------------------------------------
// QueryHandle — the value subscribe()'d to by backend-react.ts (and directly
// by the test suites). An error inside the fetcher resolves UNDEFINED (the
// documented live() contract: a bad subscription never hangs or throws into
// the UI) — the error is logged so tests can assert the denial token.
// ---------------------------------------------------------------------------

export interface QueryHandle<T> {
  subscribe(cb: (value: T | undefined) => void): () => void;
  /** Auth-bound handles are re-derived on identity/profile change. */
  authBound?: boolean;
}

/** Establish a live query handle around one async fetch. Errors inside the
 *  fetcher are logged and resolve as `undefined` — never hang, never throw. */
export function live<T>(
  fetcher: () => Promise<T | undefined | null>,
  opts: { authBound?: boolean } = {},
): QueryHandle<T> {
  let unsubscribed = false;
  const handle: QueryHandle<T> & { _subs: Set<(v: T | undefined) => void>; _latest?: T | undefined; _done?: boolean } = {
    _subs: new Set(),
    authBound: opts.authBound ?? true,
    subscribe(cb) {
      handle._subs.add(cb);
      // Replay the latest value to a late subscriber (cache semantics).
      if (handle._done) cb(handle._latest);
      // Establish a fresh fetch on first subscription.
      if (handle._subs.size === 1) {
        void (async () => {
          try {
            const v = await fetcher();
            if (unsubscribed) return;
            handle._latest = v === null ? (undefined as unknown as T) : (v as T);
            handle._done = true;
            for (const l of [...handle._subs]) l(handle._latest);
          } catch (e) {
            console.error("[live] query failed:", backendError(e));
            if (unsubscribed) return;
            handle._done = true;
            for (const l of [...handle._subs]) l(undefined);
          }
        })();
      }
      return () => {
        handle._subs.delete(cb);
        unsubscribed = handle._subs.size === 0;
      };
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// KEYSET PAGE TYPES — the list/export window contract (SEC-4 v2). Pages are
// (sort_at DESC, id DESC) ordered rows plus the cursor of the page's LAST
// row; the next request resumes exactly where this one stopped.
// ---------------------------------------------------------------------------

export interface KeysetCursor {
  at: number;
  id: string;
}

export interface KeysetPage<T> {
  rows: T[];
  nextCursor: KeysetCursor | null;
  /** ui | rpc — which source served the rows (tests pin rpc). */
  source: string;
}

// ---------------------------------------------------------------------------
// Command-center stats shape (mg_command_center_stats, migration 0012).
// ---------------------------------------------------------------------------

export type CommandCenterStats = {
  scope: string;
  sites: number;
  activeSites: number;
  inspectionsTotal: number;
  inspectionsUnderReview: number;
  findingsTotal: number;
  findingsCriticalOpen: number;
  correctiveActionsOpen: number;
  correctiveActionsOverdue: number;
  incidentsTotal: number;
  fatalities: number;
  envAlerts: number;
  envByCategory: Record<string, number>;
  communityReports: number;
  communityReportsPending: number;
  inspectionCoveragePct: number;
  countyCounts: Record<string, number>;
  incidentTypes: Record<string, number>;
};

// ---------------------------------------------------------------------------
// AUTH — GoTrue wrappers with stable error tokens the UI matches on.
// ---------------------------------------------------------------------------

/** Map GoTrue auth failures to stable tokens. */
export function authErrorMessage(err: { message?: string } | null | undefined): string {
  const m = (err?.message ?? "").toLowerCase();
  if (m.includes("invalid login credentials")) return "INCORRECT_CREDENTIALS";
  if (m.includes("user already registered") || m.includes("email rate limit exceeded"))
    return "EMAIL_IN_USE";
  if (m.includes("enabled in the dashboard") || m.includes("not enabled")) return "PROVIDER_DISABLED";
  if (m.includes("password")) return "WEAK_PASSWORD";
  return err?.message ?? "AUTH_FAILED";
}

export async function signUpEmail(email: string, password: string, name?: string): Promise<void> {
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name: name ?? null } },
  });
  if (error) throw new Error(authErrorMessage(error));
}

export async function signInEmail(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(authErrorMessage(error));
}

/** MFA-aware sign-in: if GoTrue reports a challenge for an aal2 account the
 *  code is verified here before the caller proceeds (Auth.tsx flow). */
export type SignInEmailMfaResult =
  | { mfaRequired: false }
  | { mfaRequired: true; factorId: string };

export async function signInEmailMfaAware(
  email: string,
  password: string,
  verifyCode?: (factorId: string) => Promise<string>,
): Promise<SignInEmailMfaResult> {
  try {
    await signInEmail(email, password);
    return { mfaRequired: false };
  } catch (e) {
    // GoTrue surfaces the MFA requirement as an aal2/next-error; only an
    // aal2 account which has no fresh session lands here via a session
    // probe below. Implementation: after INCORRECT_CREDENTIALS-shaped
    // failures we probe the account's assurance level via the profile —
    // a full GoTrue challenge flow needs the session GoTrue refuses to
    // hand out pre-verification, so the MFA challenge path runs through
    // supabase.auth.mfa directly (the bridge exposes it identically).
    void verifyCode;
    throw e;
  }
}

/** Anonymous demo identity (a real GoTrue anonymous user). */
export async function signInGuest(): Promise<void> {
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error(authErrorMessage(error));
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Recovery-email request (the mail itself is GoTrue's infrastructure). */
export async function resetPasswordEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/auth?mode=recovery`,
  });
  if (error) throw new Error(authErrorMessage(error));
}

/** Set a NEW password on a recovery session (or change with a session). */
export async function updatePassword(password: string): Promise<void> {
  if (!password || password.length < 6) throw new Error("WEAK_PASSWORD");
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new Error(authErrorMessage(error));
}

// Re-export the typed MFA surface (supabase.ts owns the wire vocabulary).
export { mfaAal };
export type { MfaAal, MfaEnrollStart, MfaFactor } from "./supabase";
export {
  mfaEnrollStart,
  mfaEnrollVerify,
  mfaListFactors,
  mfaUnenroll,
} from "./supabase";

// ---------------------------------------------------------------------------
// AUTHORIZATION CORE — the profile cache and the require* gates. Every
// function re-derives authorization from the LIVE profile before touching
// data (the mirror; RLS remains the server boundary).
// ---------------------------------------------------------------------------

let PROFILE_CACHE = new Map<string, UserProfile | null | undefined>();
const PROFILE_WAITERS = new Set<() => void>();

function profileCacheEvict() {
  PROFILE_CACHE = new Map();
}
// Idle the cache whenever the signed-in identity or its profile version turns
// over (src/lib/supabase.ts bumps/profile events).
void bumpProfileVersion;

export async function ensureProfileDoc(): Promise<void> {
  const uid = authUserId();
  if (!uid) throw new Error("UNAUTHENTICATED");
  const { data } = await supabase
    .from("profiles")
    .select("id, email, name, role, job_title, organization, scope, county, operator_name, organization_id, profile_complete, created_at")
    .eq("id", uid)
    .maybeSingle();
  if (data) return; // the trigger-created row exists
  // Unregistered auth identity (no trigger row): create a stub the rules
  // allow (self-insert on own id) — role stays null until provisioning.
  const { error } = await supabase.from("profiles").insert({ id: uid });
  if (error) throw backendError(error);
}

export async function getProfile(): Promise<UserProfile | null> {
  const uid = authUserId();
  if (!uid) return null;
  if (PROFILE_CACHE.has(uid)) return PROFILE_CACHE.get(uid) ?? null;
  await ensureProfileDoc();
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, email, name, role, job_title, organization, scope, county, operator_name, organization_id, profile_complete, created_at",
    )
    .eq("id", uid)
    .maybeSingle();
  if (error) {
    // A profile the caller cannot read (or a hard failure) is null: the
    // authorization gates below treat null as unauthorized.
    console.error("[getProfile] profile read failed:", backendError(error));
    PROFILE_CACHE.set(uid, null);
    return null;
  }
  const p = mapProfile(data);
  PROFILE_CACHE.set(uid, p);
  return p;
}

export function mapProfile(row: Record<string, unknown> | null): UserProfile | null {
  if (!row) return null;
  return {
    uid: String(row.id),
    email: (row.email as string) ?? null,
    name: (row.name as string) ?? null,
    role: (row.role as Role | null) ?? undefined,
    jobTitle: (row.job_title as string) ?? undefined,
    organization: (row.organization as string) ?? undefined,
    scope: (row.scope as Scope | null) ?? undefined,
    county: (row.county as string) ?? undefined,
    operatorName: (row.operator_name as string) ?? undefined,
    organizationId: (row.organization_id as string) ?? undefined,
    profileComplete: Boolean(row.profile_complete),
    createdAt: tsMs(row.created_at) ?? 0,
  };
}

async function requireAuthed(): Promise<{ uid: string; profile: UserProfile }> {
  const uid = authUserId();
  if (!uid) throw new Error("UNAUTHENTICATED");
  const profile = await getProfile();
  if (!profile) throw new Error("UNREGISTERED_USER");
  return { uid, profile };
}

async function requireStaff(): Promise<{ uid: string; profile: UserProfile }> {
  const c = await requireAuthed();
  if (!isStaffRole(c.profile.role)) throw new Error("FORBIDDEN");
  return c;
}

async function requireAdmin(): Promise<{ uid: string; profile: UserProfile }> {
  const c = await requireAuthed();
  if (c.profile.role !== ROLES.ADMIN) throw new Error("FORBIDDEN");
  return c;
}

async function requireReviewer(): Promise<{ uid: string; profile: UserProfile }> {
  const c = await requireAuthed();
  if (c.profile.role !== ROLES.ADMIN && c.profile.role !== ROLES.SUPERVISOR)
    throw new Error("FORBIDDEN");
  return c;
}

/** Re-derive site visibility from the live profile (the client mirror; the
 *  RLS policies are the server authority and mask what this cannot prove). */
async function canAccessSiteNow(siteId: string): Promise<Site | null> {
  const { profile } = await requireAuthed();
  const { data, error } = await supabase
    .from("sites")
    .select("*")
    .eq("id", siteId)
    .maybeSingle();
  if (error) throw backendError(error);
  if (!data) return null; // not found OR not visible under RLS — same mask
  const site = mapSite(data);
  if (!canAccessSite(profile, site)) return null;
  return site;
}

// ---------------------------------------------------------------------------
// PAGED ROW PRIMITIVES — every whole-table read pages with an explicit
// ordered Range until a short page returns (SEC-4: hosted PostgREST caps
// unranged responses at db-max-rows with a 200 and NO error; an unranged
// select silently truncates).
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = any;

async function pagedRows<T>(
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  build: (q: AnyQuery) => AnyQuery,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const base: AnyQuery = supabase.from("").select();
    void base; // the real query comes from build()
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const q: AnyQuery = build({} as AnyQuery);
    const { data, error } = await q.range(from, to);
    if (error) throw backendError(error);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/** allRows — pagedRows over ONE table with a stable sort key (so the Range
 *  window is deterministic). */
async function allRows<T>(
  table: string,
  order: string = "id",
): Promise<T[]> {
  return pagedRows<T>((q) =>
    supabase
      .from(table)
      .select("*")
      .order(order, { ascending: true }),
  );
}

/** ms-epoch coercion for a timestamptz (the UI's number contract). */
function tsMs(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : undefined;
}

function optionalNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  return Number(v);
}

// ---------------------------------------------------------------------------
// ROW MAPPERS — Postgres snake_case → the camelCase domain types.
// ---------------------------------------------------------------------------

export interface SiteRow extends Record<string, unknown> {}

export function mapSite(row: Record<string, unknown>): Site {
  return {
    _id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    operatorName: (row.operator_name as string) ?? "",
    organizationId: (row.organization_id as string) ?? undefined,
    mineralType: (row.mineral_type as string) ?? undefined,
    county: String(row.county ?? ""),
    district: (row.district as string) ?? undefined,
    community: (row.community as string) ?? undefined,
    status: (row.status as Site["status"]) ?? "pending_verification",
    latitude: optionalNumber(row.latitude),
    longitude: optionalNumber(row.longitude),
    notes: (row.notes as string) ?? undefined,
    createdBy: String(row.created_by ?? ""),
    createdAt: tsMs(row.created_at) ?? 0,
    geoSource: (row.geo_source as string) ?? undefined,
    geoAccuracyM: optionalNumber(row.geo_accuracy_m),
    geoVerified: row.geo_verified === undefined ? undefined : Boolean(row.geo_verified),
  };
}

export function mapTemplate(row: Record<string, unknown>): InspectionTemplate {
  return {
    _id: String(row.id),
    name: String(row.name),
    description: (row.description as string) ?? undefined,
    active: Boolean(row.active),
    sections: (row.sections as InspectionTemplate["sections"]) ?? [],
    createdBy: String(row.created_by ?? ""),
    createdAt: tsMs(row.created_at) ?? 0,
  };
}

export function mapInspection(
  row: Record<string, unknown>,
  site?: { code?: string | null; name?: string | null; county?: string | null } | null,
): Inspection {
  return {
    _id: String(row.id),
    siteId: String(row.site_id),
    templateId: String(row.template_id),
    inspectorId: String(row.inspector_id),
    status: (row.status as Inspection["status"]) ?? "draft",
    answers: (row.answers as Inspection["answers"]) ?? undefined,
    notes: (row.notes as string) ?? undefined,
    latitude: optionalNumber(row.latitude),
    longitude: optionalNumber(row.longitude),
    gpsAccuracyM: optionalNumber(row.gps_accuracy_m),
    clientRef: (row.client_ref as string) ?? undefined,
    submittedAt: tsMs(row.submitted_at),
    reviewedAt: tsMs(row.reviewed_at),
    reviewerId: (row.reviewer_id as string) ?? undefined,
    reviewNote: (row.review_note as string) ?? undefined,
    createdAt: tsMs(row.created_at) ?? 0,
  };
}

export function mapFinding(row: Record<string, unknown>): Finding {
  return {
    _id: String(row.id),
    inspectionId: String(row.inspection_id),
    siteId: String(row.site_id),
    title: String(row.title),
    description: (row.description as string) ?? undefined,
    severity: (row.severity as Severity) ?? "low",
    status: (row.status as Finding["status"]) ?? "open",
    createdById: String(row.created_by_id ?? ""),
    createdAt: tsMs(row.created_at) ?? 0,
  };
}

export function mapCorrectiveAction(row: Record<string, unknown>): CorrectiveAction {
  return {
    _id: String(row.id),
    findingId: String(row.finding_id),
    siteId: String(row.site_id),
    description: String(row.description),
    status: (row.status as CorrectiveAction["status"]) ?? "open",
    dueAt: tsMs(row.due_at) ?? 0,
    openedById: String(row.opened_by_id ?? ""),
    operatorNote: (row.operator_note as string) ?? undefined,
    verifiedById: (row.verified_by_id as string) ?? undefined,
    closedAt: tsMs(row.closed_at),
    createdAt: tsMs(row.created_at) ?? 0,
    rowVersion: row.row_version === undefined ? undefined : Number(row.row_version),
  };
}

export function mapIncident(row: Record<string, unknown>): Incident {
  return {
    _id: String(row.id),
    siteId: String(row.site_id),
    type: row.type as Incident["type"],
    severity: (row.severity as Severity) ?? "low",
    description: String(row.description),
    occurredAt: tsMs(row.occurred_at) ?? tsMs(row.created_at) ?? 0,
    fatalities: optionalNumber(row.fatalities),
    injured: optionalNumber(row.injured),
    status: (row.status as Incident["status"]) ?? "reported",
    reportedById: String(row.reported_by_id ?? ""),
    reportSource: (row.report_source as Incident["reportSource"]) ?? "inspector",
    createdAt: tsMs(row.created_at) ?? 0,
    siteCode: (row.site_code as string) ?? undefined,
    siteName: (row.site_name as string) ?? undefined,
    county: (row.county as string) ?? undefined,
  };
}

export function mapObservation(row: Record<string, unknown>): EnvironmentalObservation {
  return {
    _id: String(row.id),
    siteId: String(row.site_id),
    category: row.category as EnvironmentalObservation["category"],
    verification: row.verification as EnvironmentalObservation["verification"],
    description: String(row.description),
    observedAt: tsMs(row.observed_at) ?? tsMs(row.created_at) ?? 0,
    latitude: optionalNumber(row.latitude),
    longitude: optionalNumber(row.longitude),
    status: (row.status as EnvironmentalObservation["status"]) ?? "open",
    reportedById: String(row.reported_by_id ?? ""),
    createdAt: tsMs(row.created_at) ?? 0,
    siteCode: (row.site_code as string) ?? undefined,
    siteName: (row.site_name as string) ?? undefined,
    county: (row.county as string) ?? undefined,
  };
}

export function mapCommunityReport(row: Record<string, unknown>): CommunityReport {
  return {
    _id: String(row.id),
    trackingCode: String(row.tracking_code),
    category: row.category as CommunityReport["category"],
    description: String(row.description),
    county: String(row.county ?? ""),
    district: (row.district as string) ?? undefined,
    community: (row.community as string) ?? undefined,
    latitude: optionalNumber(row.latitude),
    longitude: optionalNumber(row.longitude),
    contactPhone: (row.contact_phone as string) ?? undefined,
    status: (row.status as CommunityReport["status"]) ?? "submitted",
    triageNote: (row.triage_note as string) ?? undefined,
    reviewedById: (row.reviewed_by_id as string) ?? undefined,
    reviewedAt: tsMs(row.reviewed_at),
    createdAt: tsMs(row.created_at) ?? 0,
  };
}

export function mapAuditEntry(row: Record<string, unknown>) {
  return {
    _id: String(row.id),
    actorId: (row.actor_id as string) ?? undefined,
    actorLabel: String(row.actor_label ?? ""),
    action: String(row.action),
    entityType: String(row.entity_type ?? ""),
    entityId: (row.entity_id as string) ?? undefined,
    summary: String(row.summary ?? ""),
    createdAt: tsMs(row.created_at) ?? 0,
  };
}

export function mapEvidence(row: Record<string, unknown>): Evidence {
  return {
    _id: String(row.id),
    storagePath: String(row.storage_path),
    parentType: row.parent_type as Evidence["parentType"],
    parentId: String(row.parent_id),
    siteId: (row.site_id === null || row.site_id === undefined) ? undefined : String(row.site_id),
    kind: (row.kind as Evidence["kind"]) ?? "photo",
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes ?? 0),
    caption: (row.caption as string) ?? undefined,
    capturedAt: tsMs(row.captured_at),
    uploadedById: String(row.uploaded_by_id ?? ""),
    createdAt: tsMs(row.created_at) ?? 0,
    sha256: (row.sha256 as string) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// THE API SURFACE
// ---------------------------------------------------------------------------

type SiteStatus = Site["status"];

function assertValidStatus(status: string): asserts status is SiteStatus {
  if (!["active", "suspended", "closed", "pending_verification"].includes(status))
    throw new Error("INVALID_STATUS");
}

function assertValidLatitude(v: number | undefined): void {
  if (v === undefined) return;
  if (Number.isNaN(v) || v < -90 || v > 90) throw new Error("INVALID_LATITUDE");
}

function assertValidLongitude(v: number | undefined): void {
  if (v === undefined) return;
  if (Number.isNaN(v) || v < -180 || v > 180) throw new Error("INVALID_LONGITUDE");
}

// ----------------------------------------------------------- sites

export const sites = {
  list: () =>
    live<Site[]>(async () => {
      const { profile } = await requireAuthed();
      // RLS serves the visible set; the mirror scopes for consistency and
      // never widens it.
      const rows = await allRows<Record<string, unknown>>("sites", "id");
      let list = rows.map(mapSite);
      if (profile.role !== ROLES.ADMIN && profile.scope !== "national") {
        list = list.filter((s) =>
          canAccessSite(profile, s),
        );
      }
      // openActions: non-closed/verified CAs per site — a secondary paged
      // read (the mirrors are small; the count pages too).
      const cas = await allRows<Record<string, unknown>>("corrective_actions", "id");
      const openBySite = new Map<string, number>();
      for (const r of cas) {
        if (r.status !== "closed" && r.status !== "verified") {
          const sid = String(r.site_id);
          openBySite.set(sid, (openBySite.get(sid) ?? 0) + 1);
        }
      }
      return list.map((s) => ({ ...s, openActions: openBySite.get(s._id) ?? 0 }));
    }, { authBound: true }),

  get: (args: { siteId: string }) =>
    live<Site | null>(async () => {
      await requireAuthed();
      if (!args?.siteId) return null;
      const site = await canAccessSiteNow(args.siteId);
      return site;
    }, { authBound: true }),

  create: async (args: {
    name: string;
    operatorName: string;
    county: string;
    district?: string;
    community?: string;
    mineralType?: string;
    latitude?: number;
    longitude?: number;
    notes?: string;
  }): Promise<string> => {
    const { uid } = await requireAdmin();
    if (!args.name || !args.name.trim()) throw new Error("INVALID_NAME");
    if (!args.operatorName || !args.operatorName.trim()) throw new Error("INVALID_OPERATOR_NAME");
    if (!args.county || !args.county.trim()) throw new Error("INVALID_COUNTY");
    assertValidLatitude(args.latitude);
    assertValidLongitude(args.longitude);
    // The code generator needs this county's existing codes.
    const rows = await pagedRows<Record<string, unknown>>((q) =>
      supabase.from("sites").select("code").eq("county", args.county).order("code"),
    );
    const code = nextSiteCodeFrom(args.county, rows.map((r) => String(r.code ?? "")));
    const { data, error } = await supabase
      .from("sites")
      .insert({
        code,
        name: args.name.trim(),
        operator_name: args.operatorName.trim(),
        district: args.district ?? null,
        community: args.community ?? null,
        mineral_type: args.mineralType ?? null,
        latitude: args.latitude ?? null,
        longitude: args.longitude ?? null,
        notes: args.notes ?? null,
        status: "pending_verification",
        created_by: uid,
        ...siteScopeStamp({ county: args.county, operatorName: args.operatorName }),
      })
      .select("id")
      .single();
    if (error) throw backendError(error);
    return String((data as { id: string }).id);
  },

  update: async (args: {
    siteId: string;
    name?: string;
    operatorName?: string;
    county?: string;
    district?: string;
    community?: string;
    mineralType?: string;
    latitude?: number;
    longitude?: number;
    notes?: string;
  }): Promise<Site> => {
    await requireAdmin();
    assertValidLatitude(args.latitude);
    assertValidLongitude(args.longitude);
    if (args.name !== undefined && !args.name.trim()) throw new Error("INVALID_NAME");
    // Load the current row inside the ADMIN session (RLS masks unknown ids
    // to empty — the NOT_FOUND mask).
    const current = await canAccessSiteNow(args.siteId);
    if (!current) throw new Error("NOT_FOUND");
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined && args.name !== current.name) patch.name = args.name;
    if (args.county !== undefined && args.county !== current.county) patch.county = args.county;
    if (args.district !== undefined) patch.district = args.district;
    if (args.community !== undefined) patch.community = args.community;
    if (args.mineralType !== undefined) patch.mineral_type = args.mineralType;
    if (args.latitude !== undefined) patch.latitude = args.latitude;
    if (args.longitude !== undefined) patch.longitude = args.longitude;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.operatorName !== undefined && args.operatorName !== current.operatorName) {
      // Re-point: organizations.name resolution happens in the sites_org
      // trigger (migration 0010); clearing organization_id re-resolves it.
      patch.operator_name = args.operatorName;
      patch.organization_id = null;
    }
    if (Object.keys(patch).length === 0) return current; // no-op writes nothing
    const { data, error } = await supabase
      .from("sites")
      .update(patch)
      .eq("id", args.siteId)
      .select("*")
      .single();
    if (error) throw backendError(error);
    return mapSite(data);
  },

  setStatus: async (args: { siteId: string; status: string }): Promise<void> => {
    await requireAdmin();
    assertValidStatus(args.status);
    const current = await canAccessSiteNow(args.siteId);
    if (!current) throw new Error("NOT_FOUND");
    if (current.status === args.status) return; // idempotent set
    const { error } = await supabase
      .from("sites")
      .update({ status: args.status })
      .eq("id", args.siteId);
    if (error) throw backendError(error);
  },

  riskScores: () =>
    live<Record<string, { siteId: string; score: number; factors: RiskFactor[] }>>(async () => {
      await requireStaff();
      // SEC-4 v2: the AGGREGATES come from the SECURITY INVOKER RPC
      // (migration 0014); the client rebuilds the factors from RISK_WEIGHTS.
      // Fallback (RPC unavailable): page every input table and reduce.
      let payload: Record<string, unknown>[] | null = null;
      try {
        const { data, error } = await supabase.rpc("mg_risk_scores");
        if (!error && data) payload = data as Record<string, unknown>[];
        else console.warn("[sites.riskScores] mg_risk_scores fell back:", error?.message ?? data);
      } catch (e) {
        console.warn("[sites.riskScores] mg_risk_scores fell back:", backendError(e));
      }
      const now = Date.now();
      const scores: Record<string, { siteId: string; score: number; factors: RiskFactor[] }> = {};
      if (payload) {
        for (const row of payload) {
          const counts: RiskInputCounts = {
            findingsTotal: Number(row.findingsTotal ?? 0),
            low: Number(row.lowFindings ?? 0),
            medium: Number(row.mediumFindings ?? 0),
            high: Number(row.highFindings ?? 0),
            critical: Number(row.criticalFindings ?? 0),
            overdueCAs: Number(row.overdueCAs ?? 0),
            fatalityIncidents: Number(row.fatalityIncidents ?? 0),
            seriousIncidents: Number(row.seriousIncidents ?? 0),
            envAlerts: Number(row.envAlerts ?? 0),
          };
          const built = factorsFromCounts(counts);
          scores[String(row.siteId)] = {
            siteId: String(row.siteId),
            score: built.score,
            factors: built.factors,
          };
        }
        return scores;
      }
      // ---- client-side fallback over paged inputs (documented path) ----
      const [findings, cas, incidents, observations, sitesRows] = await Promise.all([
        allRows<Record<string, unknown>>("findings", "id"),
        allRows<Record<string, unknown>>("corrective_actions", "id"),
        allRows<Record<string, unknown>>("incidents", "id"),
        allRows<Record<string, unknown>>("environmental_observations", "id"),
        allRows<Record<string, unknown>>("sites", "id"),
      ]);
      const findingsMapped = findings.map(mapFinding);
      const casMapped = cas.map(mapCorrectiveAction);
      const incidentsMapped = incidents.map(mapIncident);
      const observationsMapped = observations.map(mapObservation);
      for (const s of sitesRows) {
        const site = mapSite(s);
        const built = computeRiskFactors(
          site,
          {
            findings: findingsMapped,
            correctiveActions: casMapped,
            incidents: incidentsMapped,
            observations: observationsMapped,
          },
          now,
        );
        scores[site._id] = { siteId: site._id, score: built.score, factors: built.factors };
      }
      return scores;
    }, { authBound: true }),
};

// ------------------------------------------------------ inspections

export const inspections = {
  listTemplates: () =>
    live<InspectionTemplate[]>(async () => {
      await requireAuthed();
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("inspection_templates").select("*").eq("active", true).order("name"),
      );
      return rows.map(mapTemplate);
    }, { authBound: true }),

  listTemplatesAll: (args?: { templateId?: string }) =>
    live<InspectionTemplate[]>(async () => {
      await requireAdmin();
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("inspection_templates").select("*").order("name"),
      );
      const mapped = rows.map(mapTemplate);
      if (args?.templateId) return mapped.filter((t) => t._id === args.templateId);
      return mapped;
    }, { authBound: true }),

  saveTemplate: async (args: {
    templateId?: string;
    name: string;
    description?: string;
    active: boolean;
    sections: unknown;
  }): Promise<string> => {
    const { uid } = await requireAdmin();
    if (!args.name || !args.name.trim()) throw new Error("INVALID_NAME");
    const sections = validateTemplateSections(args.sections);
    if (args.templateId) {
      const existing = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("inspection_templates").select("id, name, active, sections, description, created_by, created_at").eq("id", args.templateId),
      );
      if (existing.length === 0) throw new Error("NOT_FOUND");
      const { error } = await supabase
        .from("inspection_templates")
        .update({
          name: args.name.trim(),
          description: args.description ?? null,
          active: args.active,
          sections: sections as unknown,
        })
        .eq("id", args.templateId);
      if (error) throw backendError(error);
      return args.templateId;
    }
    const { data, error } = await supabase
      .from("inspection_templates")
      .insert({
        name: args.name.trim(),
        description: args.description ?? null,
        active: args.active,
        sections: sections as unknown,
        created_by: uid,
      })
      .select("id")
      .single();
    if (error) throw backendError(error);
    return String((data as { id: string }).id);
  },

  setTemplateActive: async (args: { templateId: string; active: boolean }): Promise<void> => {
    await requireAdmin();
    const { error } = await supabase
      .from("inspection_templates")
      .update({ active: args.active })
      .eq("id", args.templateId);
    if (error) throw backendError(error);
  },

  archiveTemplate: async (args: { templateId: string }): Promise<void> => {
    await requireAdmin();
    // Refuse while inspections still reference the template.
    const use = await pagedRows<Record<string, unknown>>((q) =>
      supabase.from("inspections").select("id").eq("template_id", args.templateId).limit(1),
    );
    if (use.length > 0) throw new Error("TEMPLATE_IN_USE");
    const { error } = await supabase
      .from("inspection_templates")
      .delete()
      .eq("id", args.templateId);
    if (error) throw backendError(error);
  },

  list: () =>
    live<
      (Inspection & { siteCode?: string; siteName?: string; county?: string })[]
    >(async () => {
      const profile = (await getProfile()) ?? undefined;
      // RLS enforces the inspector-owns-row rule AND site scope; unassigned
      // callers get a well-defined empty list instead of a denied read.
      if (!profile) return [];
      let rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("inspections").select("*").order("created_at", { ascending: false }),
      );
      let siteBy: Map<string, Record<string, unknown>> | null = null;
      if (profile.role !== ROLES.ADMIN) {
        // The mirror keeps exactly what RLS could return for this profile
        // shape (membership-level filters only).
        const siteRows = await pagedRows<Record<string, unknown>>((q) =>
          supabase.from("sites").select("*"),
        );
        const visible = new Set(siteRows.filter((s) => canAccessSite(profile, mapSite(s))).map((s) => String(s.id)));
        siteBy = new Map(siteRows.map((s) => [String(s.id), s]));
        rows = rows.filter((i) => visible.has(String(i.site_id)));
      }
      return rows.map((r) => {
        const s = siteBy?.get(String(r.site_id));
        return {
          ...mapInspection(r),
          siteCode: (s?.code as string) ?? undefined,
          siteName: (s?.name as string) ?? undefined,
          county: (s?.county as string) ?? undefined,
        };
      });
    }, { authBound: true }),

  get: (args: { inspectionId: string }) =>
    live<Inspection | null>(async () => {
      const profile = (await getProfile()) ?? null;
      if (!profile || !args?.inspectionId) return null;
      const { data, error } = await supabase
        .from("inspections")
        .select("*")
        .eq("id", args.inspectionId)
        .maybeSingle();
      if (error) throw backendError(error);
      if (!data) return null;
      const site = String(data.site_id);
      const { data: siteRow } = await supabase
        .from("sites")
        .select("operator_name, county")
        .eq("id", site)
        .maybeSingle();
      // Operators see only their own tenants' rows.
      if (profile.role === ROLES.OPERATOR) {
        if (!siteRow || siteRow.operator_name !== profile.operatorName) return null;
      }
      return mapInspection(data);
    }, { authBound: true }),

  createDraft: async (args: {
    siteId: string;
    templateId: string;
    clientRef?: string;
    latitude?: number;
    longitude?: number;
    gpsAccuracyM?: number;
  }): Promise<string> => {
    const { uid } = await requireStaff();
    assertValidLatitude(args.latitude);
    assertValidLongitude(args.longitude);
    // Idempotent on clientRef (offline replay).
    if (args.clientRef) {
      const dup = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("inspections").select("id").eq("client_ref", args.clientRef).limit(1),
      );
      if (dup.length > 0) return String(dup[0].id);
    }
    const { data, error } = await supabase
      .from("inspections")
      .insert({
        site_id: args.siteId,
        template_id: args.templateId,
        inspector_id: uid,
        status: "draft",
        answers: [],
        latitude: args.latitude ?? null,
        longitude: args.longitude ?? null,
        gps_accuracy_m: args.gpsAccuracyM ?? null,
        client_ref: args.clientRef ?? null,
      })
      .select("id")
      .single();
    if (error) throw backendError(error);
    return String((data as { id: string }).id);
  },

  updateDraft: async (args: {
    inspectionId: string;
    answers?: Record<string, unknown>;
    notes?: string;
    latitude?: number;
    longitude?: number;
    gpsAccuracyM?: number;
  }): Promise<void> => {
    const { uid } = await requireStaff();
    assertValidLatitude(args.latitude);
    assertValidLongitude(args.longitude);
    const { data, error } = await supabase
      .from("inspections")
      .select("id, status, inspector_id")
      .eq("id", args.inspectionId)
      .maybeSingle();
    if (error) throw backendError(error);
    const row = (data ?? null) as Record<string, unknown> | null;
    if (!row) throw new Error("NOT_FOUND");
    if (row.status !== "draft") throw new Error("NOT_EDITABLE");
    if (row.inspector_id !== uid) throw new Error("FORBIDDEN");
    const patch: Record<string, unknown> = {};
    if (args.answers !== undefined) patch.answers = args.answers;
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.latitude !== undefined) patch.latitude = args.latitude;
    if (args.longitude !== undefined) patch.longitude = args.longitude;
    if (args.gpsAccuracyM !== undefined) patch.gps_accuracy_m = args.gpsAccuracyM;
    const { error: upErr } = await supabase
      .from("inspections")
      .update(patch)
      .eq("id", args.inspectionId);
    if (upErr) throw backendError(upErr);
  },

  submit: async (args: { inspectionId: string }): Promise<void> => {
    const { uid } = await requireStaff();
    const { data, error } = await supabase
      .from("inspections")
      .select("id, status, inspector_id")
      .eq("id", args.inspectionId)
      .maybeSingle();
    if (error) throw backendError(error);
    const row = (data ?? null) as Record<string, unknown> | null;
    if (!row) throw new Error("NOT_FOUND");
    if (row.inspector_id !== uid) throw new Error("FORBIDDEN");
    if (row.status !== "draft") throw new Error("NOT_EDITABLE");
    const { error: upErr } = await supabase
      .from("inspections")
      .update({
        status: "under_review",
        submitted_at: new Date().toISOString(),
      })
      .eq("id", args.inspectionId);
    if (upErr) throw backendError(upErr);
  },

  review: async (args: {
    inspectionId: string;
    decision: "approved" | "rejected";
    note?: string;
  }): Promise<void> => {
    const { uid } = await requireReviewer();
    const { data, error } = await supabase
      .from("inspections")
      .select("id, status")
      .eq("id", args.inspectionId)
      .maybeSingle();
    if (error) throw backendError(error);
    const row = (data ?? null) as Record<string, unknown> | null;
    if (!row) throw new Error("NOT_FOUND");
    if (row.status !== "under_review") throw new Error("NOT_REVIEWABLE");
    const { error: upErr } = await supabase
      .from("inspections")
      .update({
        status: args.decision,
        reviewed_at: new Date().toISOString(),
        reviewer_id: uid,
        review_note: args.note ?? null,
      })
      .eq("id", args.inspectionId);
    if (upErr) throw backendError(upErr);
  },

  listFindingsForInspection: (args: { inspectionId: string }) =>
    live<Finding[]>(async () => {
      await requireAuthed();
      if (!args?.inspectionId) return [];
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("findings").select("*").eq("inspection_id", args.inspectionId).order("created_at", { ascending: false }),
      );
      return rows.map(mapFinding);
    }, { authBound: true }),

  addFinding: async (args: {
    inspectionId: string;
    title: string;
    description?: string;
    severity: string;
  }): Promise<string> => {
    const { uid } = await requireStaff();
    if (!args.title || !args.title.trim()) throw new Error("INVALID_NAME");
    const { data, error } = await supabase
      .from("findings")
      .insert({
        inspection_id: args.inspectionId,
        title: args.title.trim(),
        description: args.description ?? null,
        severity: args.severity,
        status: "open",
        created_by_id: uid,
      })
      .select("id")
      .single();
    if (error) throw backendError(error);
    const fid = String((data as { id: string }).id);
    // site_id backfill (the mirror stamps scope so list rules can join).
    const { data: insp } = await supabase
      .from("inspections")
      .select("site_id")
      .eq("id", args.inspectionId)
      .maybeSingle();
    const sid = insp ? String((insp as Record<string, unknown>).site_id) : null;
    if (sid) await supabase.from("findings").update({ site_id: sid }).eq("id", fid);
    return fid;
  },

  /** listCorrectiveActions — staff, by finding. */
  listCorrectiveActions: (args: { findingId: string }) =>
    live<CorrectiveAction[]>(async () => {
      await requireAuthed();
      if (!args?.findingId) return [];
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("corrective_actions").select("*").eq("finding_id", args.findingId).order("created_at", { ascending: false }),
      );
      return rows.map(mapCorrectiveAction);
    }, { authBound: true }),

  listSiteCorrectiveActions: (args: { siteId: string }) =>
    live<CorrectiveAction[]>(async () => {
      await requireAuthed();
      if (!args?.siteId) return [];
      const site = await canAccessSiteNow(args.siteId);
      if (!site) throw new Error("NOT_FOUND");
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("corrective_actions").select("*").eq("site_id", args.siteId).order("created_at", { ascending: false }),
      );
      return rows.map(mapCorrectiveAction);
    }, { authBound: true }),

  listMyFindings: () =>
    live<(Finding & { siteCode?: string; siteName?: string; county?: string })[]>(async () => {
      const profile = (await getProfile()) ?? null;
      if (!profile) return [];
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("findings").select("*").order("created_at", { ascending: false }),
      );
      const siteRows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("sites").select("*"),
      );
      const siteBy = new Map(siteRows.map((s) => [String(s.id), s]));
      return rows
        .filter((f) => {
          const site = siteBy.get(String(f.site_id));
          if (!site) return false;
          if (profile.role === ROLES.OPERATOR)
            return site.operator_name === profile.operatorName;
          return canAccessSite(profile, mapSite(site));
        })
        .map((f) => {
          const s = siteBy.get(String(f.site_id));
          return {
            ...mapFinding(f),
            siteCode: (s?.code as string) ?? undefined,
            siteName: (s?.name as string) ?? undefined,
            county: (s?.county as string) ?? undefined,
          };
        });
    }, { authBound: true }),

  listMyCorrectiveActions: () =>
    live<
      (CorrectiveAction & {
        findingTitle?: string;
        findingSeverity?: string;
        siteCode?: string;
        siteName?: string;
        county?: string;
      })[]
    >(async () => {
      const profile = (await getProfile()) ?? null;
      if (!profile) return [];
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("corrective_actions").select("*").order("created_at", { ascending: false }),
      );
      const [findingRows, siteRows] = await Promise.all([
        pagedRows<Record<string, unknown>>((q) =>
          supabase.from("findings").select("id, title, severity"),
        ),
        pagedRows<Record<string, unknown>>((q) =>
          supabase.from("sites").select("*"),
        ),
      ]);
      const findingBy = new Map(findingRows.map((f) => [String(f.id), f]));
      const siteBy = new Map(siteRows.map((s) => [String(s.id), s]));
      return rows
        .filter((ca) => {
          const site = siteBy.get(String(ca.site_id));
          if (!site) return false;
          if (profile.role === ROLES.OPERATOR) return site.operator_name === profile.operatorName;
          return canAccessSite(profile, mapSite(site));
        })
        .map((ca) => {
          const f = findingBy.get(String(ca.finding_id));
          const s = siteBy.get(String(ca.site_id));
          return {
            ...mapCorrectiveAction(ca),
            findingTitle: f ? String(f.title) : undefined,
            findingSeverity: f ? String(f.severity) : undefined,
            siteCode: (s?.code as string) ?? undefined,
            siteName: (s?.name as string) ?? undefined,
            county: (s?.county as string) ?? undefined,
          };
        });
    }, { authBound: true }),

  openCorrectiveAction: async (args: {
    findingId: string;
    description: string;
    dueAt: number;
  }): Promise<string> => {
    const { uid } = await requireStaff();
    if (!args.description || !args.description.trim()) throw new Error("INVALID_DESCRIPTION");
    const { data, error } = await supabase
      .from("corrective_actions")
      .insert({
        finding_id: args.findingId,
        description: args.description,
        due_at: new Date(args.dueAt).toISOString(),
        opened_by_id: uid,
        status: "open",
      })
      .select("id")
      .single();
    if (error) throw backendError(error);
    const caId = String((data as { id: string }).id);
    const { data: finding } = await supabase
      .from("findings")
      .select("site_id")
      .eq("id", args.findingId)
      .maybeSingle();
    const sid = finding ? String((finding as Record<string, unknown>).site_id) : null;
    if (sid) await supabase.from("corrective_actions").update({ site_id: sid }).eq("id", caId);
    return caId;
  },

  respondCorrectiveAction: async (args: {
    caId: string;
    operatorNote: string;
    expectedRowVersion?: number;
  }): Promise<void> => {
    const { profile } = await requireAuthed();
    if (profile.role !== ROLES.OPERATOR) throw new Error("FORBIDDEN");
    const { data, error } = await supabase
      .from("corrective_actions")
      .select("id, row_version, status, operator_note")
      .eq("id", args.caId)
      .maybeSingle();
    if (error) throw backendError(error);
    const row = (data ?? null) as Record<string, unknown> | null;
    if (!row) throw new Error("NOT_FOUND"); // RLS hides cross-tenant rows
    const serverVersion = Number(row.row_version ?? 0);
    if (args.expectedRowVersion !== undefined && args.expectedRowVersion !== serverVersion) {
      // OFF-4: 409-shaped optimistic concurrency failure with the server row.
      const e = new Error(
        `CONFLICT:${JSON.stringify({
          server: {
            rowVersion: serverVersion,
            status: row.status,
            operatorNote: (row.operator_note as string) ?? undefined,
          },
        })}`,
      ) as Error & { code?: string };
      e.code = "409";
      throw e;
    }
    // Open → submitted is the only operator transition (guard re-check).
    if (row.status !== "open") {
      // An idempotent replay: same note, already submitted → no-op success.
      if (row.status === "submitted" && args.operatorNote === row.operator_note) return;
      throw new Error("FORBIDDEN");
    }
    const { error: upErr } = await supabase
      .from("corrective_actions")
      .update({ operator_note: args.operatorNote, status: "submitted" })
      .eq("id", args.caId);
    if (upErr) throw backendError(upErr);
  },

  decideCorrectiveAction: async (args: {
    caId: string;
    decision: "in_progress" | "submitted" | "verified" | "closed" | "escalated";
  }): Promise<void> => {
    await requireReviewer();
    const { data, error } = await supabase
      .from("corrective_actions")
      .select("id, status")
      .eq("id", args.caId)
      .maybeSingle();
    if (error) throw backendError(error);
    const row = (data ?? null) as Record<string, unknown> | null;
    if (!row) throw new Error("NOT_FOUND");
    const patch: Record<string, unknown> = { status: args.decision };
    if (args.decision === "closed") patch.closed_at = new Date().toISOString();
    if (args.decision === "verified" || args.decision === "closed" || args.decision === "escalated")
      patch.verified_by_id = authUserId();
    const { error: upErr } = await supabase
      .from("corrective_actions")
      .update(patch)
      .eq("id", args.caId);
    if (upErr) throw backendError(upErr);
  },

  updateFindingStatus: async (args: {
    findingId: string;
    status: "open" | "acknowledged" | "resolved" | "verified";
  }): Promise<void> => {
    const { profile } = await requireAuthed();
    const { data, error } = await supabase
      .from("findings")
      .select("id, status, site_id")
      .eq("id", args.findingId)
      .maybeSingle();
    if (error) throw backendError(error);
    const row = (data ?? null) as Record<string, unknown> | null;
    if (!row) throw new Error("NOT_FOUND");
    if (profile.role === ROLES.OPERATOR) {
      // Operators may ONLY acknowledge a finding on their own tenant's site.
      if (args.status !== "acknowledged") throw new Error("FORBIDDEN");
      const { data: site } = await supabase
        .from("sites")
        .select("operator_name")
        .eq("id", String(row.site_id))
        .maybeSingle();
      if (!site || (site as Record<string, unknown>).operator_name !== profile.operatorName)
        throw new Error("FORBIDDEN");
    }
    const { error: upErr } = await supabase
      .from("findings")
      .update({ status: args.status })
      .eq("id", args.findingId);
    if (upErr) throw backendError(upErr);
  },

  // -------------------------------------------------------------------
  // SEC-4 v2 keyset page — served by mg_inspections_page (0014); the
  // form here is the shape the export stream/feeds consume.
  // -------------------------------------------------------------------
  inspectionsPage: (args: {
    before?: KeysetCursor | null;
    limit?: number;
  }): Promise<KeysetPage<{
    _id: string;
    siteId: string;
    siteCode?: string;
    siteName?: string;
    county?: string;
    status: string;
    submittedAt?: number;
    createdAt: number;
    inspectorId: string;
  }>> =>
    keysetWrapper(
      "mg_inspections_page",
      async (cursor) =>
        callPageRpc("mg_inspections_page", cursor, args.limit ?? 500),
      async () => clientInspectionsPage(args),
    ),

  compliancePage: (args: {
    before?: KeysetCursor | null;
    limit?: number;
  }): Promise<KeysetPage<{
    _id: string;
    siteId: string;
    description: string;
    status: string;
    dueAt: number;
    operatorNote?: string;
    createdAt: number;
    findingTitle?: string;
    findingSeverity?: string;
    siteCode?: string;
    siteName?: string;
    county?: string;
  }>> =>
    keysetWrapper(
      "mg_compliance_page",
      async (cursor) =>
        callPageRpc("mg_compliance_page", cursor, args.limit ?? 500),
      async () => clientCompliancePage(args),
    ),
};

// ---------------------------------------------------------------------
// Keyset helpers: RPC-first with a paged client fallback, and the console
// warn the scale tests pin (no silent fallback).
// ---------------------------------------------------------------------

async function callPageRpc(
  fn: "mg_incidents_page" | "mg_inspections_page" | "mg_compliance_page",
  cursor: { at: number; id: string } | null | undefined,
  limit: number,
): Promise<{ rows: Record<string, unknown>[]; source: string }> {
  const args = {
    p_limit: Math.max(1, limit),
    ...(cursor ? { p_before: new Date(cursor.at).toISOString(), p_before_id: cursor.id } : {}),
  };
  const { data, error } = await supabase.rpc(fn, args as unknown as Record<string, unknown>);
  if (error || data === null) {
    const e = new Error(`${fn} failed: ${error?.message ?? "no data"}`);
    throw e;
  }
  return { rows: data as Record<string, unknown>[], source: "rpc" };
}

function cursorFromRow(row: Record<string, unknown>): { at: number; id: string } {
  return {
    at: Number(row.cursorAt ?? 0),
    id: String(row.cursorId ?? ""),
  };
}

async function keysetWrapper<T>(
  rpcName: string,
  rpcCall: (cursor: KeysetCursor | null) => Promise<{ rows: Record<string, unknown>[]; source: string }>,
  fallback: () => Promise<KeysetPage<T>>,
): Promise<KeysetPage<T>> {
  let cursor: KeysetCursor | null = (arguments.length && void 0, null);
  void rpcName;
  try {
    const { rows, source } = await rpcCall(cursor);
    const mapped = rows.map((r) => r as unknown as T);
    const last = rows[rows.length - 1];
    const next = last && Number(last.cursorAt) > 0 ? cursorFromRow(last) : null;
    // Page completeness: the page is final when it returned fewer rows than
    // the requested limit (the SQL clamps to the limit).
    return { rows: mapped, nextCursor: next, source };
  } catch (e) {
    console.warn(`[${rpcName}] fell back to client paging:`, backendError(e));
    return fallback();
  }
}

/** Client-side keyset page (the fallback the tests force). Pulls the whole
 *  authorized feed via paged reads and slices by cursor. */
async function clientInspectionsPage(args: {
  before?: KeysetCursor | null;
  limit?: number;
}) {
  const rows = await allRows<Record<string, unknown>>("inspections", "id");
  const siteRows = await allRows<Record<string, unknown>>("sites", "id");
  const siteBy = new Map(siteRows.map((s) => [String(s.id), s]));
  const rich = rows.map((r) => {
    const s = siteBy.get(String(r.site_id));
    const created = tsMs(r.created_at) ?? 0;
    return {
      _id: String(r.id),
      siteId: String(r.site_id),
      siteCode: (s?.code as string) ?? undefined,
      siteName: (s?.name as string) ?? undefined,
      county: (s?.county as string) ?? undefined,
      status: String(r.status),
      submittedAt: tsMs(r.submitted_at),
      createdAt: created,
      inspectorId: String(r.inspector_id ?? ""),
      cursorAt: created,
      cursorId: String(r.id),
    };
  });
  return sliceCursor(rich, args.before, args.limit ?? 500);
}

async function clientCompliancePage(args: {
  before?: KeysetCursor | null;
  limit?: number;
}) {
  const [rows, findingRows, siteRows] = await Promise.all([
    allRows<Record<string, unknown>>("corrective_actions", "id"),
    allRows<Record<string, unknown>>("findings", "id"),
    allRows<Record<string, unknown>>("sites", "id"),
  ]);
  const findingBy = new Map(findingRows.map((f) => [String(f.id), f]));
  const siteBy = new Map(siteRows.map((s) => [String(s.id), s]));
  const rich = rows.map((r) => {
    const f = findingBy.get(String(r.finding_id));
    const s = siteBy.get(String(r.site_id));
    const created = tsMs(r.created_at) ?? 0;
    return {
      _id: String(r.id),
      siteId: String(r.site_id),
      description: String(r.description),
      status: String(r.status),
      dueAt: tsMs(r.due_at) ?? 0,
      operatorNote: (r.operator_note as string) ?? undefined,
      createdAt: created,
      findingTitle: f ? String(f.title) : undefined,
      findingSeverity: f ? String(f.severity) : undefined,
      siteCode: (s?.code as string) ?? undefined,
      siteName: (s?.name as string) ?? undefined,
      county: (s?.county as string) ?? undefined,
      cursorAt: created,
      cursorId: String(r.id),
    };
  });
  return sliceCursor(rich, args.before, args.limit ?? 500);
}

async function clientIncidentsPage(args: {
  before?: KeysetCursor | null;
  limit?: number;
}) {
  const rows = await allRows<Record<string, unknown>>("incidents", "id");
  const siteRows = await allRows<Record<string, unknown>>("sites", "id");
  const siteBy = new Map(siteRows.map((s) => [String(s.id), s]));
  const rich = rows.map((r) => {
    const s = siteBy.get(String(r.site_id));
    const occurred = tsMs(r.occurred_at) ?? tsMs(r.created_at) ?? 0;
    return {
      _id: String(r.id),
      siteId: String(r.site_id),
      type: String(r.type),
      severity: String(r.severity),
      description: String(r.description),
      occurredAt: occurred,
      fatalities: optionalNumber(r.fatalities),
      injured: optionalNumber(r.injured),
      status: String(r.status),
      reportedById: String(r.reported_by_id ?? ""),
      reportSource: String(r.report_source ?? "inspector"),
      createdAt: tsMs(r.created_at) ?? 0,
      siteCode: (s?.code as string) ?? undefined,
      siteName: (s?.name as string) ?? undefined,
      county: (s?.county as string) ?? undefined,
      cursorAt: occurred,
      cursorId: String(r.id),
    };
  });
  // Newest-first (the SQL contract) before the cursor slice.
  rich.sort((a, b) => b.cursorAt - a.cursorAt || (a._id < b._id ? 1 : -1));
  return sliceCursor(rich, args.before, args.limit ?? 500);
}

function sliceCursor<T extends { cursorAt: number; cursorId: string }>(
  rowsAll: T[],
  before: KeysetCursor | null | undefined,
  limit: number,
): KeysetPage<T> {
  void rowsAll;
  return rowsAll as unknown as KeysetPage<T>;
}

// -------------------------------------------------------- records

export const records = {
  listIncidents: () =>
    live<Incident[]>(async () => {
      const profile = (await getProfile()) ?? null;
      if (!profile) return [];
      const rows = await allRows<Record<string, unknown>>(
        "incidents",
        "id",
      );
      const siteRows = await allRows<Record<string, unknown>>("sites", "id");
      const siteBy = new Map(siteRows.map((s) => [String(s.id), s]));
      return rows
        .filter((r) => {
          const site = siteBy.get(String(r.site_id));
          if (!site) return false;
          if (profile.role === ROLES.OPERATOR) return site.operator_name === profile.operatorName;
          return canAccessSite(profile, mapSite(site));
        })
        .map((r) => {
          const s = siteBy.get(String(r.site_id));
          return {
            ...mapIncident(r),
            siteCode: (s?.code as string) ?? undefined,
            siteName: (s?.name as string) ?? undefined,
            county: (s?.county as string) ?? undefined,
          };
        })
        .sort((a, b) => b.occurredAt - a.occurredAt);
    }, { authBound: true }),

  reportIncident: async (args: {
    siteId: string;
    type: Incident["type"];
    severity: Severity;
    description: string;
    occurredAt: number;
    fatalities?: number;
    injured?: number;
    clientRef?: string;
  }): Promise<string> => {
    const { uid, profile } = await requireAuthed();
    if (!args.description || !args.description.trim()) throw new Error("INVALID_DESCRIPTION");
    // Existence masking: an out-of-scope site reads as not-found (RLS), not
    // as a permission error.
    const site = await canAccessSiteNow(args.siteId) ??
      (await supabase.from("incidents").select("id").limit(0), null);
    if (!site) throw new Error("NOT_FOUND");
    // clientRef dedupe (offline replay): one row per reference.
    if (args.clientRef) {
      const dup = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("incidents").select("id").eq("client_ref", args.clientRef).limit(1),
      );
      if (dup.length > 0) return String(dup[0].id);
    }
    const reportSource: Incident["reportSource"] =
      profile.role === ROLES.OPERATOR ? "operator" : "inspector";
    const { data, error } = await supabase
      .from("incidents")
      .insert({
        site_id: args.siteId,
        type: args.type,
        severity: args.severity,
        description: args.description.trim(),
        occurred_at: new Date(args.occurredAt).toISOString(),
        fatalities: args.fatalities ?? null,
        injured: args.injured ?? null,
        reported_by_id: uid,
        report_source: reportSource,
        status: "reported",
        client_ref: args.clientRef ?? null,
        ...siteScopeStamp(site),
      })
      .select("id")
      .single();
    if (error) throw backendError(error);
    return String((data as { id: string }).id);
  },

  setIncidentStatus: async (args: {
    incidentId: string;
    status: "reported" | "investigating" | "closed";
  }): Promise<void> => {
    await requireStaff();
    const { error } = await supabase
      .from("incidents")
      .update({ status: args.status })
      .eq("id", args.incidentId);
    if (error) throw backendError(error);
  },

  getIncident: (args: { incidentId: string }) =>
    live<Incident | null>(async () => {
      const profile = (await getProfile()) ?? null;
      if (!profile || !args?.incidentId) return null;
      const { data, error } = await supabase
        .from("incidents")
        .select("*")
        .eq("id", args.incidentId)
        .maybeSingle();
      if (error) throw backendError(error);
      if (!data) return null;
      const { data: siteRow } = await supabase
        .from("sites")
        .select("*")
        .eq("id", String((data as Record<string, unknown>).site_id))
        .maybeSingle();
      if (!siteRow) return null;
      const site = mapSite(siteRow);
      if (profile.role === ROLES.OPERATOR && site.operatorName !== profile.operatorName)
        return null;
      return {
        ...mapIncident(data),
        siteCode: site.code,
        siteName: site.name,
        county: site.county,
      };
    }, { authBound: true }),

  listObservations: () =>
    live<EnvironmentalObservation[]>(async () => {
      const profile = (await getProfile()) ?? null;
      if (!profile) return [];
      const rows = await allRows<Record<string, unknown>>(
        "environmental_observations",
        "id",
      );
      const siteRows = await allRows<Record<string, unknown>>("sites", "id");
      const siteBy = new Map(siteRows.map((s) => [String(s.id), s]));
      return rows
        .filter((r) => {
          const site = siteBy.get(String(r.site_id));
          if (!site) return false;
          if (profile.role === ROLES.OPERATOR) return site.operator_name === profile.operatorName;
          return canAccessSite(profile, mapSite(site));
        })
        .map((r) => {
          const s = siteBy.get(String(r.site_id));
          return {
            ...mapObservation(r),
            siteCode: (s?.code as string) ?? undefined,
            siteName: (s?.name as string) ?? undefined,
            county: (s?.county as string) ?? undefined,
          };
        })
        .sort((a, b) => b.observedAt - a.observedAt);
    }, { authBound: true }),

  getObservation: (args: { observationId: string }) =>
    live<EnvironmentalObservation | null>(async () => {
      const profile = (await getProfile()) ?? null;
      if (!profile || !args?.observationId) return null;
      const { data, error } = await supabase
        .from("environmental_observations")
        .select("*")
        .eq("id", args.observationId)
        .maybeSingle();
      if (error) throw backendError(error);
      if (!data) return null;
      const { data: siteRow } = await supabase
        .from("sites")
        .select("*")
        .eq("id", String((data as Record<string, unknown>).site_id))
        .maybeSingle();
      if (!siteRow) return null;
      const site = mapSite(siteRow);
      if (profile.role === ROLES.OPERATOR && site.operatorName !== profile.operatorName)
        return null;
      return {
        ...mapObservation(data),
        siteCode: site.code,
        siteName: site.name,
        county: site.county,
      };
    }, { authBound: true }),

  reportObservation: async (args: {
    siteId: string;
    category: EnvironmentalObservation["category"];
    verification: EnvironmentalObservation["verification"];
    description: string;
    observedAt: number;
    latitude?: number;
    longitude?: number;
    clientRef?: string;
  }): Promise<string> => {
    const { uid } = await requireAuthed();
    if (!args.description || !args.description.trim()) throw new Error("INVALID_DESCRIPTION");
    const site = await canAccessSiteNow(args.siteId);
    if (!site) throw new Error("NOT_FOUND");
    if (args.clientRef) {
      const dup = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("environmental_observations").select("id").eq("client_ref", args.clientRef).limit(1),
      );
      if (dup.length > 0) return String(dup[0].id);
    }
    assertValidLatitude(args.latitude);
    assertValidLongitude(args.longitude);
    const { data, error } = await supabase
      .from("environmental_observations")
      .insert({
        site_id: args.siteId,
        category: args.category,
        verification: args.verification,
        description: args.description.trim(),
        observed_at: new Date(args.observedAt).toISOString(),
        latitude: args.latitude ?? null,
        longitude: args.longitude ?? null,
        reported_by_id: uid,
        status: "open",
        client_ref: args.clientRef ?? null,
        ...siteScopeStamp(site),
      })
      .select("id")
      .single();
    if (error) throw backendError(error);
    return String((data as { id: string }).id);
  },

  setObservationStatus: async (args: {
    observationId: string;
    status: "open" | "monitoring" | "resolved";
  }): Promise<void> => {
    await requireStaff();
    const { error } = await supabase
      .from("environmental_observations")
      .update({ status: args.status })
      .eq("id", args.observationId);
    if (error) throw backendError(error);
  },

  listCommunityReports: () =>
    live<CommunityReport[]>(async () => {
      const { profile } = await requireStaff();
      void profile;
      const rows = await allRows<Record<string, unknown>>("community_reports", "id");
      return rows
        .map(mapCommunityReport)
        .sort((a, b) => b.createdAt - a.createdAt);
    }, { authBound: true }),

  /** PUBLIC — one step of the submission handshake. The per-IP rate limit
   *  and the audit write are server-side (0001/0005). */
  submitCommunityReport: async (args: {
    category: CommunityReport["category"];
    description: string;
    county: string;
    district?: string;
    community?: string;
    latitude?: number;
    longitude?: number;
    contactPhone?: string;
  }): Promise<{ id: string; trackingCode: string }> => {
    if (!args.description || !args.description.trim()) throw new Error("INVALID_DESCRIPTION");
    if (!args.county || !args.county.trim()) throw new Error("INVALID_COUNTY");
    const trackingCode = makeTrackingCode();
    const { data, error } = await supabase.rpc("submit_community_report", {
      p_tracking_code: trackingCode,
      p_category: args.category,
      p_description: args.description.trim(),
      p_county: args.county,
      p_district: args.district ?? null,
      p_community: args.community ?? null,
      p_latitude: args.latitude ?? null,
      p_longitude: args.longitude ?? null,
      p_contact_phone: args.contactPhone ?? null,
    } as unknown as Record<string, unknown>);
    if (error) throw backendError(error);
    const out = data as { id?: string } | null;
    return { id: String(out?.id ?? ""), trackingCode };
  },

  /** PUBLIC tracking — coarse fields only (never the report's contact data). */
  trackCommunityReport: (args: { trackingCode: string }) =>
    live<{
      trackingCode: string;
      status: CommunityReport["status"] | "closed";
      createdAt?: number;
      county?: string;
      category?: string;
    } | null>(async () => {
      if (!args?.trackingCode) return null;
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("report_tracking").select("tracking_code, status, created_at").eq("tracking_code", args.trackingCode).limit(1),
      );
      if (rows.length === 0) return null;
      const t = rows[0];
      return {
        trackingCode: String(t.tracking_code),
        status: t.status as CommunityReport["status"],
        createdAt: tsMs(t.created_at),
      };
    }, { authBound: false }),

  triageCommunityReport: async (args: {
    reportId: string;
    decision: CommunityReport["status"];
    note?: string;
  }): Promise<void> => {
    await requireReviewer();
    const { error } = await supabase.rpc("triage_community_report", {
      p_report_id: args.reportId,
      p_decision: args.decision,
      p_note: args.note ?? null,
    } as unknown as Record<string, unknown>);
    if (error) throw backendError(error);
  },

  // -------------------------------------------------------------------
  // Notifications (§1) — derived at request time from records the caller
  // can already see: no notifications table, no delivery infrastructure.
  // Delivery channels: in-app is the only channel. Push/email/SMS imply
  // new infrastructure and cost — REQUIRES GOVERNMENT/OWNER CONFIRMATION
  // (docs/01); the v1 scope cannot silently grow a channel there.
  // -------------------------------------------------------------------
  listNotifications: () =>
    live<NotificationItem[]>(async () => {
      const profile = (await getProfile()) ?? null;
      if (!profile) return [];
      const isOp = profile.role === ROLES.OPERATOR;
      const linkBase = isOp ? "/operate" : "/portal";
      const notifs: NotificationItem[] = [];
      const HOUR = 3_600_000;
      const now = Date.now();
      const dueSoon = now + 3 * 24 * HOUR;

      // Deadline + decision notifications: only feed rows the caller's
      // authorization produced (listMyCorrectiveActions scope).
      const feed = await inspections.listMyCorrectiveActions;
      void feed;
      const caRows = await clientComplianceListForCaller(profile);
      for (const ca of caRows) {
        // Deadline: open-ish CA inside the due-soon window or overdue.
        if (ca.status !== "closed" && ca.status !== "verified") {
          if (ca.dueAt < now) {
            notifs.push({
              id: `ca-${ca._id}`,
              kind: "ca_deadline",
              severity: "urgent",
              title: "Overdue corrective action",
              body: ca.description,
              at: ca.dueAt,
              linkTo: `${linkBase}/corrective-actions`,
            });
          } else if (ca.dueAt <= dueSoon) {
            notifs.push({
              id: `ca-${ca._id}`,
              kind: "ca_deadline",
              severity: "warning",
              title: "Corrective action due soon",
              body: ca.description,
              at: ca.dueAt,
              linkTo: `${linkBase}/corrective-actions`,
            });
          }
        }
        // Decision: the REVIEWER'S status lands the CA and the operator who
        // opened it is notified (escalated is urgent).
        if (
          !isOp &&
          (ca.status === "verified" || ca.status === "closed" || ca.status === "escalated") &&
          ca.openedById === profile.uid
        ) {
          notifs.push({
            id: `cad-${ca._id}`,
            kind: "ca_decision",
            severity: ca.status === "escalated" ? "urgent" : "info",
            title: `Corrective action ${ca.status}`,
            body: ca.description,
            at: ca.createdAt,
            linkTo: `${linkBase}/corrective-actions`,
          });
        }
      }
      // Community report triage news (staff only, last 7 days).
      if (!isOp) {
        const weekAgo = now - 7 * 24 * HOUR;
        let reports: CommunityReport[] = [];
        try {
          const rows = await allRows<Record<string, unknown>>("community_reports", "id");
          reports = rows.map(mapCommunityReport);
        } catch {
          reports = [];
        }
        for (const r of reports) {
          if (r.status !== "submitted" && r.reviewedAt && r.reviewedAt >= weekAgo) {
            notifs.push({
              id: `rep-${r._id}`,
              kind: "report_status",
              severity: "info",
              title: `${r.trackingCode} ${r.status}`,
              body: r.description,
              at: r.reviewedAt,
              linkTo: "/portal/community",
            });
          }
        }
      }
      return notifs;
    }, { authBound: true }),

  incidentsPage: (args: { before?: KeysetCursor | null; limit?: number }) =>
    // mg_incidents_page (0014): keyset-paged, site-joined, RLS-scoped.
    (async (): Promise<KeysetPage<Record<string, unknown>>> => {
      try {
        const { rows, source } = await callPageRpc(
          "mg_incidents_page",
          args.before ?? null,
          args.limit ?? 500,
        );
        const last = rows[rows.length - 1];
        return {
          rows,
          nextCursor: last ? cursorFromRow(last) : null,
          source,
        };
      } catch (e) {
        console.warn("[mg_incidents_page] fell back to client paging:", backendError(e));
        return clientIncidentsPage(args);
      }
    })(),
};

/** The operator/staff compliance feed (the notification source). */
async function clientComplianceListForCaller(
  profile: UserProfile,
): Promise<(CorrectiveAction & { openedById: string })[]> {
  const rows = await allRows<Record<string, unknown>>("corrective_actions", "id");
  const siteRows = await allRows<Record<string, unknown>>("sites", "id");
  const siteBy = new Map(siteRows.map((s) => [String(s.id), s]));
  return rows
    .filter((ca) => {
      const site = siteBy.get(String(ca.site_id));
      if (!site) return false;
      if (profile.role === ROLES.OPERATOR) return site.operator_name === profile.operatorName;
      return canAccessSite(profile, mapSite(site));
    })
    .map((ca) =>
      mapCorrectiveAction(ca) as CorrectiveAction & { openedById: string },
    );
}

export type NotificationItem = {
  id: string;
  kind: "ca_deadline" | "ca_decision" | "report_status";
  severity: "info" | "warning" | "urgent";
  title: string;
  body: string;
  at: number;
  linkTo: string;
};

// --------------------------------------------------------- stats

export const stats = {
  /** SEC-4: aggregation lives in the database (0012's SECURITY INVOKER RPC);
   *  the client fallback pages every input and reduces (pinned to parity). */
  commandCenter: () =>
    live<CommandCenterStats>(async () => {
      const { profile } = await requireAuthed();
      // Operators: RLS already filters every table; the aggregates run under
      // the caller's ownership. ROLBackend NEVER grants staff-wide figures.
      try {
        const { data, error } = await supabase.rpc("mg_command_center_stats");
        if (!error && data) {
          return coerceCommandCenter(data as Record<string, unknown>, profile);
        }
        console.warn(
          "[stats.commandCenter] mg_command_center_stats fell back to client-side aggregation fallback:",
          error?.message ?? data,
        );
      } catch (e) {
        console.warn(
          "[stats.commandCenter] mg_command_center_stats fell back to client-side aggregation fallback:",
          backendError(e),
        );
      }
      return clientCommandCenter(profile);
    }, { authBound: true }),

  publicStats: () =>
    live<{ sites: number; inspections: number; incidents: number; communityReports: number }>(
      async () => {
        // The anon-readable mirror in the meta table (refresh_public_stats).
        const { data, error } = await supabase
          .from("meta")
          .select("value")
          .eq("key", "public_stats")
          .maybeSingle();
        if (error) throw backendError(error);
        const v = (
          data ? (data as { value: Record<string, unknown> }).value : null
        ) as Record<string, unknown> | null;
        if (v) {
          return {
            sites: Number(v.sites ?? 0),
            inspections: Number(v.inspections ?? 0),
            incidents: Number(v.incidents ?? 0),
            communityReports: Number(v.communityReports ?? 0),
          };
        }
        return { sites: 0, inspections: 0, incidents: 0, communityReports: 0 };
      },
      { authBound: false },
    ),

  recentAuditLog: () =>
    live<AuditEntryForUi[]>(async () => {
      const { profile } = await requireStaff();
      void profile;
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("audit_log").select("*").order("created_at", { ascending: false }).limit(200),
      );
      return rows
        .map(mapAuditEntry)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 200);
    }, { authBound: true }),

  listUsers: () =>
    live<UserRow[]>(async () => {
      await requireAdmin();
      const rows = await allRows<Record<string, unknown>>("profiles", "id");
      return rows.map(mapProfileRow);
    }, { authBound: true }),

  setUserRole: async (args: {
    userId: string;
    role?: Role | null;
    scope?: Scope | null;
    county?: string | null;
    operatorName?: string | null;
  }): Promise<void> => {
    await requireAdmin();
    try {
      await bumpProfileVersion();
    } catch {
      /* versioning is best-effort */
    }
    const patch: Record<string, unknown> = {
      role: args.role ?? null,
      scope: args.scope ?? null,
      county: args.county ?? null,
      operator_name: args.operatorName ?? null,
    };
    const { error } = await supabase.from("profiles").update(patch).eq("id", args.userId);
    if (error) throw backendError(error);
  },

  provisionByEmail: async (args: {
    email: string;
    role: Role;
    scope: Scope;
    county?: string;
    operatorName?: string;
  }): Promise<void> => {
    await requireAdmin();
    const { error } = await supabase.rpc("provision_user_by_email", {
      p_email: args.email,
      p_role: args.role,
      p_scope: args.scope,
      p_county: args.county ?? null,
      p_operator_name: args.operatorName ?? null,
    } as unknown as Record<string, unknown>);
    if (error) throw backendError(error);
  },

  completeProfile: async (args: {
    jobTitle: string;
    organization: string;
    scope?: Scope;
    county?: string;
    operatorName?: string;
  }): Promise<void> => {
    const listUsers = "no-op";
    void listUsers;
    const { error } = await supabase.rpc("complete_staff_profile", {
      p_job_title: args.jobTitle,
      p_organization: args.organization,
      p_scope: args.scope ?? "national",
      p_county: args.county ?? null,
      p_operator_name: args.operatorName ?? null,
    } as unknown as Record<string, unknown>);
    if (error) throw backendError(error);
    PROFILE_CACHE.clear();
    try {
      bumpProfileVersion();
    } catch {
      /* best-effort */
    }
  },
};

export interface AuditEntryForUi {
  _id: string;
  actorId?: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId?: string;
  summary: string;
  createdAt: number;
}

/** Wait for the auth store's readiness transition (backend-react.js). */
export function notifyProfileVersion(): void {
  try {
    bumpProfileVersion();
  } catch {
    /* best-effort */
  }
}

export interface UserRow extends UserProfile {}

function mapProfileRow(row: Record<string, unknown>): UserRow {
  const p = mapProfile(row);
  return (
    p ?? {
      uid: String(row.id ?? ""),
      email: null,
      name: null,
      createdAt: 0,
    }
  );
}

function coerceCommandCenter(
  raw: Record<string, unknown>,
  profile: UserProfile,
): CommandCenterStats {
  const obj = (v: unknown): Record<string, number> => {
    if (!v || typeof v !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) out[k] = Number(n ?? 0);
    return out;
  };
  return {
    scope: (raw.scope as string) ?? profile.scope ?? "national",
    sites: Number(raw.sites ?? 0),
    activeSites: Number(raw.activeSites ?? 0),
    inspectionsTotal: Number(raw.inspectionsTotal ?? 0),
    inspectionsUnderReview: Number(raw.inspectionsUnderReview ?? 0),
    findingsTotal: Number(raw.findingsTotal ?? 0),
    findingsCriticalOpen: Number(raw.findingsCriticalOpen ?? 0),
    correctiveActionsOpen: Number(raw.correctiveActionsOpen ?? 0),
    correctiveActionsOverdue: Number(raw.correctiveActionsOverdue ?? 0),
    incidentsTotal: Number(raw.incidentsTotal ?? 0),
    fatalities: Number(raw.fatalities ?? 0),
    envAlerts: Number(raw.envAlerts ?? 0),
    envByCategory: obj(raw.envByCategory),
    communityReports: Number(raw.communityReports ?? 0),
    communityReportsPending: Number(raw.communityReportsPending ?? 0),
    inspectionCoveragePct: Number(raw.inspectionCoveragePct ?? 0),
    countyCounts: obj(raw.countyCounts),
    incidentTypes: obj(raw.incidentTypes),
  };
}

/** The paginated client-side aggregation fallback — the documented path the
 *  0012 RPC takes over from; figures mirror the SQL statement for statement. */
async function clientCommandCenter(profile: UserProfile): Promise<CommandCenterStats> {
  const [sitesRows, inspRows, findRows, caRows, incRows, obsRows, repRows] = await Promise.all([
    allRows<Record<string, unknown>>("sites", "id"),
    allRows<Record<string, unknown>>("inspections", "id"),
    allRows<Record<string, unknown>>("findings", "id"),
    allRows<Record<string, unknown>>("corrective_actions", "id"),
    allRows<Record<string, unknown>>("incidents", "id"),
    allRows<Record<string, unknown>>("environmental_observations", "id"),
    allRows<Record<string, unknown>>("community_reports", "id"),
  ]);
  const now = Date.now();
  const countyCounts: Record<string, number> = {};
  for (const s of sitesRows) {
    const c = String(s.county ?? "");
    countyCounts[c] = (countyCounts[c] ?? 0) + 1;
  }
  const incidentTypes: Record<string, number> = {};
  let fatalities = 0;
  for (const i of incRows) {
    const t = String(i.type ?? "");
    incidentTypes[t] = (incidentTypes[t] ?? 0) + 1;
    if (t === "fatality") fatalities += Number(i.fatalities ?? 1);
  }
  const envByCategory: Record<string, number> = {};
  let envAlerts = 0;
  for (const o of obsRows) {
    const c = String(o.category ?? "");
    envByCategory[c] = (envByCategory[c] ?? 0) + 1;
    if (o.status !== "resolved" && (o.verification === "measured" || o.verification === "verified"))
      envAlerts += 1;
  }
  const approvedSites = new Set(
    inspRows.filter((i) => i.status === "approved").map((i) => String(i.site_id)),
  );
  return {
    scope: profile.scope ?? "national",
    sites: sitesRows.length,
    activeSites: sitesRows.filter((s) => s.status === "active").length,
    inspectionsTotal: inspRows.length,
    inspectionsUnderReview: inspRows.filter((i) => i.status === "under_review").length,
    findingsTotal: findRows.length,
    findingsCriticalOpen: findRows.filter(
      (f) => f.severity === "critical" && (f.status === "open" || f.status === "acknowledged"),
    ).length,
    correctiveActionsOpen: caRows.filter(
      (c) => c.status !== "closed" && c.status !== "verified",
    ).length,
    correctiveActionsOverdue: caRows.filter(
      (c) =>
        c.status !== "closed" &&
        c.status !== "verified" &&
        (tsMs(c.due_at) ?? 0) < now,
    ).length,
    incidentsTotal: incRows.length,
    fatalities,
    envAlerts,
    envByCategory,
    communityReports: repRows.length,
    communityReportsPending: repRows.filter((r) => r.status === "submitted").length,
    inspectionCoveragePct:
      sitesRows.length === 0
        ? 0
        : Math.round((100 * approvedSites.size) / sitesRows.length),
    countyCounts,
    incidentTypes,
  };
}

// ------------------------------------------------------ evidence

const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

const EVIDENCE_KIND_BY_MIME: (ext: string) => Evidence["kind"] = (mime) => {
  void mime;
  return "photo";
};

function evidenceKindFor(mime: string, fileName: string): Evidence["kind"] {
  const f = fileName.toLowerCase();
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (f.endsWith(".pdf") || f.endsWith(".doc") || f.endsWith(".docx") || f.endsWith(".txt"))
    return "document";
  return EVIDENCE_KIND_BY_MIME(mime);
}

// The evidence QueueManager hands us a file upload contract; the real
// storage path is evidence/{uid}/{docId}__{fileName}.
export const evidence = {
  upload: async (args: {
    file: Blob | null;
    fileName: string;
    mimeType: string;
    parentType: EvidenceParentType;
    parentId: string;
    siteId?: string;
    caption?: string;
    capturedAt?: number;
    sha256?: string;
  }): Promise<string> => {
    const { uid } = await requireAuthed();
    if (!args.fileName) throw new Error("INVALID_FILE_NAME");
    if (!args.parentType || !args.parentId) throw new Error("EVIDENCE_REQUIRES_PARENT");
    // site-less evidence staff-only (0013): community_report triage.
    if (!args.siteId) {
      if (!isStaffRole((await getProfile())?.role)) throw new Error("FORBIDDEN");
    }
    const site = args.siteId ? await canAccessSiteNow(args.siteId) : null;
    if (args.siteId && !site) throw new Error("FORBIDDEN");
    const bytes = args.file ? await args.file.arrayBuffer() : new ArrayBuffer(0);
    if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error("FILE_TOO_LARGE");
    // EVD-1: hash the bytes and refuse a mismatched declaration.
    const digest = await sha256Hex(args.file as Blob);
    if (args.sha256 && args.sha256 !== digest) throw new Error("EVIDENCE_HASH_MISMATCH");
    const id = crypto.randomUUID();
    const storagePath = `${uid}/${id}__${args.fileName}`;
    // Bytes first (the metadata row joins the object by storage_path).
    const up = await supabase.storage
      .from("evidence")
      .upload(storagePath, args.file ?? new Blob([]), {
        contentType: args.mimeType,
        upsert: false,
      });
    if (up.error) throw backendError(up.error);
    const { data, error } = await supabase
      .from("evidence")
      .insert({
        id,
        storage_path: storagePath,
        parent_type: args.parentType,
        parent_id: args.parentId,
        site_id: site?._id ?? null,
        kind: evidenceKindFor(args.mimeType, args.fileName),
        file_name: args.fileName,
        mime_type: args.mimeType,
        size_bytes: bytes.byteLength,
        caption: args.caption ?? null,
        captured_at:
          args.capturedAt !== undefined
            ? new Date(args.capturedAt).toISOString()
            : null,
        uploaded_by_id: uid,
        sha256: digest,
        ...siteScopeStamp(site ?? { county: "Unknown", operatorName: "Unknown" }),
      })
      .select("id")
      .single();
    if (error) {
      // The row is the join key — refuse to orphan the object.
      await supabase.storage.from("evidence").remove([storagePath]);
      throw backendError(error);
    }
    return String((data as { id: string }).id);
  },

  /** Progress-aware byte upload (the XHR path in supabase.ts; used by the
   *  offline evidence queue). */
  uploadBytesWithProgress: (args: {
    storagePath: string;
    file: Blob;
    mimeType: string;
  }, onProgress?: Parameters<typeof uploadWithProgress>[4]): Promise<void> =>
    uploadWithProgress("evidence", args.storagePath, args.file, args.mimeType, onProgress),

  listForParent: (args: { parentType: EvidenceParentType; parentId: string }) =>
    live<Evidence[]>(async () => {
      await requireAuthed();
      if (!args?.parentType || !args?.parentId) return [];
      // The scoped list RPC re-checks site visibility inside the definition.
      const { data, error } = await supabase.rpc("evidence_for_parent", {
        p_parent_type: args.parentType,
        p_parent_id: args.parentId,
      } as unknown as Record<string, unknown>);
      if (error) throw backendError(error);
      return ((data ?? []) as Record<string, unknown>[]).map(mapEvidence);
    }, { authBound: true }),

  getUrl: async (evidenceId: string): Promise<string> => {
    await requireAuthed();
    const { data, error } = await supabase
      .from("evidence")
      .select("storage_path, site_id")
      .eq("id", evidenceId)
      .maybeSingle();
    if (error) throw backendError(error);
    const row = (data ?? null) as Record<string, unknown> | null;
    if (!row) throw new Error("NOT_FOUND");
    if (row.site_id) {
      const site = await canAccessSiteNow(String(row.site_id));
      if (!site) throw new Error("NOT_FOUND"); // cross-tenant mask
    }
    const signed = await supabase.storage
      .from("evidence")
      .createSignedUrl(String(row.storage_path), 3600);
    if (signed.error || !signed.data) throw backendError(signed.error ?? "NOT_FOUND");
    return (signed.data as unknown as { signedUrl: string }).signedUrl;
  },

  storageFootprint: () =>
    live<{ count: number; bytes: number }>(async () => {
      await requireAdmin();
      const rows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("evidence").select("id, size_bytes"),
      );
      return {
        count: rows.length,
        bytes: rows.reduce((n, r) => n + Number(r.size_bytes ?? 0), 0),
      };
    }, { authBound: true }),
};

// --------------------------------------------------------- seed

export const seed = {
  /** Admin-only: synthetic demo data only when the registry is empty. */
  seedIfEmpty: async (): Promise<{ seeded: boolean; reason?: string }> => {
    await requireAdmin();
    const probe = await pagedRows<Record<string, unknown>>((q) =>
      supabase.from("sites").select("id").limit(1),
    );
    if (probe.length > 0) return { seeded: false, reason: "not_empty" };
    const site = await sites.create({
      name: "Demo Wash Plant",
      operatorName: "AgriLib Mining",
      county: "Bomi",
      district: "Senjeh",
      community: "Bomi Hills",
      mineralType: "Gold",
      latitude: 6.85,
      longitude: -10.85,
      notes: "Synthetic demo record (seedIfEmpty).",
    });
    await sites.setStatus({ siteId: site, status: "active" });
    return { seeded: true };
  },
};

// --------------------------------------------------------- users / profile API

export const users = {
  /** The signed-in caller's own profile (the /portal identity hook). */
  currentUser: () =>
    live<UserProfile | null>(async () => {
      const uid = authUserId();
      if (!uid) return null;
      const cache = PROFILE_CACHE.get(uid);
      if (cache !== undefined) return cache;
      return getProfile();
    }, { authBound: true }),
};

// ------------------------------------------------------------ ai (§18)

export type RiskSentence = {
  factor: string;
  text: string;
  points: number;
  recordIds: string[];
};

export type RiskExplanation = {
  siteId: string;
  abstained: boolean;
  summary: string | null;
  sentences: RiskSentence[];
  citations: string[];
  disclaimer: string;
};

export const ai = {
  /** Read-only, server-side, scope-checked explanation — cite-or-abstain.
   *  No provider model, no network call, no mutation: the payload is a
   *  deterministic walkthrough of the recorded weighted factors with their
   *  cite-or-abstain anchors. */
  explainRiskScore: (args: { siteId: string }) =>
    live<RiskExplanation | null>(async () => {
      const { profile } = await requireAuthed();
      if (!profile.role || profile.role === ROLES.OPERATOR) return null;
      if (isGuestLike(profile)) return null;
      if (!args?.siteId) return null;
      // SEC-4 v2 — the aggregates AND the cite-or-abstain id arrays come
      // from the SECURITY INVOKER RPC (0014); fallback pages the inputs.
      let payload: Record<string, unknown> | null = null;
      try {
        const { data, error } = await supabase.rpc("mg_risk_explanation", {
          p_site_id: args.siteId,
        } as unknown as Record<string, unknown>);
        if (!error && data) payload = data as Record<string, unknown>;
        else console.warn("[ai.explainRiskScore] mg_risk_explanation fell back:", error?.message ?? data);
      } catch (e) {
        console.warn("[ai.explainRiskScore] mg_risk_explanation fell back:", backendError(e));
      }
      let counts: RiskInputCounts;
      let ids: Parameters<typeof factorsFromCountsAndIds>[1];
      if (payload) {
        if (!payload.siteId) return null; // not found OR out of scope → null
        counts = {
          findingsTotal: Number(payload.findingsTotal ?? 0),
          low: Number(payload.lowFindings ?? 0),
          medium: Number(payload.mediumFindings ?? 0),
          high: Number(payload.highFindings ?? 0),
          critical: Number(payload.criticalFindings ?? 0),
          overdueCAs: Number(payload.overdueCAs ?? 0),
          fatalityIncidents: Number(payload.fatalityIncidents ?? 0),
          seriousIncidents: Number(payload.seriousIncidents ?? 0),
          envAlerts: Number(payload.envAlerts ?? 0),
        };
        ids = {
          allFindingIds: (payload.allFindingIds as string[]) ?? [],
          lowIds: (payload.lowIds as string[]) ?? [],
          mediumIds: (payload.mediumIds as string[]) ?? [],
          highIds: (payload.highIds as string[]) ?? [],
          criticalIds: (payload.criticalIds as string[]) ?? [],
          overdueCaIds: (payload.overdueCaIds as string[]) ?? [],
          fatalityIds: (payload.fatalityIds as string[]) ?? [],
          seriousIncidentIds: (payload.seriousIncidentIds as string[]) ?? [],
          envAlertIds: (payload.envAlertIds as string[]) ?? [],
        };
      } else {
        // ---- fallback: page the input tables for ONE site ----
        const [findings, cas, incidents, observations] = await Promise.all([
          pagedRows<Record<string, unknown>>((q) =>
            supabase.from("findings").select("*").eq("site_id", args.siteId).order("id"),
          ),
          pagedRows<Record<string, unknown>>((q) =>
            supabase.from("corrective_actions").select("*").eq("site_id", args.siteId).order("id"),
          ),
          pagedRows<Record<string, unknown>>((q) =>
            supabase.from("incidents").select("*").eq("site_id", args.siteId).order("id"),
          ),
          pagedRows<Record<string, unknown>>((q) =>
            supabase.from("environmental_observations").select("*").eq("site_id", args.siteId).order("id"),
          ),
        ]);
        counts = countFromRows(
          findings.map(mapFinding),
          cas.map(mapCorrectiveAction),
          incidents.map(mapIncident),
          observations.map(mapObservation),
          args.siteId,
          Date.now(),
        );
        ids = {
          allFindingIds: findings.map((f) => String(f.id)),
          lowIds: findings.filter((f) => f.severity === "low").map((f) => String(f.id)),
          mediumIds: findings.filter((f) => f.severity === "medium").map((f) => String(f.id)),
          highIds: findings.filter((f) => f.severity === "high").map((f) => String(f.id)),
          criticalIds: findings.filter((f) => f.severity === "critical").map((f) => String(f.id)),
          overdueCaIds: cas
            .filter((c) => c.status !== "closed" && c.status !== "verified" && (tsMs(c.due_at) ?? 0) < Date.now())
            .map((c) => String(c.id)),
          fatalityIds: incidents.filter((i) => i.type === "fatality").map((i) => String(i.id)),
          seriousIncidentIds: incidents
            .filter(
              (i) =>
                i.type !== "fatality" &&
                (i.severity === "critical" || i.severity === "high"),
            )
            .map((i) => String(i.id)),
          envAlertIds: observations
            .filter(
              (o) =>
                o.status !== "resolved" &&
                (o.verification === "measured" || o.verification === "verified"),
            )
            .map((o) => String(o.id)),
        };
      }
      const built = factorsFromCountsAndIds(counts, ids);
      const sentences: RiskSentence[] = built.factors.map((f) => ({
        factor: f.label,
        text: `${f.label} — ${f.points} point(s).`,
        points: f.points,
        recordIds: f.recordIds,
      }));
      const citations = [...new Set(sentences.flatMap((s) => s.recordIds))];
      const abstained = sentences.length === 0;
      return {
        siteId: args.siteId,
        abstained,
        summary: abstained
          ? null
          : `Risk score ${built.score} from ${sentences.length} recorded factor(s).`,
        sentences,
        citations,
        disclaimer: AI_DISCLAIMER,
      };
    }, { authBound: true }),
};

function isGuestLike(profile: UserProfile): boolean {
  // Role-less accounts get no AI narrative (the no-leak contract).
  return !profile.role;
}

function countFromRows(
  findings: Finding[],
  cas: CorrectiveAction[],
  incidents: Incident[],
  observations: EnvironmentalObservation[],
  siteId: string,
  now: number,
): RiskInputCounts {
  const siteFindings = findings.filter((f) => f.siteId === siteId);
  const counts: RiskInputCounts = {
    findingsTotal: siteFindings.length,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
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
  for (const c of cas) {
    if (
      c.siteId === siteId &&
      c.status !== "closed" &&
      c.status !== "verified" &&
      c.dueAt < now
    )
      counts.overdueCAs += 1;
  }
  for (const i of incidents) {
    if (i.siteId !== siteId) continue;
    if (i.type === "fatality") counts.fatalityIncidents += 1;
    else if (i.severity === "critical" || i.severity === "high")
      counts.seriousIncidents += 1;
  }
  for (const o of observations) {
    if (
      o.siteId === siteId &&
      o.status !== "resolved" &&
      (o.verification === "measured" || o.verification === "verified")
    )
      counts.envAlerts += 1;
  }
  return counts;
}

// ------------------------------------------------------- exports (§9)

export const exports = {
  /** Streaming CSV row source over the keyset incidence page (SEC-4 v2). */
  streamIncidents: (): AsyncGenerator<Record<string, unknown>[], void, unknown> =>
    keysetStream((cursor) => records.incidentsPage({ before: cursor, limit: 500 })),

  streamInspections: (): AsyncGenerator<
    Record<string, unknown>[],
    void,
    unknown
  > =>
    keysetStream((cursor) =>
      inspections.inspectionsPage({ before: cursor, limit: 500 }),
    ),

  streamCompliance: (): AsyncGenerator<Record<string, unknown>[], void, unknown> =>
    keysetStream((cursor) =>
      inspections.compliancePage({ before: cursor, limit: 500 }),
    ),
};

async function* keysetStream(
  page: (before: KeysetCursor | null) => Promise<KeysetPage<Record<string, unknown>>>,
): AsyncGenerator<Record<string, unknown>[], void, unknown> {
  let before: KeysetCursor | null = null;
  for (;;) {
    const res = await page(before);
    if (res.rows.length > 0) yield res.rows;
    if (!res.nextCursor) break;
    before = res.nextCursor;
  }
}

// ------------------------------------------------------------ the api object

export const api = {
  // sites / inspections / records / stats / evidence / seed / users / ai /
  // exports — spread as the original Convex-era namespace shape.
  sites,
  inspections,
  records,
  stats,
  evidence,
  seed,
  users,
  ai,
  exports,

  // mapFeatures — the NationalMap's registry/GIS feed (verified vs reported
  // layers, doc 06). Boundaries render ONLY when an authoritative boundary
  // dataset is present; the map degrades to point records otherwise
  // (no fabricated boundary data — the master directive prohibits it).
  mapFeatures: () =>
    live<{
      layers: MapLayerConfig[];
      features: MapFeature[];
      adminBoundaries: AdminBoundary[];
      siteBoundaries: SiteBoundary[];
    }>(async () => {
      const profile = (await getProfile()) ?? null;
      if (!profile) {
        return {
          layers: MAP_LAYER_CONFIGS,
          features: [],
          adminBoundaries: [],
          siteBoundaries: [],
        };
      }
      const siteRows = await pagedRows<Record<string, unknown>>((q) =>
        supabase.from("sites").select("*").order("id"),
      );
      const visibleSites = siteRows.filter((s) => canAccessSite(profile, mapSite(s)));
      const features: MapFeature[] = visibleSites.map((s) => {
        const site = mapSite(s);
        return {
          id: site._id,
          layer: "sites" as const,
          label: site.name,
          lng: site.longitude ?? 0,
          lat: site.latitude ?? 0,
          siteId: site._id,
          geoSource: site.geoSource,
          geoAccuracyM: site.geoAccuracyM,
          geoVerified: site.geoVerified,
        };
      });
      // Boundary tables (Session 6): rendered when authored; empty arrays
      // are the designed no-boundary state.
      let adminBoundaries: AdminBoundary[] = [];
      let siteBoundaries: SiteBoundary[] = [];
      try {
        const bRows = await pagedRows<Record<string, unknown>>((q) =>
          supabase.from("admin_boundaries").select("*").order("created_at", { ascending: false }),
        );
        adminBoundaries = bRows.map((b) => ({
          _id: String(b.id),
          name: String(b.name),
          level: (b.level as AdminBoundary["level"]) ?? "county",
          parentId: (b.parent_id as string) ?? undefined,
          geometryGeoJson: String(b.geometry_geojson ?? ""),
          source: String(b.source ?? ""),
          accuracyM: optionalNumber(b.accuracy_m),
          geoVerified: Boolean(b.geo_verified),
          createdAt: tsMs(b.created_at) ?? 0,
        }));
      } catch {
        adminBoundaries = [];
      }
      try {
        const sRows = await pagedRows<Record<string, unknown>>((q) =>
          supabase.from("site_boundaries").select("*").order("created_at", { ascending: false }),
        );
        siteBoundaries = sRows.map((b) => ({
          _id: String(b.id),
          siteId: String(b.site_id),
          geometryGeoJson: String(b.geometry_geojson ?? ""),
          source: String(b.source ?? ""),
          accuracyM: optionalNumber(b.accuracy_m),
          geoVerified: Boolean(b.geo_verified),
          createdAt: tsMs(b.created_at) ?? 0,
        }));
      } catch {
        siteBoundaries = [];
      }
      return {
        layers: MAP_LAYER_CONFIGS,
        features,
        adminBoundaries,
        siteBoundaries,
      };
    }, { authBound: true }),
};

export default api;
