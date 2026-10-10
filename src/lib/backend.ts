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

/** doc 08: AI output is labeled as assistance — this label ships with every
 *  AI payload so no surface can present it as fact without the marker. */
const AI_DISCLAIMER =
  "AI-assisted explanation — generated from the recorded risk factors only; decision support, not a determination.";
import {
  adminBoundaryFromRow,
  communityReportFeature,
  incidentFeature,
  indexSites,
  inspectionFeature,
  observationFeature,
  parseBoundaryGeometry,
  riskIndicatorFeature,
  siteBoundaryFromRow,
  siteFeature,
  validateGeoJsonPolygon,
} from "./gis";
import {
  MAP_LAYER_CONFIGS,
  canAccessSite,
  isStaffRole,
  makeTrackingCode,
  nextSiteCodeFrom,
  type AdminBoundary,
  type AuditEntry,
  type CommunityReport,
  type CorrectiveAction,
  type EnvironmentalObservation,
  type Evidence,
  type EvidenceKind,
  type Finding,
  type Incident,
  type Inspection,
  type InspectionTemplate,
  type MapFeature,
  type MapLayerConfig,
  type Role,
  type Scope,
  type Site,
  type SiteBoundary,
  type UserProfile,
  ROLES,
} from "./types";

// ---------------------------------------------------------------------------
// QUERY HANDLES — a Convex useQuery-compatible subscription surface
// ---------------------------------------------------------------------------

export interface QueryHandle<T> {
  /** True when the result depends on the signed-in user. Consumed by the
   *  React cache layer to re-derive subscriptions after auth changes. */
  authBound?: boolean;
  subscribe(cb: (value: T | undefined) => void): () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

// ---------------------------------------------------------------------------
// TIME HELPERS — timestamptz <-> epoch-ms
// ---------------------------------------------------------------------------

function toMs(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}
function toMsOrNull(v: unknown): number | undefined {
  if (v == null) return undefined;
  const t = toMs(v);
  return t === 0 ? undefined : t;
}
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// ROW MAPPERS — public.* (snake_case) -> domain types (camelCase, _id)
// ---------------------------------------------------------------------------

function mapProfile(r: AnyRow): UserProfile {
  return {
    uid: r.id as string,
    email: (r.email as string) ?? null,
    name: (r.name as string) ?? null,
    role: (r.role as Role) ?? undefined,
    jobTitle: (r.job_title as string) ?? undefined,
    organization: (r.organization as string) ?? undefined,
    scope: (r.scope as Scope) ?? undefined,
    county: (r.county as string) ?? undefined,
    operatorName: (r.operator_name as string) ?? undefined,
    organizationId: (r.organization_id as string) ?? undefined,
    profileComplete: r.profile_complete === true,
    createdAt: toMs(r.created_at),
  };
}

function mapSite(r: AnyRow): Site {
  return {
    _id: r.id as string,
    code: r.code,
    name: r.name,
    operatorName: r.operator_name,
    organizationId: r.organization_id ?? undefined,
    mineralType: r.mineral_type ?? undefined,
    county: r.county,
    district: r.district ?? undefined,
    community: r.community ?? undefined,
    status: r.status,
    latitude: r.latitude ?? undefined,
    longitude: r.longitude ?? undefined,
    notes: r.notes ?? undefined,
    createdBy: r.created_by,
    createdAt: toMs(r.created_at),
    geoSource: (r.geo_source as string | null) ?? undefined,
    geoAccuracyM:
      r.geo_accuracy_m === null || r.geo_accuracy_m === undefined
        ? undefined
        : Number(r.geo_accuracy_m),
    geoVerified: r.geo_verified === true,
  };
}

function mapTemplate(r: AnyRow): InspectionTemplate {
  return {
    _id: r.id as string,
    name: r.name,
    description: r.description ?? undefined,
    active: r.active === true,
    sections: (r.sections ?? []) as InspectionTemplate["sections"],
    createdBy: r.created_by,
    createdAt: toMs(r.created_at),
  };
}

function mapInspection(r: AnyRow): Inspection {
  return {
    _id: r.id as string,
    siteId: r.site_id,
    templateId: r.template_id,
    inspectorId: r.inspector_id,
    status: r.status,
    answers: (r.answers ?? undefined) as Inspection["answers"],
    notes: r.notes ?? undefined,
    latitude: r.latitude ?? undefined,
    longitude: r.longitude ?? undefined,
    gpsAccuracyM: r.gps_accuracy_m ?? undefined,
    clientRef: r.client_ref ?? undefined,
    submittedAt: toMsOrNull(r.submitted_at),
    reviewedAt: toMsOrNull(r.reviewed_at),
    reviewerId: r.reviewer_id ?? undefined,
    reviewNote: r.review_note ?? undefined,
    createdAt: toMs(r.created_at),
  };
}

function mapFinding(r: AnyRow): Finding {
  return {
    _id: r.id as string,
    inspectionId: r.inspection_id,
    siteId: r.site_id,
    title: r.title,
    description: r.description ?? undefined,
    severity: r.severity,
    status: r.status,
    createdById: r.created_by_id,
    createdAt: toMs(r.created_at),
  };
}

function mapCA(r: AnyRow): CorrectiveAction {
  return {
    _id: r.id as string,
    findingId: r.finding_id,
    siteId: r.site_id,
    description: r.description,
    status: r.status,
    dueAt: toMs(r.due_at),
    openedById: r.opened_by_id,
    operatorNote: r.operator_note ?? undefined,
    verifiedById: r.verified_by_id ?? undefined,
    closedAt: toMsOrNull(r.closed_at),
    createdAt: toMs(r.created_at),
    rowVersion: r.row_version == null ? undefined : Number(r.row_version),
  };
}

function mapIncident(r: AnyRow): Incident {
  return {
    _id: r.id as string,
    siteId: r.site_id,
    type: r.type,
    severity: r.severity,
    description: r.description,
    occurredAt: toMs(r.occurred_at),
    fatalities: r.fatalities ?? undefined,
    injured: r.injured ?? undefined,
    status: r.status,
    reportedById: r.reported_by_id,
    reportSource: r.report_source,
    createdAt: toMs(r.created_at),
  };
}

function mapObservation(r: AnyRow): EnvironmentalObservation {
  return {
    _id: r.id as string,
    siteId: r.site_id,
    category: r.category,
    verification: r.verification,
    description: r.description,
    observedAt: toMs(r.observed_at),
    latitude: r.latitude ?? undefined,
    longitude: r.longitude ?? undefined,
    status: r.status,
    reportedById: r.reported_by_id,
    createdAt: toMs(r.created_at),
  };
}

function mapReport(r: AnyRow): CommunityReport {
  return {
    _id: r.id as string,
    trackingCode: r.tracking_code,
    category: r.category,
    description: r.description,
    county: r.county,
    district: r.district ?? undefined,
    community: r.community ?? undefined,
    latitude: r.latitude ?? undefined,
    longitude: r.longitude ?? undefined,
    contactPhone: r.contact_phone ?? undefined,
    status: r.status,
    triageNote: r.triage_note ?? undefined,
    reviewedById: r.reviewed_by_id ?? undefined,
    reviewedAt: toMsOrNull(r.reviewed_at),
    createdAt: toMs(r.created_at),
  };
}

function mapAudit(r: AnyRow): AuditEntry {
  return {
    _id: r.id as string,
    actorId: r.actor_id ?? undefined,
    actorLabel: r.actor_label,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id ?? undefined,
    summary: r.summary,
    createdAt: toMs(r.created_at),
  };
}

function mapEvidence(r: AnyRow): Evidence {
  return {
    _id: r.id as string,
    storagePath: r.storage_path,
    parentType: r.parent_type,
    parentId: r.parent_id,
    siteId: r.site_id ?? undefined,
    kind: r.kind,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes ?? 0),
    caption: r.caption ?? undefined,
    capturedAt: toMsOrNull(r.captured_at),
    uploadedById: r.uploaded_by_id,
    createdAt: toMs(r.created_at),
    sha256: r.sha256 ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

async function getProfile(uid: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", uid)
    .maybeSingle();
  if (error) throw backendError(error);
  return data ? mapProfile(data) : null;
}

// Short-TTL profile cache: list queries re-derive authorization on every run;
// without this, one dashboard render costs a profiles read per query. TTL is
// intentionally short (5s) so role changes surface quickly. Auth mutations
// always use a fresh read (cached=false default).
let profileCache: { uid: string; profile: UserProfile | null; at: number } | null =
  null;
const PROFILE_TTL_MS = 5_000;

async function getProfileCached(uid: string): Promise<UserProfile | null> {
  if (
    profileCache &&
    profileCache.uid === uid &&
    Date.now() - profileCache.at < PROFILE_TTL_MS
  ) {
    return profileCache.profile;
  }
  const profile = await getProfile(uid);
  profileCache = { uid, profile, at: Date.now() };
  return profile;
}

async function requireAuthed(cached = false): Promise<UserProfile> {
  const uid = authUserId();
  if (!uid) throw new Error("UNAUTHENTICATED");
  const profile = cached ? await getProfileCached(uid) : await getProfile(uid);
  if (!profile) throw new Error("UNREGISTERED_USER");
  return profile;
}

async function requireStaffUser(cached = false): Promise<UserProfile> {
  const user = await requireAuthed(cached);
  if (!isStaffRole(user.role)) throw new Error("FORBIDDEN");
  return user;
}

async function requireAdminUser(cached = false): Promise<UserProfile> {
  const user = await requireAuthed(cached);
  if (user.role !== ROLES.ADMIN) throw new Error("FORBIDDEN");
  return user;
}

async function requireReviewerUser(cached = false): Promise<UserProfile> {
  const user = await requireAuthed(cached);
  if (user.role !== ROLES.ADMIN && user.role !== ROLES.SUPERVISOR)
    throw new Error("FORBIDDEN");
  return user;
}

async function actorLabel(user: UserProfile): Promise<string> {
  return user.email ?? user.name ?? user.uid;
}

/** NON-AUTHORITATIVE breadcrumb (SEC-1, migration 0009).
 *  The authoritative audit trail is written by the server: every mutation
 *  fires mg_audit_row(), which records the session actor (auth.uid(), never
 *  client-supplied), entity, timestamp and before/after diff in the SAME
 *  transaction as the write — so a client crash can neither lose nor forge a
 *  row. audit_log INSERT/UPDATE/DELETE is revoked from all client roles.
 *  This helper now only leaves a console trace of what the UI intended. */
async function logAudit(entry: {
  actorId?: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId?: string;
  summary: string;
}) {
  console.debug(
    "[audit:breadcrumb]",
    entry.action,
    `${entry.entityType}:${entry.entityId ?? "-"}`,
    entry.summary,
    `(${entry.actorLabel})`,
  );
}

async function getSite(siteId: string): Promise<Site | null> {
  const { data, error } = await supabase
    .from("sites")
    .select("*")
    .eq("id", siteId)
    .maybeSingle();
  if (error) throw backendError(error);
  return data ? mapSite(data) : null;
}

async function insertReturningId(
  table: string,
  values: AnyRow,
): Promise<string> {
  const { data, error } = await supabase
    .from(table)
    .insert(values)
    .select("id")
    .single();
  if (error) throw backendError(error);
  return data.id as string;
}

// ---------------------------------------------------------------------------
// SEC-4 — paged reads: hosted PostgREST caps an unranged response
// (db-max-rows, default 1,000 rows). A bare `select("*")` therefore
// SILENTLY TRUNCATES past that size and every statistic, risk score and
// export computed from it is quietly wrong — the defect this section closes.
// ---------------------------------------------------------------------------

/** The hosted PostgREST default row cap — the size of one wire page. */
const POSTGREST_MAX_ROWS = 1000;

type PagedPage = PromiseLike<{
  data: unknown;
  error: { message: string; code?: string } | null;
}>;

/** Fetch EVERY row a query yields by paging with an explicit ordered Range
 *  until a short page comes back. Correctness never depends on the server's
 *  row cap, at any table size. (An error on any page throws — truncation is
 *  never an acceptable outcome here.) */
async function pagedRows<T>(
  page: (from: number, to: number) => PagedPage,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += POSTGREST_MAX_ROWS) {
    const { data, error } = await page(from, from + POSTGREST_MAX_ROWS - 1);
    if (error) throw backendError(error);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < POSTGREST_MAX_ROWS) return out;
  }
}

/** Fetch all rows of a table the caller can see (RLS enforces the scope) —
 *  paged, ordered by primary key so the Range windows are stable across
 *  requests (SEC-4). */
async function allRows<T>(table: string): Promise<T[]> {
  return pagedRows<T>((from, to) =>
    supabase
      .from(table)
      .select("*")
      .order("id", { ascending: true })
      .range(from, to),
  );
}

/** Every site code in the registry — paged for the same SEC-4 reason: a
 *  truncated scan would re-propose an existing code once a lineage passes
 *  the row cap (the unique constraint would then refuse the insert). */
async function allSiteCodes(): Promise<string[]> {
  const rows = await pagedRows<{ code: string }>((from, to) =>
    supabase
      .from("sites")
      .select("code")
      .order("id", { ascending: true })
      .range(from, to),
  );
  return rows.map((r) => r.code);
}

/** Paged read of one parent's children (or any eq-filtered slice) — the
 *  same ordered Range windows as allRows; correctness never depends on the
 *  server's row cap, however deep the slice grows (SEC-4). */
async function pagedEqRows<T>(
  table: string,
  column: string,
  value: unknown,
): Promise<T[]> {
  return pagedRows<T>((from, to) =>
    supabase
      .from(table)
      .select("*")
      .eq(column, value)
      .order("id", { ascending: true })
      .range(from, to),
  );
}

// ---------------------------------------------------------------------------
// SEC-4 v2 — keyset pages: the list pages' and the exports' row sources.
//
// Rows arrive in (sort_at DESC, id DESC) windows driven by a (cursorAt,
// cursorId) keyset predicate computed in Postgres by the SECURITY INVOKER
// RPCs of migration 0014. Unlike offset windows, a keyset window CANNOT skip
// or repeat rows when the table grows underneath the pager: the predicate is
// "everything strictly before the last row the caller actually received".
// Each page carries the cursor of its own last row, so the next request
// resumes exactly where the previous one stopped.
// ---------------------------------------------------------------------------

export type KeysetCursor = { at: number; id: string };

export interface KeysetPage<T> {
  rows: T[];
  /** Cursor of the page's last row — null when the feed is exhausted. */
  nextCursor: KeysetCursor | null;
  /** How this page was produced: "rpc" (SQL keyset page, migration 0014) or
   *  "fallback" (the full authorized feed in one page — pre-0014 lineage). */
  source: "rpc" | "fallback";
}

/** The list pages' window size — well under the hosted row cap, deep enough
 *  that a normal session never taps "Load more" twice. */
const KEYSET_PAGE_SIZE = 500;

/** Coerce one RPC jsonb field to a finite number (mapCommandCenterStats
 *  discipline: no downstream UI math may ever see undefined/NaN). */
function numOf(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Coerce one RPC jsonb field to a string array (id arrays from
 *  mg_risk_explanation). */
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x));
}

/** One keyset page through a 0014 RPC. Returns null when the RPC is not on
 *  this lineage (error) — the caller falls back to the exact full-feed path
 *  instead of guessing what a half-page means. */
async function keysetPageRpc<T>(
  fn: string,
  before: KeysetCursor | null,
  limit: number,
  mapRow: (raw: AnyRow) => T,
): Promise<KeysetPage<T> | null> {
  const { data, error } = await supabase.rpc(fn, {
    p_before: before ? iso(before.at) : null,
    p_before_id: before ? before.id : null,
    p_limit: limit,
  });
  if (error || !Array.isArray(data)) return null;
  const raw = data as AnyRow[];
  const last = raw.length > 0 ? raw[raw.length - 1] : null;
  return {
    rows: raw.map(mapRow),
    // A full page MIGHT have a successor; a short page cannot.
    nextCursor:
      last && raw.length >= limit
        ? { at: numOf(last.cursorAt), id: String(last.cursorId) }
        : null,
    source: "rpc",
  };
}

