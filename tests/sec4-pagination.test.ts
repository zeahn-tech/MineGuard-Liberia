// ---------------------------------------------------------------------------
// SEC-4 — SILENT TRUNCATION / SCALE (security roadmap, HIGH).
//
// Hosted PostgREST caps unranged responses at db-max-rows (default 1,000
// rows). Before SEC-4 every whole-table read in src/lib/backend.ts was a
// bare `select("*")` and every statistic was summed IN THE BROWSER — past
// the cap the data arrived silently truncated and the Command Center, the
// risk scores, the AI explainer and the CSV exports were quietly wrong with
// no error anywhere.
//
// The fix has two halves, both pinned here:
//   1. PAGINATION — pagedRows()/allRows() in the data layer fetch with an
//      explicit ordered Range until a short page returns, so row-level
//      reads see every visible row at any table size.
//   2. AGGREGATION — mg_command_center_stats() (migration 0012, SECURITY
//      INVOKER) computes the Command Center's figures in the database and
//      returns ONE jsonb row; the client only coerces fields.
//
// HARNESS FIDELITY: the wire bridge EMULATES the hosted cap
// (tests/helpers/backend-edge.ts, POSTGREST_MAX_ROWS) — an unranged select
// really does stop at 1,000 rows here. The fixtures below (1,250 findings /
// 1,200 incidents) are therefore a real reproduction of the production
// hazard: regressing to a bare select or to unpaginated client-side
// summation FAILS these tests instead of shipping wrong numbers.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { api, type CommandCenterStats } from "../src/lib/backend";
import {
  __testSetAuthUserId,
  __testSetSupabaseClient,
  supabase,
} from "../src/lib/supabase";
import {
  adminExec,
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";

/** Hosted PostgREST db-max-rows default — the cap the bridge emulates. */
const PAGE_CAP = 1000;

// Fixture ids in the 9000-namespace: disjoint from every other suite's
// identity/record ids (aaaa/bbbb/cccc/dddd/eeee/ffff/8888/9999 patterns).
const SITE_ID = "90000000-0000-4000-8000-000000000001";
const INSP_ID = "90000100-0000-4000-8000-000000000001";
const FINDINGS = 1250; // > cap: proves aggregation AND multi-page reads
const INCIDENTS = 1200; // > cap: proves list surfaces page
const findingId = (i: number) =>
  `90000200-0000-4000-8000-${String(i).padStart(12, "0")}`;
const incidentId = (i: number) =>
  `90000300-0000-4000-8000-${String(i).padStart(12, "0")}`;

let clientSwapped = false;

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

/** Remove the fixture (and only the fixture) — the shared in-process edge
 *  database must be byte-identical for every suite that runs after this
 *  file. Sites are never deletable through the app, so the registry guard
 *  is disabled for the cleanup exactly as the perf fixture does it. */
async function cleanFixture() {
  await adminSql(`delete from public.findings where site_id = '${SITE_ID}'`);
  await adminSql(`delete from public.incidents where site_id = '${SITE_ID}'`);
  await adminSql(`delete from public.inspections where site_id = '${SITE_ID}'`);
  await adminSql(`alter table public.sites disable trigger sites_guard`);
  await adminSql(`delete from public.sites where id = '${SITE_ID}'`);
  await adminSql(`alter table public.sites enable trigger sites_guard`);
  await adminSql(`delete from public.audit_log where entity_id like '9000%'`);
}

async function seedFixture() {
  await cleanFixture(); // idempotent: a rerun after a failed teardown is safe

  // The site goes through the admin session (the registry write guard checks
  // mg_has_permission under the authenticated role) — same idiom as the perf
  // fixture. Everything else is bulk SQL, also like the perf fixture.
  await adminExec(
    `set local role authenticated;
     set local request.jwt.claims = '{"sub":"${f.admin}","role":"authenticated"}';
     insert into public.sites
       (id, code, name, operator_name, mineral_type, county, district,
        community, status, latitude, longitude, created_by)
     values
       ('${SITE_ID}', 'LB-SEC4-001', 'SEC4 Scale Probe Site',
        'SEC4 Probe Mining', 'Gold', 'Bomi', 'Senjeh', 'Probe Hills',
        'active', 6.9, -10.9, '${f.admin}')`,
  );

  await adminSql(
    `insert into public.inspections
       (id, site_id, template_id, inspector_id, status, answers, created_at)
     values
       ('${INSP_ID}', '${SITE_ID}', '${f.template}', '${f.admin}',
        'submitted', '[]'::jsonb, now())`,
  );

  const findingRows: string[] = [];
  for (let i = 1; i <= FINDINGS; i++) {
    findingRows.push(
      `('${findingId(i)}', '${INSP_ID}', '${SITE_ID}', 'SEC4 finding ${i}', 'low', '${f.admin}')`,
    );
  }
  await adminSql(
    `insert into public.findings
       (id, inspection_id, site_id, title, severity, created_by_id)
     values ${findingRows.join(",")}`,
  );

  const incidentRows: string[] = [];
  for (let i = 1; i <= INCIDENTS; i++) {
    incidentRows.push(
      `('${incidentId(i)}', '${SITE_ID}', 'near_miss', 'low', 'SEC4 incident ${i}', ` +
        `now() - interval '${i} minutes', '${f.admin}', 'inspector', 'reported')`,
    );
  }
  await adminSql(
    `insert into public.incidents
       (id, site_id, type, severity, description, occurred_at,
        reported_by_id, report_source, status)
     values ${incidentRows.join(",")}`,
  );
}

beforeAll(async () => {
  await getEdgeDb();
  if (!clientSwapped) {
    __testSetSupabaseClient(createEdgeClient());
    clientSwapped = true;
  }
  await seedFixture();
});

afterAll(async () => {
  await cleanFixture();
});

// ===========================================================================
// The hazard is real on the wire (bridge fidelity)
// ===========================================================================

describe("SEC-4: the hosted row cap exists — reads must page past it", () => {
  test("an unranged select stops at the cap; an explicit Range fetches past it", async () => {
    setIdentity(f.admin);
    // The defect itself: no Range, no limit → the response is truncated to
    // db-max-rows with a 200 and NO error. This is what production did to
    // every statistic before SEC-4.
    const capped = await supabase.from("incidents").select("*");
    expect(capped.error).toBeNull();
    expect(capped.data!.length).toBe(PAGE_CAP);

    // The fix's primitive: an explicit Range window is NOT truncated (the
    // fixture alone holds INCIDENTS > PAGE_CAP rows).
    const paged = await supabase
      .from("incidents")
      .select("*")
      .order("id", { ascending: true })
      .range(0, 4999);
    expect(paged.error).toBeNull();
    expect(paged.data!.length).toBeGreaterThan(PAGE_CAP);
  });

  test("records.listIncidents returns EVERY row past the cap (paged allRows)", async () => {
    setIdentity(f.admin);
    const list = await first(api.records.listIncidents());
    const mine = list!.filter((i) => i._id.startsWith("90000300-"));
    // A regression to the old bare select would surface exactly PAGE_CAP of
    // the fixture's INCIDENTS here — silently.
    expect(mine.length).toBe(INCIDENTS);
  });

  test("risk scores are computed from the COMPLETE finding set, not the capped slice", async () => {
    setIdentity(f.admin);
    const scores = await first(api.sites.riskScores());
    const mine = scores![SITE_ID];
    expect(mine).toBeDefined();
    // All FINDINGS findings are severity 'low' on this site: under
    // truncation the factor would read "1000 low finding(s)".
    const severity = mine.factors.find((x) => x.label.endsWith("low finding(s)"));
    expect(severity?.label).toBe(`${FINDINGS} low finding(s)`);
    // The repeat-findings factor keys on floor(n/4) — also unreachable from
    // a capped slice.
    expect(mine.factors.some((x) => x.label === "Repeat findings at site")).toBe(true);
    // The score invariant holds over the full set: score ≡ Σ factor points.
    expect(mine.score).toBe(mine.factors.reduce((a, x) => a + x.points, 0));
  });
});

// ===========================================================================
// Aggregation happens in the database (migration 0012)
// ===========================================================================

describe("SEC-4: command-center stats are exact past the cap (RPC)", () => {
  test("every figure equals the database's own count at >1,000-row volume", async () => {
    setIdentity(f.admin);
    const s = await first(api.stats.commandCenter());
    expect(s).toBeDefined();

    // Ground truth straight from the tables. The admin identity sees every
    // row under RLS, so plain totals are the correct expectations.
    const gt = (
      await adminSql(`select
        (select count(*) from public.sites) as sites,
        (select count(*) from public.inspections) as inspections,
        (select count(*) from public.findings) as findings,
        (select count(*) from public.incidents) as incidents,
        (select count(*) from public.environmental_observations) as env,
        (select count(*) from public.community_reports) as reports`)
    )[0] as Record<string, unknown>;

    expect(s!.findingsTotal).toBe(Number(gt.findings));
    expect(s!.incidentsTotal).toBe(Number(gt.incidents));
    expect(s!.sites).toBe(Number(gt.sites));
    expect(s!.inspectionsTotal).toBe(Number(gt.inspections));
    expect(s!.communityReports).toBe(Number(gt.reports));
    // ...and the fixture really is past the cap (the numbers above are only
    // meaningful if the volume was enough to truncate a bare read).
    expect(s!.findingsTotal).toBeGreaterThanOrEqual(FINDINGS);
    expect(s!.incidentsTotal).toBeGreaterThanOrEqual(INCIDENTS);

    // Internal consistency of the group-bys (same visible row set).
    const sum = (m: Record<string, number>) =>
      Object.values(m).reduce((a, b) => a + b, 0);
    expect(sum(s!.countyCounts)).toBe(s!.sites);
    expect(sum(s!.incidentTypes)).toBe(s!.incidentsTotal);
    expect(sum(s!.envByCategory)).toBe(Number(gt.env));
  });

  test("the RPC and the client-side fallback return IDENTICAL figures", async () => {
    setIdentity(f.admin);

    // 1) The RPC path — assert it really ran (otherwise this comparison
    //    would degrade to fallback-vs-fallback and prove nothing).
    const rpcWarns: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      rpcWarns.push(args.map((a) => String(a)).join(" "));
    });
    let viaRpc: CommandCenterStats | undefined;
    try {
      viaRpc = await first(api.stats.commandCenter());
    } finally {
      warnSpy.mockRestore();
    }
    expect(rpcWarns.filter((w) => w.includes("mg_command_center_stats"))).toEqual([]);

    // 2) Force the RPC to fail → commandCenter must fall back to the
    //    paginated client-side aggregation and produce the SAME object.
    const base = createEdgeClient();
    const failing: SupabaseClient = {
      ...base,
      rpc: (name: string, payload?: Record<string, unknown>) =>
        name === "mg_command_center_stats"
          ? Promise.resolve({ data: null, error: { message: "SEC4_FORCED_RPC_FAILURE" } })
          : (base as unknown as { rpc: (n: string, p?: Record<string, unknown>) => Promise<unknown> }).rpc(name, payload),
    } as unknown as SupabaseClient;
    __testSetSupabaseClient(failing);
    let viaFallback: CommandCenterStats | undefined;
    try {
      viaFallback = await first(api.stats.commandCenter());
    } finally {
      __testSetSupabaseClient(base); // restore the plain bridge client
    }

    expect(viaFallback).toBeDefined();
    // SQL translation ≡ TypeScript aggregation, field for field, over the
    // same data — including every figure derived from >1,000-row tables
    // (which the fallback only gets right because its reads page).
    expect(viaFallback).toEqual(viaRpc);
  });

  test("anon cannot execute the stats RPC (the anon surface stays two flows)", async () => {
    setIdentity(null);
    const res = await supabase.rpc("mg_command_center_stats");
    expect(res.data).toBeNull();
    expect(res.error).toBeTruthy();
    // EXECUTE is revoked from anon — Postgres refuses before the body runs.
    expect(String((res.error as { message?: string })?.message ?? "")).toMatch(
      /permission denied/i,
    );
  });
});

