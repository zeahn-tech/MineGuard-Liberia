// ---------------------------------------------------------------------------
// MINEGUARD LIBERIA — FIREBASE DATA LAYER
//
// Mirrors the previous Convex backend function-for-function. Every function
// re-derives authorization from the caller's user profile BEFORE touching
// data (defense in depth) and every consequential write appends to the
// auditLog. Firestore/Storage security rules (firestore.rules, storage.rules)
// are the authoritative server-side boundary; these checks shape errors and
// keep the client honest.
// ---------------------------------------------------------------------------

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fbLimit,
  onSnapshot,
  orderBy,
  query as fsQuery,
  setDoc,
  updateDoc,
  where,
  type DocumentReference,
  type Query,
  type Unsubscribe,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { auth, db, fbStorage } from "./firebase";
import {
  canAccessSite,
  isStaffRole,
  makeTrackingCode,
  nextSiteCodeFrom,
  scopeConstraintForUser,
  siteScopeStamp,
  type ScopeConstraint,
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
  subscribe(cb: (value: T | undefined) => void): Unsubscribe;
}

// Collections whose LIST rules check a per-document scope field (county /
// operatorName) rather than a coarse role check. Watching them unconstrained
// is rejected by Firestore for county/operator callers, so the watcher must
// carry the caller's scope constraint — the same one the scoped read uses.
const SCOPED_COLLECTIONS = new Set([
  "sites",
  "inspections",
  "findings",
  "correctiveActions",
  "incidents",
  "environmentalObservations",
]);

// Collections whose list rule keys on the PARENT record (not a field on the
// document), so the generic collection watcher cannot be made rules-safe. A
// raw watcher would be rejected for every non-admin caller; skip it. The
// evidence UI refreshes with its own post-upload nonce instead.
const WATCH_SKIP = new Set(["evidence"]);

// Last scope derived for the signed-in user (set by requireAuthed). Read by
// live()'s watcher so push updates keep working under scoped list rules.
let currentScope: ScopeConstraint | undefined;

/** The constrained collection query a scoped watcher must use, or null when
 *  the collection is unscoped or the caller can read it unconstrained. */
function scopedCollectionQuery(name: string): Query | null {
  if (!SCOPED_COLLECTIONS.has(name)) return null;
  const c = currentScope;
  if (!c || c === "all" || c === "none") return null;
  return fsQuery(collection(db, name), where(c.field, "==", c.value));
}