/** Stream a keyset feed page by page to exhaustion — the exports' row
 *  source. Each page is serialized (and released) before the next is
 *  fetched, so the export's memory tracks one page, not the table. */
function keysetPages<T>(
  fetch: (before: KeysetCursor | null) => Promise<KeysetPage<T>>,
): AsyncGenerator<T[]> {
  return (async function* () {
    let before: KeysetCursor | null = null;
    for (;;) {
      const page = await fetch(before);
      yield page.rows;
      if (!page.nextCursor) return;
      before = page.nextCursor;
    }
  })();
}

async function refreshPublicStats() {
  const { error } = await supabase.rpc("refresh_public_stats");
  if (error) console.warn("[backend] publicStats refresh skipped:", error.message);
}

// ---------------------------------------------------------------------------
// SEC-4 v2 — full-feed fetchers (the live lists and the keyset pages'
// fallback both consume them; single body per feed so the two paths cannot
// diverge) and the RPC row mappers.
// ---------------------------------------------------------------------------

/** The caller-visible incidents feed, enriched — the exact body of the old
 *  records.listIncidents fetcher. */
async function fetchIncidents(
  user: UserProfile,
): Promise<(Incident & { siteCode: string; siteName: string; county: string })[]> {
  const [incRaw, siteRaw] = await Promise.all([
    allRows<AnyRow>("incidents"),
    allRows<AnyRow>("sites"),
  ]);
  const byId = new Map(siteRaw.map((r) => [r.id as string, mapSite(r)]));
  const out: (Incident & { siteCode: string; siteName: string; county: string })[] = [];
  for (const r of incRaw) {
    const inc = mapIncident(r);
    const site = byId.get(inc.siteId);
    if (!site) continue;
    if (user.role === ROLES.OPERATOR) {
      if (!user.operatorName || site.operatorName !== user.operatorName) continue;
    }
    out.push({
      ...inc,
      siteCode: site.code,
      siteName: site.name,
      county: site.county,
    });
  }
  out.sort((a, b) => b.occurredAt - a.occurredAt);
  return out;
}

/** The caller-visible inspections feed, enriched — the exact body of the old
 *  inspections.list fetcher. */
/** One row of the keyset incident page (feed + CSV export). */
export type IncidentPageRow = Incident & {
  siteCode: string;
  siteName: string;
  county: string;
};

export type InspectionListRow = {
  _id: string;
  siteId: string;
  siteCode: string;
  siteName: string;
  county: string;
  status: Inspection["status"];
  submittedAt?: number;
  createdAt: number;
  inspectorId: string;
};

async function fetchInspections(user: UserProfile): Promise<InspectionListRow[]> {
  const [inspRaw, siteRaw] = await Promise.all([
    allRows<AnyRow>("inspections"),
    allRows<AnyRow>("sites"),
  ]);
  const byId = new Map(siteRaw.map((r) => [r.id as string, mapSite(r)]));
  const out: InspectionListRow[] = [];
  for (const r of inspRaw) {
    const insp = mapInspection(r);
    const site = byId.get(insp.siteId);
    if (!site) continue;
    if (!canAccessSite(user, site)) continue;
    if (
      user.role === ROLES.INSPECTOR &&
      user.scope !== "national" &&
      insp.inspectorId !== user.uid
    ) {
      continue;
    }
    out.push({
      _id: insp._id,
      siteId: insp.siteId,
      siteCode: site.code,
      siteName: site.name,
      county: site.county,
      status: insp.status,
      submittedAt: insp.submittedAt,
      createdAt: insp.createdAt,
      inspectorId: insp.inspectorId,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** The caller-visible compliance feed, enriched — the exact body of the old
 *  inspections.listMyCorrectiveActions fetcher. */
export type ComplianceListRow = CorrectiveAction & {
  findingTitle: string;
  findingSeverity: Finding["severity"];
  siteCode: string;
  siteName: string;
  county: string;
};

async function fetchCompliance(user: UserProfile): Promise<ComplianceListRow[]> {
  const [caRaw, findingRaw, siteRaw] = await Promise.all([
    allRows<AnyRow>("corrective_actions"),
    allRows<AnyRow>("findings"),
    allRows<AnyRow>("sites"),
  ]);
  const findings = new Map(findingRaw.map((r) => [r.id as string, mapFinding(r)]));
  const sites = new Map(siteRaw.map((r) => [r.id as string, mapSite(r)]));
  const out: ComplianceListRow[] = [];
  for (const r of caRaw) {
    const ca = mapCA(r);
    const site = sites.get(ca.siteId);
    if (!site || !canAccessSite(user, site)) continue;
    const finding = findings.get(ca.findingId);
    out.push({
      ...ca,
      findingTitle: finding?.title ?? "Compliance finding",
      findingSeverity: finding?.severity ?? "medium",
      siteCode: site.code,
      siteName: site.name,
      county: site.county,
    });
  }
  // Openest obligations first: open/in_progress/submitted before decided
  // ones, then by soonest deadline.
  const openRank = (s: CorrectiveAction["status"]) =>
    s === "open" ? 0 : s === "in_progress" ? 1 : s === "submitted" ? 2 : s === "escalated" ? 3 : 4;
  out.sort(
    (a, b) => openRank(a.status) - openRank(b.status) || a.dueAt - b.dueAt,
  );
  return out;
}

// --- SEC-4 v2 mappers: 0014 RPC payloads (camelCase jsonb) → feed shapes ---

/** mg_incidents_page row → the enriched incident shape listIncidents returns
 *  (fields coerced; the cursor pair stays in the raw row). */
function mapIncidentPageRow(r: AnyRow): Incident & {
  siteCode: string;
  siteName: string;
  county: string;
} {
  return {
    _id: String(r._id),
    siteId: r.siteId as string,
    type: r.type as Incident["type"],
    severity: r.severity as Incident["severity"],
    description: r.description as string,
    occurredAt: numOf(r.occurredAt),
    fatalities: r.fatalities == null ? undefined : Number(r.fatalities),
    injured: r.injured == null ? undefined : Number(r.injured),
    status: r.status as Incident["status"],
    reportedById: r.reportedById as string,
    reportSource: r.reportSource as Incident["reportSource"],
    createdAt: numOf(r.createdAt),
    siteCode: r.siteCode as string,
    siteName: r.siteName as string,
    county: r.county as string,
  };
}

/** mg_inspections_page row → the InspectionListRow shape. */
function mapInspectionPageRow(r: AnyRow): InspectionListRow {
  return {
    _id: String(r._id),
    siteId: r.siteId as string,
    siteCode: r.siteCode as string,
    siteName: r.siteName as string,
    county: r.county as string,
    status: r.status as Inspection["status"],
    submittedAt: r.submittedAt == null ? undefined : numOf(r.submittedAt),
    createdAt: numOf(r.createdAt),
    inspectorId: r.inspectorId as string,
  };
}

/** mg_compliance_page row → the export/feed page shape (the exact columns
 *  the §9 compliance export serializes; the live feed keeps its richer
 *  ComplianceListRow). */
export type CompliancePageRow = {
  _id: string;
  siteId: string;
  findingId: string;
  description: string;
  status: CorrectiveAction["status"];
  dueAt: number;
  operatorNote?: string;
  createdAt: number;
  findingTitle: string;
  findingSeverity: Finding["severity"];
  siteCode: string;
  siteName: string;
  county: string;
};

function mapCompliancePageRow(r: AnyRow): CompliancePageRow {
  return {
    _id: String(r._id),
    findingId: r.findingId as string,
    siteId: r.siteId as string,
    description: r.description as string,
    status: r.status as CorrectiveAction["status"],
    dueAt: numOf(r.dueAt),
    operatorNote: r.operatorNote == null ? undefined : (r.operatorNote as string),
    createdAt: numOf(r.createdAt),
    findingTitle: r.findingTitle == null ? "Compliance finding" : (r.findingTitle as string),
    findingSeverity: (r.findingSeverity ?? "medium") as Finding["severity"],
    siteCode: r.siteCode as string,
    siteName: r.siteName as string,
    county: r.county as string,
  };
}

// --- SEC-4 v2: the explainer's sentence builder + the mg_risk_explanation
// mapper (shared by the RPC path; the fallback builds the same response
// inline from computeRiskFactors' factors).

/** The explainer's sentence list — the fixed, factor-grounded text (doc 08:
 *  cite-or-abstain; every sentence names the records it is grounded in). */
function explanationSentences(factors: RiskFactor[]): {
  factor: string;
  points: number;
  recordIds: string[];
  text: string;
}[] {
  return factors.map((f) => ({
    factor: f.label,
    points: f.points,
    recordIds: f.recordIds,
    text: `${f.label} contribute${f.points === 1 ? "s" : ""} ${f.points} point${f.points === 1 ? "" : "s"} to the indicator at this site.`,
  }));
}

/** mg_risk_explanation payload → the explainer response: the count aggregates
 *  rebuild the factors through the shared builder (factorsFromCountsAndIds)
 *  and the id arrays become the per-sentence citations. */
function explanationFromRow(row: AnyRow): {
  siteId: string;
  generatedAt: number;
  abstained: boolean;
  summary: string | null;
  citations: string[];
  sentences: { factor: string; points: number; recordIds: string[]; text: string }[];
  disclaimer: string;
} {
  const counts: RiskInputCounts = {
    findingsTotal: numOf(row.findingsTotal),
    low: numOf(row.lowFindings),
    medium: numOf(row.mediumFindings),
    high: numOf(row.highFindings),
    critical: numOf(row.criticalFindings),
    overdueCAs: numOf(row.overdueCAs),
    fatalityIncidents: numOf(row.fatalityIncidents),
    seriousIncidents: numOf(row.seriousIncidents),
    envAlerts: numOf(row.envAlerts),
  };
  const { score, factors } = factorsFromCountsAndIds(counts, {
    allFindingIds: strArr(row.allFindingIds),
    lowIds: strArr(row.lowIds),
    mediumIds: strArr(row.mediumIds),
    highIds: strArr(row.highIds),
    criticalIds: strArr(row.criticalIds),
    overdueCaIds: strArr(row.overdueCaIds),
    fatalityIds: strArr(row.fatalityIds),
    seriousIncidentIds: strArr(row.seriousIncidentIds),
    envAlertIds: strArr(row.envAlertIds),
  });
  const citations = [...new Set(factors.flatMap((f) => f.recordIds))].sort();
  // Cite-or-abstain: with no factors there is nothing to explain — abstain
  // rather than invent a narrative.
  if (factors.length === 0) {
    return {
      siteId: String(row.siteId),
      generatedAt: Date.now(),
      abstained: true,
      summary: null,
      citations: [],
      sentences: [],
      disclaimer: AI_DISCLAIMER,
    };
  }
  return {
    siteId: String(row.siteId),
    generatedAt: Date.now(),
    abstained: false,
    summary: `The risk indicator of ${score} for ${row.name} (${row.code}) is the sum of ${factors.length} recorded factor${factors.length === 1 ? "" : "s"}; each sentence below names the record it is grounded in.`,
    citations,
    sentences: explanationSentences(factors),
    disclaimer: AI_DISCLAIMER,
  };
}

function evidenceKindByMime(mime: string): EvidenceKind {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "photo";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}

export interface CommandCenterStats {
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
}

/** SEC-4 — field-by-field coercion for the mg_command_center_stats RPC
 *  payload (jsonb arrives as plain JSON). Every figure becomes a finite
 *  number and every group-by a number map, so no downstream UI math can
 *  ever see undefined/NaN. Key names match the SQL jsonb_build_object
 *  keys exactly; the scope falls back to the caller's profile only if the
 *  RPC somehow omitted it. */
function mapCommandCenterStats(
  raw: unknown,
  scope: string | null | undefined,
): CommandCenterStats {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number => {
    const x = typeof v === "number" ? v : Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const m = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>))
        out[k] = n(val);
    }
    return out;
  };
  return {
    scope: typeof r.scope === "string" && r.scope ? r.scope : scope ?? "national",
    sites: n(r.sites),
    activeSites: n(r.activeSites),
    inspectionsTotal: n(r.inspectionsTotal),
    inspectionsUnderReview: n(r.inspectionsUnderReview),
    findingsTotal: n(r.findingsTotal),
    findingsCriticalOpen: n(r.findingsCriticalOpen),
    correctiveActionsOpen: n(r.correctiveActionsOpen),
    correctiveActionsOverdue: n(r.correctiveActionsOverdue),
    incidentsTotal: n(r.incidentsTotal),
    fatalities: n(r.fatalities),
    envAlerts: n(r.envAlerts),
    envByCategory: m(r.envByCategory),
    communityReports: n(r.communityReports),
    communityReportsPending: n(r.communityReportsPending),
    inspectionCoveragePct: n(r.inspectionCoveragePct),
    countyCounts: m(r.countyCounts),
    incidentTypes: m(r.incidentTypes),
  };
}

// ---------------------------------------------------------------------------
// LIVE QUERIES — fetch once, then push-refresh via Postgres realtime
//
// PERF CONTRACT (unchanged from the Firebase layer):
//  - The fetcher runs ONCE on subscribe, then at most once per burst of
//    realtime events (300ms trailing debounce), never concurrently.
//  - authBound (default true): the result depends on the signed-in user, so
//    the shared cache re-derives it after sign-in/out or profile changes.
//  - RLS scopes every list server-side; the client adds no correctness
//    filters of its own.
// ---------------------------------------------------------------------------

function live<T>(
  fetcher: () => Promise<T>,
  watch: string[],
  opts?: { authBound?: boolean },
): QueryHandle<T> {
  const authBound = opts?.authBound !== false;
  return {
    authBound,
    subscribe(cb) {
      let cancelled = false;
      let inFlight = false;
      let dirty = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let attempts = 0;
      const unsubs: (() => void)[] = [];
      let watchersReady = false;

      const onWatchEvent = () => {
        if (cancelled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void run();
        }, 300);
      };

      const setupWatchers = () => {
        if (watchersReady || cancelled || watch.length === 0) return;
        watchersReady = true;
        try {
          const uid = authUserId();
          let channel = supabase.channel(
            `mg:${watch.join("|")}:${uid ?? "anon"}`,
          );
          for (const table of watch) {
            channel = channel.on(
              "postgres_changes",
              { event: "*", schema: "public", table },
              onWatchEvent,
            );
          }
          channel.subscribe();
          unsubs.push(() => {
            void supabase.removeChannel(channel);
          });
        } catch {
          // Realtime is best-effort; the initial fetch already ran.
        }
      };

      const run = async () => {
        if (inFlight) {
          dirty = true;
          return;
        }
        inFlight = true;
        try {
          const value = await fetcher();
          if (!cancelled) {
            attempts = 0;
            cb(value);
          }
        } catch (err) {
          console.error("[backend] query failed:", err);
          if (!cancelled) {
            cb(undefined); // no value yet — consumers stay in "loading"
            // SELF-HEAL: without this retry the FIRST failure bricked the
            // screen forever — the shared cache reads the error's
            // `undefined` as "still loading" and nothing ever re-ran the
            // fetcher (the "loads forever" failure mode). Capped backoff:
            // 1s, 2s, 4s, 8s, 16s, then every 30s.
            attempts += 1;
            const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
            retryTimer = setTimeout(() => {
              retryTimer = null;
              void run();
            }, delay);
          }
        } finally {
          inFlight = false;
          if (!cancelled) setupWatchers();
          if (dirty && !cancelled) {
            dirty = false;
            timer = setTimeout(() => {
              timer = null;
              void run();
            }, 100);
          }
        }
      };
      void run();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
        if (retryTimer) clearTimeout(retryTimer);
        for (const u of unsubs) u();
      };
    },
  };
}

