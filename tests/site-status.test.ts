// ---------------------------------------------------------------------------
// PHASE 1 — site status rules (src/lib/site-status.ts). Pure unit tests for
// the documented methodology: missing / stale / insufficient data is never
// presented as safe, critical findings stay visible whatever else looks
// favorable, filters behave, invalid coordinates are never plotted.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DAY_MS,
  NO_BOARD_FILTERS,
  STALE_AFTER_DAYS,
  STATUS_META,
  STATUS_ORDER,
  ageText,
  applyBoardFilters,
  computeSiteStatuses,
  hasValidPosition,
  periodMsOf,
  sortByUrgency,
  summarize,
  type SiteStatusInputs,
  type StatusSite,
} from "../src/lib/site-status";

const NOW = Date.UTC(2026, 9, 31);
const daysAgo = (d: number) => NOW - d * DAY_MS;

const site = (id: string, over: Partial<StatusSite> = {}): StatusSite => ({
  id,
  code: `LB-${id}`,
  name: `Site ${id}`,
  operatorName: "AgriLib Mining",
  organizationId: "org-a",
  county: "Bomi",
  registryStatus: "active",
  latitude: 6.85,
  longitude: -10.85,
  ...over,
});

const inputs = (over: Partial<SiteStatusInputs> = {}): SiteStatusInputs => ({
  sites: [],
  inspections: [],
  findings: [],
  actions: [],
  incidents: [],
  loadedAt: NOW,
  ...over,
});

const approved = (siteId: string, ago: number) => ({
  siteId,
  status: "approved" as const,
  reviewedAt: daysAgo(ago),
  submittedAt: daysAgo(ago + 2),
  createdAt: daysAgo(ago + 3),
});

const statusOf = (i: SiteStatusInputs, id: string, periodMs: number | null = null) =>
  computeSiteStatuses(i, { now: NOW, periodMs }).find((r) => r.site.id === id)!;

