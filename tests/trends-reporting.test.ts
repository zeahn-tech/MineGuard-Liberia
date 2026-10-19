// ---------------------------------------------------------------------------
// SESSION 9 — command-center TRENDS (§19) and SUMMARY REPORT (§1)
// (migration 0021: mg_trend_series / mg_trend_geo / mg_summary_report).
//
// Properties pinned here:
//  1. SERIES: zero-filled buckets, exact counts, UTC day/week/month bucketing.
//  2. INPUT BOUNDS: unknown metric/bucket, inverted or oversized ranges are
//     refused (allowlisted metrics — no dynamic SQL).
//  3. SCOPE: figures are computed under the caller's RLS — an operator's
//     trend/report never includes another tenant's rows.
//  4. GEO: per-county totals for the window vs the preceding equal window.
//  5. REPORT: payload shape; period vs "as of now" separation; CSV and print
//     carry the "NOT AN OFFICIAL DOCUMENT" disclaimer (source contracts).
// Fixtures live in 2020 so they cannot collide with seed data; all removed.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../src/lib/backend";
import { supabase, __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import {
  mapSummaryReport,
  REPORT_BANNER,
  REPORT_DISCLAIMER,
  reportToCsv,
} from "../src/lib/reporting";
import {
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";

const REF = "s9trend-";

function setIdentity(uid: string | null) {
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}
function first<T>(q: { subscribe: (cb: (v: T) => void) => () => void }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      unsub();
      resolve(v);
    });
  });
}
async function rpc(name: string, args: Record<string, unknown>) {
  return supabase.rpc(name, args);
}
async function incident(site: string, at: string, type = "injury", fatalities: number | null = null) {
  await adminSql(
    `insert into public.incidents (site_id, type, severity, description, occurred_at, fatalities, client_ref, reported_by_id)
     values ('${site}', '${type}', 'medium', 'S9 trend fixture', '${at}', ${fatalities ?? "null"}, '${REF}${Math.random().toString(36).slice(2)}', '${f.admin}')`,
  );
}

beforeAll(async () => {
  await getEdgeDb();
  __testSetSupabaseClient(createEdgeClient());
  await adminSql(`delete from public.incidents where client_ref like '${REF}%'`);
  // siteA (Bomi, AgriLib): Mar 5, Mar 20, May 2 2020 (+ one fatality Mar 6 counting 2); Feb 10 for the "before" window
  await incident(f.siteA, "2020-03-05T10:00:00Z");
  await incident(f.siteA, "2020-03-20T23:59:59Z");
  await incident(f.siteA, "2020-05-02T00:00:00Z");
  await incident(f.siteA, "2020-03-06T08:00:00Z", "fatality", 2);
  await incident(f.siteA, "2020-02-10T08:00:00Z");
  // siteB (Grand Cape Mount, OreCo): another tenant
  await incident(f.siteB, "2020-03-10T12:00:00Z");
});

afterAll(async () => {
  await adminSql(`delete from public.incidents where client_ref like '${REF}%'`);
});

const series = async (args: Record<string, unknown>) => {
  const { data, error } = await rpc("mg_trend_series", args);
  return { data: data as { total: number; points: { bucket: string; value: number }[] }, error };
};