/** Single-row live query: true push reactivity via a filtered realtime
 *  subscription. Used for the user profile and public stats. */
function liveDoc<T>(
  getTarget: () => { table: string; column: string; value: string } | null,
  mapRow: (r: AnyRow) => T,
  opts?: { authBound?: boolean },
): QueryHandle<T | null> {
  const authBound = opts?.authBound !== false;
  return {
    authBound,
    subscribe(cb) {
      let cancelled = false;
      const target = getTarget();
      if (!target) {
        cb(null);
        return () => {};
      }
      const { table, column, value } = target;

      const unsubs: (() => void)[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      let inFlight = false;
      let dirty = false;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let attempts = 0;

      const onWatchEvent = () => {
        if (cancelled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void run();
        }, 300);
      };

      const run = async () => {
        if (inFlight) {
          dirty = true;
          return;
        }
        inFlight = true;
        try {
          const { data, error } = await supabase
            .from(table)
            .select("*")
            .eq(column, value)
            .maybeSingle();
          if (error) throw backendError(error);
          const v = data ? mapRow(data) : null;
          if (!cancelled) {
            attempts = 0;
            cb(v);
          }
        } catch (err) {
          console.error("[backend] doc query failed:", err);
          if (!cancelled) {
            // An ERROR is not "no row": emitting null here pushed signed-in
            // users into the wrong empty state ("no portal role assigned")
            // on a transient failure. Stay silent — the document keeps
            // loading — and retry with the same capped backoff.
            attempts += 1;
            const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
            retryTimer = setTimeout(() => {
              retryTimer = null;
              void run();
            }, delay);
          }
        } finally {
          inFlight = false;
          if (!cancelled && unsubs.length === 0) {
            try {
              let channel = supabase.channel(
                `mg:${table}:${column}:${value}`,
              );
              channel = channel.on(
                "postgres_changes",
                {
                  event: "*",
                  schema: "public",
                  table,
                  filter: `${column}=eq.${value}`,
                },
                onWatchEvent,
              );
              channel.subscribe();
              unsubs.push(() => {
                void supabase.removeChannel(channel);
              });
            } catch {
              /* best-effort */
            }
          }
          if (dirty && !cancelled) {
            dirty = false;
            void run();
          }
        }
      };
      void run();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
        if (retryTimer) clearTimeout(retryTimer);
        for (const u of unsubs) u();
      };
    },
  };
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

/** Map Supabase auth errors to the stable message tokens Auth.tsx renders. */
function authErrorMessage(err: { message?: string } | null | undefined): string {
  const m = (err?.message ?? "").toLowerCase();
  if (m.includes("invalid login credentials")) return "INCORRECT_CREDENTIALS";
  if (m.includes("email not confirmed")) return "EMAIL_NOT_CONFIRMED";
  if (m.includes("already registered") || m.includes("already exists"))
    return "EMAIL_IN_USE";
  if (m.includes("password should be at least") || m.includes("weak_password"))
    return "WEAK_PASSWORD";
  if (m.includes("over_request_rate_limit") || m.includes("too many"))
    return "TOO_MANY_ATTEMPTS";
  if (m.includes("anonymous sign-ins are disabled") || m.includes("anonymous"))
    return "ANON_DISABLED";
  if (m.includes("signups not allowed")) return "SIGNUPS_DISABLED";
  return err?.message ?? "AUTH_FAILED";
}

// ---------------------------------------------------------------------------
// ACCOUNT RECOVERY + MFA — Gap Closure Directive Gap #4 (docs/04 gap 2).
// Password reset (request + set) and TOTP factor lifecycle over the GoTrue
// helpers in src/lib/supabase.ts. Recovery CODES and WebAuthn/phone factors
// are NOT implemented (documented residual).
// ---------------------------------------------------------------------------

export {
  mfaAal,
  mfaEnrollStart,
  mfaEnrollVerify,
  mfaListFactors,
  mfaUnenroll,
} from "./supabase";
export { validateTemplateSections } from "./template-schema";
export type { MfaAal, MfaEnrollStart, MfaFactor } from "./supabase";

/** Request a password-reset email. Response and timing are identical for
 *  known and unknown addresses (no account enumeration) — Supabase does the
 *  same server-side. The redirect lands on the app ROOT (not a hash route):
 *  supabase-js exchanges the recovery token in the URL fragment/query before
 *  the router sees it, restoring a session for setting the new password.
 *  With a recovery session active, change the password on /portal/security
 *  or via the /auth reset panel. */
export async function resetPasswordEmail(email: string) {
  // Bun/SSR-safe: tests run the data layer without a DOM.
  const base =
    typeof window !== "undefined"
      ? `${window.location.origin}${window.location.pathname}`
      : "http://localhost:5173/";
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: base,
  });
  if (error) throw new Error(authErrorMessage(error));
}

/** Set a new password from a recovery session (the email link restores a
 *  privileged session GoTrue treats as aal1 for password update). */
export async function updatePassword(newPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(authErrorMessage(error));
}

/** Create the profile row for a fresh account (idempotent; the
 *  on_auth_user_created trigger normally does this first). */
export async function ensureProfileDoc() {
  const uid = authUserId();
  if (!uid) return;
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: uid }, { onConflict: "id", ignoreDuplicates: true });
  if (error) console.warn("[backend] profile ensure skipped:", error.message);
}

export async function signInEmail(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(authErrorMessage(error));
  await ensureProfileDoc();
}

/** Sign in and return whether the account requires a second step. GoTrue's
 *  assurance contract: when a VERIFIED factor exists, a fresh password
 *  session is aal1 while the account requires aal2 — MFA_CHALLENGE_REQUIRED
 *  tells the UI to run the authenticator-code step. profileVersion is
 *  intentionally NOT bumped here (ensureProfileDoc runs post-challenge). */
export async function signInEmailMfaAware(email: string, password: string) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(authErrorMessage(error));
  const aal = await mfaAal();
  if (aal.next === "aal2" && aal.current !== "aal2") {
    return { mfaRequired: true };
  }
  await ensureProfileDoc();
  return { mfaRequired: false };
}

export async function signUpEmail(email: string, password: string, name?: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name: name ?? null } },
  });
  if (error) throw new Error(authErrorMessage(error));
  if (!data.session) {
    throw new Error(
      "CONFIRM_EMAIL: account created — check your inbox to confirm the address before signing in.",
    );
  }
  await ensureProfileDoc();
}

export async function signInGuest() {
  const { error } = await supabase.auth.signInAnonymously();
  if (error)
    throw new Error(
      `ANON_DISABLED: ${authErrorMessage(error)} — guest sign-in requires anonymous sign-ins to be enabled for this Supabase project.`,
    );
  await ensureProfileDoc();
}

export async function signOut() {
  await supabase.auth.signOut();
  profileCache = null;
}

// ---------------------------------------------------------------------------
// API SURFACE — identical shape to the previous layer
// ---------------------------------------------------------------------------