describe("status rules", () => {
  test("a site with NO data is 'insufficient' — never safe/recent", () => {
    const r = statusOf(inputs({ sites: [site("s1")] }), "s1");
    expect(r.status).toBe("insufficient");
    expect(r.lastApprovedInspectionAt).toBeNull();
    expect(r.approvedAgeDays).toBeNull();
  });

  test("no incidents reported does NOT make a site safe", () => {
    // Zero incidents, zero findings, zero actions, but no approved inspection.
    const r = statusOf(inputs({ sites: [site("s1")] }), "s1");
    expect(r.incidentsInPeriod).toBe(0);
    expect(r.status).not.toBe("recent_information");
  });

  test("draft/rejected/submitted inspections are NOT verified information", () => {
    const base = { siteId: "s1", createdAt: daysAgo(5) };
    for (const status of ["draft", "submitted", "under_review", "rejected"] as const) {
      const r = statusOf(
        inputs({ sites: [site("s1")], inspections: [{ ...base, status, submittedAt: daysAgo(4) }] }),
        "s1",
      );
      expect(r.status).toBe("insufficient");
      expect(r.lastApprovedInspectionAt).toBeNull();
    }
  });

  test("submitted-but-unreviewed work appears only as company-submitted", () => {
    const r = statusOf(
      inputs({
        sites: [site("s1")],
        inspections: [{ siteId: "s1", status: "submitted", submittedAt: daysAgo(3), createdAt: daysAgo(4) }],
      }),
      "s1",
    );
    expect(r.lastSubmissionAt).toBe(daysAgo(3));
    expect(r.lastApprovedInspectionAt).toBeNull();
  });

  test("approved inspection within the window → recent_information", () => {
    const r = statusOf(inputs({ sites: [site("s1")], inspections: [approved("s1", 30)] }), "s1");
    expect(r.status).toBe("recent_information");
    expect(r.approvedAgeDays).toBe(30);
  });

  test("approved inspection older than the window → stale; boundary is inclusive-fresh", () => {
    const stale = statusOf(inputs({ sites: [site("s1")], inspections: [approved("s1", STALE_AFTER_DAYS + 1)] }), "s1");
    expect(stale.status).toBe("stale");
    const edge = statusOf(inputs({ sites: [site("s1")], inspections: [approved("s1", STALE_AFTER_DAYS)] }), "s1");
    expect(edge.status).toBe("recent_information");
  });

  test("the staleness window is configurable per call", () => {
    const rows = computeSiteStatuses(
      inputs({ sites: [site("s1")], inspections: [approved("s1", 40)] }),
      { now: NOW, staleAfterDays: 30 },
    );
    expect(rows[0].status).toBe("stale");
  });

  test("uses the LATEST approved inspection", () => {
    const r = statusOf(
      inputs({ sites: [site("s1")], inspections: [approved("s1", 400), approved("s1", 10)] }),
      "s1",
    );
    expect(r.approvedAgeDays).toBe(10);
    expect(r.status).toBe("recent_information");
  });

  test("open critical finding → review_now, and wins over favorable inspection data", () => {
    const r = statusOf(
      inputs({
        sites: [site("s1")],
        inspections: [approved("s1", 1)],
        findings: [{ siteId: "s1", severity: "critical", status: "open" }],
      }),
      "s1",
    );
    expect(r.status).toBe("review_now");
    expect(r.openCriticalFindings).toBe(1);
  });

  test("acknowledged critical is still open; resolved/verified/non-critical are not", () => {
    const mk = (severity: "critical" | "high", status: "open" | "acknowledged" | "resolved" | "verified") =>
      statusOf(
        inputs({ sites: [site("s1")], inspections: [approved("s1", 1)], findings: [{ siteId: "s1", severity, status }] }),
        "s1",
      ).openCriticalFindings;
    expect(mk("critical", "acknowledged")).toBe(1);
    expect(mk("critical", "resolved")).toBe(0);
    expect(mk("critical", "verified")).toBe(0);
    expect(mk("high", "open")).toBe(0);
  });

  test("open fatal or critical incident → review_now; closed one does not", () => {
    const mk = (status: "reported" | "investigating" | "closed", fatalities: number, severity: "low" | "critical" = "low") =>
      statusOf(
        inputs({
          sites: [site("s1")],
          inspections: [approved("s1", 1)],
          incidents: [{ siteId: "s1", severity, status, occurredAt: daysAgo(2), fatalities, createdAt: daysAgo(2) }],
        }),
        "s1",
      );
    expect(mk("reported", 1).status).toBe("review_now");
    expect(mk("investigating", 0, "critical").status).toBe("review_now");
    expect(mk("closed", 2).status).toBe("recent_information");
  });

  test("overdue outstanding action → action_overdue; verified/closed or future-due are not", () => {
    const mk = (status: "open" | "in_progress" | "submitted" | "verified" | "closed" | "escalated", due: number) =>
      statusOf(
        inputs({ sites: [site("s1")], inspections: [approved("s1", 1)], actions: [{ siteId: "s1", status, dueAt: due }] }),
        "s1",
      );
    expect(mk("open", daysAgo(1)).status).toBe("action_overdue");
    expect(mk("escalated", daysAgo(10)).overdueActions).toBe(1);
    expect(mk("submitted", daysAgo(1)).overdueActions).toBe(1); // awaiting verification is still outstanding
    expect(mk("closed", daysAgo(100)).overdueActions).toBe(0);
    expect(mk("verified", daysAgo(100)).overdueActions).toBe(0);
    expect(mk("open", NOW + DAY_MS).overdueActions).toBe(0);
  });

  test("priority: review_now > action_overdue > insufficient/stale > recent", () => {
    const i = inputs({
      sites: [site("crit"), site("over"), site("none"), site("old"), site("ok")],
      inspections: [approved("crit", 5), approved("over", 5), approved("old", 400), approved("ok", 5)],
      findings: [{ siteId: "crit", severity: "critical", status: "open" }],
      actions: [
        { siteId: "crit", status: "open", dueAt: daysAgo(3) },
        { siteId: "over", status: "open", dueAt: daysAgo(3) },
      ],
    });
    const byId = Object.fromEntries(computeSiteStatuses(i, { now: NOW }).map((r) => [r.site.id, r.status]));
    expect(byId).toEqual({
      crit: "review_now",
      over: "action_overdue",
      none: "insufficient",
      old: "stale",
      ok: "recent_information",
    });
    const sorted = sortByUrgency(computeSiteStatuses(i, { now: NOW })).map((r) => r.site.id);
    expect(sorted).toEqual(["crit", "over", "none", "old", "ok"]);
  });

  test("there is NO safe / compliant / low-risk status anywhere", () => {
    const text = JSON.stringify(STATUS_META).toLowerCase();
    expect(STATUS_ORDER).toHaveLength(5);
    expect(Object.keys(STATUS_META).sort()).toEqual([...STATUS_ORDER].sort());
    for (const k of STATUS_ORDER) {
      expect(k).not.toMatch(/safe|compliant|low/);
      expect(STATUS_META[k].label.toLowerCase()).not.toMatch(/\bsafe\b|compliant|low risk/);
    }
    // The one status that sounds positive explicitly disclaims a verdict.
    expect(STATUS_META.recent_information.description).toMatch(/not a safety or compliance verdict/i);
    expect(text).toContain("absence of reports is not evidence of safety");
  });
});