describe("mg_trend_series", () => {
  test("monthly buckets are zero-filled and exact (admin sees every tenant)", async () => {
    setIdentity(f.admin);
    const { data, error } = await series({ p_metric: "incidents", p_bucket: "month", p_from: "2020-01-15", p_to: "2020-06-30" });
    expect(error).toBeNull();
    expect(data.points.map((p) => p.bucket)).toEqual([
      "2020-01-01", "2020-02-01", "2020-03-01", "2020-04-01", "2020-05-01", "2020-06-01",
    ]);
    // Mar: 5th, 20th, fatality 6th, siteB 10th = 4 ; Feb 1 ; May 1
    expect(data.points.map((p) => Number(p.value))).toEqual([0, 1, 4, 0, 1, 0]);
    expect(Number(data.total)).toBe(6);
  });

  test("the last instant of the last day is included, the first instant of the next is not", async () => {
    setIdentity(f.admin);
    const { data } = await series({ p_metric: "incidents", p_bucket: "day", p_from: "2020-03-20", p_to: "2020-03-20" });
    expect(data.points).toHaveLength(1);
    expect(Number(data.points[0].value)).toBe(1); // 23:59:59Z on the 20th
    const may = await series({ p_metric: "incidents", p_bucket: "day", p_from: "2020-05-01", p_to: "2020-05-01" });
    expect(Number(may.data.points[0].value)).toBe(0); // May 2 00:00:00Z is the next day
  });

  test("weekly buckets start on Monday (UTC)", async () => {
    setIdentity(f.admin);
    const { data } = await series({ p_metric: "incidents", p_bucket: "week", p_from: "2020-03-02", p_to: "2020-03-22" });
    expect(data.points.map((p) => p.bucket)).toEqual(["2020-03-02", "2020-03-09", "2020-03-16"]);
    // wk of Mar 2: 5th + fatality 6th = 2 ; wk of Mar 9: siteB 10th = 1 ; wk of Mar 16: 20th = 1
    expect(data.points.map((p) => Number(p.value))).toEqual([2, 1, 1]);
  });

  test("fatalities sum the recorded count (a null count counts as 1)", async () => {
    setIdentity(f.admin);
    const { data } = await series({ p_metric: "fatalities", p_bucket: "month", p_from: "2020-03-01", p_to: "2020-03-31" });
    expect(Number(data.total)).toBe(2);
  });

  test("an operator's trend contains only their own tenant", async () => {
    setIdentity(f.opA);
    const a = await series({ p_metric: "incidents", p_bucket: "month", p_from: "2020-03-01", p_to: "2020-03-31" });
    expect(Number(a.data.total)).toBe(3); // siteB's incident is invisible
    setIdentity(f.opB);
    const b = await series({ p_metric: "incidents", p_bucket: "month", p_from: "2020-03-01", p_to: "2020-03-31" });
    expect(Number(b.data.total)).toBe(1);
  });

  test("bad input is refused", async () => {
    setIdentity(f.admin);
    expect((await series({ p_metric: "passwords", p_bucket: "month" })).error).toBeTruthy();
    expect((await series({ p_metric: "incidents", p_bucket: "hour" })).error).toBeTruthy();
    expect((await series({ p_metric: "incidents", p_bucket: "day", p_from: "2020-03-10", p_to: "2020-03-01" })).error).toBeTruthy();
    expect((await series({ p_metric: "incidents", p_bucket: "day", p_from: "2010-01-01", p_to: "2020-01-01" })).error).toBeTruthy();
    expect((await series({ p_metric: "incidents; drop table sites", p_bucket: "day" })).error).toBeTruthy();
  });

  test("the typed API returns the same numbers", async () => {
    setIdentity(f.admin);
    const s = await first(api.stats.trendSeries({ metric: "incidents", bucket: "month", from: "2020-03-01", to: "2020-03-31" }));
    expect(s?.total).toBe(4);
    expect(s?.points).toHaveLength(1);
  });
});

describe("mg_trend_geo", () => {
  test("per-county window vs the preceding equal window", async () => {
    setIdentity(f.admin);
    const { data, error } = await rpc("mg_trend_geo", { p_metric: "incidents", p_from: "2020-03-01", p_to: "2020-03-31" });
    expect(error).toBeNull();
    const g = data as { previousFrom: string; previousTo: string; rows: { county: string; value: number; previous: number; delta: number; changePct: number | null }[] };
    expect(g.previousFrom).toBe("2020-01-30");
    expect(g.previousTo).toBe("2020-02-29");
    const bomi = g.rows.find((r) => r.county === "Bomi")!;
    expect(Number(bomi.value)).toBe(3);
    expect(Number(bomi.previous)).toBe(1);
    expect(Number(bomi.delta)).toBe(2);
    expect(Number(bomi.changePct)).toBe(200);
    const gcm = g.rows.find((r) => r.county === "Grand Cape Mount")!;
    expect(Number(gcm.value)).toBe(1);
    expect(gcm.changePct).toBeNull(); // previous 0 → no meaningful percentage
  });

  test("geography is scoped: an operator sees only their county's row", async () => {
    setIdentity(f.opA);
    const { data } = await rpc("mg_trend_geo", { p_metric: "incidents", p_from: "2020-03-01", p_to: "2020-03-31" });
    const rows = (data as { rows: { county: string }[] }).rows;
    expect(rows.map((r) => r.county)).toEqual(["Bomi"]);
  });
});

