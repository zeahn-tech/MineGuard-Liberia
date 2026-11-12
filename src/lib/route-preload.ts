// ---------------------------------------------------------------------------
// ROUTE PRELOADING — why a tab click must never blank the screen.
//
// Every page is a lazy chunk. If a click reaches a page whose chunk has not been
// downloaded yet, React has to wait for it. Waiting is normally harmless (a
// router navigation is a transition, so the old page stays on screen) — BUT the
// app's data hooks read their cache through useSyncExternalStore, and React
// cannot run those updates as transitions. Any background refresh, queue poll or
// notification that lands while the chunk is still downloading drags the pending
// navigation into a blocking render, and the nearest <Suspense> fallback replaces
// whatever it wraps. With a single boundary at the very top of the app, that was
// the whole screen: sidebar, header and page vanished for a moment.
//
// Two defences, both in place:
//   1. Each shell wraps its <Outlet /> in its own boundary (RouteBoundary), so a
//      pending page only ever replaces the page area — the shell stays put.
//   2. This module warms the chunks so the boundary is rarely reached at all:
//      on pointer-hover / focus / touch of a link (intent), and for the likely
//      next pages during idle time (skipped on Data Saver and slow links, where
//      downloading pages nobody asked for would cost the people we build for).
//
// The specifiers below are the same ones main.tsx lazy-loads; the bundler
// de-duplicates them, so a preload is the real chunk, not a second copy.
// ---------------------------------------------------------------------------

type Loader = () => Promise<unknown>;

interface RouteEntry {
  /** Matches the router pathname (hash routing: no "#"). */
  test: RegExp;
  load: Loader[];
  /** Small, commonly visited pages — safe to warm during idle time. */
  idle?: boolean;
}

const ROUTES: RouteEntry[] = [
  // ---- staff portal ----
  { test: /^\/portal\/?$/, load: [() => import("../pages/CommandCenter.tsx")], idle: true },
  { test: /^\/portal\/sites\/[^/]+/, load: [() => import("../pages/SiteDetail.tsx")] },
  { test: /^\/portal\/sites\/?$/, load: [() => import("../pages/Sites.tsx")], idle: true },
  { test: /^\/portal\/oversight/, load: [() => import("../pages/Oversight.tsx")], idle: true },
  { test: /^\/portal\/map/, load: [() => import("../pages/NationalMap.tsx")] },
  { test: /^\/portal\/companies\/[^/]+/, load: [() => import("../pages/CompanyDetail.tsx")] },
  { test: /^\/portal\/companies\/?$/, load: [() => import("../pages/Companies.tsx")] },
  { test: /^\/portal\/site-requests/, load: [() => import("../pages/SiteRequests.tsx")] },
  { test: /^\/portal\/users/, load: [() => import("../pages/AdminUsers.tsx")] },
  { test: /^\/portal\/boundaries/, load: [() => import("../pages/Boundaries.tsx")] },
  { test: /^\/portal\/inspections\/[^/]+/, load: [() => import("../pages/InspectionDetail.tsx")] },
  { test: /^\/portal\/inspections\/?$/, load: [() => import("../pages/Inspections.tsx")], idle: true },
  { test: /^\/portal\/corrective-actions/, load: [() => import("../pages/CorrectiveActions.tsx")], idle: true },
  { test: /^\/portal\/incidents\/[^/]+/, load: [() => import("../pages/IncidentDetail.tsx")] },
  { test: /^\/portal\/incidents\/?$/, load: [() => import("../pages/Incidents.tsx")], idle: true },
  { test: /^\/portal\/emergency\/[^/]+/, load: [() => import("../pages/emergency/EmergencyAlertPage.tsx")] },
  { test: /^\/portal\/emergency\/?$/, load: [() => import("../pages/emergency/EmergencyConsole.tsx")] },
  { test: /^\/portal\/safety/, load: [() => import("../pages/safety/SafetyGuidance.tsx")] },
  { test: /^\/portal\/jsa/, load: [() => import("../pages/safety/JsaPage.tsx")] },
  { test: /^\/portal\/environment\/[^/]+/, load: [() => import("../pages/ObservationDetail.tsx")] },
  { test: /^\/portal\/environment\/?$/, load: [() => import("../pages/Environment.tsx")], idle: true },
  { test: /^\/portal\/community/, load: [() => import("../pages/Community.tsx")], idle: true },
  { test: /^\/portal\/feedback/, load: [() => import("../pages/FeedbackInbox.tsx")] },
  { test: /^\/portal\/content/, load: [() => import("../pages/ContentAdmin.tsx")] },
  { test: /^\/portal\/voice-ministry/, load: [() => import("../pages/voice/MinistryVoiceReview.tsx")] },
  { test: /^\/portal\/reports/, load: [() => import("../pages/Reports.tsx")] },
  { test: /^\/portal\/audit/, load: [() => import("../pages/Audit.tsx")] },
  { test: /^\/portal\/risk-config/, load: [() => import("../pages/RiskConfig.tsx")] },
  { test: /^\/portal\/templates/, load: [() => import("../pages/Templates.tsx")] },
  { test: /^\/portal\/profile/, load: [() => import("../pages/ProfileSettings.tsx")] },
  { test: /^\/portal\/security/, load: [() => import("../pages/Security.tsx")] },

  // ---- company (operator) section ----
  { test: /^\/operate\/?$/, load: [() => import("../pages/operate/OperatorOverview.tsx")], idle: true },
  { test: /^\/operate\/sites/, load: [() => import("../pages/operate/OperatorSites.tsx")], idle: true },
  { test: /^\/operate\/findings/, load: [() => import("../pages/operate/OperatorFindings.tsx")], idle: true },
  { test: /^\/operate\/corrective-actions/, load: [() => import("../pages/operate/OperatorCorrectiveActions.tsx")], idle: true },
  { test: /^\/operate\/incidents/, load: [() => import("../pages/operate/OperatorIncidents.tsx")], idle: true },
  { test: /^\/operate\/emergency\/[^/]+/, load: [() => import("../pages/emergency/EmergencyAlertPage.tsx")] },
  { test: /^\/operate\/emergency\/?$/, load: [() => import("../pages/emergency/EmergencyConsole.tsx")] },
  { test: /^\/operate\/safety/, load: [() => import("../pages/safety/SafetyGuidance.tsx")] },
  { test: /^\/operate\/jsa/, load: [() => import("../pages/safety/JsaPage.tsx")] },
  { test: /^\/operate\/voice-review/, load: [() => import("../pages/voice/VoiceReview.tsx")] },
  { test: /^\/operate\/voice/, load: [() => import("../pages/voice/VoiceReport.tsx")] },
  { test: /^\/operate\/ministry-requests/, load: [() => import("../pages/voice/MinistryRequests.tsx")] },
  { test: /^\/operate\/team/, load: [() => import("../pages/operate/OperatorTeam.tsx")] },
  { test: /^\/operate\/company/, load: [() => import("../pages/operate/OperatorCompany.tsx")] },
  { test: /^\/operate\/activity/, load: [() => import("../pages/operate/OperatorActivity.tsx")] },
  { test: /^\/operate\/analytics/, load: [() => import("../pages/operate/OperatorAnalytics.tsx")] },
  { test: /^\/operate\/site-requests/, load: [() => import("../pages/operate/OperatorSiteRequests.tsx")] },
  { test: /^\/operate\/import/, load: [() => import("../pages/operate/OperatorImport.tsx")] },
  { test: /^\/operate\/profile/, load: [() => import("../pages/ProfileSettings.tsx")] },
  { test: /^\/operate\/security/, load: [() => import("../pages/operate/OperatorSecurity.tsx")] },

  // ---- registry ----
  { test: /^\/registry\/?$/, load: [() => import("../pages/Companies.tsx")] },
  { test: /^\/registry\/security/, load: [() => import("../pages/operate/OperatorSecurity.tsx")] },
  { test: /^\/registry\/profile/, load: [() => import("../pages/ProfileSettings.tsx")] },
];