export const api = {
  // ----------------------------------------------------------------- users
  users: {
    currentUser: () =>
      liveDoc<UserProfile>(
        () => {
          const uid = authUserId();
          return uid ? { table: "profiles", column: "id", value: uid } : null;
        },
        mapProfile,
      ),
  },

  // ----------------------------------------------------------------- sites
  sites: {
    list: () =>
      live<(Site & { openActions: number })[]>(async () => {
        const user = await requireAuthed(true);
        // Unassigned accounts have no readable scope — empty, not an error.
        if (!user.role) return [];
        const [sitesRaw, casRaw] = await Promise.all([
          allRows<AnyRow>("sites"),
          allRows<AnyRow>("corrective_actions"),
        ]);
        const openBySite = new Map<string, number>();
        for (const ca of casRaw) {
          if (ca.status !== "closed" && ca.status !== "verified") {
            openBySite.set(
              ca.site_id as string,
              (openBySite.get(ca.site_id as string) ?? 0) + 1,
            );
          }
        }
        return sitesRaw
          .map(mapSite)
          .filter((s) => canAccessSite(user, s))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({ ...s, openActions: openBySite.get(s._id) ?? 0 }));
      }, ["sites", "corrective_actions"]),

    get: (args: { siteId: string }) =>
      live<Site | null>(async () => {
        const user = await requireAuthed();
        const site = await getSite(args.siteId);
        // Null (not a throw) so the detail page renders its
        // "not found or access denied" state instead of spinning forever.
        if (!site) return null;
        if (!canAccessSite(user, site)) return null;
        return site;
      }, ["sites"]),

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
    }) => {
      const user = await requireAdminUser();
      const existingCodes = await allSiteCodes();
      const code = nextSiteCodeFrom(args.county, existingCodes);
      const id = await insertReturningId("sites", {
        name: args.name,
        operator_name: args.operatorName,
        county: args.county,
        district: args.district ?? null,
        community: args.community ?? null,
        mineral_type: args.mineralType ?? null,
        latitude: args.latitude ?? null,
        longitude: args.longitude ?? null,
        notes: args.notes ?? null,
        status: "pending_verification",
        code,
        created_by: user.uid,
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "site.create",
        entityType: "sites",
        entityId: id,
        summary: `Registered site ${code} (${args.name}) in ${args.county}`,
      });
      await refreshPublicStats();
      return id;
    },

    setStatus: async (args: { siteId: string; status: string }) => {
      const user = await requireAdminUser();
      const site = await getSite(args.siteId);
      if (!site) throw new Error("NOT_FOUND");
      if (
        !["active", "suspended", "closed", "pending_verification"].includes(
          args.status,
        )
      ) {
        throw new Error("INVALID_STATUS");
      }
      const { error } = await supabase
        .from("sites")
        .update({ status: args.status })
        .eq("id", args.siteId);
      if (error) throw backendError(error);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "site.status",
        entityType: "sites",
        entityId: args.siteId,
        summary: `Site ${site.code} status set to ${args.status}`,
      });
    },

    /** Admin site edit (SITE-1). The client only decides WHICH columns
     *  change — the boundary lives server-side:
     *    * RLS "sites update" gates the write on the permission matrix
     *      (mg_has_permission('sites.update') — admin only), and
     *      mg_guard_site_write re-checks it before the row moves;
     *    * the server's mg_audit_row trigger writes the authoritative
     *      before/after diff in the SAME transaction (SEC-1 — the client
     *      cannot write audit_log at all), and sites_touch bumps
     *      row_version/updated_by;
     *    * changing operatorName clears organization_id first so the
     *      sites_org trigger re-resolves (or creates) the tenant by name —
     *      the same contract sites.create uses. A write that changes
     *      nothing is a no-op: no row_version bump, no audit row. */
    update: async (args: {
      siteId: string;
      name?: string;
      operatorName?: string;
      county?: string;
      district?: string;
      community?: string;
      mineralType?: string;
      latitude?: number | null;
      longitude?: number | null;
      notes?: string | null;
    }) => {
      const user = await requireAdminUser();
      const site = await getSite(args.siteId);
      if (!site) throw new Error("NOT_FOUND");

      const patch: AnyRow = {};
      const changed: string[] = [];
      /** Queue a column only when the value actually differs from the row
       *  (undefined fields are never sent; null-ish strings normalize to
       *  null so "clear district" works). */
      const put = (column: string, value: unknown, current: unknown) => {
        if (value === (current ?? null)) return;
        patch[column] = value;
        changed.push(column);
      };

      if (args.name !== undefined) {
        const v = args.name.trim();
        if (!v) throw new Error("INVALID_NAME");
        put("name", v, site.name);
      }
      if (args.county !== undefined) {
        const v = args.county.trim();
        if (!v) throw new Error("INVALID_COUNTY");
        put("county", v, site.county);
      }
      if (args.district !== undefined)
        put("district", args.district.trim() || null, site.district);
      if (args.community !== undefined)
        put("community", args.community.trim() || null, site.community);
      if (args.mineralType !== undefined)
        put("mineral_type", args.mineralType.trim() || null, site.mineralType);
      if (args.latitude !== undefined) {
        if (
          args.latitude !== null &&
          (args.latitude < -90 || args.latitude > 90)
        )
          throw new Error("INVALID_LATITUDE");
        put("latitude", args.latitude, site.latitude);
      }
      if (args.longitude !== undefined) {
        if (
          args.longitude !== null &&
          (args.longitude < -180 || args.longitude > 180)
        )
          throw new Error("INVALID_LONGITUDE");
        put("longitude", args.longitude, site.longitude);
      }
      if (args.notes !== undefined) put("notes", args.notes, site.notes);
      if (args.operatorName !== undefined) {
        const v = args.operatorName.trim();
        if (!v) throw new Error("INVALID_OPERATOR");
        if (v !== site.operatorName) {
          // Re-point the tenant: clear the binding so mg_sync_site_org
          // resolves (or mints) the organization by name on THIS write.
          // (A bare operator_name change on a bound row would be silently
          // re-derived from the old organization — see the sites_org trigger.)
          patch.organization_id = null;
          patch.operator_name = v;
          changed.push("operator_name");
        }
      }

      if (changed.length === 0) return site; // idempotent no-op

      const { error } = await supabase
        .from("sites")
        .update(patch)
        .eq("id", args.siteId);
      if (error) throw backendError(error);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "site.edit",
        entityType: "sites",
        entityId: args.siteId,
        summary: `Site ${site.code} updated: ${changed.join(", ")}`,
      });
      return (await getSite(args.siteId)) ?? site;
    },

    riskScores: () =>
      live<Record<string, { score: number; factors: { label: string; points: number }[] }>>(
        async () => {
          const user = await requireAuthed(true);
          if (!user.role) return {};
          // SEC-4 v2 — AGGREGATE IN THE DATABASE: mg_risk_scores (SECURITY
          // INVOKER, migration 0014) reduces the five input tables to ONE
          // count-aggregate row per visible site; the client rebuilds the
          // exact factor breakdown from RISK_WEIGHTS through the SAME factor
          // builder the fallback uses. No O(n) rows on the wire at any table
          // size, and the scope is the caller's RLS visibility — the same
          // policies the fallback's paged reads go through.
          const { data, error } = await supabase.rpc("mg_risk_scores");
          if (!error && Array.isArray(data)) {
            const byId: Record<
              string,
              { score: number; factors: RiskFactor[] }
            > = {};
            for (const raw of data as AnyRow[]) {
              const counts: RiskInputCounts = {
                findingsTotal: numOf(raw.findingsTotal),
                low: numOf(raw.lowFindings),
                medium: numOf(raw.mediumFindings),
                high: numOf(raw.highFindings),
                critical: numOf(raw.criticalFindings),
                overdueCAs: numOf(raw.overdueCAs),
                fatalityIncidents: numOf(raw.fatalityIncidents),
                seriousIncidents: numOf(raw.seriousIncidents),
                envAlerts: numOf(raw.envAlerts),
              };
              byId[String(raw.siteId)] = factorsFromCounts(counts);
            }
            return byId;
          }
          // Fallback (lineage without migration 0014): the original
          // full-input computation — exact at any size because every input
          // read pages; only the wire cost differs. Loud about why.
          console.warn(
            "[backend] mg_risk_scores unavailable — client-side aggregation fallback:",
            error ? error.message ?? String(error) : "unexpected payload",
          );
          const now = Date.now();
          const [sitesRaw, findingsRaw, casRaw, incRaw, envRaw] =
            await Promise.all([
              allRows<AnyRow>("sites"),
              allRows<AnyRow>("findings"),
              allRows<AnyRow>("corrective_actions"),
              allRows<AnyRow>("incidents"),
              allRows<AnyRow>("environmental_observations"),
            ]);
          const sites = sitesRaw.map(mapSite).filter((s) => canAccessSite(user, s));
          const byId: Record<
            string,
            { score: number; factors: RiskFactor[] }
          > = {};
          for (const site of sites) {
            const { score, factors } = computeRiskFactors(site, {
              findings: findingsRaw.map(mapFinding),
              correctiveActions: casRaw.map(mapCA),
              incidents: incRaw.map(mapIncident),
              observations: envRaw.map(mapObservation),
            }, now);
            byId[site._id] = { score, factors };
          }
          return byId;
        },
        ["sites", "findings", "corrective_actions", "incidents", "environmental_observations"],
      ),
  },

  // ---------------------------------------------------------------- ai
  // §18 AI assistance — FIRST capability only: risk-score explanation.
  // The fixed, user-visible assistance label (doc 08: "output is labeled as
  // assistance").
  // Governed by docs/08_AI_GOVERNANCE.MD. Implementation of the four
  // constraints, as stated:
  //
  // 1. SERVER-SIDE SCOPING — the inputs to the explanation are assembled
  //    by this data layer from the same scoped queries as riskScores; the
  //    caller's identity is re-derived server-side (requireAuthed), and the
  //    site access check is the authorization core's canAccessSite. There
  //    is no prompt-time privilege and no client-supplied content.
  // 2. CITE-OR-ABSTAIN — every explanation sentence is grounded in the
  //    factor's record IDs (computeRiskFactors attaches them). With no
  //    contributing factors the explainer abstains: the output states the
  //    site has no recorded risk inputs rather than inventing narrative.
  //    Nothing is ever synthesized beyond the weight arithmetic.
  // 3. HUMAN CONFIRMATION — the explanation is a read-only walkthrough.
  //    There is NO write path: no mutation, no draft, no state change —
  //    the authoritative record cannot be touched by this surface, so no
  //    confirmation flow is even reachable.
  // 4. PROVIDER KEYS SERVER-SIDE ONLY — satisfied structurally: this
  //    capability needs no provider model at all. It is a deterministic
  //    walkthrough of the existing weighted computation, so there is no
  //    key, no SDK, and no network call anywhere in the path (asserted by
  //    the test suite's source contract).
  //
  // AI output is LABELLED in the UI (never merged into any record), and
  // the hard prohibitions hold: no fabrication (cite-or-abstain), no
  // guilt/violation language (the model counts records, it does not judge),
  // no autonomous decisions (nothing to decide), no authorization bypass
  // (same core), no out-of-scope leakage (same core).
  ai: {
    explainRiskScore: (args: { siteId: string }) =>
      live<{
        siteId: string;
        generatedAt: number;
        abstained: boolean;
        summary: string | null;
        citations: string[];
        sentences: { factor: string; points: number; recordIds: string[]; text: string }[];
        disclaimer: string;
      } | null>(async () => {
        const user = await requireAuthed();
        if (!user.role) return null; // no AI narrative for role-less accounts
        // SEC-4 v2 — the explanation's inputs are assembled IN THE DATABASE:
        // mg_risk_explanation (SECURITY INVOKER, migration 0014) returns the
        // one site's count aggregates PLUS the record-id arrays the
        // cite-or-abstain contract anchors to. Scope is never re-derived
        // client-side: a site the caller cannot see yields no row — the same
        // null-mask as before ("not found OR out of scope → same null").
        const { data, error } = await supabase.rpc("mg_risk_explanation", {
          p_site_id: args.siteId,
        });
        if (!error && data && typeof data === "object") {
          return explanationFromRow(data as AnyRow);
        }
        // Fallback (lineage without migration 0014): the original path —
        // same scoped reads as the old riskScores; re-derive server-side.
        console.warn(
          "[backend] mg_risk_explanation unavailable — client-side fallback:",
          error ? error.message ?? String(error) : "unexpected payload",
        );
        const site = await getSite(args.siteId);
        if (!site) return null; // null-masked: not found OR out of scope
        if (!canAccessSite(user, site)) return null;
        const [findingsRaw, casRaw, incRaw, envRaw] = await Promise.all([
          allRows<AnyRow>("findings"),
          allRows<AnyRow>("corrective_actions"),
          allRows<AnyRow>("incidents"),
          allRows<AnyRow>("environmental_observations"),
        ]);
        const { score, factors } = computeRiskFactors(
          site,
          {
            findings: findingsRaw.map(mapFinding),
            correctiveActions: casRaw.map(mapCA),
            incidents: incRaw.map(mapIncident),
            observations: envRaw.map(mapObservation),
          },
          Date.now(),
        );

        const citations = [...new Set(factors.flatMap((f) => f.recordIds))].sort();
        // Cite-or-abstain: with no factors there is nothing to explain —
        // abstain rather than invent a narrative.
        if (factors.length === 0) {
          return {
            siteId: args.siteId,
            generatedAt: Date.now(),
            abstained: true,
            summary: null,
            citations: [],
            sentences: [],
            disclaimer: AI_DISCLAIMER,
          };
        }
        return {
          siteId: args.siteId,
          generatedAt: Date.now(),
          abstained: false,
          summary: `The risk indicator of ${score} for ${site.name} (${site.code}) is the sum of ${factors.length} recorded factor${factors.length === 1 ? "" : "s"}; each sentence below names the record it is grounded in.`,
          citations,
          sentences: explanationSentences(factors),
          disclaimer: AI_DISCLAIMER,
        };
      }, ["sites", "findings", "corrective_actions", "incidents", "environmental_observations"]),
  },

  // ----------------------------------------------------------- inspections
  inspections: {
    listTemplates: () =>
      live<InspectionTemplate[]>(async () => {
        await requireAuthed();
        // SEC-4: paged read — no unranged select anywhere (the active filter
        // narrows the set; the ordered Range keeps correctness independent of
        // the server's row cap at any table size).
        const rows = await pagedRows<AnyRow>((from, to) =>
          supabase
            .from("inspection_templates")
            .select("*")
            .eq("active", true)
            .order("id", { ascending: true })
            .range(from, to),
        );
        // 0009: archived templates (soft-deleted) leave every surface.
        return rows.filter((r) => !r.archived_at).map(mapTemplate);
      }, ["inspection_templates"]),

    /** ALL templates regardless of active flag — the template editor's list
     *  (§11: inspection design configurable without a code change). */
    listTemplatesAll: () =>
      live<InspectionTemplate[]>(async () => {
        const user = await requireStaffUser();
        void user; // inspectors/supervisors may READ templates too — admin surface only for writes
        // SEC-4: paged read ordered by the primary key (stable windows), then
        // displayed newest-first — the same order the SQL ORDER BY produced.
        const rows = await allRows<AnyRow>("inspection_templates");
        // 0009: archived templates are gone from the editor list too —
        // archive is this app's delete (row stays for history/audit).
        return rows
          .filter((r) => !r.archived_at)
          .map(mapTemplate)
          .sort((a, b) => b.createdAt - a.createdAt);
      }, ["inspection_templates"]),

    /** Create or update a template. The sections JSON is validated here —
     *  the client editor enforces shape, but the data layer is the boundary
     *  that must never persist a malformed template into the field flow
     *  (draft answers key on `si:qi`, so shape IS a contract). */
    saveTemplate: async (args: {
      templateId?: string;
      name: string;
      description?: string;
      active: boolean;
      sections: InspectionTemplate["sections"];
    }) => {
      const user = await requireAdminUser();
      const name = args.name.trim();
      if (!name) throw new Error("TEMPLATE_NAME_REQUIRED");
      if (name.length > 120) throw new Error("TEMPLATE_NAME_TOO_LONG");
      const validation = validateTemplateSections(args.sections);
      if (validation) throw new Error(validation);

      const row: Record<string, unknown> = {
        name,
        description: args.description?.trim() || null,
        active: args.active === true,
        sections: args.sections,
      };
      if (args.templateId) {
        const { error } = await supabase
          .from("inspection_templates")
          .update(row)
          .eq("id", args.templateId);
        if (error) throw backendError(error);
        await logAudit({
          actorId: user.uid,
          actorLabel: await actorLabel(user),
          action: "template.update",
          entityType: "inspection_templates",
          entityId: args.templateId,
          summary: `Template “${name}” updated (${args.sections.length} section(s))`,
        });
        return args.templateId;
      }
      const id = await insertReturningId("inspection_templates", {
        ...row,
        created_by: user.uid,
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "template.create",
        entityType: "inspection_templates",
        entityId: id,
        summary: `Template “${name}” created (${args.sections.length} section(s))`,
      });
      return id;
    },

    /** Set the active flag (the publish/unpublish switch). */
    setTemplateActive: async (args: { templateId: string; active: boolean }) => {
      const user = await requireAdminUser();
      const { error } = await supabase
        .from("inspection_templates")
        .update({ active: args.active })
        .eq("id", args.templateId);
      if (error) throw backendError(error);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "template.active",
        entityType: "inspection_templates",
        entityId: args.templateId,
        summary: `Template ${args.active ? "published" : "unpublished"}`,
      });
    },

    /** Archive a template — the soft-delete lifecycle (SEC-2, migration
     *  0009): client DELETE is revoked outright and the guard trigger
     *  refuses hard DELETE for everyone, so archiving (archived_at stamp,
     *  server-audited) is how templates are retired. Refused while
     *  inspections reference the template so history keeps its shape. */
    archiveTemplate: async (args: { templateId: string }) => {
      const user = await requireAdminUser();
      const used = await supabase
        .from("inspections")
        .select("id")
        .eq("template_id", args.templateId)
        .limit(1);
      if (used.error) throw backendError(used.error);
      if ((used.data ?? []).length > 0) throw new Error("TEMPLATE_IN_USE");
      // archived_at is the only client-supplied piece (wall clock); the
      // attribution (updated_by) and the audit row are stamped server-side.
      const { error } = await supabase
        .from("inspection_templates")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", args.templateId);
      if (error) throw backendError(error);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "template.archive",
        entityType: "inspection_templates",
        entityId: args.templateId,
        summary: "Template archived",
      });
    },

    list: () =>
      live<InspectionListRow[]>(async () => {
        const user = await requireAuthed(true);
        if (!user.role) return [];
        return fetchInspections(user);
      }, ["inspections", "sites"]),

    /** SEC-4 v2 — the inspections list page's keyset page (migration 0014's
     *  SECURITY INVOKER mg_inspections_page): (created_at, id) DESC windows.
     *  The inspector-owns-row rule is already an RLS predicate on the table,
     *  so the page reproduces the client list's visible set without
     *  re-deriving scope. Fallback on a pre-0014 lineage: the complete
     *  authorized feed in one page (exact, just not incremental); a load-more
     *  request returns an empty page rather than repeating rows. */
    inspectionsPage: async (args: {
      before?: KeysetCursor | null;
      limit?: number;
    }): Promise<KeysetPage<InspectionListRow>> => {
      const user = await requireAuthed(true);
      if (!user.role) return { rows: [], nextCursor: null, source: "fallback" };
      const limit = Math.min(
        Math.max(1, Math.trunc(args.limit ?? KEYSET_PAGE_SIZE)),
        POSTGREST_MAX_ROWS,
      );
      const viaRpc = await keysetPageRpc(
        "mg_inspections_page",
        args.before ?? null,
        limit,
        mapInspectionPageRow,
      );
      if (viaRpc) return viaRpc;
      if (args.before) return { rows: [], nextCursor: null, source: "fallback" };
      console.warn(
        "[backend] mg_inspections_page unavailable — full authorized feed in one page (migration 0014 not applied); list stays exact, paging inactive",
      );
      return { rows: await fetchInspections(user), nextCursor: null, source: "fallback" };
    },

    /** The §9 compliance export's row source (see api.exports): the same
     *  keyset-page contract over corrective actions + finding + site, joined
     *  in SQL. No UI page consumes it — the live feed keeps its richer
     *  openest-first ordering. */
    compliancePage: async (args: {
      before?: KeysetCursor | null;
      limit?: number;
    }): Promise<KeysetPage<CompliancePageRow>> => {
      const user = await requireAuthed(true);
      if (!user.role) return { rows: [], nextCursor: null, source: "fallback" };
      const limit = Math.min(
        Math.max(1, Math.trunc(args.limit ?? KEYSET_PAGE_SIZE)),
        POSTGREST_MAX_ROWS,
      );
      const viaRpc = await keysetPageRpc(
        "mg_compliance_page",
        args.before ?? null,
        limit,
        mapCompliancePageRow,
      );
      if (viaRpc) return viaRpc;
      if (args.before) return { rows: [], nextCursor: null, source: "fallback" };
      console.warn(
        "[backend] mg_compliance_page unavailable — full authorized feed in one page (migration 0014 not applied); export stays exact, streaming inactive",
      );
      return { rows: await fetchCompliance(user), nextCursor: null, source: "fallback" };
    },

    get: (args: { inspectionId: string }) =>
      live<Inspection | null>(async () => {
        const user = await requireAuthed();
        const { data, error } = await supabase
          .from("inspections")
          .select("*")
          .eq("id", args.inspectionId)
          .maybeSingle();
        if (error) throw backendError(error);
        if (!data) return null;
        const insp = mapInspection(data);
        const site = await getSite(insp.siteId);
        if (!site || !canAccessSite(user, site)) return null;
        return insp;
      }, ["inspections"]),

    createDraft: async (args: {
      siteId: string;
      templateId: string;
      clientRef?: string;
    }) => {
      const user = await requireStaffUser();
      const site = await getSite(args.siteId);
      if (!site) throw new Error("NOT_FOUND");
      if (user.scope === "county" && user.county !== site.county)
        throw new Error("FORBIDDEN");

      // Offline dedupe: same clientRef returns the existing record.
      if (args.clientRef) {
        const { data } = await supabase
          .from("inspections")
          .select("id")
          .eq("client_ref", args.clientRef)
          .limit(1);
        if (data && data.length > 0) return data[0].id as string;
      }

      const id = await insertReturningId("inspections", {
        site_id: args.siteId,
        template_id: args.templateId,
        inspector_id: user.uid,
        status: "draft",
        client_ref: args.clientRef ?? null,
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "inspection.draft",
        entityType: "inspections",
        entityId: id,
        summary: `Draft inspection created at ${site.code}`,
      });
      return id;
    },

    updateDraft: async (args: {
      inspectionId: string;
      answers?: Record<string, unknown>;
      notes?: string;
      latitude?: number;
      longitude?: number;
      gpsAccuracyM?: number;
    }) => {
      const user = await requireAuthed();
      const { data, error: e1 } = await supabase
        .from("inspections")
        .select("*")
        .eq("id", args.inspectionId)
        .maybeSingle();
      if (e1) throw backendError(e1);
      if (!data) throw new Error("NOT_FOUND");
      const insp = mapInspection(data);
      if (insp.inspectorId !== user.uid) throw new Error("FORBIDDEN");
      if (insp.status !== "draft") throw new Error("NOT_EDITABLE");
      const patch: AnyRow = {};
      if (args.answers !== undefined) patch.answers = args.answers;
      if (args.notes !== undefined) patch.notes = args.notes;
      if (args.latitude !== undefined) patch.latitude = args.latitude;
      if (args.longitude !== undefined) patch.longitude = args.longitude;
      if (args.gpsAccuracyM !== undefined) patch.gps_accuracy_m = args.gpsAccuracyM;
      const { error } = await supabase
        .from("inspections")
        .update(patch)
        .eq("id", args.inspectionId);
      if (error) throw backendError(error);
    },

    submit: async (args: { inspectionId: string }) => {
      const user = await requireAuthed();
      const { data, error: e1 } = await supabase
        .from("inspections")
        .select("*")
        .eq("id", args.inspectionId)
        .maybeSingle();
      if (e1) throw backendError(e1);
      if (!data) throw new Error("NOT_FOUND");
      const insp = mapInspection(data);
      if (insp.inspectorId !== user.uid) throw new Error("FORBIDDEN");
      if (insp.status !== "draft") throw new Error("NOT_EDITABLE");
      const { error } = await supabase
        .from("inspections")
        .update({ status: "under_review", submitted_at: iso(Date.now()) })
        .eq("id", args.inspectionId);
      if (error) throw backendError(error);
      const site = await getSite(insp.siteId);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "inspection.submit",
        entityType: "inspections",
        entityId: args.inspectionId,
        summary: `Inspection submitted for review at ${site?.code ?? insp.siteId}`,
      });
      await refreshPublicStats();
    },

    review: async (args: {
      inspectionId: string;
      decision: "approved" | "rejected";
      note?: string;
    }) => {
      const user = await requireReviewerUser();
      const { data, error: e1 } = await supabase
        .from("inspections")
        .select("*")
        .eq("id", args.inspectionId)
        .maybeSingle();
      if (e1) throw backendError(e1);
      if (!data) throw new Error("NOT_FOUND");
      if (data.status !== "under_review") throw new Error("NOT_REVIEWABLE");
      const { error } = await supabase
        .from("inspections")
        .update({
          status: args.decision,
          reviewed_at: iso(Date.now()),
          reviewer_id: user.uid,
          review_note: args.note ?? null,
        })
        .eq("id", args.inspectionId);
      if (error) throw backendError(error);
      const site = await getSite((data as AnyRow).site_id as string);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: `inspection.${args.decision}`,
        entityType: "inspections",
        entityId: args.inspectionId,
        summary: `Inspection at ${site?.code ?? (data as AnyRow).site_id} ${args.decision} by reviewer`,
      });
    },

    listFindingsForInspection: (args: { inspectionId: string }) =>
      live<Finding[]>(async () => {
        const user = await requireAuthed();
        const { data: inspRow, error: e1 } = await supabase
          .from("inspections")
          .select("*")
          .eq("id", args.inspectionId)
          .maybeSingle();
        if (e1) throw backendError(e1);
        if (!inspRow) throw new Error("NOT_FOUND");
        const insp = mapInspection(inspRow);
        const site = await getSite(insp.siteId);
        if (!site || !canAccessSite(user, site)) throw new Error("FORBIDDEN");
        // SEC-4: the same paged read as every whole-table scan — a parent's
        // findings are bounded by that parent's volume, but the read must
        // never depend on the server's row cap.
        const rows = await pagedEqRows<AnyRow>("findings", "inspection_id", args.inspectionId);
        return rows.map(mapFinding);
      }, ["findings"]),

    /** Findings feed for the operator portal (§20): every finding on sites
     *  the caller can access, joined with site identity. Operators are
     *  strictly tenant-scoped (RLS + mirror); staff get their own scope. */
    listMyFindings: () =>
      live<
        (Finding & { siteCode: string; siteName: string; county: string })[]
      >(async () => {
        const user = await requireAuthed(true);
        if (!user.role) return [];
        const [findingRaw, siteRaw] = await Promise.all([
          allRows<AnyRow>("findings"),
          allRows<AnyRow>("sites"),
        ]);
        const sites = new Map(siteRaw.map((r) => [r.id as string, mapSite(r)]));
        const out = [];
        for (const r of findingRaw) {
          const f = mapFinding(r);
          const site = sites.get(f.siteId);
          if (!site || !canAccessSite(user, site)) continue;
          out.push({
            ...f,
            siteCode: site.code,
            siteName: site.name,
            county: site.county,
          });
        }
        // Openest findings first, then newest.
        const openRank = (s: Finding["status"]) =>
          s === "open" ? 0 : s === "acknowledged" ? 1 : s === "resolved" ? 2 : 3;
        out.sort(
          (a, b) =>
            openRank(a.status) - openRank(b.status) || b.createdAt - a.createdAt,
        );
        return out;
      }, ["findings", "sites"]),

    addFinding: async (args: {
      inspectionId: string;
      title: string;
      description?: string;
      severity: Finding["severity"];
    }) => {
      const user = await requireStaffUser();
      const { data: inspRow, error: e1 } = await supabase
        .from("inspections")
        .select("*")
        .eq("id", args.inspectionId)
        .maybeSingle();
      if (e1) throw backendError(e1);
      if (!inspRow) throw new Error("NOT_FOUND");
      const insp = mapInspection(inspRow);
      const site = await getSite(insp.siteId);
      if (!site) throw new Error("NOT_FOUND");
      const id = await insertReturningId("findings", {
        inspection_id: args.inspectionId,
        site_id: insp.siteId,
        title: args.title,
        description: args.description ?? null,
        severity: args.severity,
        status: "open",
        created_by_id: user.uid,
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "finding.create",
        entityType: "findings",
        entityId: id,
        summary: `${args.severity.toUpperCase()} finding recorded: ${args.title}`,
      });
      return id;
    },

    updateFindingStatus: async (args: {
      findingId: string;
      status: Finding["status"];
    }) => {
      const user = await requireAuthed();
      const { data, error: e1 } = await supabase
        .from("findings")
        .select("*")
        .eq("id", args.findingId)
        .maybeSingle();
      if (e1) throw backendError(e1);
      if (!data) throw new Error("NOT_FOUND");
      const finding = mapFinding(data);
      const site = await getSite(finding.siteId);
      if (!site) throw new Error("NOT_FOUND");
      const isOwner = finding.createdById === user.uid;
      const isReviewer =
        user.role === ROLES.ADMIN || user.role === ROLES.SUPERVISOR;
      const isSiteOperator =
        user.role === ROLES.OPERATOR && user.operatorName === site.operatorName;
      // Operators may only acknowledge; staff/reviewers may resolve/verify.
      if (isSiteOperator) {
        if (args.status !== "acknowledged") throw new Error("FORBIDDEN");
      } else if (!isOwner && !isReviewer) {
        throw new Error("FORBIDDEN");
      }
      const { error } = await supabase
        .from("findings")
        .update({ status: args.status })
        .eq("id", args.findingId);
      if (error) throw backendError(error);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "finding.status",
        entityType: "findings",
        entityId: args.findingId,
        summary: `Finding "${finding.title}" set to ${args.status}`,
      });
    },

    listCorrectiveActions: (args: { findingId: string }) =>
      live<CorrectiveAction[]>(async () => {
        const user = await requireAuthed();
        const { data, error: e1 } = await supabase
          .from("findings")
          .select("*")
          .eq("id", args.findingId)
          .maybeSingle();
        if (e1) throw backendError(e1);
        if (!data) throw new Error("NOT_FOUND");
        const finding = mapFinding(data);
        const site = await getSite(finding.siteId);
        if (!site || !canAccessSite(user, site)) throw new Error("FORBIDDEN");
        // SEC-4: paged read (see listFindingsForInspection).
        const rows = await pagedEqRows<AnyRow>("corrective_actions", "finding_id", args.findingId);
        return rows.map(mapCA);
      }, ["corrective_actions"]),

    listSiteCorrectiveActions: (args: { siteId: string }) =>
      live<CorrectiveAction[]>(async () => {
        const user = await requireAuthed();
        const site = await getSite(args.siteId);
        if (!site || !canAccessSite(user, site)) return [];
        // SEC-4: paged read (see listFindingsForInspection).
        const rows = await pagedEqRows<AnyRow>("corrective_actions", "site_id", args.siteId);
        return rows.map(mapCA);
      }, ["corrective_actions"]),

    /** Compliance obligations for the operator portal (§20): every corrective
     *  action on sites the caller can access, joined with the finding title
     *  and site identity. Operators are strictly tenant-scoped by RLS + the
     *  client mirror; staff get the same feed over their own scope. */
    listMyCorrectiveActions: () =>
      live<ComplianceListRow[]>(async () => {
        const user = await requireAuthed(true);
        if (!user.role) return [];
        return fetchCompliance(user);
      }, ["corrective_actions", "findings", "sites"]),

    openCorrectiveAction: async (args: {
      findingId: string;
      description: string;
      dueAt: number;
    }) => {
      const user = await requireStaffUser();
      const { data, error: e1 } = await supabase
        .from("findings")
        .select("*")
        .eq("id", args.findingId)
        .maybeSingle();
      if (e1) throw backendError(e1);
      if (!data) throw new Error("NOT_FOUND");
      const finding = mapFinding(data);
      const site = await getSite(finding.siteId);
      if (!site) throw new Error("NOT_FOUND");
      const id = await insertReturningId("corrective_actions", {
        finding_id: args.findingId,
        site_id: finding.siteId,
        description: args.description,
        status: "open",
        due_at: iso(args.dueAt),
        opened_by_id: user.uid,
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "ca.open",
        entityType: "corrective_actions",
        entityId: id,
        summary: `Corrective action opened (due ${new Date(args.dueAt).toISOString().slice(0, 10)}): ${args.description.slice(0, 80)}`,
      });
      return id;
    },

    respondCorrectiveAction: async (args: {
      caId: string;
      operatorNote: string;
      /** row_version the operator was looking at (OFF-4). When present the
       *  update is conditional on it — a row someone else changed first
       *  answers CONFLICT (HTTP 409) with a snapshot for the resolution
       *  screen instead of silently overwriting their work. */
      expectedRowVersion?: number;
    }) => {
      const user = await requireAuthed();
      const { data, error: e1 } = await supabase
        .from("corrective_actions")
        .select("*")
        .eq("id", args.caId)
        .maybeSingle();
      if (e1) throw backendError(e1);
      if (!data) throw new Error("NOT_FOUND");
      const ca = mapCA(data);
      const site = await getSite(ca.siteId);
      if (!site) throw new Error("NOT_FOUND");
      if (user.role !== ROLES.OPERATOR || user.operatorName !== site.operatorName)
        throw new Error("FORBIDDEN");
      // Idempotent replay (OFF: mid-sync crash): the server applied this
      // response but the local queue removal was interrupted. Same note on
      // an already-submitted action IS the desired end state — report
      // success so the queue drains instead of dead-ending on the guard.
      if (ca.status === "submitted" && (ca.operatorNote ?? "") === args.operatorNote) {
        return;
      }
      let query = supabase
        .from("corrective_actions")
        .update({ operator_note: args.operatorNote, status: "submitted" })
        .eq("id", args.caId);
      if (args.expectedRowVersion != null) {
        query = query.eq("row_version", args.expectedRowVersion);
      }
      const { data: updated, error } = await query.select("id");
      if (error) throw backendError(error);
      if (args.expectedRowVersion != null && (!updated || updated.length === 0)) {
        // Zero rows matched: someone bumped row_version first. Fetch the
        // current row so the human resolution screen can show both sides.
        const { data: cur } = await supabase
          .from("corrective_actions")
          .select("*")
          .eq("id", args.caId)
          .maybeSingle();
        if (!cur) throw new Error("NOT_FOUND");
        const curCa = mapCA(cur);
        const conflict = new Error(
          `CONFLICT:${JSON.stringify({
            server: {
              status: curCa.status,
              operatorNote: curCa.operatorNote ?? null,
              rowVersion: curCa.rowVersion ?? null,
              closedAt: curCa.closedAt ?? null,
              verifiedById: curCa.verifiedById ?? null,
            },
          })}`,
        ) as Error & { code?: string };
        conflict.code = "409";
        throw conflict;
      }
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "ca.respond",
        entityType: "corrective_actions",
        entityId: args.caId,
        summary: "Operator response submitted for corrective action",
      });
    },

    decideCorrectiveAction: async (args: {
      caId: string;
      decision: CorrectiveAction["status"];
    }) => {
      const user = await requireReviewerUser();
      const { data, error: e1 } = await supabase
        .from("corrective_actions")
        .select("*")
        .eq("id", args.caId)
        .maybeSingle();
      if (e1) throw backendError(e1);
      if (!data) throw new Error("NOT_FOUND");
      const ca = mapCA(data);
      const { error } = await supabase
        .from("corrective_actions")
        .update({
          status: args.decision,
          verified_by_id: user.uid,
          closed_at:
            args.decision === "closed"
              ? iso(Date.now())
              : ca.closedAt
                ? iso(ca.closedAt)
                : null,
        })
        .eq("id", args.caId);
      if (error) throw backendError(error);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: `ca.${args.decision}`,
        entityType: "corrective_actions",
        entityId: args.caId,
        summary: `Corrective action ${args.decision}`,
      });
    },
  },

  // --------------------------------------------------------------- records
  records: {
    listIncidents: () =>
      live<(Incident & { siteCode: string; siteName: string; county: string })[]>(
        async () => {
          const user = await requireAuthed(true);
          if (!user.role) return [];
          return fetchIncidents(user);
        },
        ["incidents", "sites"],
      ),

    /** SEC-4 v2 — the incidents list page's keyset page (migration 0014's
     *  SECURITY INVOKER mg_incidents_page): (occurred_at, id) DESC windows
     *  resumable by cursor, immune to offset skew from concurrent inserts.
     *  On a lineage without 0014 the FIRST page falls back to the complete
     *  authorized feed in one page (hasMore=false — exact either way), and a
     *  load-more request returns an EMPTY page rather than repeating rows
     *  that fallback already carried. */
    incidentsPage: async (args: {
      before?: KeysetCursor | null;
      limit?: number;
    }): Promise<
      KeysetPage<Incident & { siteCode: string; siteName: string; county: string }>
    > => {
      const user = await requireAuthed(true);
      if (!user.role) return { rows: [], nextCursor: null, source: "fallback" };
      const limit = Math.min(
        Math.max(1, Math.trunc(args.limit ?? KEYSET_PAGE_SIZE)),
        POSTGREST_MAX_ROWS,
      );
      const viaRpc = await keysetPageRpc(
        "mg_incidents_page",
        args.before ?? null,
        limit,
        mapIncidentPageRow,
      );
      if (viaRpc) return viaRpc;
      if (args.before) return { rows: [], nextCursor: null, source: "fallback" };
      console.warn(
        "[backend] mg_incidents_page unavailable — full authorized feed in one page (migration 0014 not applied); list stays exact, paging inactive",
      );
      return { rows: await fetchIncidents(user), nextCursor: null, source: "fallback" };
    },

    getIncident: (args: { incidentId: string }) =>
      live<Incident | null>(async () => {
        const user = await requireAuthed();
        const { data, error } = await supabase
          .from("incidents")
          .select("*")
          .eq("id", args.incidentId)
          .maybeSingle();
        if (error) throw backendError(error);
        if (!data) return null;
        const inc = mapIncident(data);
        const site = await getSite(inc.siteId);
        if (!site || !canAccessSite(user, site)) return null;
        return { ...inc, siteCode: site.code, siteName: site.name, county: site.county };
      }, ["incidents", "sites"]),

    reportIncident: async (args: {
      siteId: string;
      type: Incident["type"];
      severity: Incident["severity"];
      description: string;
      occurredAt: number;
      fatalities?: number;
      injured?: number;
      clientRef?: string;
    }) => {
      const user = await requireAuthed();
      // Offline dedupe: the same queued submission replayed after reconnect
      // must not create a second incident record.
      if (args.clientRef) {
        const { data } = await supabase
          .from("incidents")
          .select("id")
          .eq("client_ref", args.clientRef)
          .limit(1);
        if (data && data.length > 0) return data[0].id as string;
      }
      const site = await getSite(args.siteId);
      if (!site) throw new Error("NOT_FOUND");
      if (!canAccessSite(user, site)) throw new Error("FORBIDDEN");
      const id = await insertReturningId("incidents", {
        site_id: args.siteId,
        type: args.type,
        severity: args.severity,
        description: args.description,
        occurred_at: iso(args.occurredAt),
        fatalities: args.fatalities ?? null,
        injured: args.injured ?? null,
        status: "reported",
        client_ref: args.clientRef ?? null,
        reported_by_id: user.uid,
        report_source: user.role === ROLES.OPERATOR ? "operator" : "inspector",
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "incident.report",
        entityType: "incidents",
        entityId: id,
        summary: `${args.type.replace("_", " ")} reported at ${site.code}`,
      });
      await refreshPublicStats();
      return id;
    },

    setIncidentStatus: async (args: {
      incidentId: string;
      status: "investigating" | "closed";
    }) => {
      const user = await requireStaffUser();
      const { error } = await supabase
        .from("incidents")
        .update({ status: args.status })
        .eq("id", args.incidentId);
      if (error) throw backendError(error);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "incident.status",
        entityType: "incidents",
        entityId: args.incidentId,
        summary: `Incident status set to ${args.status}`,
      });
    },

    listObservations: () =>
      live<EnvironmentalObservation[]>(async () => {
        const user = await requireAuthed(true);
        if (!user.role) return [];
        const [obsRaw, siteRaw] = await Promise.all([
          allRows<AnyRow>("environmental_observations"),
          allRows<AnyRow>("sites"),
        ]);
        const byId = new Map(siteRaw.map((r) => [r.id as string, mapSite(r)]));
        const out: EnvironmentalObservation[] = [];
        for (const r of obsRaw) {
          const o = mapObservation(r);
          const site = byId.get(o.siteId);
          if (!site) continue;
          if (!canAccessSite(user, site)) continue;
          out.push({ ...o, siteCode: site.code, siteName: site.name, county: site.county });
        }
        out.sort((a, b) => b.observedAt - a.observedAt);
        return out;
      }, ["environmental_observations", "sites"]),

    getObservation: (args: { observationId: string }) =>
      live<EnvironmentalObservation | null>(async () => {
        const user = await requireAuthed();
        const { data, error } = await supabase
          .from("environmental_observations")
          .select("*")
          .eq("id", args.observationId)
          .maybeSingle();
        if (error) throw backendError(error);
        if (!data) return null;
        const obs = mapObservation(data);
        const site = await getSite(obs.siteId);
        if (!site || !canAccessSite(user, site)) return null;
        return { ...obs, siteCode: site.code, siteName: site.name, county: site.county };
      }, ["environmental_observations", "sites"]),

    reportObservation: async (args: {
      siteId: string;
      category: EnvironmentalObservation["category"];
      verification: EnvironmentalObservation["verification"];
      description: string;
      observedAt: number;
      latitude?: number;
      longitude?: number;
      clientRef?: string;
    }) => {
      const user = await requireAuthed();
      // Offline dedupe (same contract as createDraft/reportIncident).
      if (args.clientRef) {
        const { data } = await supabase
          .from("environmental_observations")
          .select("id")
          .eq("client_ref", args.clientRef)
          .limit(1);
        if (data && data.length > 0) return data[0].id as string;
      }
      const site = await getSite(args.siteId);
      if (!site) throw new Error("NOT_FOUND");
      if (!canAccessSite(user, site)) throw new Error("FORBIDDEN");
      const id = await insertReturningId("environmental_observations", {
        site_id: args.siteId,
        category: args.category,
        verification: args.verification,
        description: args.description,
        observed_at: iso(args.observedAt),
        latitude: args.latitude ?? null,
        longitude: args.longitude ?? null,
        status: "open",
        client_ref: args.clientRef ?? null,
        reported_by_id: user.uid,
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "observation.report",
        entityType: "environmental_observations",
        entityId: id,
        summary: `${args.category.replace("_", " ")} (${args.verification}) at ${site.code}`,
      });
      return id;
    },

    setObservationStatus: async (args: {
      observationId: string;
      status: "open" | "monitoring" | "resolved";
    }) => {
      const user = await requireStaffUser();
      const { error } = await supabase
        .from("environmental_observations")
        .update({ status: args.status })
        .eq("id", args.observationId);
      if (error) throw backendError(error);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "observation.status",
        entityType: "environmental_observations",
        entityId: args.observationId,
        summary: `Observation status set to ${args.status}`,
      });
    },

    listCommunityReports: () =>
      live<CommunityReport[]>(async () => {
        // Staff-only data (RLS); non-staff get an empty queue, not a hang.
        const user = await requireAuthed(true);
        if (!isStaffRole(user.role)) return [];
        const rows = await allRows<AnyRow>("community_reports");
        return rows.map(mapReport).sort((a, b) => b.createdAt - a.createdAt);
      }, ["community_reports"]),

    /** Public: anyone may submit a concern. No authentication required. */
    submitCommunityReport: async (args: {
      category: CommunityReport["category"];
      description: string;
      county: string;
      district?: string;
      community?: string;
      latitude?: number;
      longitude?: number;
      contactPhone?: string;
    }) => {
      // Rate limiting, tracking mirror and audit are enforced server-side by
      // the security-definer RPC (30 reports/minute cap).
      const { data, error } = await supabase.rpc("submit_community_report", {
        p_tracking_code: makeTrackingCode(),
        p_category: args.category,
        p_description: args.description,
        p_county: args.county,
        p_district: args.district ?? null,
        p_community: args.community ?? null,
        p_latitude: args.latitude ?? null,
        p_longitude: args.longitude ?? null,
        p_contact_phone: args.contactPhone ?? null,
      });
      if (error) throw backendError(error);
      const payload = data as { id: string; trackingCode: string };
      return { id: payload.id, trackingCode: payload.trackingCode };
    },

    /** Public: track by code. Returns only coarse, non-sensitive fields. */
    trackCommunityReport: (args: { trackingCode: string }) =>
      live<{ trackingCode: string; status: string; createdAt: number } | null>(
        async () => {
          const code = args.trackingCode.trim().toUpperCase();
          const { data, error } = await supabase
            .from("report_tracking")
            .select("*")
            .eq("tracking_code", code)
            .maybeSingle();
          if (error) throw backendError(error);
          if (!data) return null;
          return {
            trackingCode: data.tracking_code as string,
            status: data.status as string,
            createdAt: toMs(data.created_at),
          };
        },
        ["report_tracking"],
      ),

    triageCommunityReport: async (args: {
      reportId: string;
      decision: CommunityReport["status"];
      note?: string;
    }) => {
      await requireReviewerUser();
      const { error } = await supabase.rpc("triage_community_report", {
        p_report_id: args.reportId,
        p_decision: args.decision,
        p_note: args.note ?? null,
      });
      if (error) throw backendError(error);
    },

    // ------------------------------------------------------- notifications
    // §1 MINIMAL IN-APP NOTIFICATIONS — derived, not stored.
    //
    // SCOPE DECISION: v1 notifications are COMPUTED at request time from
    // records the caller can already see. No notifications table, no
    // delivery infrastructure, no cost, no retention question. The v1 event
    // classes (the two the directive names):
    //   * corrective-action DEADLINES — open CAs in the caller's scope,
    //     flagged due-soon (≤3 days) or overdue, with per-record links;
    //   * community-report STATUS CHANGES — staff see triaged (under_review /
    //     verified / dismissed / referred) reports from the last 7 days;
    //     a reporter-visible variant is NOT possible without knowing who the
    //     anonymous reporter was (tracking-code lookup stays the public's
    //     channel by design).
    // Push / email / SMS are EXPLICITLY NOT implemented — they imply new
    // infrastructure and cost (provider accounts, PII handling, retention)
    // and are classified REQUIRES GOVERNMENT/OWNER CONFIRMATION in docs/01.

    listNotifications: () =>
      live<
        {
          id: string;
          kind: "ca_deadline" | "ca_decision" | "report_status";
          severity: "info" | "warning" | "urgent";
          title: string;
          body: string;
          linkTo: string;
          at: number;
        }[]
      >(async () => {
        const user = await requireAuthed(true);
        if (!user.role) return [];
        const now = Date.now();
        const DAY = 86_400_000;
        const out: {
          id: string;
          kind: "ca_deadline" | "ca_decision" | "report_status";
          severity: "info" | "warning" | "urgent";
          title: string;
          body: string;
          linkTo: string;
          at: number;
        }[] = [];

        // 1. Corrective-action deadlines in the caller's scope. For operators
        //    this is their tenant's obligations; for staff their own scope —
        //    the same scoped feeds the portal pages use.
        const [caRaw, findingRaw, siteRaw] = await Promise.all([
          allRows<AnyRow>("corrective_actions"),
          allRows<AnyRow>("findings"),
          allRows<AnyRow>("sites"),
        ]);
        const findings = new Map(findingRaw.map((r) => [r.id as string, mapFinding(r)]));
        const sites = new Map(siteRaw.map((r) => [r.id as string, mapSite(r)]));
        for (const r of caRaw) {
          const ca = mapCA(r);
          if (ca.status !== "open" && ca.status !== "in_progress") continue;
          const site = sites.get(ca.siteId);
          if (!site || !canAccessSite(user, site)) continue;
          const finding = findings.get(ca.findingId);
          const dueMs = ca.dueAt - now;
          const isOverdue = dueMs < 0;
          if (!isOverdue && dueMs > 3 * DAY) continue; // due-soon window: ≤3d
          const siteLabel = `${site.code} ${site.name}`;
          out.push({
            id: `ca-${ca._id}`,
            kind: "ca_deadline",
            severity: isOverdue ? "urgent" : "warning",
            title: isOverdue
              ? `Overdue corrective action at ${siteLabel}`
              : `Corrective action due soon at ${siteLabel}`,
            body: `${finding?.title ?? "Compliance finding"} — ${ca.description}`,
            linkTo: user.role === ROLES.OPERATOR ? "/operate/corrective-actions" : `/portal/sites/${site._id}`,
            at: ca.dueAt,
          });
        }

        // 2. Reviewer decisions on corrective actions the caller opened —
        //    the operator learns their response was verified/closed/escalated.
        if (user.role === ROLES.OPERATOR && user.operatorName) {
          for (const r of caRaw) {
            const ca = mapCA(r);
            if (ca.openedById !== user.uid) continue;
            if (ca.status !== "verified" && ca.status !== "closed" && ca.status !== "escalated") continue;
            const site = sites.get(ca.siteId);
            if (!site) continue;
            out.push({
              id: `cad-${ca._id}`,
              kind: "ca_decision",
              severity: ca.status === "escalated" ? "urgent" : "info",
              title:
                ca.status === "escalated"
                  ? `Corrective action ESCALATED at ${site.code} ${site.name}`
                  : `Corrective action ${ca.status} at ${site.code} ${site.name}`,
              body: ca.description,
              linkTo: "/operate/corrective-actions",
              at: ca.closedAt ?? ca.dueAt,
            });
          }
        }

        // 3. Community-report status changes — staff queue only (RLS-scoped).
        if (isStaffRole(user.role)) {
          const repRaw = await allRows<AnyRow>("community_reports");
          for (const r of repRaw) {
            const rep = mapReport(r);
            if (rep.status === "submitted") continue; // untouched — not news
            const reviewedAt = rep.reviewedAt ?? rep.createdAt;
            if (now - reviewedAt > 7 * DAY) continue; // recent window only
            out.push({
              id: `rep-${rep._id}`,
              kind: "report_status",
              severity: rep.status === "verified" ? "info" : "warning",
              title: `Community report ${rep.trackingCode} → ${rep.status.replace("_", " ")}`,
              body: rep.description,
              linkTo: "/portal/community",
              at: reviewedAt,
            });
          }
        }

        // Urgent first, then newest.
        const sevRank = { urgent: 0, warning: 1, info: 2 } as const;
        out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.at - a.at);
        return out;
      }, ["corrective_actions", "findings", "sites", "community_reports"]),
  },

  // ----------------------------------------------------------------- stats
  stats: {
    commandCenter: () =>
      live<CommandCenterStats>(async () => {
        const user = await requireAuthed(true);
        // Unassigned accounts: zeroed figures, no denied queries.
        if (!user.role) {
          return {
            scope: user.scope ?? "national",
            sites: 0, activeSites: 0,
            inspectionsTotal: 0, inspectionsUnderReview: 0,
            findingsTotal: 0, findingsCriticalOpen: 0,
            correctiveActionsOpen: 0, correctiveActionsOverdue: 0,
            incidentsTotal: 0, fatalities: 0,
            envAlerts: 0, envByCategory: {},
            communityReports: 0, communityReportsPending: 0,
            inspectionCoveragePct: 0, countyCounts: {}, incidentTypes: {},
          };
        }
        // SEC-4 — AGGREGATE IN THE DATABASE. Hosted PostgREST caps unranged
        // responses at db-max-rows (default 1,000 rows): the old path shipped
        // every row of seven tables to the browser and summed them there, so
        // past the cap every figure on this screen was silently wrong. The RPC
        // is SECURITY INVOKER — it aggregates exactly the RLS-visible rows this
        // caller would page through — and returns ONE row: correct at any
        // table size, O(1) rows on the wire.
        const { data, error } = await supabase.rpc("mg_command_center_stats");
        if (!error && data && typeof data === "object") {
          return mapCommandCenterStats(data, user.scope);
        }
        // Fallback (lineage without migration 0012 yet): the original
        // client-side aggregation below — every input is paged to completion
        // (allRows → pagedRows), so its figures are exact at any size too;
        // only the wire cost differs. Loud about why, never truncated.
        console.warn(
          "[backend] mg_command_center_stats unavailable — client-side aggregation fallback:",
          error ? error.message ?? String(error) : "empty payload",
        );
        const staff = isStaffRole(user.role);
        const [sitesRaw, inspRaw, findingsRaw, casRaw, incRaw, envRaw, reportsRaw] =
          await Promise.all([
            allRows<AnyRow>("sites"),
            allRows<AnyRow>("inspections"),
            allRows<AnyRow>("findings"),
            allRows<AnyRow>("corrective_actions"),
            allRows<AnyRow>("incidents"),
            allRows<AnyRow>("environmental_observations"),
            staff
              ? allRows<AnyRow>("community_reports")
              : Promise.resolve([] as AnyRow[]),
          ]);
        const sites = sitesRaw.map(mapSite).filter((s) => canAccessSite(user, s));
        const inspections = inspRaw.map(mapInspection);
        const findings = findingsRaw.map(mapFinding);
        const cas = casRaw.map(mapCA);
        const incidents = incRaw.map(mapIncident);
        const env = envRaw.map(mapObservation);
        const reports = reportsRaw.map(mapReport);
        const now = Date.now();

        const visibleIds = new Set(sites.map((s) => s._id));
        const visInspections = inspections.filter((i) => visibleIds.has(i.siteId));
        const visFindings = findings.filter((f) => visibleIds.has(f.siteId));
        const visCas = cas.filter((c) => visibleIds.has(c.siteId));
        const visIncidents = incidents.filter((i) => visibleIds.has(i.siteId));
        const visEnv = env.filter((o) => visibleIds.has(o.siteId));

        const openCa = visCas.filter(
          (c) => c.status !== "closed" && c.status !== "verified",
        );
        const overdueCa = openCa.filter((c) => c.dueAt < now);
        const fatalities = visIncidents
          .filter((i) => i.type === "fatality")
          .reduce(
            (a, i) => a + (i.fatalities ?? (i.type === "fatality" ? 1 : 0)),
            0,
          );
        const envAlerts = visEnv.filter(
          (o) =>
            o.status !== "resolved" &&
            (o.verification === "measured" || o.verification === "verified"),
        );
        const approved = new Set(
          visInspections.filter((i) => i.status === "approved").map((i) => i.siteId),
        );
        const coverage =
          sites.length === 0 ? 0 : Math.round((approved.size / sites.length) * 100);
        const countyCounts: Record<string, number> = {};
        for (const s of sites) countyCounts[s.county] = (countyCounts[s.county] ?? 0) + 1;
        const countBy = (arr: { [k: string]: unknown }[], key: string) => {
          const m: Record<string, number> = {};
          for (const item of arr) {
            const k = String(item[key]);
            m[k] = (m[k] ?? 0) + 1;
          }
          return m;
        };

        return {
          scope: user.scope ?? "national",
          sites: sites.length,
          activeSites: sites.filter((s) => s.status === "active").length,
          inspectionsTotal: visInspections.length,
          inspectionsUnderReview: visInspections.filter((i) => i.status === "under_review").length,
          findingsTotal: visFindings.length,
          findingsCriticalOpen: visFindings.filter(
            (f) => f.severity === "critical" && (f.status === "open" || f.status === "acknowledged"),
          ).length,
          correctiveActionsOpen: openCa.length,
          correctiveActionsOverdue: overdueCa.length,
          incidentsTotal: visIncidents.length,
          fatalities,
          envAlerts: envAlerts.length,
          envByCategory: countBy(visEnv as unknown as { [k: string]: unknown }[], "category"),
          communityReports: reports.length,
          communityReportsPending: reports.filter((r) => r.status === "submitted").length,
          inspectionCoveragePct: coverage,
          countyCounts,
          incidentTypes: countBy(visIncidents as unknown as { [k: string]: unknown }[], "type"),
        };
      }, ["sites", "inspections", "findings", "corrective_actions", "incidents", "environmental_observations", "community_reports"]),

    recentAuditLog: () =>
      live<AuditEntry[]>(async () => {
        // Staff-only data (RLS); non-staff get an empty list, not a hang.
        const user = await requireAuthed();
        if (!isStaffRole(user.role)) return [];
        const { data, error } = await supabase
          .from("audit_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(200);
        if (error) throw backendError(error);
        return (data ?? []).map(mapAudit);
      }, ["audit_log"]),

    publicStats: () =>
      liveDoc<{ sites: number; inspections: number; incidents: number; communityReports: number }>(
        () => ({ table: "meta", column: "key", value: "public_stats" }),
        (r) => {
          const v = (r.value ?? {}) as Record<string, unknown>;
          return {
            sites: Number(v.sites ?? 0),
            inspections: Number(v.inspections ?? 0),
            incidents: Number(v.incidents ?? 0),
            communityReports: Number(v.communityReports ?? 0),
          };
        },
        { authBound: false },
      ),

    listUsers: () =>
      live<UserProfile[]>(async () => {
        await requireAdminUser(true);
        const rows = await allRows<AnyRow>("profiles");
        return rows.map(mapProfile);
      }, ["profiles"]),

    setUserRole: async (args: {
      userId: string;
      role: Role;
      scope?: Scope;
      county?: string;
      operatorName?: string;
    }) => {
      const user = await requireAdminUser();
      const target = await getProfile(args.userId);
      if (!target) throw new Error("NOT_FOUND");
      const { error } = await supabase
        .from("profiles")
        .update({
          role: args.role,
          scope: args.scope ?? target.scope ?? null,
          county: args.county ?? target.county ?? null,
          operator_name: args.operatorName ?? target.operatorName ?? null,
          profile_complete: true,
        })
        .eq("id", args.userId);
      if (error) throw backendError(error);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "user.role.set",
        entityType: "users",
        entityId: args.userId,
        summary: `Role ${args.role} assigned to ${target.email ?? args.userId}`,
      });
      bumpProfileVersion();
    },

    provisionByEmail: async (args: {
      email: string;
      role: Role;
      scope: Scope;
      county?: string;
      operatorName?: string;
    }) => {
      const user = await requireAdminUser();
      const { error } = await supabase.rpc("provision_user_by_email", {
        p_email: args.email.toLowerCase(),
        p_role: args.role,
        p_scope: args.scope,
        p_county: args.county ?? null,
        p_operator_name: args.operatorName ?? null,
      });
      if (error) throw backendError(error);
      bumpProfileVersion();
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "user.role.set",
        entityType: "users",
        summary: `Role ${args.role} (${args.scope}) assigned to ${args.email}`,
      });
    },

    completeProfile: async (args: {
      jobTitle: string;
      organization: string;
      scope?: Scope;
      county?: string;
      operatorName?: string;
    }) => {
      await requireAuthed();
      const { error } = await supabase.rpc("complete_staff_profile", {
        p_job_title: args.jobTitle,
        p_organization: args.organization,
        p_scope: args.scope ?? "national",
        p_county: args.county ?? null,
        p_operator_name: args.operatorName ?? null,
      });
      if (error) throw backendError(error);
      // Role/scope may have changed (first-admin bootstrap) — re-derive all
      // auth-bound subscriptions.
      bumpProfileVersion();
    },
  },

  // --------------------------------------------------------------- exports
  // §9 REPORTING EXPORTS — STREAMING (SEC-4 v2). The row source moved into
  // the database: pages of site-joined rows come from the SECURITY INVOKER
  // keyset RPCs (migration 0014) — the same RLS scope as the feeds — and are
  // serialized incrementally by export-csv (csvChunks/streamCsvFile). Each
  // page is released as it is consumed, so an export's memory tracks one
  // page, not the table, and no export path can exceed the caller's
  // authorization: the row source IS the caller's row visibility (invoker +
  // RLS; no definer, no service role anywhere).
  exports: {
    streamIncidents: (): AsyncGenerator<IncidentPageRow[]> =>
      keysetPages((before) => api.records.incidentsPage({ before })),
    streamInspections: (): AsyncGenerator<InspectionListRow[]> =>
      keysetPages((before) => api.inspections.inspectionsPage({ before })),
    streamCompliance: (): AsyncGenerator<CompliancePageRow[]> =>
      keysetPages((before) => api.inspections.compliancePage({ before })),
  },

  // -------------------------------------------------------------- evidence
  evidence: {
    /**
     * Upload bytes to Storage, then record the evidence row.
     *
     * STORAGE CONTRACT: object path MUST be {uid}/{evidenceRowId}__{fileName}
     * inside the private `evidence` bucket — the storage insert policy checks
     * the first folder against the caller's uid, and the read policy joins the
     * metadata row by storage_path to re-derive role + tenant per read.
     * siteId is MANDATORY.
     */
    upload: async (args: {
      file: Blob;
      fileName: string;
      mimeType: string;
      parentType: Evidence["parentType"];
      parentId: string;
      /** Mandatory except for community_report attachments (migration 0013:
       *  a public report is not bound to any site). */
      siteId?: string;
      caption?: string;
      capturedAt?: number;
      /** Client-computed digest; re-hashed here and refused on mismatch. */
      sha256?: string;
      /** Optional byte-progress callback (§10). When provided AND the
       *  environment has XMLHttpRequest (browser), bytes go up through the
       *  progress-emitting wire path; otherwise the supabase-js path is
       *  used (tests, exotic environments — same object, same policies). */
      onProgress?: (p: { loaded: number; total: number }) => void;
    }) => {
      const user = await requireAuthed();
      if (!user.role) throw new Error("FORBIDDEN");
      if (args.parentType !== "community_report") {
        // Every site-bound parent requires a visible site (EVD-1 kept the
        // site-less path exclusive to community triage).
        if (!args.siteId) throw new Error("EVIDENCE_REQUIRES_SITE");
      } else if (!isStaffRole(user.role)) {
        // Site-less community-report attachments are staff-only — mirrors
        // the 0013 RLS / storage / RPC branches.
        throw new Error("FORBIDDEN");
      }
      if (args.file.size > 25 * 1024 * 1024)
        throw new Error("FILE_TOO_LARGE");
      const site = args.siteId ? await getSite(args.siteId) : null;
      if (args.siteId && (!site || !canAccessSite(user, site)))
        throw new Error("FORBIDDEN");
      // EVD-1: hash the bytes independently; a client-declared digest that
      // does not match the bytes about to be stored is refused — the row's
      // sha256 always describes the bytes actually uploaded.
      const computed = await sha256Hex(args.file);
      if (args.sha256 && computed && args.sha256 !== computed)
        throw new Error("EVIDENCE_HASH_MISMATCH");
      const storedSha = computed ?? args.sha256 ?? null;
      const kind = evidenceKindByMime(args.mimeType);
      // 1. Generate the row id FIRST (no write yet) so the object name can
      //    embed it — {rowId}__{fileName} is the join key the read policy
      //    parses to re-check scope on every read.
      const c = globalThis.crypto as Crypto | undefined;
      const rowId =
        c && typeof c.randomUUID === "function"
          ? c.randomUUID()
          : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      const storagePath = `${user.uid}/${rowId}__${args.fileName}`;
      // 2. Upload bytes (uid first-folder contract + 25MB bucket cap
      //    re-checked server-side by the bucket setting and storage policy).
      if (args.onProgress && typeof XMLHttpRequest !== "undefined") {
        try {
          await uploadWithProgress(
            "evidence",
            storagePath,
            args.file,
            args.mimeType,
            args.onProgress,
          );
        } catch (e) {
          throw backendError(e);
        }
      } else {
        const { error: upErr } = await supabase.storage
          .from("evidence")
          .upload(storagePath, args.file, { contentType: args.mimeType });
        if (upErr) throw backendError(upErr);
      }
      // 3. Create the metadata row — reads only work once this exists, so a
      //    failed write leaves no readable reference to the bytes.
      const row = {
        id: rowId,
        storage_path: storagePath,
        parent_type: args.parentType,
        parent_id: args.parentId,
        site_id: args.siteId || null,
        kind,
        file_name: args.fileName,
        mime_type: args.mimeType,
        size_bytes: args.file.size,
        caption: args.caption ?? null,
        captured_at: args.capturedAt == null ? null : iso(args.capturedAt),
        uploaded_by_id: user.uid,
        sha256: storedSha,
      };
      let { error: dbErr } = await supabase.from("evidence").insert(row);
      if (dbErr && String((dbErr as { message?: string }).message ?? "").includes("sha256")) {
        // Pre-0013 lineage (live until migration 0013 is applied): the
        // column does not exist yet. Record the row WITHOUT the digest
        // rather than failing every upload on that lineage; the digest is
        // recomputed whenever verification needs it.
        console.warn(
          "evidence.upload: evidence.sha256 missing (0013 not applied) — storing row without digest",
        );
        const { sha256: _omit, ...legacyRow } = row;
        ({ error: dbErr } = await supabase.from("evidence").insert(legacyRow));
      }
      if (dbErr) throw backendError(dbErr);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "evidence.upload",
        entityType: "evidence",
        entityId: rowId,
        summary: `${kind} evidence attached to ${args.parentType} at ${site ? `site ${site.code}` : "no site (community triage)"}`,
      });
      return rowId;
    },

    listForParent: (args: {
      parentType: Evidence["parentType"];
      parentId: string;
      refresh?: number;
    }) =>
      live<Evidence[]>(async () => {
        const user = await requireAuthed();
        if (!user.role) return [];
        // The security-definer RPC applies the rules-equivalent scope check
        // (mg_can_access_site) — the client never queries raw evidence rows.
        const { data, error } = await supabase.rpc("evidence_for_parent", {
          p_parent_type: args.parentType,
          p_parent_id: args.parentId,
        });
        if (error) throw backendError(error);
        return (data ?? []).map(mapEvidence);
      }, ["evidence"]),

    /**
     * Signed-read proxy: mints a short-lived signed URL for an evidence row.
     *
     * Gap #2 (evidence URL revocation): the URL is minted ONLY after the
     * `evidence_url` RPC re-derives the caller's CURRENT site access (the
     * same mg_can_access_site predicate as the storage read policy) and logs
     * the mint to the definer-only evidence_url_audit table. The TTL drops
     * from 3600s to 120s - a leaked link is a two-minute exposure, not an
     * hour, and revoking a user's access kills their NEXT mint immediately
     * (revocation-at-mint; in-flight URLs <=120s are the documented residual).
     * The RPC clamps TTL server-side (30-300s) regardless of what we send.
     */
    getUrl: async (evidenceId: string): Promise<string | null> => {
      await requireAuthed();
      const TTL_SECONDS = 120;
      const { data: path, error } = await supabase.rpc("evidence_url", {
        p_evidence_id: evidenceId,
        p_ttl_seconds: TTL_SECONDS,
      });
      if (error) throw backendError(error);
      if (!path) throw new Error("NOT_FOUND");
      const { data: signed, error: sErr } = await supabase.storage
        .from("evidence")
        .createSignedUrl(path as string, TTL_SECONDS);
      if (sErr || !signed) return null;
      return signed.signedUrl;
    },

    storageFootprint: () =>
      live<{ count: number; totalBytes: number }>(async () => {
        await requireAdminUser();
        // SEC-4: paged read — the old unranged select stopped at the server's
        // row cap, so past 1,000 objects this figure was silently wrong.
        const rows = await pagedRows<{ size_bytes: unknown }>((from, to) =>
          supabase
            .from("evidence")
            .select("size_bytes")
            .order("id", { ascending: true })
            .range(from, to),
        );
        return {
          count: rows.length,
          totalBytes: rows.reduce((a, e) => a + Number(e.size_bytes ?? 0), 0),
        };
      }, ["evidence"]),
  },

  // ------------------------------------------------------------------ seed
  seed: {
    checkSeeded: () =>
      live<{ seeded: boolean }>(async () => {
        const { data, error } = await supabase.from("sites").select("id").limit(1);
        if (error) throw backendError(error);
        return { seeded: (data ?? []).length > 0 };
      }, ["sites"]),

    /** Demo seeding writes sites/templates/inspections — admin-only under
     *  RLS, so the data layer checks admin to fail fast. */
    seedIfEmpty: async () => {
      await requireAdminUser();
      // Existence probe only — limit(1) keeps this a bounded read (SEC-4).
      const { data, error } = await supabase.from("sites").select("id").limit(1);
      if (error) throw backendError(error);
      if ((data ?? []).length > 0) {
        return { seeded: false, reason: "not_empty" as const };
      }
      await runSeed();
      return { seeded: true as const };
    },
  },

  // -------------------------------------------------------------------- gis
  // Admin authoring path for boundaries + position verification (GIS-1 /
  // GIS-3). Client validation mirrors the database CHECK
  // (validateGeoJsonPolygon == public.mg_valid_geojson_polygon, pinned by
  // tests/gis.test.ts); the geo.write permission, RLS and the audit trigger
  // are the real boundary.
  gis: {
    /** Create or replace the single outline of a site. */
    saveSiteBoundary: async (args: {
      siteId: string;
      geometryGeoJson: string;
      source: string;
      accuracyM?: number;
      geoVerified?: boolean;
    }): Promise<SiteBoundary> => {
      const user = await requireAdminUser();
      assertBoundaryInput(args);
      if (!(await getSite(args.siteId))) throw new Error("NOT_FOUND");
      const row = {
        site_id: args.siteId,
        geometry_geojson: JSON.parse(args.geometryGeoJson),
        source: args.source.trim(),
        accuracy_m: args.accuracyM ?? null,
        geo_verified: args.geoVerified === true,
      };
      const existing = await supabase
        .from("site_boundaries")
        .select("id")
        .eq("site_id", args.siteId)
        .maybeSingle();
      if (existing.error) throw backendError(existing.error);
      const id = existing.data
        ? (existing.data as { id: string }).id
        : globalThis.crypto.randomUUID();
      const write = existing.data
        ? await supabase.from("site_boundaries").update(row).eq("id", id)
        : await supabase
            .from("site_boundaries")
            .insert({ ...row, id, created_by: user.uid });
      if (write.error) throw backendError(write.error);
      // Re-read (RLS-scoped) instead of trusting a write's RETURNING shape.
      const back = await supabase
        .from("site_boundaries")
        .select("*")
        .eq("id", id)
        .single();
      if (back.error) throw backendError(back.error);
      return siteBoundaryFromRow(back.data as AnyRow);
    },

    /** Create an administrative-area outline (county, district, …). */
    saveAdminBoundary: async (args: {
      name: string;
      level: AdminBoundary["level"] | "region";
      adminAreaId?: string;
      parentId?: string;
      geometryGeoJson: string;
      source: string;
      accuracyM?: number;
      geoVerified?: boolean;
    }): Promise<AdminBoundary> => {
      const user = await requireAdminUser();
      assertBoundaryInput(args);
      if (!args.name.trim()) throw new Error("INVALID_NAME");
      const id = globalThis.crypto.randomUUID();
      const write = await supabase.from("admin_boundaries").insert({
        id,
        name: args.name.trim(),
        level: args.level,
        admin_area_id: args.adminAreaId ?? null,
        parent_id: args.parentId ?? null,
        geometry_geojson: JSON.parse(args.geometryGeoJson),
        source: args.source.trim(),
        accuracy_m: args.accuracyM ?? null,
        geo_verified: args.geoVerified === true,
        created_by: user.uid,
      });
      if (write.error) throw backendError(write.error);
      const back = await supabase
        .from("admin_boundaries")
        .select("*")
        .eq("id", id)
        .single();
      if (back.error) throw backendError(back.error);
      return adminBoundaryFromRow(back.data as AnyRow);
    },

    /** Record (or withdraw) verification of a site's point position. A
     *  source is mandatory to verify; the DB guard + CHECK enforce it again. */
    setSiteGeoVerification: async (args: {
      siteId: string;
      geoVerified: boolean;
      source: string;
      accuracyM?: number;
    }): Promise<Site> => {
      await requireAdminUser();
      if (args.geoVerified && !args.source?.trim()) throw new Error("INVALID_SOURCE");
      if (args.accuracyM !== undefined && !(args.accuracyM >= 0))
        throw new Error("INVALID_ACCURACY");
      const current = await getSite(args.siteId);
      if (!current) throw new Error("NOT_FOUND");
      const write = await supabase
        .from("sites")
        .update({
          geo_verified: args.geoVerified,
          geo_source: args.source?.trim() || current.geoSource || null,
          geo_accuracy_m: args.accuracyM ?? null,
        })
        .eq("id", args.siteId);
      if (write.error) throw backendError(write.error);
      const back = await getSite(args.siteId);
      if (!back) throw new Error("NOT_FOUND");
      return back;
    },
  },

  // mapFeatures — the NationalMap's GIS feed (docs/06). EVERY layer is read
  // through the caller's own Postgres session, so scoping is Row Level
  // Security (sites/incidents/inspections/observations via
  // mg_can_access_site, community reports via the staff scope matrix, site
  // boundaries via the site matrix) — nothing is re-derived or widened here.
  // Boundaries render ONLY from authored, CHECK-validated rows; the map
  // degrades to point records otherwise (no fabricated boundary data).
  mapFeatures: () =>
    live<MapFeedPayload>(
      loadMapFeatures,
      [
        "sites",
        "incidents",
        "inspections",
        "environmental_observations",
        "community_reports",
        "admin_boundaries",
        "site_boundaries",
      ],
      { authBound: true },
    ),
};