describe("incident period", () => {
  const i = (periodMs: number | null) =>
    statusOf(
      inputs({
        sites: [site("s1")],
        incidents: [
          { siteId: "s1", severity: "low", status: "closed", occurredAt: daysAgo(10), createdAt: daysAgo(10) },
          { siteId: "s1", severity: "low", status: "closed", occurredAt: daysAgo(100), createdAt: daysAgo(100) },
          { siteId: "s1", severity: "low", status: "closed", occurredAt: daysAgo(400), createdAt: daysAgo(400) },
        ],
      }),
      "s1",
      periodMs,
    ).incidentsInPeriod;

  test("counts only incidents inside the selected period", () => {
    expect(i(periodMsOf("30d"))).toBe(1);
    expect(i(periodMsOf("90d"))).toBe(1);
    expect(i(periodMsOf("365d"))).toBe(2);
    expect(i(periodMsOf("all"))).toBe(3);
  });

  test("the period never changes the primary status (a serious old open incident still flags)", () => {
    const r = statusOf(
      inputs({
        sites: [site("s1")],
        inspections: [approved("s1", 1)],
        incidents: [{ siteId: "s1", severity: "critical", status: "investigating", occurredAt: daysAgo(500), createdAt: daysAgo(500) }],
      }),
      "s1",
      periodMsOf("30d"),
    );
    expect(r.incidentsInPeriod).toBe(0);
    expect(r.status).toBe("review_now");
  });
});

describe("coordinates", () => {
  test("hasValidPosition rejects missing, NaN, (0,0), and out-of-Liberia points", () => {
    expect(hasValidPosition(6.45, -9.4)).toBe(true);
    expect(hasValidPosition(undefined, -9.4)).toBe(false);
    expect(hasValidPosition(6.45, undefined)).toBe(false);
    expect(hasValidPosition(Number.NaN, -9.4)).toBe(false);
    expect(hasValidPosition(0, 0)).toBe(false);
    expect(hasValidPosition(6.45, 9.4)).toBe(false); // missing minus sign
    expect(hasValidPosition(40, -74)).toBe(false);
  });

  test("a site without a valid position is still listed (never dropped), flagged hasPosition=false", () => {
    const rows = computeSiteStatuses(
      inputs({ sites: [site("s1", { latitude: undefined, longitude: undefined }), site("s2", { latitude: 0, longitude: 0 })] }),
      { now: NOW },
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.hasPosition)).toBe(true);
    expect(summarize(rows).withPosition).toBe(0);
  });
});

describe("filters", () => {
  const i = inputs({
    sites: [
      site("a", { county: "Bomi", organizationId: "org-a", operatorName: "AgriLib Mining" }),
      site("b", { county: "Grand Cape Mount", organizationId: "org-b", operatorName: "OreCo Liberia", name: "Cape Mount Ore Site" }),
      site("c", { county: "Bomi", organizationId: undefined, operatorName: "Legacy Co" }),
    ],
    inspections: [approved("a", 5), approved("b", 400)],
    findings: [{ siteId: "a", severity: "critical", status: "open" }],
  });
  const rows = computeSiteStatuses(i, { now: NOW });
  const ids = (f: Partial<typeof NO_BOARD_FILTERS>) =>
    applyBoardFilters(rows, { ...NO_BOARD_FILTERS, ...f }).map((r) => r.site.id).sort();

  test("no filters returns everything", () => expect(ids({})).toEqual(["a", "b", "c"]));
  test("county", () => expect(ids({ counties: ["Bomi"] })).toEqual(["a", "c"]));
  test("organization by id, with name fallback for legacy sites", () => {
    expect(ids({ organizations: ["org-b"] })).toEqual(["b"]);
    expect(ids({ organizations: ["name:Legacy Co"] })).toEqual(["c"]);
  });
  test("status", () => expect(ids({ statuses: ["review_now"] })).toEqual(["a"]));
  test("critical only", () => expect(ids({ criticalOnly: true })).toEqual(["a"]));
  test("freshness fresh / stale / none", () => {
    expect(ids({ freshness: "fresh" })).toEqual(["a"]);
    expect(ids({ freshness: "stale" })).toEqual(["b"]);
    expect(ids({ freshness: "none" })).toEqual(["c"]);
  });
  test("text matches name, code or company, case-insensitively", () => {
    expect(ids({ text: "cape mount" })).toEqual(["b"]);
    expect(ids({ text: "legacy" })).toEqual(["c"]);
    expect(ids({ text: "LB-a" })).toEqual(["a"]);
  });
  test("filters combine (AND)", () => {
    expect(ids({ counties: ["Bomi"], statuses: ["insufficient"] })).toEqual(["c"]);
    expect(ids({ counties: ["Grand Cape Mount"], criticalOnly: true })).toEqual([]);
  });
  test("filtering never hides a critical finding that matches the filter", () => {
    const shown = applyBoardFilters(rows, { ...NO_BOARD_FILTERS, freshness: "fresh" });
    expect(shown[0].openCriticalFindings).toBe(1);
  });
});

