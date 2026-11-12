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
      // links warm their chunk on hover / focus / touch
      expect(src).toContain("{...preloadProps(item.to)}");
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
});