// ===========================================================================
// Source contract (the intent, pinned mechanically)
// ===========================================================================

describe("SEC-4: source contract", () => {
  const backendSrc = readFileSync(
    join(import.meta.dir, "..", "src", "lib", "backend.ts"),
    "utf8",
  );
  const bridgeSrc = readFileSync(
    join(import.meta.dir, "helpers", "backend-edge.ts"),
    "utf8",
  );

  test("whole-table reads page with an explicit Range (no bare select survives)", () => {
    expect(backendSrc).toContain(".range(from, to)");
    // The old un-paginated allRows body must be gone.
    expect(backendSrc).not.toContain(
      'const { data, error } = await supabase.from(table).select("*");',
    );
    // Non-vacuity: the SEC-4 call sites still go through allRows.
    expect((backendSrc.match(/allRows</g) ?? []).length).toBeGreaterThanOrEqual(10);
  });

  test("the command center aggregates through the database RPC", () => {
    expect(backendSrc).toContain('rpc("mg_command_center_stats")');
    // The paginated client aggregation survives as the documented fallback.
    expect(backendSrc).toContain("client-side aggregation fallback");
  });

  test("the harness emulates the hosted row cap (so these tests stay honest)", () => {
    expect(bridgeSrc).toContain("POSTGREST_MAX_ROWS");
    expect(bridgeSrc).toMatch(/limit \$\{POSTGREST_MAX_ROWS\}/);
    expect(bridgeSrc).toContain("range(from: number, to: number)");
  });
});
