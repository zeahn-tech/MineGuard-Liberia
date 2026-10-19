// Session 10 / UX-1 — automated accessibility scan (axe-core: WCAG 2.0/2.1/2.2
// A+AA rules, INCLUDING colour contrast) over the public, staff and operator
// routes, at every reference viewport, against the production bundle with the
// Supabase network stubbed. Automated scans catch roughly a third of WCAG
// issues; this is evidence, not a conformance claim (see docs/16).
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { installStub, type StubRole } from "./stub";

const ROUTES: { path: string; role: StubRole | null; name: string }[] = [
  { path: "/", role: null, name: "landing" },
  { path: "/auth", role: null, name: "auth" },
  { path: "/report", role: null, name: "report" },
  { path: "/report/track", role: null, name: "track" },
  { path: "/portal", role: "admin", name: "command-center" },
  { path: "/portal/sites", role: "admin", name: "sites" },
  { path: "/portal/map", role: "admin", name: "map" },
  { path: "/portal/inspections", role: "admin", name: "inspections" },
  { path: "/portal/incidents", role: "admin", name: "incidents" },
  { path: "/portal/environment", role: "admin", name: "environment" },
  { path: "/portal/community", role: "admin", name: "community" },
  { path: "/portal/audit", role: "admin", name: "audit" },
  { path: "/portal/reports", role: "admin", name: "reports" },
  { path: "/portal/risk-config", role: "admin", name: "risk-config" },
  { path: "/portal/boundaries", role: "admin", name: "boundaries" },
  { path: "/portal/templates", role: "admin", name: "templates" },
  { path: "/portal/security", role: "admin", name: "security" },
  { path: "/operate", role: "operator", name: "operator-overview" },
  { path: "/operate/sites", role: "operator", name: "operator-sites" },
  { path: "/operate/findings", role: "operator", name: "operator-findings" },
  { path: "/operate/corrective-actions", role: "operator", name: "operator-actions" },
  { path: "/operate/incidents", role: "operator", name: "operator-incidents" },
  { path: "/operate/security", role: "operator", name: "operator-security" },
  { path: "/definitely-not-a-page", role: null, name: "not-found" },
];

for (const r of ROUTES) {
  test(`axe: ${r.name}`, async ({ page }) => {
    await installStub(page, { role: r.role });
    await page.goto(`/#${r.path}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(800); // let lazy routes + live queries settle
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const summary = results.violations.map(
      (v) => `${v.id} [${v.impact}] ×${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`,
    );
    expect(summary, summary.join("\n")).toEqual([]);
    // every page exposes exactly one h1 and a main landmark
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
  });
}