export interface MapFeedPayload {
  layers: MapLayerConfig[];
  features: MapFeature[];
  adminBoundaries: AdminBoundary[];
  siteBoundaries: SiteBoundary[];
}

function assertBoundaryInput(args: {
  geometryGeoJson: string;
  source: string;
  accuracyM?: number;
}): void {
  if (!args.source || !args.source.trim()) throw new Error("INVALID_SOURCE");
  if (args.accuracyM !== undefined && !(args.accuracyM >= 0))
    throw new Error("INVALID_ACCURACY");
  const check = validateGeoJsonPolygon(args.geometryGeoJson);
  if (!check.ok) throw new Error(`INVALID_GEOMETRY: ${check.error}`);
}

/** First value a live handle delivers (internal one-shot read). */
function firstValue<T>(h: QueryHandle<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    let unsub: (() => void) | null = null;
    let settled = false;
    unsub = h.subscribe((v) => {
      if (settled) return;
      settled = true;
      queueMicrotask(() => unsub?.());
      resolve(v);
    });
    if (settled) queueMicrotask(() => unsub?.());
  });
}

/** Read one table; a table the caller cannot read (RLS) or that is absent on
 *  an older lineage yields [] — a layer never fails the whole map. */
async function tolerantRows(table: string): Promise<AnyRow[]> {
  try {
    return await allRows<AnyRow>(table);
  } catch {
    return [];
  }
}

