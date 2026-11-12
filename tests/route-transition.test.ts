import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Regression: clicking a sidebar tab blanked the whole screen for a moment.
// Cause: every page is a lazy chunk and the only <Suspense> was at the app root, so a
// page still downloading (kicked to a blocking render by any useSyncExternalStore update)
// replaced the entire shell. See src/lib/route-preload.ts.
describe("tab changes never blank the shell", () => {
  for (const layout of ["src/pages/PortalLayout.tsx", "src/pages/operate/OperatorLayout.tsx", "src/pages/RegistryLayout.tsx"]) {
    test(`${layout} keeps its sidebar/header and suspends only the page area`, () => {
      const src = read(layout);
      expect(src).toMatch(/<RouteBoundary>\s*<Outlet \/>\s*<\/RouteBoundary>/);
      // links warm their chunk + data on hover / focus / touch and hold the current page until the next is ready
      expect(src).toContain("{...intentLink(item.to)}");
    });
  }

  test("the portal and operator shells warm their common pages while idle", () => {
    expect(read("src/pages/PortalLayout.tsx")).toContain('preloadSectionWhenIdle("/portal")');
    expect(read("src/pages/operate/OperatorLayout.tsx")).toContain('preloadSectionWhenIdle("/operate")');
  });

  test("every page that main.tsx lazy-loads under a shell has a preload entry", () => {
    const main = read("src/main.tsx");
    const preload = read("src/lib/route-preload.ts");
    const shellPages = [
      "CommandCenter", "Sites", "SiteDetail", "NationalMap", "Inspections", "InspectionDetail", "Incidents",
      "IncidentDetail", "Environment", "ObservationDetail", "Community", "Audit", "Reports", "RiskConfig",
      "Boundaries", "Oversight", "AdminUsers", "SiteRequests", "Companies", "CompanyDetail", "CorrectiveActions",
      "OperatorOverview", "OperatorSites", "OperatorFindings", "OperatorTeam", "OperatorAnalytics",
    ];
    for (const page of shellPages) {
      expect(main).toContain(`/${page}.tsx`);
      expect(preload).toContain(`/${page}.tsx`);
    }
  });

  test("a tab click holds the current page until the next one's code and data are ready (capped), never a blank swap", () => {
    const pre = read("src/lib/route-preload.ts");
    expect(pre).toContain("HOLD_MAX_MS");
    expect(pre).toContain("e.preventDefault()");
    // the main portal tabs start the data their page waits on
    for (const q of ["api.stats.commandCenter", "api.inspections.listMyCorrectiveActions", "api.sites.list", "api.oversight.list"]) {
      expect(pre).toContain(`prefetchQuery(${q}`);
    }
    expect(read("src/lib/backend-react.ts")).toContain("export function prefetchQuery");
    expect(read("src/components/RouteBoundary.tsx")).toContain("useNavigationPending");
  });

  test("a page-level skeleton is labelled and visible, not a pale unlabelled screen", () => {
    expect(read("src/components/PageLoading.tsx")).toContain('aria-hidden="true" className="text-xs font-medium uppercase');
    expect(read("src/components/ui/skeleton.tsx")).toContain("bg-foreground/10");
  });
});