// PERF CONTRACT (performance fix):
//  - The fetcher runs ONCE on subscribe, then at most once per burst of
//    snapshot events (300ms trailing debounce), and never concurrently
//    (single-flight with a dirty flag). Snapshot storms therefore collapse
//    into a single refetch instead of refetch-per-event.
//  - authBound (default true): the result depends on the signed-in user, so
//    the shared cache re-derives it after sign-in/out. Public queries opt out.
function live<T>(
  fetcher: () => Promise<T>,
  watch: string[],
  opts?: { authBound?: boolean },
): QueryHandle<T> {
  const authBound = opts?.authBound !== false;
  return {
    // Flag consumed by the React cache layer (backend-react.ts).
    authBound,
    subscribe(cb) {
      let cancelled = false;
      let inFlight = false;
      let dirty = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubs: Unsubscribe[] = [];
      let watchersReady = false;

      const onWatchEvent = () => {
        if (cancelled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void run();
        }, 300);
      };

      // Watchers are established AFTER the first fetch resolves, because it is
      // the fetch (requireAuthed) that derives the caller's scope. List rules
      // are per-document scoped, so an unconstrained collection watcher is
      // REJECTED for county/operator callers — the watcher must carry the same
      // constraint as the scoped read, or push updates silently stop.
      const setupWatchers = () => {
        if (watchersReady || cancelled) return;
        watchersReady = true;
        for (const name of watch) {
          // Parent-joined collections (evidence) can't be watched safely by a
          // generic collection watcher — see WATCH_SKIP above.
          if (WATCH_SKIP.has(name)) continue;
          try {
            const unsub = onSnapshot(
              scopedCollectionQuery(name) ?? collection(db, name),
              onWatchEvent,
              (err) => {
                // Denied LIST (e.g. role-scoped collections) must not become an
                // unhandled rejection; the initial fetch already surfaced state.
                console.warn(`[backend] watcher for "${name}" denied:`, err.code);
              },
            );
            unsubs.push(unsub);
          } catch {
            // Collection watcher is best-effort; initial fetch already ran.
          }
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

/** Single-document live query: true push reactivity, zero watchers over whole
 *  collections. Used for the user profile and public stats. */
function liveDoc<T>(
  getRef: () => DocumentReference | null,
  opts?: { authBound?: boolean },
): QueryHandle<T | null> {
  const authBound = opts?.authBound !== false;
  return {
    // Flag consumed by the React cache layer (backend-react.ts).
    authBound,
    subscribe(cb) {
      const r = getRef();
      if (!r) {
        cb(null);
        return () => {};
      }
      return onSnapshot(
        r,
        (snap) => {
          cb(snap.exists() ? withId<T>(snap.id, snap.data()) : null);
        },
        (err) => {
          console.error("[backend] doc query failed:", err);
          cb(null);
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------------------

type AnyDoc = Record<string, unknown>;

function withId<T>(id: string, data: AnyDoc): T {
  return { _id: id, ...(data as object) } as unknown as T;
}

async function getProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  return { uid: snap.id, ...(snap.data() as object) } as unknown as UserProfile;
}

// Short-TTL profile cache: list queries re-derive authorization on every run;
// without this, one dashboard render costs a profile getDoc per query. TTL is
// intentionally short (5s) so role changes surface quickly. Mutations always
// use a fresh read (cached=false default).
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
  const u = auth.currentUser;
  if (!u) throw new Error("UNAUTHENTICATED");
  const profile = cached
    ? await getProfileCached(u.uid)
    : await getProfile(u.uid);
  if (!profile) throw new Error("UNREGISTERED_USER");
  // Publish the caller's scope for live()'s scoped watchers.
  currentScope = scopeConstraintForUser(profile);
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
  await addDoc(collection(db, "auditLog"), {
    ...entry,
    createdAt: Date.now(),
  });
}

async function getSite(siteId: string): Promise<Site | null> {
  const snap = await getDoc(doc(db, "sites", siteId));
  return snap.exists() ? withId<Site>(snap.id, snap.data()) : null;
}

/** Site list scoped to the caller. Admin/national staff read all sites;
 *  county staff are constrained to their county; operators to their
 *  organization — the constraint mirrors the /sites LIST rule exactly, so the
 *  server enforces it. Unassigned accounts get none instead of a denial that
 *  would leave the UI loading forever. */
async function sitesForUser(user: UserProfile): Promise<Site[]> {
  return scopedAll<Site>("sites", user);
}

async function all<T>(name: string): Promise<T[]> {
  const snap = await getDocs(collection(db, name));
  return snap.docs.map((d) => withId<T>(d.id, d.data()));
}

async function whereAll<T>(
  name: string,
  field: string,
  op: "==" | "in",
  value: unknown,
): Promise<T[]> {
  const snap = await getDocs(
    fsQuery(collection(db, name), where(field, op, value)),
  );
  return snap.docs.map((d) => withId<T>(d.id, d.data()));
}

/**
 * Scope-aware collection read (doc 04 gap 5, closed).
 *
 * Every site-scoped record carries denormalized `county` + `operatorName`
 * (stamped at write time from its site). This helper applies EXACTLY the
 * constraint the LIST rules require, so county/operator scoping is enforced by
 * the server: Firestore rejects an unconstrained query for a county-scoped or
 * operator caller instead of silently returning foreign records.
 *
 * Note: records written before scope stamping (or by an external tool) lack
 * the fields and are therefore invisible to county/operator callers until the
 * admin backfill (stats.backfillScopeFields) stamps them. Admin/national
 * callers are unaffected.
 */
async function scopedAll<T>(name: string, user: UserProfile): Promise<T[]> {
  const c = scopeConstraintForUser(user);
  if (c === "all") return all<T>(name);
  if (c === "none") return [];
  return whereAll<T>(name, c.field, "==", c.value);
}

/** Scope-aware single-field query: a base equality filter (e.g. parentId,
 *  inspectionId, findingId) PLUS the caller's scope constraint. Used for
 *  child collections (findings, corrective actions, evidence) whose list rules
 *  apply the same per-document scope check. */
async function scopedWhereAll<T>(
  name: string,
  baseField: string,
  baseValue: unknown,
  user: UserProfile,
): Promise<T[]> {
  const c = scopeConstraintForUser(user);
  if (c === "none") return [];
  const constraints = [where(baseField, "==", baseValue)];
  if (c !== "all") constraints.push(where(c.field, "==", c.value));
  const snap = await getDocs(fsQuery(collection(db, name), ...constraints));
  return snap.docs.map((d) => withId<T>(d.id, d.data()));
}

/** Does any staff user exist yet? (First-run admin bootstrap.)
 *  Uses the meta/hasStaff sentinel doc so the check works under security
 *  rules for users who are not yet staff (they cannot query /users). */
async function anyStaffExists(): Promise<boolean> {
  const snap = await getDoc(doc(db, "meta", "hasStaff"));
  return snap.exists();
}

// Public stats recompute reads four whole collections; throttled to once per
// minute so bursty writes (bulk inspection submission, seeding) don't multiply
// read volume. The seed path forces a refresh.
const PUBLIC_STATS_MIN_INTERVAL_MS = 60_000;

// Public community-report cap per minute. Mirrors the /rateLimits rule guard
// (30/min). The client checks it to fail fast with a friendly message, but the
// authoritative enforcement is the rule-level per-minute counter.
const PUBLIC_REPORT_PER_MINUTE = 30;
let lastPublicStatsAt = 0;

/** Recompute public aggregate counts (landing page). Never exposes content.
 *  Best-effort: a permission denial (e.g. unauthenticated public submit
 *  flow) must never fail the business transaction itself. */
async function refreshPublicStats(force = false) {
  const now = Date.now();
  if (!force && now - lastPublicStatsAt < PUBLIC_STATS_MIN_INTERVAL_MS) return;
  lastPublicStatsAt = now;
  try {
    const [sites, inspections, incidents, reports] = await Promise.all([
      getDocs(collection(db, "sites")),
      getDocs(collection(db, "inspections")),
      getDocs(collection(db, "incidents")),
      getDocs(collection(db, "communityReports")),
    ]);
    await setDoc(
      doc(db, "meta", "publicStats"),
      {
        sites: sites.size,
        inspections: inspections.size,
        incidents: incidents.size,
        communityReports: reports.size,
        updatedAt: Date.now(),
      },
      { merge: true },
    );
  } catch (err) {
    console.warn("[backend] publicStats refresh skipped:", err);
  }
}

interface PublicStatsShape {
  sites: number;
  inspections: number;
  incidents: number;
  communityReports: number;
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
// AUTH
// ---------------------------------------------------------------------------

export async function fbSignInEmail(email: string, password: string) {
  const { signInWithEmailAndPassword } = await import("firebase/auth");
  const { auth } = await import("./firebase");
  const cred = await signInWithEmailAndPassword(auth, email, password);
  await ensureProfileDoc(cred.user.uid, email, cred.user.displayName);
}

export async function fbSignUpEmail(email: string, password: string, name?: string) {
  const { createUserWithEmailAndPassword, updateProfile } = await import(
    "firebase/auth"
  );
  const { auth } = await import("./firebase");
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (name) await updateProfile(cred.user, { displayName: name });
  await ensureProfileDoc(cred.user.uid, email, name ?? null);
}

export async function fbSignInGuest() {
  const { signInAnonymously, updateProfile } = await import("firebase/auth");
  const { auth } = await import("./firebase");
  const cred = await signInAnonymously(auth);
  await ensureProfileDoc(
    cred.user.uid,
    null,
    cred.user.displayName ?? null,
  ).catch(() => {});
  // Anonymous sign-in requires the provider to be enabled in the Firebase
  // console; updateProfile is cosmetic and must not block sign-in.
  void updateProfile;
}

export async function fbSignOut() {
  const { signOut } = await import("firebase/auth");
  const { auth } = await import("./firebase");
  await signOut(auth);
}

/** Create the profile doc for a fresh account (idempotent). */
export async function ensureProfileDoc(
  uid: string,
  email: string | null,
  name: string | null,
) {
  const existing = await getDoc(doc(db, "users", uid));
  if (existing.exists()) return;
  await setDoc(doc(db, "users", uid), {
    email,
    emailLower: (email ?? "").toLowerCase(),
    name,
    role: null,
    scope: null,
    profileComplete: false,
    createdAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// API SURFACE — shaped like the previous Convex `api` object
// ---------------------------------------------------------------------------

export const api = {
  // ----------------------------------------------------------------- users
  users: {
    // Single-document subscription: the profile updates via push (e.g. the
    // profile-completion dialog closes the instant the write lands) instead of
    // refetching the whole users collection.
    currentUser: () =>
      liveDoc<UserProfile>(() => {
        const u = auth.currentUser;
        return u ? doc(db, "users", u.uid) : null;
      }),
  },

  // ----------------------------------------------------------------- sites
  sites: {
    list: () =>
      live<(Site & { openActions: number })[]>(async () => {
        const user = await requireAuthed(true);
        // Unassigned accounts have no readable scope — empty, not an error.
        if (!user.role) return [];
        const [sites, cas] = await Promise.all([
          sitesForUser(user),
          scopedAll<CorrectiveAction>("correctiveActions", user),
        ]);
        const openBySite = new Map<string, number>();
        for (const ca of cas) {
          if (ca.status !== "closed" && ca.status !== "verified") {
            openBySite.set(ca.siteId, (openBySite.get(ca.siteId) ?? 0) + 1);
          }
        }
        return sites
          .filter((s) => canAccessSite(user, s))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({ ...s, openActions: openBySite.get(s._id) ?? 0 }));
      }, ["sites", "correctiveActions"]),

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
      const existing = await all<Site>("sites");
      const code = nextSiteCodeFrom(
        args.county,
        existing.map((s) => s.code),
      );
      const refDoc = await addDoc(collection(db, "sites"), {
        ...args,
        status: "pending_verification",
        code,
        createdBy: user.uid,
        createdAt: Date.now(),
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "site.create",
        entityType: "sites",
        entityId: refDoc.id,
        summary: `Registered site ${code} (${args.name}) in ${args.county}`,
      });
      await refreshPublicStats();
      return refDoc.id;
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
      await updateDoc(doc(db, "sites", args.siteId), {
        status: args.status,
      });
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
          const [sites, findings, cas, incidents, env] = await Promise.all([
            sitesForUser(user),
            scopedAll<Finding>("findings", user),
            scopedAll<CorrectiveAction>("correctiveActions", user),
            scopedAll<Incident>("incidents", user),
            scopedAll<EnvironmentalObservation>("environmentalObservations", user),
          ]);
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
              low: 0,
              medium: 0,
              high: 0,
              critical: 0,
            };
            for (const f of siteFindings) {
              const p =
                f.severity === "critical"
                  ? W.criticalFinding
                  : f.severity === "high"
                    ? W.highFinding
                    : f.severity === "medium"
                      ? W.mediumFinding
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
        ["sites", "findings", "correctiveActions", "incidents", "environmentalObservations"],
      ),
  },

  // ----------------------------------------------------------- inspections
  inspections: {
    listTemplates: () =>
      live<InspectionTemplate[]>(async () => {
        // Non-sensitive form definitions — operators need them to render
        // inspection records referencing a template (rules allow staff+operator).
        await requireAuthed();
        const allT = await all<InspectionTemplate>("inspectionTemplates");
        return allT.filter((t) => t.active);
      }, ["inspectionTemplates"]),

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
        // Unassigned accounts have no readable scope; return empty rather than
        // triggering a rules denial that would leave the tab loading forever.
        if (!user.role) return [];
        const [inspections, sites] = await Promise.all([
          scopedAll<Inspection>("inspections", user),
          sitesForUser(user),
        ]);
        const byId = new Map(sites.map((s) => [s._id, s]));
        const out = [];
        for (const insp of inspections) {
          const site = byId.get(insp.siteId);
          if (!site) continue;
          // Unified scope filter: admins see all, county staff their county,
          // operators their organization's sites, unassigned accounts none.
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
        const snap = await getDoc(doc(db, "inspections", args.inspectionId));
        if (!snap.exists()) throw new Error("NOT_FOUND");
        const insp = withId<Inspection>(snap.id, snap.data());
        const site = await getSite(insp.siteId);
        // Null (not a throw) so the detail page can render its denied state.
        if (!site) return null;
        if (user.role === ROLES.OPERATOR) {
          if (!user.operatorName || site.operatorName !== user.operatorName)
            return null;
        } else if (!isStaffRole(user.role)) {
          return null;
        }
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
        const existing = await scopedWhereAll<Inspection>(
          "inspections",
          "clientRef",
          args.clientRef,
          user,
        );
        if (existing.length > 0) return existing[0]._id;
      }

      const refDoc = await addDoc(collection(db, "inspections"), {
        siteId: args.siteId,
        templateId: args.templateId,
        inspectorId: user.uid,
        status: "draft",
        clientRef: args.clientRef ?? null,
        ...siteScopeStamp(site), // denormalized county/operatorName (list scoping)
        createdAt: Date.now(),
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "inspection.draft",
        entityType: "inspections",
        entityId: refDoc.id,
        summary: `Draft inspection created at ${site.code}`,
      });
      return refDoc.id;
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
      const snap = await getDoc(doc(db, "inspections", args.inspectionId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const insp = withId<Inspection>(snap.id, snap.data());
      if (insp.inspectorId !== user.uid) throw new Error("FORBIDDEN");
      if (insp.status !== "draft") throw new Error("NOT_EDITABLE");
      const patch: AnyDoc = {};
      if (args.answers !== undefined) patch.answers = args.answers;
      if (args.notes !== undefined) patch.notes = args.notes;
      if (args.latitude !== undefined) patch.latitude = args.latitude;
      if (args.longitude !== undefined) patch.longitude = args.longitude;
      if (args.gpsAccuracyM !== undefined) patch.gpsAccuracyM = args.gpsAccuracyM;
      await updateDoc(doc(db, "inspections", args.inspectionId), patch);
    },

    submit: async (args: { inspectionId: string }) => {
      const user = await requireAuthed();
      const snap = await getDoc(doc(db, "inspections", args.inspectionId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const insp = withId<Inspection>(snap.id, snap.data());
      if (insp.inspectorId !== user.uid) throw new Error("FORBIDDEN");
      if (insp.status !== "draft") throw new Error("NOT_EDITABLE");
      await updateDoc(doc(db, "inspections", args.inspectionId), {
        status: "under_review",
        submittedAt: Date.now(),
      });
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
      const snap = await getDoc(doc(db, "inspections", args.inspectionId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const insp = withId<Inspection>(snap.id, snap.data());
      if (insp.status !== "under_review") throw new Error("NOT_REVIEWABLE");
      await updateDoc(doc(db, "inspections", args.inspectionId), {
        status: args.decision,
        reviewedAt: Date.now(),
        reviewerId: user.uid,
        reviewNote: args.note ?? null,
      });
      const site = await getSite(insp.siteId);
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: `inspection.${args.decision}`,
        entityType: "inspections",
        entityId: args.inspectionId,
        summary: `Inspection at ${site?.code ?? insp.siteId} ${args.decision} by reviewer`,
      });
    },

    listFindingsForInspection: (args: { inspectionId: string }) =>
      live<Finding[]>(async () => {
        const user = await requireAuthed();
        // Operators may read findings for inspections at sites they operate
        // (they acknowledge findings and respond to corrective actions).
        const snap = await getDoc(doc(db, "inspections", args.inspectionId));
        if (!snap.exists()) throw new Error("NOT_FOUND");
        const insp = withId<Inspection>(snap.id, snap.data());
        const site = await getSite(insp.siteId);
        if (!site || !canAccessSite(user, site)) throw new Error("FORBIDDEN");
        return await scopedWhereAll<Finding>(
          "findings",
          "inspectionId",
          args.inspectionId,
          user,
        );
      }, ["findings"]),

    addFinding: async (args: {
      inspectionId: string;
      title: string;
      description?: string;
      severity: Finding["severity"];
    }) => {
      const user = await requireStaffUser();
      const snap = await getDoc(doc(db, "inspections", args.inspectionId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const insp = withId<Inspection>(snap.id, snap.data());
      const site = await getSite(insp.siteId);
      if (!site) throw new Error("NOT_FOUND");
      const refDoc = await addDoc(collection(db, "findings"), {
        inspectionId: args.inspectionId,
        siteId: insp.siteId,
        title: args.title,
        description: args.description ?? null,
        severity: args.severity,
        status: "open",
        createdById: user.uid,
        ...siteScopeStamp(site), // denormalized county/operatorName (list scoping)
        createdAt: Date.now(),
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "finding.create",
        entityType: "findings",
        entityId: refDoc.id,
        summary: `${args.severity.toUpperCase()} finding recorded: ${args.title}`,
      });
      return refDoc.id;
    },

    updateFindingStatus: async (args: {
      findingId: string;
      status: Finding["status"];
    }) => {
      const user = await requireAuthed();
      const snap = await getDoc(doc(db, "findings", args.findingId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const finding = withId<Finding>(snap.id, snap.data());
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
      await updateDoc(doc(db, "findings", args.findingId), {
        status: args.status,
      });
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
        const snap = await getDoc(doc(db, "findings", args.findingId));
        if (!snap.exists()) throw new Error("NOT_FOUND");
        const finding = withId<Finding>(snap.id, snap.data());
        const site = await getSite(finding.siteId);
        if (!site || !canAccessSite(user, site)) throw new Error("FORBIDDEN");
        return await scopedWhereAll<CorrectiveAction>(
          "correctiveActions",
          "findingId",
          args.findingId,
          user,
        );
      }, ["correctiveActions"]),

    listSiteCorrectiveActions: (args: { siteId: string }) =>
      live<CorrectiveAction[]>(async () => {
        const user = await requireAuthed();
        const site = await getSite(args.siteId);
        if (!site || !canAccessSite(user, site)) return [];
        return await scopedWhereAll<CorrectiveAction>(
          "correctiveActions",
          "siteId",
          args.siteId,
          user,
        );
      }, ["correctiveActions"]),

    openCorrectiveAction: async (args: {
      findingId: string;
      description: string;
      dueAt: number;
    }) => {
      const user = await requireStaffUser();
      const snap = await getDoc(doc(db, "findings", args.findingId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const finding = withId<Finding>(snap.id, snap.data());
      const site = await getSite(finding.siteId);
      if (!site) throw new Error("NOT_FOUND");
      const refDoc = await addDoc(collection(db, "correctiveActions"), {
        findingId: args.findingId,
        siteId: finding.siteId,
        description: args.description,
        status: "open",
        dueAt: args.dueAt,
        openedById: user.uid,
        ...siteScopeStamp(site), // denormalized county/operatorName (list scoping)
        createdAt: Date.now(),
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "ca.open",
        entityType: "correctiveActions",
        entityId: refDoc.id,
        summary: `Corrective action opened (due ${new Date(args.dueAt).toISOString().slice(0, 10)}): ${args.description.slice(0, 80)}`,
      });
      return refDoc.id;
    },

    respondCorrectiveAction: async (args: {
      caId: string;
      operatorNote: string;
    }) => {
      const user = await requireAuthed();
      const snap = await getDoc(doc(db, "correctiveActions", args.caId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const ca = withId<CorrectiveAction>(snap.id, snap.data());
      const site = await getSite(ca.siteId);
      if (!site) throw new Error("NOT_FOUND");
      if (user.role !== ROLES.OPERATOR || user.operatorName !== site.operatorName)
        throw new Error("FORBIDDEN");
      await updateDoc(doc(db, "correctiveActions", args.caId), {
        operatorNote: args.operatorNote,
        status: "submitted",
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "ca.respond",
        entityType: "correctiveActions",
        entityId: args.caId,
        summary: "Operator response submitted for corrective action",
      });
    },

    decideCorrectiveAction: async (args: {
      caId: string;
      decision: CorrectiveAction["status"];
    }) => {
      const user = await requireReviewerUser();
      const snap = await getDoc(doc(db, "correctiveActions", args.caId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const ca = withId<CorrectiveAction>(snap.id, snap.data());
      await updateDoc(doc(db, "correctiveActions", args.caId), {
        status: args.decision,
        verifiedById: user.uid,
        closedAt: args.decision === "closed" ? Date.now() : (ca.closedAt ?? null),
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: `ca.${args.decision}`,
        entityType: "correctiveActions",
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
        const [incidents, sites] = await Promise.all([
          scopedAll<Incident>("incidents", user),
          sitesForUser(user),
        ]);
        const byId = new Map(sites.map((s) => [s._id, s]));
        const out: Incident[] = [];
        for (const inc of incidents) {
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
        const snap = await getDoc(doc(db, "incidents", args.incidentId));
        if (!snap.exists()) throw new Error("NOT_FOUND");
        const inc = withId<Incident>(snap.id, snap.data());
        const site = await getSite(inc.siteId);
        // Null (not a throw) so the detail page can render its denied state.
        if (!site || !canAccessSite(user, site)) return null;
        return {
          ...inc,
          siteCode: site.code,
          siteName: site.name,
          county: site.county,
        };
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
      // must not create a second incident record (same contract as createDraft).
      if (args.clientRef) {
        const existing = await scopedWhereAll<Incident>(
          "incidents",
          "clientRef",
          args.clientRef,
          user,
        );
        if (existing.length > 0) return existing[0]._id;
      }
      const site = await getSite(args.siteId);
      if (!site) throw new Error("NOT_FOUND");
      if (!canAccessSite(user, site)) throw new Error("FORBIDDEN");
      const refDoc = await addDoc(collection(db, "incidents"), {
        siteId: args.siteId,
        type: args.type,
        severity: args.severity,
        description: args.description,
        occurredAt: args.occurredAt,
        fatalities: args.fatalities ?? null,
        injured: args.injured ?? null,
        status: "reported",
        clientRef: args.clientRef ?? null,
        reportedById: user.uid,
        reportSource: user.role === ROLES.OPERATOR ? "operator" : "inspector",
        ...siteScopeStamp(site), // denormalized county/operatorName (list scoping)
        createdAt: Date.now(),
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "incident.report",
        entityType: "incidents",
        entityId: refDoc.id,
        summary: `${args.type.replace("_", " ")} reported at ${site.code}`,
      });
      await refreshPublicStats();
      return refDoc.id;
    },

    setIncidentStatus: async (args: {
      incidentId: string;
      status: "investigating" | "closed";
    }) => {
      const user = await requireStaffUser();
      await updateDoc(doc(db, "incidents", args.incidentId), {
        status: args.status,
      });
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
        const [obs, sites] = await Promise.all([
          scopedAll<EnvironmentalObservation>("environmentalObservations", user),
          sitesForUser(user),
        ]);
        const byId = new Map(sites.map((s) => [s._id, s]));
        const out: EnvironmentalObservation[] = [];
        for (const o of obs) {
          const site = byId.get(o.siteId);
          if (!site) continue;
          if (!canAccessSite(user, site)) continue;
          out.push({
            ...o,
            siteCode: site.code,
            siteName: site.name,
            county: site.county,
          });
        }
        out.sort((a, b) => b.observedAt - a.observedAt);
        return out;
      }, ["environmentalObservations", "sites"]),

    getObservation: (args: { observationId: string }) =>
      live<EnvironmentalObservation | null>(async () => {
        const user = await requireAuthed();
        const snap = await getDoc(
          doc(db, "environmentalObservations", args.observationId),
        );
        if (!snap.exists()) throw new Error("NOT_FOUND");
        const obs = withId<EnvironmentalObservation>(snap.id, snap.data());
        const site = await getSite(obs.siteId);
        // Null (not a throw) so the detail page can render its denied state.
        if (!site || !canAccessSite(user, site)) return null;
        return {
          ...obs,
          siteCode: site.code,
          siteName: site.name,
          county: site.county,
        };
      }, ["environmentalObservations", "sites"]),

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
        const existing = await scopedWhereAll<EnvironmentalObservation>(
          "environmentalObservations",
          "clientRef",
          args.clientRef,
          user,
        );
        if (existing.length > 0) return existing[0]._id;
      }
      const site = await getSite(args.siteId);
      if (!site) throw new Error("NOT_FOUND");
      if (!canAccessSite(user, site)) throw new Error("FORBIDDEN");
      const refDoc = await addDoc(
        collection(db, "environmentalObservations"),
        {
          siteId: args.siteId,
          category: args.category,
          verification: args.verification,
          description: args.description,
          observedAt: args.observedAt,
          latitude: args.latitude ?? null,
          longitude: args.longitude ?? null,
          status: "open",
          clientRef: args.clientRef ?? null,
          reportedById: user.uid,
          ...siteScopeStamp(site), // denormalized county/operatorName (list scoping)
          createdAt: Date.now(),
        },
      );
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "observation.report",
        entityType: "environmentalObservations",
        entityId: refDoc.id,
        summary: `${args.category.replace("_", " ")} (${args.verification}) at ${site.code}`,
      });
      return refDoc.id;
    },

    setObservationStatus: async (args: {
      observationId: string;
      status: "open" | "monitoring" | "resolved";
    }) => {
      const user = await requireStaffUser();
      await updateDoc(
        doc(db, "environmentalObservations", args.observationId),
        { status: args.status },
      );
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "observation.status",
        entityType: "environmentalObservations",
        entityId: args.observationId,
        summary: `Observation status set to ${args.status}`,
      });
    },

    listCommunityReports: () =>
      live<CommunityReport[]>(async () => {
        // Staff-only data (rules). Non-staff callers get an empty queue
        // instead of a denial that would leave the UI loading forever.
        const user = await requireAuthed();
        if (!isStaffRole(user.role)) return [];
        // County-scoped staff triage only their county's reports (rules enforce
        // the same condition on report read).
        const allR = await scopedAll<CommunityReport>("communityReports", user);
        allR.sort((a, b) => b.createdAt - a.createdAt);
        return allR;
      }, ["communityReports"]),

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
      const now = Date.now();
      // ---------------------------------------------------- rate-limit handshake
      // The /communityReports create rule requires the report to carry the
      // CURRENT per-minute bucket id AND for a counter doc at
      // /rateLimits/cr-{unixMinute} to already exist under the cap. That bucket
      // is the authoritative server-side limiter; the client must perform this
      // half (create-or-increment) or the create is denied outright. Rules
      // recompute the id from SERVER request time, so a submission straddling a
      // minute boundary can be rejected — an honest limitation documented in
      // doc 04, where a Cloud Function gatekeeper is the planned full fix.
      const bucketId = `cr-${Math.floor(now / 60000)}`;
      const bucketRef = doc(db, "rateLimits", bucketId);
      const bucketSnap = await getDoc(bucketRef);
      if (!bucketSnap.exists()) {
        // Rules pin create to count == 1 with numeric timestamps.
        await setDoc(bucketRef, { count: 1, createdAt: now, updatedAt: now });
      } else {
        const count = Number(bucketSnap.data().count ?? 0);
        if (count >= PUBLIC_REPORT_PER_MINUTE) throw new Error("RATE_LIMITED");
        // Rules allow only count (+1 exactly) and updatedAt to change.
        await updateDoc(bucketRef, { count: count + 1, updatedAt: now });
      }

      const trackingCode = makeTrackingCode();
      const refDoc = await addDoc(collection(db, "communityReports"), {
        ...args,
        trackingCode,
        status: "submitted",
        rateBucket: bucketId,
        createdAt: now,
      });
      await setDoc(
        doc(db, "reportTracking", trackingCode),
        { trackingCode, status: "submitted", createdAt: now },
      );
      await logAudit({
        actorLabel: "public",
        action: "communityReport.submit",
        entityType: "communityReports",
        entityId: refDoc.id,
        summary: `Public report ${trackingCode} (${args.category}) in ${args.county}`,
      });
      await refreshPublicStats();
      return { id: refDoc.id, trackingCode };
    },

    /** Public: track by code. Returns only coarse, non-sensitive fields. */
    trackCommunityReport: (args: { trackingCode: string }) =>
      live<{ trackingCode: string; status: string; createdAt: number } | null>(
        async () => {
          const snap = await getDoc(
            doc(db, "reportTracking", args.trackingCode.trim().toUpperCase()),
          );
          if (!snap.exists()) return null;
          const d = snap.data();
          return {
            trackingCode: d.trackingCode as string,
            status: d.status as string,
            createdAt: d.createdAt as number,
          };
        },
        ["reportTracking"],
      ),

    triageCommunityReport: async (args: {
      reportId: string;
      decision: CommunityReport["status"];
      note?: string;
    }) => {
      const user = await requireReviewerUser();
      const snap = await getDoc(doc(db, "communityReports", args.reportId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const report = withId<CommunityReport>(snap.id, snap.data());
      await updateDoc(doc(db, "communityReports", args.reportId), {
        status: args.decision,
        triageNote: args.note ?? null,
        reviewedById: user.uid,
        reviewedAt: Date.now(),
      });
      if (report.trackingCode) {
        await setDoc(
          doc(db, "reportTracking", report.trackingCode),
          { trackingCode: report.trackingCode, status: args.decision },
          { merge: true },
        );
      }
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "communityReport.triage",
        entityType: "communityReports",
        entityId: args.reportId,
        summary: `Report ${report.trackingCode} triaged: ${args.decision}`,
      });
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
            sites: 0,
            activeSites: 0,
            inspectionsTotal: 0,
            inspectionsUnderReview: 0,
            findingsTotal: 0,
            findingsCriticalOpen: 0,
            correctiveActionsOpen: 0,
            correctiveActionsOverdue: 0,
            incidentsTotal: 0,
            fatalities: 0,
            envAlerts: 0,
            envByCategory: {},
            communityReports: 0,
            communityReportsPending: 0,
            inspectionCoveragePct: 0,
            countyCounts: {},
            incidentTypes: {},
          };
        }
        const [sites, inspections, findings, cas, incidents, env, reports] =
          await Promise.all([
            sitesForUser(user),
            scopedAll<Inspection>("inspections", user),
            scopedAll<Finding>("findings", user),
            scopedAll<CorrectiveAction>("correctiveActions", user),
            scopedAll<Incident>("incidents", user),
            scopedAll<EnvironmentalObservation>("environmentalObservations", user),
            // Community reports are staff-readable only (rules). Operators
            // legitimately see zeros for these figures.
            staff
              ? scopedAll<CommunityReport>("communityReports", user)
              : Promise.resolve([] as CommunityReport[]),
          ]);
        const now = Date.now();

        const visibleSites = sites.filter((s) => canAccessSite(user, s));
        const visibleIds = new Set(visibleSites.map((s) => s._id));

        const visInspections = inspections.filter((i) =>
          visibleIds.has(i.siteId),
        );
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
          visInspections
            .filter((i) => i.status === "approved")
            .map((i) => i.siteId),
        );
        const coverage =
          visibleSites.length === 0
            ? 0
            : Math.round((approved.size / visibleSites.length) * 100);

        const countyCounts: Record<string, number> = {};
        for (const s of visibleSites) {
          countyCounts[s.county] = (countyCounts[s.county] ?? 0) + 1;
        }

        const countBy = (arr: AnyDoc[], key: string) => {
          const m: Record<string, number> = {};
          for (const item of arr) {
            const k = String(item[key]);
            m[k] = (m[k] ?? 0) + 1;
          }
          return m;
        };

        return {
          scope: user.scope ?? "national",
          sites: visibleSites.length,
          activeSites: visibleSites.filter((s) => s.status === "active").length,
          inspectionsTotal: visInspections.length,
          inspectionsUnderReview: visInspections.filter(
            (i) => i.status === "under_review",
          ).length,
          findingsTotal: visFindings.length,
          findingsCriticalOpen: visFindings.filter(
            (f) =>
              f.severity === "critical" &&
              (f.status === "open" || f.status === "acknowledged"),
          ).length,
          correctiveActionsOpen: openCa.length,
          correctiveActionsOverdue: overdueCa.length,
          incidentsTotal: visIncidents.length,
          fatalities,
          envAlerts: envAlerts.length,
          envByCategory: countBy(visEnv as unknown as AnyDoc[], "category"),
          communityReports: reports.length,
          communityReportsPending: reports.filter(
            (r) => r.status === "submitted",
          ).length,
          inspectionCoveragePct: coverage,
          countyCounts,
          incidentTypes: countBy(visIncidents as unknown as AnyDoc[], "type"),
        };
      }, ["sites", "inspections", "findings", "correctiveActions", "incidents", "environmentalObservations", "communityReports"]),

    recentAuditLog: () =>
      live<AuditEntry[]>(async () => {
        // Staff-only data (rules); non-staff get an empty list, not a hang.
        const user = await requireAuthed();
        if (!isStaffRole(user.role)) return [];
        const snap = await getDocs(
          fsQuery(
            collection(db, "auditLog"),
            orderBy("createdAt", "desc"),
            fbLimit(200),
          ),
        );
        return snap.docs.map((d) => withId<AuditEntry>(d.id, d.data()));
      }, ["auditLog"]),

    publicStats: () =>
      liveDoc<PublicStatsShape>(() => doc(db, "meta", "publicStats"), {
        authBound: false,
      }),

    listUsers: () =>
      live<UserProfile[]>(async () => {
        await requireAdminUser(true);
        return await all<UserProfile>("users");
      }, ["users"]),

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
      await updateDoc(doc(db, "users", args.userId), {
        role: args.role,
        scope: args.scope ?? target.scope ?? null,
        county: args.county ?? target.county ?? null,
        operatorName: args.operatorName ?? target.operatorName ?? null,
        profileComplete: true,
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "user.role.set",
        entityType: "users",
        entityId: args.userId,
        summary: `Role ${args.role} assigned to ${target.email ?? args.userId}`,
      });
    },

    provisionByEmail: async (args: {
      email: string;
      role: Role;
      scope: Scope;
      county?: string;
      operatorName?: string;
    }) => {
      const user = await requireAdminUser();
      const snap = await getDocs(
        fsQuery(
          collection(db, "users"),
          where("emailLower", "==", args.email.toLowerCase()),
          fbLimit(1),
        ),
      );
      if (snap.empty)
        throw new Error("USER_NOT_FOUND: that email has not signed in yet");
      const targetDoc = snap.docs[0];
      await updateDoc(targetDoc.ref, {
        role: args.role,
        scope: args.scope,
        county: args.county ?? targetDoc.data().county ?? null,
        operatorName:
          args.operatorName ?? targetDoc.data().operatorName ?? null,
        profileComplete: true,
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "user.role.set",
        entityType: "users",
        entityId: targetDoc.id,
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
      const user = await requireAuthed();
      if (auth.currentUser?.isAnonymous) {
        throw new Error(
          "GUEST_ACCOUNT: guest accounts cannot hold staff roles. Sign up with an email account instead.",
        );
      }
      // First-run bootstrap: if no staff exists yet (meta/hasStaff sentinel
      // absent), the first user to complete a profile becomes the platform
      // administrator. This is the only path that grants admin without a
      // prior admin, and the security rules re-verify the same condition.
      // Users can never write their own role in any other circumstance.
      const isFirst = !(await anyStaffExists());
      const patch: AnyDoc = {
        jobTitle: args.jobTitle,
        organization: args.organization,
        scope: args.scope ?? user.scope ?? null,
        county: args.county ?? user.county ?? null,
        operatorName: args.operatorName ?? user.operatorName ?? null,
        profileComplete: true,
      };
      if (isFirst) patch.role = ROLES.ADMIN;
      await updateDoc(doc(db, "users", user.uid), patch);
      if (isFirst) {
        await setDoc(doc(db, "meta", "hasStaff"), {
          createdAt: Date.now(),
          bootstrappedBy: user.uid,
        });
      }
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "user.profile.complete",
        entityType: "users",
        entityId: user.uid,
        summary: `Profile completed for ${user.email ?? user.uid}${isFirst ? " (bootstrapped as first admin)" : ""}`,
      });
    },
  },

  // -------------------------------------------------------------- evidence
  evidence: {
    /**
     * Upload bytes to Storage, then record the evidence doc.
     *
     * STORAGE RULES CONTRACT (storage.rules): the object path MUST be
     * evidence/{uid}/{evidenceDocId}__{fileName} — the storage rules parse
     * the doc id out of the file name and join it to this Firestore metadata
     * doc to re-derive role + tenant. siteId is MANDATORY (rules require a
     * string; the caller derives it from the parent record before calling).
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
      // The site must exist and be visible to the uploader — evidence can
      // only ever be attached to a record in the caller's scope.
      const site = await getSite(args.siteId);
      if (!site || !canAccessSite(user, site)) throw new Error("FORBIDDEN");
      const kind = evidenceKindByMime(args.mimeType);
      // 1. Generate the metadata doc id FIRST (no write yet) so the storage
      //    object name can embed it — {docId}__{fileName} is the join key
      //    storage.rules parse to re-check role + tenant on every read.
      //    Order matters: rules forbid evidence updates (append-only by
      //    design), so the metadata doc must be created exactly once with the
      //    final storagePath already known.
      const refDoc = doc(collection(db, "evidence"));
      const storagePath = `evidence/${user.uid}/${refDoc.id}__${args.fileName}`;
      // 2. Upload bytes under the rules-contract path (uid folder + 25MB cap
      //    re-checked server-side by storage.rules).
      await uploadBytes(ref(fbStorage(), storagePath), args.file, {
        contentType: args.mimeType,
      });
      // 3. Create the metadata doc (create, not update) — reads only work
      //    once this exists, so a failed write here leaves no orphaned
      //    readable bytes.
      await setDoc(refDoc, {
        storagePath,
        parentType: args.parentType,
        parentId: args.parentId,
        siteId: args.siteId,
        kind,
        fileName: args.fileName,
        mimeType: args.mimeType,
        sizeBytes: args.file.size,
        caption: args.caption ?? null,
        capturedAt: args.capturedAt ?? null,
        uploadedById: user.uid,
        createdAt: Date.now(),
      });
      await logAudit({
        actorId: user.uid,
        actorLabel: await actorLabel(user),
        action: "evidence.upload",
        entityType: "evidence",
        entityId: refDoc.id,
        summary: `${kind} evidence attached to ${args.parentType} at site ${site.code}`,
      });
      return refDoc.id;
    },

    listForParent: (args: { parentType: Evidence["parentType"]; parentId: string }) =>
      live<Evidence[]>(async () => {
        const user = await requireAuthed();
        if (!user.role) return [];
        const snap = await getDocs(
          fsQuery(
            collection(db, "evidence"),
            where("parentType", "==", args.parentType),
            where("parentId", "==", args.parentId),
          ),
        );
        // Tenant re-check per record (doc 04 gap 5: list rules are coarse;
        // single-doc gets are rules-enforced via siteVisibleAt). Skips records
        // with no siteId so operators never see site-less legacy metadata.
        const out: Evidence[] = [];
        for (const d of snap.docs) {
          const ev = withId<Evidence>(d.id, d.data());
          if (!ev.siteId) continue;
          const site = await getSite(ev.siteId);
          if (site && canAccessSite(user, site)) out.push(ev);
        }
        return out;
      }, ["evidence"]),

    /** Signed-read proxy: returns a fresh download URL for an evidence doc. */
    getUrl: async (evidenceId: string): Promise<string | null> => {
      await requireAuthed();
      const snap = await getDoc(doc(db, "evidence", evidenceId));
      if (!snap.exists()) throw new Error("NOT_FOUND");
      const ev = withId<Evidence>(snap.id, snap.data());
      try {
        return await getDownloadURL(ref(fbStorage(), ev.storagePath));
      } catch {
        return null;
      }
    },

    storageFootprint: () =>
      live<{ count: number; totalBytes: number }>(async () => {
        await requireAdminUser();
        const allE = await all<Evidence>("evidence");
        return {
          count: allE.length,
          totalBytes: allE.reduce((a, e) => a + (e.sizeBytes ?? 0), 0),
        };
      }, ["evidence"]),
  },

  // ------------------------------------------------------------------ seed
  seed: {
    checkSeeded: () =>
      live<{ seeded: boolean }>(async () => {
        const snap = await getDocs(fbQuerySites());
        return { seeded: snap.size > 0 };
      }, ["sites"]),

    /** Demo seeding writes sites/templates/inspections — admin-only under
     *  the security rules, so the data layer checks admin to fail fast. */
    seedIfEmpty: async () => {
      const user = await requireAdminUser();
      const existing = await getDocs(collection(db, "sites"));
      if (existing.size > 0) {
        return { seeded: false, reason: "not_empty" as const };
      }
      await runSeed(user);
      return { seeded: true as const };
      // (runSeed forces a publicStats refresh via refreshPublicStats(true))
    },
  },
};

// Small helper kept near seed to avoid importing query builder twice.
function fbQuerySites() {
  return fsQuery(collection(db, "sites"), fbLimit(1));
}

// ---------------------------------------------------------------------------
// DEV SEED — synthetic demonstration records only. Never real government data.
// Provenance for every seeded record is the authenticated account running it.
// ---------------------------------------------------------------------------

async function runSeed(user: UserProfile) {
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

  const siteIds: Record<string, { id: string; code: string; county: string }> = {};
  for (const def of siteDefs) {
    const existing = await all<Site>("sites");
    const code = nextSiteCodeFrom(
      def.county,
      existing.map((s) => s.code),
    );
    const refDoc = await addDoc(collection(db, "sites"), {
      code,
      name: def.name,
      operatorName: def.operatorName,
      mineralType: def.mineralType,
      county: def.county,
      district: def.district,
      community: def.community,
      status: "active",
      latitude: def.lat,
      longitude: def.lng,
      notes: "Synthetic demonstration record — not real operational data.",
      createdBy: uid,
      createdAt: now,
    });
    siteIds[def.name] = { id: refDoc.id, code, county: def.county };
  }

  const templateRef = await addDoc(collection(db, "inspectionTemplates"), {
    name: "Standard Mining Safety & Environmental Inspection",
    description:
      "Configurable baseline template used by field inspectors. Sections and questions can be edited by administrators.",
    active: true,
    createdBy: uid,
    createdAt: now,
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
  const templateId = templateRef.id;

  const zorzor = siteIds["Demo Gold Operation — Zorzor Corridor"];
  const yekepa = siteIds["Demo Iron Ore Quarry — Yekepa"];
  const robertsport = siteIds["Demo Sand Mining — Robertsport"];

  const insp1 = await addDoc(collection(db, "inspections"), {
    siteId: zorzor.id,
    templateId,
    inspectorId: uid,
    status: "approved",
    answers: {
      "0:0": true,
      "0:1": true,
      "0:2": 24,
      "0:3": "Fair",
      "1:0": true,
      "1:1": false,
      "2:0": true,
      "2:1": false,
      "3:0": true,
    },
    notes: "Routine inspection; PPE compliance observed at both pits.",
    latitude: 7.6067,
    longitude: 9.4236,
    submittedAt: now - 6 * day,
    reviewedAt: now - 5 * day,
    createdAt: now - 7 * day,
  });

  const f1 = await addDoc(collection(db, "findings"), {
    inspectionId: insp1.id,
    siteId: zorzor.id,
    title: "Sediment discharge into seasonal stream",
    description: "Uncontrolled runoff from the processing area entering the stream.",
    severity: "high",
    status: "acknowledged",
    createdById: uid,
    createdAt: now - 6 * day,
  });

  await addDoc(collection(db, "correctiveActions"), {
    findingId: f1.id,
    siteId: zorzor.id,
    description: "Construct sediment settling basin before discharge point.",
    status: "in_progress",
    dueAt: now + 14 * day,
    openedById: uid,
    createdAt: now - 5 * day,
  });

  const insp2 = await addDoc(collection(db, "inspections"), {
    siteId: yekepa.id,
    templateId,
    inspectorId: uid,
    status: "under_review",
    answers: {
      "0:0": true,
      "0:1": false,
      "0:2": 11,
      "0:3": "Fair",
      "1:0": true,
      "1:1": true,
      "1:2": "Berms eroded on eastern section.",
      "2:0": false,
      "2:1": true,
      "3:0": true,
    },
    notes: "Haul-road inspection; berms low on the eastern section.",
    latitude: 7.5989,
    longitude: 8.6333,
    submittedAt: now - 2 * day,
    createdAt: now - 3 * day,
  });

  await addDoc(collection(db, "findings"), {
    inspectionId: insp2.id,
    siteId: yekepa.id,
    title: "Haul-road berms below required height",
    description: "Eastern section berms measured below 1.5m at three points.",
    severity: "medium",
    status: "open",
    createdById: uid,
    createdAt: now - 2 * day,
  });

  await addDoc(collection(db, "incidents"), {
    siteId: robertsport.id,
    type: "injury",
    severity: "medium",
    description: "Worker laceration from handling screen mesh; treated on site.",
    occurredAt: now - 4 * day,
    injured: 1,
    status: "investigating",
    reportedById: uid,
    reportSource: "inspector",
    createdAt: now - 4 * day,
  });

  await addDoc(collection(db, "environmentalObservations"), {
    siteId: zorzor.id,
    category: "water_pollution",
    verification: "measured",
    description: "Turbidity downstream visibly elevated; sample taken for analysis.",
    observedAt: now - 5 * day,
    latitude: 7.6067,
    longitude: 9.4236,
    status: "monitoring",
    reportedById: uid,
    createdAt: now - 5 * day,
  });

  await addDoc(collection(db, "communityReports"), {
    trackingCode: "CR-DEMO0001",
    category: "pollution",
    description: "Community reports discolored water in the creek used for washing.",
    county: "Lofa",
    community: "Zorzor City",
    status: "under_review",
    createdAt: now - 3 * day,
  });
  await setDoc(doc(db, "reportTracking", "CR-DEMO0001"), {
    trackingCode: "CR-DEMO0001",
    status: "under_review",
    createdAt: now - 3 * day,
  });

  await addDoc(collection(db, "communityReports"), {
    trackingCode: "CR-DEMO0002",
    category: "suspected_illegal_mining",
    description: "Unknown digging activity observed after dark near the ridge.",
    county: "Nimba",
    community: "Yekepa",
    status: "submitted",
    createdAt: now - 1 * day,
  });
  await setDoc(doc(db, "reportTracking", "CR-DEMO0002"), {
    trackingCode: "CR-DEMO0002",
    status: "submitted",
    createdAt: now - 1 * day,
  });

  await addDoc(collection(db, "auditLog"), {
    actorId: uid,
    actorLabel: label,
    action: "system.seed",
    entityType: "sites",
    summary: "Dev seed data inserted (synthetic demonstration records only)",
    createdAt: now,
  });

  await refreshPublicStats(true);
}