export async function loadMapFeatures(): Promise<MapFeedPayload> {
  const empty: MapFeedPayload = {
    layers: MAP_LAYER_CONFIGS,
    features: [],
    adminBoundaries: [],
    siteBoundaries: [],
  };
  const uid = authUserId();
  if (!uid) return empty;
  const profile = await getProfileCached(uid);
  if (!profile || !profile.role) return empty;
  const staff = isStaffRole(profile.role);

  const siteRows = await allRows<AnyRow>("sites");
  // Defence in depth only: RLS already scoped these rows server-side.
  const siteFeatures = siteRows
    .filter((s) => canAccessSite(profile, mapSite(s)))
    .map(siteFeature)
    .filter((f): f is MapFeature => f !== null);
  const sites = indexSites(siteFeatures);

  const [incRows, inspRows, obsRows, repRows, adminRows, siteBoundRows] =
    await Promise.all([
      tolerantRows("incidents"),
      tolerantRows("inspections"),
      tolerantRows("environmental_observations"),
      staff ? tolerantRows("community_reports") : Promise.resolve([] as AnyRow[]),
      tolerantRows("admin_boundaries"),
      tolerantRows("site_boundaries"),
    ]);

  const features: MapFeature[] = [...siteFeatures];
  for (const r of incRows) {
    const f = incidentFeature(r, sites);
    if (f) features.push(f);
  }
  for (const r of inspRows) {
    const f = inspectionFeature(r, sites);
    if (f) features.push(f);
  }
  for (const r of obsRows) {
    if (r.status === "resolved") continue; // open/monitoring only (docs/06)
    const f = observationFeature(r, sites);
    if (f) features.push(f);
  }
  for (const r of repRows) {
    if (r.status === "dismissed") continue; // dismissed reports leave the map
    const f = communityReportFeature(r);
    if (f) features.push(f);
  }
  if (staff) {
    const scores = (await firstValue(api.sites.riskScores())) ?? {};
    for (const site of siteFeatures) {
      const f = riskIndicatorFeature(site, scores[site.id]?.score ?? 0);
      if (f) features.push(f);
    }
  }

  // Boundaries: invalid stored geometry is dropped, never drawn or repaired.
  const adminBoundaries = adminRows
    .map(adminBoundaryFromRow)
    .filter((b) => parseBoundaryGeometry(b.geometryGeoJson) !== null);
  const siteBoundaries = siteBoundRows
    .map(siteBoundaryFromRow)
    .filter(
      (b) => sites.has(b.siteId) && parseBoundaryGeometry(b.geometryGeoJson) !== null,
    );

  return { layers: MAP_LAYER_CONFIGS, features, adminBoundaries, siteBoundaries };
}