describe("summary", () => {
  test("separates verified-recent, stale, and missing; counts critical independently of status", () => {
    const rows = computeSiteStatuses(
      inputs({
        sites: [site("a"), site("b"), site("c"), site("d")],
        inspections: [approved("a", 5), approved("b", 400), approved("d", 5)],
        findings: [
          { siteId: "a", severity: "critical", status: "open" },
          { siteId: "a", severity: "critical", status: "acknowledged" },
        ],
        actions: [{ siteId: "d", status: "open", dueAt: daysAgo(2) }],
      }),
      { now: NOW },
    );
    const s = summarize(rows);
    expect(s.sites).toBe(4);
    expect(s.recentApproved).toBe(2); // a (flagged critical but fresh) and d
    expect(s.stale).toBe(1); // b
    expect(s.noApprovedInspection).toBe(1); // c
    expect(s.sitesWithOpenCritical).toBe(1);
    expect(s.openCriticalFindings).toBe(2);
    expect(s.overdueActions).toBe(1);
    // The three freshness buckets partition the sites: nothing is dropped.
    expect(s.recentApproved + s.stale + s.noApprovedInspection).toBe(s.sites);
  });

  test("an empty scope summarizes to zeros (no NaN)", () => {
    const s = summarize([]);
    expect(Object.values(s).every((v) => v === 0)).toBe(true);
  });
});

describe("ageText", () => {
  test("renders never / today / days / months / years", () => {
    expect(ageText(null, NOW)).toBe("never");
    expect(ageText(NOW, NOW)).toBe("today");
    expect(ageText(daysAgo(1), NOW)).toBe("1 day ago");
    expect(ageText(daysAgo(12), NOW)).toBe("12 days ago");
    expect(ageText(daysAgo(120), NOW)).toBe("4 months ago");
    expect(ageText(daysAgo(1200), NOW)).toBe("3 years ago");
  });
});

describe("source contracts", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

  test("the status module is dependency-free (no network, no backend import)", () => {
    const src = read("src/lib/site-status.ts");
    expect(src).not.toMatch(/from "\.\/backend|supabase|fetch\(|localStorage/);
  });

  test("the feed selects ONLY minimal columns — no free text, answers, notes, or identities", () => {
    const src = read("src/lib/backend.ts");
    const block = src.slice(src.indexOf("siteStatusFeed:"), src.indexOf("trendSeries:"));
    expect(block.length).toBeGreaterThan(200);
    for (const forbidden of [
      "description",
      "answers",
      "notes",
      "reported_by",
      "inspector_id",
      "reviewer_id",
      "review_note",
      "created_by",
      "contact_phone",
      "evidence",
      "select(\"*\")",
    ]) {
      expect(block, `siteStatusFeed must not read ${forbidden}`).not.toContain(forbidden);
    }
    expect(block).toContain("requireAuthed");
    expect(block).not.toMatch(/service_role|rpc\(/); // plain RLS reads only
  });

  test("the board and map render a status, never a 'safe' label", () => {
    for (const f of ["src/components/SiteStatusBoard.tsx", "src/pages/NationalMap.tsx"]) {
      const src = read(f);
      expect(src).not.toMatch(/>\s*Safe\s*</i);
      expect(src).not.toMatch(/Fully compliant|All clear/i);
    }
  });
});
