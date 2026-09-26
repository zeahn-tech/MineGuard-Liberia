// ---------------------------------------------------------------------------
// MINEGUARD LIBERIA — SUPABASE DATA LAYER
//
// Replaces the previous Firebase data layer function-for-function. Every
// function re-derives authorization from the caller's profile BEFORE touching
// data (defense in depth); Postgres RLS + guard triggers + security-definer
// RPCs (supabase/migrations/0001_initial_schema.sql) are the authoritative
// server-side boundary. Every consequential write appends to audit_log.
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
  supabase,
} from "./supabase";
import {
  canAccessSite,
  isStaffRole,
  makeTrackingCode,
  nextSiteCodeFrom,
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
  type Role,
  type Scope,
  type Site,
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
    siteId: r.site_id,
    kind: r.kind,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes ?? 0),
    caption: r.caption ?? undefined,
    capturedAt: toMsOrNull(r.captured_at),
    uploadedById: r.uploaded_by_id,
    createdAt: toMs(r.created_at),
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

async function logAudit(entry: {
  actorId?: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId?: string;
  summary: string;
}) {
  const { error } = await supabase.from("audit_log").insert({
    actor_id: entry.actorId ?? null,
    actor_label: entry.actorLabel,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    summary: entry.summary,
  });
  if (error) console.warn("[backend] audit write skipped:", error.message);
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

/** Fetch all rows of a table the caller can see (RLS enforces the scope). */
async function allRows<T>(table: string): Promise<T[]> {
  const { data, error } = await supabase.from(table).select("*");
  if (error) throw backendError(error);
  return (data ?? []) as T[];
}

async function refreshPublicStats() {
  const { error } = await supabase.rpc("refresh_public_stats");
  if (error) console.warn("[backend] publicStats refresh skipped:", error.message);
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
          if (!cancelled) cb(value);
        } catch (err) {
          console.error("[backend] query failed:", err);
          if (!cancelled) cb(undefined);
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
          if (!cancelled) cb(v);
        } catch (err) {
          console.error("[backend] doc query failed:", err);
          if (!cancelled) cb(null);
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
      const existing = await supabase.from("sites").select("code");
      if (existing.error) throw backendError(existing.error);
      const code = nextSiteCodeFrom(
        args.county,
        (existing.data ?? []).map((r) => r.code as string),
      );
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

    riskScores: () =>
      live<Record<string, { score: number; factors: { label: string; points: number }[] }>>(
        async () => {
          const user = await requireAuthed(true);
          if (!user.role) return {};
          const [sitesRaw, findingsRaw, casRaw, incRaw, envRaw] =
            await Promise.all([
              allRows<AnyRow>("sites"),
              allRows<AnyRow>("findings"),
              allRows<AnyRow>("corrective_actions"),
              allRows<AnyRow>("incidents"),
              allRows<AnyRow>("environmental_observations"),
            ]);
          const sites = sitesRaw.map(mapSite).filter((s) => canAccessSite(user, s));
          const findings = findingsRaw.map(mapFinding);
          const cas = casRaw.map(mapCA);
          const incidents = incRaw.map(mapIncident);
          const env = envRaw.map(mapObservation);
          const now = Date.now();
          // Configurable weights — tuned by the program owner, not hardcoded law.
          const W = {
            criticalFinding: 10,
            highFinding: 6,
            mediumFinding: 3,
            lowFinding: 1,
            repeatFinding: 4,
            overdueCA: 8,
            fatality: 15,
            seriousIncident: 7,
            envAlert: 5,
          };
          const out: Record<
            string,
            { score: number; factors: { label: string; points: number }[] }
          > = {};
          for (const site of sites) {
            const factors: { label: string; points: number }[] = [];
            const siteFindings = findings.filter((f) => f.siteId === site._id);
            let points = 0;
            const sevCount: Record<string, number> = {
              low: 0, medium: 0, high: 0, critical: 0,
            };
            for (const f of siteFindings) {
              const p =
                f.severity === "critical" ? W.criticalFinding
                : f.severity === "high" ? W.highFinding
                : f.severity === "medium" ? W.mediumFinding
                : W.lowFinding;
              points += p;
              sevCount[f.severity] = (sevCount[f.severity] ?? 0) + 1;
            }
            if (sevCount.critical)
              factors.push({ label: `${sevCount.critical} critical finding(s)`, points: sevCount.critical * W.criticalFinding });
            if (sevCount.high)
              factors.push({ label: `${sevCount.high} high finding(s)`, points: sevCount.high * W.highFinding });
            if (sevCount.medium)
              factors.push({ label: `${sevCount.medium} medium finding(s)`, points: sevCount.medium * W.mediumFinding });
            if (sevCount.low)
              factors.push({ label: `${sevCount.low} low finding(s)`, points: sevCount.low * W.lowFinding });

            const repeatFactor =
              siteFindings.length > 3
                ? W.repeatFinding * Math.floor(siteFindings.length / 4)
                : 0;
            if (repeatFactor)
              factors.push({ label: "Repeat findings at site", points: repeatFactor });
            points += repeatFactor;

            const overdue = cas.filter(
              (c) =>
                c.siteId === site._id &&
                c.status !== "closed" &&
                c.status !== "verified" &&
                c.dueAt < now,
            ).length;
            if (overdue) {
              factors.push({ label: `${overdue} overdue corrective action(s)`, points: overdue * W.overdueCA });
              points += overdue * W.overdueCA;
            }

            const fatalities = incidents.filter(
              (i) => i.siteId === site._id && i.type === "fatality",
            ).length;
            if (fatalities) {
              factors.push({ label: `${fatalities} fatality incident(s)`, points: fatalities * W.fatality });
              points += fatalities * W.fatality;
            }
            const serious = incidents.filter(
              (i) =>
                i.siteId === site._id &&
                i.type !== "fatality" &&
                (i.severity === "critical" || i.severity === "high"),
            ).length;
            if (serious) {
              factors.push({ label: `${serious} serious incident(s)`, points: serious * W.seriousIncident });
              points += serious * W.seriousIncident;
            }
            const envAlerts = env.filter(
              (o) =>
                o.siteId === site._id &&
                o.status !== "resolved" &&
                (o.verification === "measured" || o.verification === "verified"),
            ).length;
            if (envAlerts) {
              factors.push({ label: `${envAlerts} verified environmental alert(s)`, points: envAlerts * W.envAlert });
              points += envAlerts * W.envAlert;
            }
            out[site._id] = { score: points, factors };
          }
          return out;
        },
        ["sites", "findings", "corrective_actions", "incidents", "environmental_observations"],
      ),
  },

  // ----------------------------------------------------------- inspections
  inspections: {
    listTemplates: () =>
      live<InspectionTemplate[]>(async () => {
        await requireAuthed();
        const { data, error } = await supabase
          .from("inspection_templates")
          .select("*")
          .eq("active", true);
        if (error) throw backendError(error);
        return (data ?? []).map(mapTemplate);
      }, ["inspection_templates"]),

    list: () =>
      live<
        {
          _id: string;
          siteId: string;
          siteCode: string;
          siteName: string;
          county: string;
          status: Inspection["status"];
          submittedAt?: number;
          createdAt: number;
          inspectorId: string;
        }[]
      >(async () => {
        const user = await requireAuthed(true);
        if (!user.role) return [];
        const [inspRaw, siteRaw] = await Promise.all([
          allRows<AnyRow>("inspections"),
          allRows<AnyRow>("sites"),
        ]);
        const byId = new Map(siteRaw.map((r) => [r.id as string, mapSite(r)]));
        const out: {
          _id: string; siteId: string; siteCode: string; siteName: string;
          county: string; status: Inspection["status"]; submittedAt?: number;
          createdAt: number; inspectorId: string;
        }[] = [];
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
      }, ["inspections", "sites"]),

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
        const { data, error } = await supabase
          .from("findings")
          .select("*")
          .eq("inspection_id", args.inspectionId);
        if (error) throw backendError(error);
        return (data ?? []).map(mapFinding);
      }, ["findings"]),

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
        const { data: rows, error } = await supabase
          .from("corrective_actions")
          .select("*")
          .eq("finding_id", args.findingId);
        if (error) throw backendError(error);
        return (rows ?? []).map(mapCA);
      }, ["corrective_actions"]),

    listSiteCorrectiveActions: (args: { siteId: string }) =>
      live<CorrectiveAction[]>(async () => {
        const user = await requireAuthed();
        const site = await getSite(args.siteId);
        if (!site || !canAccessSite(user, site)) return [];
        const { data, error } = await supabase
          .from("corrective_actions")
          .select("*")
          .eq("site_id", args.siteId);
        if (error) throw backendError(error);
        return (data ?? []).map(mapCA);
      }, ["corrective_actions"]),

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
      const { error } = await supabase
        .from("corrective_actions")
        .update({ operator_note: args.operatorNote, status: "submitted" })
        .eq("id", args.caId);
      if (error) throw backendError(error);
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
      live<Incident[]>(async () => {
        const user = await requireAuthed(true);
        if (!user.role) return [];
        const [incRaw, siteRaw] = await Promise.all([
          allRows<AnyRow>("incidents"),
          allRows<AnyRow>("sites"),
        ]);
        const byId = new Map(siteRaw.map((r) => [r.id as string, mapSite(r)]));
        const out: Incident[] = [];
        for (const r of incRaw) {
          const inc = mapIncident(r);
          const site = byId.get(inc.siteId);
          if (!site) continue;
          if (user.role === ROLES.OPERATOR) {
            if (!user.operatorName || site.operatorName !== user.operatorName)
              continue;
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
      }, ["incidents", "sites"]),

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
  },

  // ----------------------------------------------------------------- stats
  stats: {
    commandCenter: () =>
      live<CommandCenterStats>(async () => {
        const user = await requireAuthed(true);
        const staff = isStaffRole(user.role);
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
      siteId: string;
      caption?: string;
      capturedAt?: number;
    }) => {
      const user = await requireAuthed();
      if (!args.siteId) throw new Error("EVIDENCE_REQUIRES_SITE");
      if (args.file.size > 25 * 1024 * 1024)
        throw new Error("FILE_TOO_LARGE");
      const site = await getSite(args.siteId);
      if (!site || !canAccessSite(user, site)) throw new Error("FORBIDDEN");
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
      const { error: upErr } = await supabase.storage
        .from("evidence")
        .upload(storagePath, args.file, { contentType: args.mimeType });
      if (upErr) throw backendError(upErr);
      // 3. Create the metadata row — reads only work once this exists, so a
      //    failed write leaves no readable reference to the bytes.
      const { error: dbErr } = await supabase.from("evidence").insert({
        id: rowId,
        storage_path: storagePath,
        parent_type: args.parentType,
        parent_id: args.parentId,
        site_id: args.siteId,
        kind,
        file_name: args.fileName,
        mime_type: args.mimeType,
        size_bytes: args.file.size,
        caption: args.caption ?? null,
        captured_at: args.capturedAt == null ? null : iso(args.capturedAt),
        uploaded_by_id: user.uid,
      });
      if (dbErr) throw backendError(dbErr);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "evidence.upload",
        entityType: "evidence",
        entityId: rowId,
        summary: `${kind} evidence attached to ${args.parentType} at site ${site.code}`,
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
        const { data, error } = await supabase
          .from("evidence")
          .select("size_bytes");
        if (error) throw backendError(error);
        const rows = data ?? [];
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
      const { data, error } = await supabase.from("sites").select("id");
      if (error) throw backendError(error);
      if ((data ?? []).length > 0) {
        return { seeded: false, reason: "not_empty" as const };
      }
      await runSeed();
      return { seeded: true as const };
    },
  },
};

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
  const existing = await supabase.from("sites").select("code");
  if (existing.error) throw backendError(existing.error);
  const existingCodes = (existing.data ?? []).map((r) => r.code as string);
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

  await supabase.from("audit_log").insert({
    actor_id: uid,
    actor_label: label,
    action: "system.seed",
    entity_type: "sites",
    summary: "Dev seed data inserted (synthetic demonstration records only)",
  });

  await refreshPublicStats();
}