// ---------------------------------------------------------------------------
// DEV SEED — synthetic demonstration records only. Never real government data.
// Provenance for every seeded record is the authenticated account running it.
// ---------------------------------------------------------------------------

async function runSeed() {
  const user = await requireAdminUser();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const uid = user.uid;
  const label = await actorLabel(user);

  const siteDefs = [
    { name: "Demo Gold Operation — Zorzor Corridor", operatorName: "Lofa Minerals Demo", county: "Lofa", district: "Zorzor", community: "Zorzor City", mineralType: "Gold", lat: 7.6067, lng: 9.4236 },
    { name: "Demo Iron Ore Quarry — Yekepa", operatorName: "Nimba Aggregates Demo", county: "Nimba", district: "Sanniquellie-Mahn", community: "Yekepa", mineralType: "Iron Ore", lat: 7.5989, lng: 8.6333 },
    { name: "Demo Alluvial Site — Saniquellie", operatorName: "Nimba Aggregates Demo", county: "Nimba", district: "Sanniquellie-Mahn", community: "Saniquellie", mineralType: "Alluvial Gold", lat: 7.5806, lng: 8.7236 },
    { name: "Demo Sand Mining — Robertsport", operatorName: "Grand Cape Coastal Demo", county: "Grand Cape Mount", district: "Robertsport", community: "Robertsport", mineralType: "Sand", lat: 6.7572, lng: 11.3686 },
    { name: "Demo Artisanal Camp — Gbarpolu", operatorName: "Gbarpolu Artisanal Demo", county: "Gbarpolu", district: "Bopolu", community: "Bopolu", mineralType: "Gold", lat: 6.7236, lng: 9.7167 },
    { name: "Demo Basalt Pit — Ganta", operatorName: "Nimba Aggregates Demo", county: "Nimba", district: "Gba & Ma", community: "Ganta", mineralType: "Basalt", lat: 7.2194, lng: 8.9833 },
  ];

  const siteIds: Record<string, { id: string; code: string }> = {};
  const existingCodes = await allSiteCodes();
  for (const def of siteDefs) {
    const code = nextSiteCodeFrom(def.county, existingCodes);
    existingCodes.push(code);
    const id = await insertReturningId("sites", {
      code,
      name: def.name,
      operator_name: def.operatorName,
      mineral_type: def.mineralType,
      county: def.county,
      district: def.district,
      community: def.community,
      status: "active",
      latitude: def.lat,
      longitude: def.lng,
      notes: "Synthetic demonstration record — not real operational data.",
      created_by: uid,
    });
    siteIds[def.name] = { id, code };
  }

  const templateId = await insertReturningId("inspection_templates", {
    name: "Standard Mining Safety & Environmental Inspection",
    description:
      "Configurable baseline template used by field inspectors. Sections and questions can be edited by administrators.",
    active: true,
    created_by: uid,
    sections: [
      {
        title: "Site & Workforce Safety",
        questions: [
          { label: "Are workers wearing required PPE?", answerType: "boolean", required: true },
          { label: "Is a trained safety officer present on site?", answerType: "boolean", required: true },
          { label: "Number of workers observed on site", answerType: "number", required: true },
          { label: "Overall safety condition", answerType: "select", options: ["Good", "Fair", "Poor", "Immediate risk"], required: true },
        ],
      },
      {
        title: "Equipment & Infrastructure",
        questions: [
          { label: "Equipment inspected and maintained?", answerType: "boolean", required: true },
          { label: "Any structural defects observed?", answerType: "boolean", required: true },
          { label: "Describe defects or concerns", answerType: "text", required: false },
        ],
      },
      {
        title: "Environmental Condition",
        questions: [
          { label: "Signs of water pollution or sediment discharge?", answerType: "boolean", required: true },
          { label: "Waste and tailings properly managed?", answerType: "boolean", required: true },
          { label: "Additional environmental observations", answerType: "text", required: false },
        ],
      },
      {
        title: "Administrative",
        questions: [
          { label: "Site records available for review?", answerType: "boolean", required: true },
          { label: "Inspector notes", answerType: "text", required: false },
        ],
      },
    ],
  });

  const zorzor = siteIds["Demo Gold Operation — Zorzor Corridor"];
  const yekepa = siteIds["Demo Iron Ore Quarry — Yekepa"];
  const robertsport = siteIds["Demo Sand Mining — Robertsport"];

  const insp1 = await insertReturningId("inspections", {
    site_id: zorzor.id,
    template_id: templateId,
    inspector_id: uid,
    status: "approved",
    answers: {
      "0:0": true, "0:1": true, "0:2": 24, "0:3": "Fair",
      "1:0": true, "1:1": false,
      "2:0": true, "2:1": false,
      "3:0": true,
    },
    notes: "Routine inspection; PPE compliance observed at both pits.",
    latitude: 7.6067,
    longitude: 9.4236,
    submitted_at: iso(now - 6 * day),
    reviewed_at: iso(now - 5 * day),
    created_at: iso(now - 7 * day),
  });

  const f1 = await insertReturningId("findings", {
    inspection_id: insp1,
    site_id: zorzor.id,
    title: "Sediment discharge into seasonal stream",
    description: "Uncontrolled runoff from the processing area entering the stream.",
    severity: "high",
    status: "acknowledged",
    created_by_id: uid,
    created_at: iso(now - 6 * day),
  });

  await insertReturningId("corrective_actions", {
    finding_id: f1,
    site_id: zorzor.id,
    description: "Construct sediment settling basin before discharge point.",
    status: "in_progress",
    due_at: iso(now + 14 * day),
    opened_by_id: uid,
    created_at: iso(now - 5 * day),
  });

  const insp2 = await insertReturningId("inspections", {
    site_id: yekepa.id,
    template_id: templateId,
    inspector_id: uid,
    status: "under_review",
    answers: {
      "0:0": true, "0:1": false, "0:2": 11, "0:3": "Fair",
      "1:0": true, "1:1": true, "1:2": "Berms eroded on eastern section.",
      "2:0": false, "2:1": true,
      "3:0": true,
    },
    notes: "Haul-road inspection; berms low on the eastern section.",
    latitude: 7.5989,
    longitude: 8.6333,
    submitted_at: iso(now - 2 * day),
    created_at: iso(now - 3 * day),
  });

  await insertReturningId("findings", {
    inspection_id: insp2,
    site_id: yekepa.id,
    title: "Haul-road berms below required height",
    description: "Eastern section berms measured below 1.5m at three points.",
    severity: "medium",
    status: "open",
    created_by_id: uid,
    created_at: iso(now - 2 * day),
  });

  await insertReturningId("incidents", {
    site_id: robertsport.id,
    type: "injury",
    severity: "medium",
    description: "Worker laceration from handling screen mesh; treated on site.",
    occurred_at: iso(now - 4 * day),
    injured: 1,
    status: "investigating",
    reported_by_id: uid,
    report_source: "inspector",
    created_at: iso(now - 4 * day),
  });

  await insertReturningId("environmental_observations", {
    site_id: zorzor.id,
    category: "water_pollution",
    verification: "measured",
    description: "Turbidity downstream visibly elevated; sample taken for analysis.",
    observed_at: iso(now - 5 * day),
    latitude: 7.6067,
    longitude: 9.4236,
    status: "monitoring",
    reported_by_id: uid,
    created_at: iso(now - 5 * day),
  });

  const { error: repErr } = await supabase.from("community_reports").insert([
    {
      tracking_code: "CR-DEMO0001",
      category: "pollution",
      description: "Community reports discolored water in the creek used for washing.",
      county: "Lofa",
      community: "Zorzor City",
      status: "under_review",
      created_at: iso(now - 3 * day),
    },
    {
      tracking_code: "CR-DEMO0002",
      category: "suspected_illegal_mining",
      description: "Unknown digging activity observed after dark near the ridge.",
      county: "Nimba",
      community: "Yekepa",
      status: "submitted",
      created_at: iso(now - 1 * day),
    },
  ]);
  if (repErr) throw backendError(repErr);
  const { error: trkErr } = await supabase
    .from("report_tracking")
    .upsert(
      [
        { tracking_code: "CR-DEMO0001", status: "under_review", created_at: iso(now - 3 * day) },
        { tracking_code: "CR-DEMO0002", status: "submitted", created_at: iso(now - 1 * day) },
      ],
      { onConflict: "tracking_code" },
    );
  if (trkErr) throw backendError(trkErr);

  // No client-side audit insert here anymore (SEC-1): every seeded row above
  // already produced a server-written audit_log entry via mg_audit_row().
  await refreshPublicStats();
}