const started = new Set<Loader>();

function run(loaders: Loader[]) {
  for (const load of loaders) {
    if (started.has(load)) continue;
    started.add(load);
    // A failed warm-up must never surface: the real navigation retries the import
    // and the existing chunk-recovery handles a genuinely stale build.
    load().catch(() => started.delete(load));
  }
}

function stripQuery(path: string): string {
  return path.split(/[?#]/)[0] || "/";
}

/** Warm the chunk(s) for a router path — call on hover / focus / touch of a link. */
export function preloadRoute(path: string): void {
  const p = stripQuery(path);
  const hit = ROUTES.find((r) => r.test.test(p));
  if (hit) run(hit.load);
}

/** Data Saver or a 2G/3G link: only warm what the person is about to open. */
function constrainedConnection(): boolean {
  if (typeof navigator === "undefined") return false;
  const c = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!c) return false;
  return c.saveData === true || c.effectiveType === "slow-2g" || c.effectiveType === "2g" || c.effectiveType === "3g";
}

/**
 * Warm the common pages of one section while the browser is idle, one at a time,
 * so it never competes with what the person is actually doing. Returns a cancel
 * function for effect cleanup.
 */
export function preloadSectionWhenIdle(prefix: "/portal" | "/operate"): () => void {
  if (typeof window === "undefined" || constrainedConnection()) return () => {};
  const queue = ROUTES.filter((r) => r.idle && r.test.source.startsWith(`^\\${prefix}`)).flatMap((r) => r.load);
  let cancelled = false;
  let handle: number | undefined;
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };

  const next = () => {
    if (cancelled) return;
    const loader = queue.shift();
    if (!loader) return;
    run([loader]);
    schedule();
  };
  const schedule = () => {
    if (cancelled || queue.length === 0) return;
    handle = w.requestIdleCallback
      ? w.requestIdleCallback(next, { timeout: 4000 })
      : window.setTimeout(next, 600);
  };
  // Let the page the person asked for finish first.
  handle = window.setTimeout(schedule, 1500);

  return () => {
    cancelled = true;
    if (handle !== undefined) {
      w.cancelIdleCallback?.(handle);
      window.clearTimeout(handle);
    }
  };
}

/** Props for a link: warm its page the moment intent shows. */
export function preloadProps(path: string) {
  const go = () => preloadRoute(path);
  return { onPointerEnter: go, onFocus: go, onTouchStart: go } as const;
}