describe("mg_summary_report", () => {
  test("period activity is windowed; position is as-of-now; shape is stable", async () => {
    setIdentity(f.admin);
    const { data, error } = await rpc("mg_summary_report", { p_from: "2020-03-01", p_to: "2020-03-31" });
    expect(error).toBeNull();
    const rep = mapSummaryReport(data);
    expect(rep.period).toEqual({ from: "2020-03-01", to: "2020-03-31" });
    expect(rep.activity.incidents).toBe(4);
    expect(rep.activity.fatalities).toBe(2);
    expect(Object.keys(rep.activity).sort()).toEqual([
      "communityReports", "criticalFindings", "fatalities", "findings",
      "incidents", "inspectionsSubmitted", "observations",
    ]);
    expect(rep.position.sites).toBeGreaterThanOrEqual(2);
    const bomi = rep.byCounty.find((c) => c.county === "Bomi")!;
    expect(bomi.incidents).toBe(3);
    expect(rep.topRiskSites.length).toBeLessThanOrEqual(10);
    const scores = rep.topRiskSites.map((s) => s.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test("an operator's report never includes another tenant", async () => {
    setIdentity(f.opA);
    const rep = mapSummaryReport((await rpc("mg_summary_report", { p_from: "2020-03-01", p_to: "2020-03-31" })).data);
    expect(rep.activity.incidents).toBe(3);
    expect(rep.byCounty.map((c) => c.county)).toEqual(["Bomi"]);
    expect(rep.topRiskSites.every((s) => s.county === "Bomi")).toBe(true);
  });

  test("an inverted period is refused", async () => {
    setIdentity(f.admin);
    expect((await rpc("mg_summary_report", { p_from: "2020-04-01", p_to: "2020-03-01" })).error).toBeTruthy();
  });

  test("the typed API maps the payload", async () => {
    setIdentity(f.admin);
    const rep = await first(api.stats.summaryReport({ from: "2020-03-01", to: "2020-03-31" }));
    expect(rep?.activity.incidents).toBe(4);
  });
});

describe("report disclaimer — NOT AN OFFICIAL DOCUMENT", () => {
  const rep = mapSummaryReport({
    generatedAt: "2026-10-19T00:00:00Z", scope: "national",
    period: { from: "2026-07-01", to: "2026-09-30" },
    activity: { incidents: 1 }, position: { sites: 2 },
    byCounty: [{ county: "Bomi, Liberia", sites: 1, incidents: 1, fatalities: 0, criticalFindings: 0, overdueCorrectiveActions: 0 }],
    topRiskSites: [],
  });

  test("the wording says it is not official and not a Government of Liberia system", () => {
    expect(REPORT_BANNER).toBe("NOT AN OFFICIAL DOCUMENT");
    expect(REPORT_DISCLAIMER).toContain("NOT AN OFFICIAL DOCUMENT");
    expect(REPORT_DISCLAIMER).toContain("not a system of the Government of Liberia");
    expect(REPORT_DISCLAIMER).toContain("must not be cited as official statistics");
  });

  test("the CSV ends with the disclaimer and quotes embedded commas", () => {
    const csv = reportToCsv(rep);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[lines.length - 1]).toContain("NOT AN OFFICIAL DOCUMENT");
    expect(csv).toContain('"Bomi, Liberia — sites"');
  });

  test("the page renders banner + footer and hides app chrome when printing", () => {
    const page = readFileSync(join(import.meta.dir, "..", "src", "pages", "Reports.tsx"), "utf8");
    expect(page).toContain("{REPORT_BANNER}");
    expect(page).toContain("{REPORT_DISCLAIMER}");
    expect(page).toContain("data-report-footer");
    expect(page).toContain("print:hidden");
    const layout = readFileSync(join(import.meta.dir, "..", "src", "pages", "PortalLayout.tsx"), "utf8");
    expect(layout).toMatch(/aside[^>]*print:!hidden/);
    expect(layout).toMatch(/header[^>]*print:hidden/);
  });

  test("no server PDF / external service is wired in (print-to-PDF only)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "reporting.ts"), "utf8") +
      readFileSync(join(import.meta.dir, "..", "src", "pages", "Reports.tsx"), "utf8");
    expect(src).not.toMatch(/jspdf|pdfkit|puppeteer|fetch\(|XMLHttpRequest/i);
  });
});
