import { describe, expect, test } from "bun:test";
import {
  communityBy,
  countyLoad,
  coverageSplit,
  incidentSeverityInPeriod,
  recordBars,
  statusCounts,
  topIncidentSites,
} from "../src/lib/admin-charts";
import { DAY_MS, type SiteStatusRow } from "../src/lib/site-status";
import type { CommunityReport } from "../src/lib/types";

const NOW = Date.UTC(2026, 10, 7);
const row = (id: string, county: string, over: Partial<SiteStatusRow> = {}): SiteStatusRow => ({
  site: { id, code: id, name: `Site ${id}`, operatorName: "Op", county, registryStatus: "active" },
  status: "recent_information",
  openCriticalFindings: 0,
  openFindings: 0,
  overdueActions: 0,
  openActions: 0,
  openSeriousIncidents: 0,
  incidentsInPeriod: 0,
  lastApprovedInspectionAt: null,
  lastSubmissionAt: null,
  approvedAgeDays: null,
  hasPosition: true,
  ...over,
});

describe("admin chart data", () => {
  test("status counts keep every status, most urgent first, zeros included", () => {
    const r = statusCounts([row("a", "Bomi", { status: "review_now" }), row("b", "Bomi")]);
    expect(r.map((x) => x.status)).toEqual(["review_now", "action_overdue", "insufficient", "stale", "recent_information"]);
    expect(r.map((x) => x.count)).toEqual([1, 0, 0, 0, 1]);
  });

  test("county load sums per county, hides empty counties, sorts by load", () => {
    const r = countyLoad([
      row("a", "Bomi", { openCriticalFindings: 1, overdueActions: 2 }),
      row("b", "Bomi", { incidentsInPeriod: 1 }),
      row("c", "Grand Gedeh", { overdueActions: 1 }),
      row("d", "Nimba"),
    ]);
    expect(r).toEqual([
      { county: "Bomi", openCritical: 1, overdue: 2, incidents: 1 },
      { county: "Grand Gedeh", openCritical: 0, overdue: 1, incidents: 0 },
    ]);
  });

  test("top incident sites ignores sites with none and caps the list", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => row(String(n), "Bomi", { incidentsInPeriod: n }));
    rows.push(row("z", "Bomi"));
    const r = topIncidentSites(rows);
    expect(r).toHaveLength(5);
    expect(r[0]).toEqual({ label: "Site 6", value: 6 });
  });

  test("incident severity respects the period and the sites in view", () => {
    const inc = (siteId: string, severity: "low" | "critical", daysAgo: number) => ({
      siteId, severity, status: "reported" as const, occurredAt: NOW - daysAgo * DAY_MS, createdAt: NOW,
    });
    const list = [inc("a", "critical", 10), inc("a", "low", 200), inc("b", "critical", 5)];
    const r = incidentSeverityInPeriod(list, new Set(["a"]), NOW, 90 * DAY_MS);
    expect(r.find((x) => x.severity === "critical")?.count).toBe(1);
    expect(r.find((x) => x.severity === "low")?.count).toBe(0);
    expect(incidentSeverityInPeriod(list, new Set(["a"]), NOW, null).find((x) => x.severity === "low")?.count).toBe(1);
  });

  test("record bars drop zeros, prettify keys, sort descending", () => {
    expect(recordBars({ near_miss: 1, injury: 3, fire: 0 })).toEqual([
      { label: "Injury", value: 3 },
      { label: "Near miss", value: 1 },
    ]);
  });

  test("community reports group by status and category", () => {
    const mk = (status: string, category: string) => ({ status, category }) as unknown as CommunityReport;
    const reports = [mk("submitted", "pollution"), mk("submitted", "pollution"), mk("verified", "land_concern")];
    expect(communityBy(reports, "status")[0]).toEqual({ label: "Submitted", value: 2 });
    expect(communityBy(reports, "category").map((x) => x.label)).toEqual(["Pollution", "Land concern"]);
  });

  test("coverage split always totals 100 and clamps bad input", () => {
    expect(coverageSplit(43)).toEqual({ covered: 43, notCovered: 57 });
    expect(coverageSplit(250)).toEqual({ covered: 100, notCovered: 0 });
    expect(coverageSplit(Number.NaN)).toEqual({ covered: 0, notCovered: 100 });
  });
});
