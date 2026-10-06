// ---------------------------------------------------------------------------
// LOAD/PERFORMANCE BASELINE (§16 "Performance — unmeasured")
//
// Realistic pilot scale, derived from the program's own planning numbers
// (docs/02 "national registry scale for a pilot"; Liberia's pilot counties):
//
//   40 sites (2 operators × 20 sites, 4 counties) · 25 staff · 320
//   inspections · 640 findings · 320 corrective actions · 80
//   incidents · 60 environmental observations · 4,000 audit rows
//   (4 per mutation-bearing record) · 200 community reports.
//
// Method: the REAL data layer (src/lib/backend.ts) over the RLS-enforced
// wire bridge (same as the backend-edge suite) — this measures the actual
// authorization + mapping + serialization path, not a mock. Datasets are
// bulk-seeded with COPY-style multi-row INSERTs; identities are the standard
// edge identities. Each surface is measured cold (fresh profile cache is
// warm by design of the product) and across repeated calls; the budget for
// an interactive surface is 2,000 ms (2 s), the generic "feels responsive
// with a spinner" ceiling for a field tool on rural connectivity — anything
// under it is a pass, and the point of the baseline is to have NUMBERS, not
// green checkmarks.
//
// This is a BASELINE, not a stress test: it answers "what do the pilot's
// actual queries cost at the pilot's actual data volume", re-runnable any
// time via `bun test tests/perf-baseline.test.ts`.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, type CommandCenterStats } from "../src/lib/backend";
import { __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import {
  adminExec,
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";

// ---------------------------------------------------------------- the scale

const SCALE = {
  counties: ["Bomi", "Grand Cape Mount", "Montserrado", "Nimba"],
  operators: ["AgriLib Mining", "OreCo Liberia"],
  sitesPerOperator: 20,
  staff: 25,
  inspectionsPerSite: 8,
  findingsPerInspection: 2,
  caPerFinding: 1, // every other finding gets a CA
  incidentsPerSite: 2,
  observationsPerSite: 1.5,
  auditPerRecord: 4,
  communityReports: 200,
};

const totals = {
  sites: SCALE.operators.length * SCALE.sitesPerOperator,
  inspections: 0,
};

// ------------------------------------------------------------------- harness

let clientSwapped = false;
let currentUid: string | null = null;

beforeAll(async () => {
  await getEdgeDb();
  if (!clientSwapped) {
    __testSetSupabaseClient(createEdgeClient());
    clientSwapped = true;
  }
});

function setIdentity(uid: string | null) {
  currentUid = uid;
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

async function timed<T>(label: string, runs: number, fn: () => Promise<T>, budgetMs = 2000): Promise<number> {
  // Warm-up call (JIT, connection pool, plan cache) then measure.
  await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
  const worst = times[times.length - 1];
  const status = median <= budgetMs ? "PASS" : "OVER";
  console.log(
    `[perf] ${status} ${label}: median ${median.toFixed(0)}ms / worst ${worst.toFixed(0)}ms over ${runs} run(s) (budget ${budgetMs}ms)`,
  );
  return median;
}

// ----------------------------------------------------------------- the seed

async function seedPilotScale(): Promise<Record<string, string[]>> {
  const state = await adminSql(`select key from public.meta where key = 'perf_scale_v1' limit 1`);
  if (state.length > 0) {
    console.log("[perf] pilot-scale dataset already present, reusing");
    const siteRows = await adminSql(`select id from public.sites where code like 'LB-PERF-%' order by code`);
    return { siteIds: siteRows.map((r) => String(r.id)) };
  }

  console.log("[perf] seeding pilot-scale dataset…");
  const t0 = performance.now();
  const siteIds: string[] = [];

  // Auth users + profiles: 25 staff + the standard edge identities already present.
  {
    const users: string[] = [];
    const profiles: string[] = [];
    for (let i = 0; i < SCALE.staff; i++) {
      const uid = `aaaaaaaa-7000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      const county = SCALE.counties[i % SCALE.counties.length];
      users.push(
        `('${uid}', 'perf.staff${i + 1}@mineguard.test', '{"name":"Perf Staff ${i + 1}"}'::jsonb)`,
      );
      profiles.push(
        `('${uid}', 'perf.staff${i + 1}@mineguard.test', 'Perf Staff ${i + 1}', 'inspector', 'county', '${county}', true)`,
      );
    }
    await adminSql(`insert into auth.users (id, email, raw_user_meta_data) values ${users.join(",")} on conflict (id) do nothing`);
    // handle_new_user() trigger pre-creates stub profiles → upsert, not skip.
    await adminSql(
      `insert into public.profiles (id, email, name, role, scope, county, profile_complete) values ${profiles.join(",")}
       on conflict (id) do update set role = excluded.role, scope = excluded.scope, county = excluded.county, profile_complete = excluded.profile_complete`,
    );
  }

  // Sites (admin session for the registry guard).
  {
    const rows: string[] = [];
    let n = 0;
    for (const op of SCALE.operators) {
      for (let i = 0; i < SCALE.sitesPerOperator; i++) {
        n++;
        const id = `bbbbbbbb-6000-4000-8000-${String(n).padStart(12, "0")}`;
        siteIds.push(id);
        const county = SCALE.counties[n % SCALE.counties.length];
        rows.push(
          `('${id}', 'LB-PERF-${String(n).padStart(3, "0")}', 'Perf Site ${n}', '${op}', 'Gold', '${county}', 'Senjeh', 'Community ${n}', 'active', 6.8, -10.8, '${f.admin}')`,
        );
      }
    }
    setIdentity(f.admin);
    await adminExec(
      `set local role authenticated; set local request.jwt.claims = '${JSON.stringify({ sub: f.admin, role: "authenticated" })}';
       insert into public.sites (id, code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude, created_by)
       values ${rows.join(",")}`,
    );
  }

  // Inspections, findings, CAs, incidents, observations, audit rows — bulk.
  const inspections: string[] = [];
  const findings: string[] = [];
  const cas: string[] = [];
  const incidents: string[] = [];
  const observations: string[] = [];
  const audit: string[] = [];
  let inspN = 0, findN = 0, caN = 0, incN = 0, obsN = 0;
  // The first perf staff member is the F4 county inspector: give them
  // ownership of every 5th inspection so their scoped list is non-empty.
  const countyInspector = "aaaaaaaa-7000-4000-8000-000000000001";
  for (let s = 0; s < siteIds.length; s++) {
    const siteId = siteIds[s];
    for (let k = 0; k < SCALE.inspectionsPerSite; k++) {
      inspN++;
      const inspId = `dddddddd-7000-4000-8000-${String(inspN).padStart(12, "0")}`;
      const inspector = inspN % 5 === 0 ? countyInspector : f.admin;
      inspections.push(
        `('${inspId}', '${siteId}', '${f.template}', '${inspector}', '${k % 3 === 0 ? "approved" : k % 3 === 1 ? "submitted" : "under_review"}', '[{"0:0":true}]'::jsonb, now() - interval '${inspN} hours')`,
      );
      for (let q = 0; q < SCALE.findingsPerInspection; q++) {
        findN++;
        const fid = `eeeeeeee-7000-4000-8000-${String(findN).padStart(12, "0")}`;
        const sev = findN % 7 === 0 ? "critical" : findN % 3 === 0 ? "high" : findN % 2 === 0 ? "medium" : "low";
        findings.push(
          `('${fid}', '${inspId}', '${siteId}', 'Perf finding ${findN}', '${sev}', '${f.admin}')`,
        );
        if (findN % 2 === 0) {
          caN++;
          const caId = `eeeeeeee-8000-4000-8000-${String(caN).padStart(12, "0")}`;
          const status = caN % 5 === 0 ? "closed" : caN % 4 === 0 ? "verified" : caN % 3 === 0 ? "submitted" : "open";
          cas.push(
            `('${caId}', '${fid}', '${siteId}', 'Perf corrective action ${caN}', now() + interval '${(caN % 30) - 5} days', '${f.admin}', '${status}')`,
          );
        }
      }
    }
    for (let j = 0; j < SCALE.incidentsPerSite; j++) {
      incN++;
      const incId = `ffffffff-7000-4000-8000-${String(incN).padStart(12, "0")}`;
      const type = incN % 11 === 0 ? "fatality" : incN % 2 === 0 ? "injury" : "near_miss";
      incidents.push(
        `('${incId}', '${siteId}', '${type}', '${type === "fatality" ? "critical" : "medium"}', 'Perf incident ${incN}', now() - interval '${incN} hours', '${type === "fatality" ? 1 : 0}', '${f.admin}', 'inspector', 'reported')`,
      );
    }
    const nObs = Math.floor(SCALE.observationsPerSite) + (s % 2);
    for (let j = 0; j < nObs; j++) {
      obsN++;
      const obsId = `cccccccc-7000-4000-8000-${String(obsN).padStart(12, "0")}`;
      observations.push(
        `('${obsId}', '${siteId}', 'water_pollution', '${obsN % 4 === 0 ? "measured" : "alleged"}', 'Perf observation ${obsN}', now() - interval '${obsN} hours', '${f.admin}', '${obsN % 4 === 0 ? "resolved" : "open"}')`,
      );
    }
  }
  // Audit rows: 4 per record-bearing mutation, representative.
  for (let a = 0; a < SCALE.auditPerRecord * 1000; a++) {
    audit.push(
      `('${f.admin}', 'perf@mineguard.test', 'perf.seed', 'perf', null, 'Perf audit row ${a}', now() - interval '${a % 7200} minutes')`,
    );
  }

  await adminSql(`insert into public.inspections (id, site_id, template_id, inspector_id, status, answers, created_at) values ${inspections.join(",")}`);
  await adminSql(`insert into public.findings (id, inspection_id, site_id, title, severity, created_by_id) values ${findings.join(",")}`);
  await adminSql(`insert into public.corrective_actions (id, finding_id, site_id, description, due_at, opened_by_id, status) values ${cas.join(",")}`);
  await adminSql(`insert into public.incidents (id, site_id, type, severity, description, occurred_at, fatalities, reported_by_id, report_source, status) values ${incidents.join(",")}`);
  await adminSql(`insert into public.environmental_observations (id, site_id, category, verification, description, observed_at, reported_by_id, status) values ${observations.join(",")}`);

  // Audit log in chunks (12,800 rows).
  for (let i = 0; i < audit.length; i += 1000) {
    await adminSql(`insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary, created_at) values ${audit.slice(i, i + 1000).join(",")}`);
  }

  // Community reports.
  const reports: string[] = [];
  for (let r = 0; r < SCALE.communityReports; r++) {
    reports.push(
      `('CR-PERF${String(r).padStart(6, "0")}', 'pollution', 'Perf report ${r}', '${SCALE.counties[r % SCALE.counties.length]}', '${r % 3 === 0 ? "under_review" : "submitted"}')`,
    );
  }
  await adminSql(`insert into public.community_reports (tracking_code, category, description, county, status) values ${reports.join(",")} on conflict (tracking_code) do nothing`);

  await adminSql(`insert into public.meta (key, value) values ('perf_scale_v1', '{"scale":"pilot"}'::jsonb) on conflict (key) do nothing`);

  // Sanity: the seed must be visible to ordinary SQL before any measurement
  // — a baseline over silently-missing data would be worthless.
  const check = await adminSql(`select
    (select count(*) from public.sites where code like 'LB-PERF-%') s,
    (select count(*) from public.inspections where id::text like 'dddddddd-7000-%') i,
    (select count(*) from public.findings where id::text like 'eeeeeeee-7000-%') f2,
    (select count(*) from public.corrective_actions where id::text like 'eeeeeeee-8000-%') c,
    (select count(*) from public.audit_log) a`);
  const row = check[0] as Record<string, number>;
  if (Number(row.s) !== siteIds.length || Number(row.i) !== inspN) {
    throw new Error(`seed sanity failed: sites ${row.s}/${siteIds.length}, inspections ${row.i}/${inspN}`);
  }

  const elapsed = performance.now() - t0;
  totals.sites = siteIds.length;
  totals.inspections = inspN;
  console.log(
    `[perf] seeded in ${(elapsed / 1000).toFixed(1)}s: ${siteIds.length} sites, ${inspN} inspections, ${findN} findings, ${caN} CAs, ${incN} incidents, ${obsN} observations, ${audit.length} audit rows, ${SCALE.communityReports} reports`,
  );
  return { siteIds };
}

// ------------------------------------------------------------------ the bench

describe("performance baseline at pilot scale", () => {
  let siteIds: string[] = [];

  beforeAll(async () => {
    const s = await seedPilotScale();
    siteIds = s.siteIds;
  });

  // Teardown: the other suites assert against absolute counts in the shared
  // in-process database — the scale fixture must not leak into them.
  // Site deletion is guard-forbidden ("sites are never deleted"), so the
  // sites' guard trigger is disabled for the cleanup — acceptable here: the
  // guard protects PRODUCTION data from clients, and this is the bench's own
  // fixture table slice, deleted as the table owner in the same process.
  afterAll(async () => {
    console.log("[perf] tearing down pilot-scale dataset");
    await adminSql(`delete from public.corrective_actions where id::text like 'eeeeeeee-8000-%'`);
    await adminSql(`delete from public.findings where id::text like 'eeeeeeee-7000-%'`);
    await adminSql(`delete from public.inspections where id::text like 'dddddddd-7000-%'`);
    await adminSql(`delete from public.incidents where id::text like 'ffffffff-7000-%' or client_ref like 'perf-%'`);
    await adminSql(`delete from public.environmental_observations where id::text like 'cccccccc-7000-%'`);
    await adminSql(`alter table public.sites disable trigger sites_guard;`);
    await adminSql(`delete from public.sites where code like 'LB-PERF-%'`);
    await adminSql(`alter table public.sites enable trigger sites_guard;`);
    await adminSql(`delete from public.community_reports where tracking_code like 'CR-PERF%'`);
    await adminSql(`delete from public.audit_log where action = 'perf.seed' or (action = 'incident.report' and summary like 'Perf%')`);
    await adminSql(`delete from public.profiles where email like 'perf.staff%@mineguard.test'`);
    await adminSql(`delete from auth.users where email like 'perf.staff%@mineguard.test'`);
    await adminSql(`delete from public.meta where key = 'perf_scale_v1'`);
  });

  test("F3 staff: command center aggregates", async () => {
    setIdentity(f.admin);
    let stats: CommandCenterStats | undefined;
    await timed("commandCenter (admin, national)", 5, async () => {
      stats = await first(api.stats.commandCenter());
    });
    // SEC-4: every seeded row must be counted. The bridge caps unranged
    // reads at 1,000 (hosted db-max-rows), so a regression to bare selects
    // or browser-side summation would silently under-count these — and the
    // figures arrive from mg_command_center_stats as ONE row, not seven
    // tables.
    expect(stats!.sites).toBeGreaterThanOrEqual(totals.sites);
    expect(stats!.inspectionsTotal).toBeGreaterThanOrEqual(
      totals.sites * SCALE.inspectionsPerSite,
    );
    expect(stats!.findingsTotal).toBeGreaterThanOrEqual(
      totals.sites * SCALE.inspectionsPerSite * SCALE.findingsPerInspection,
    );
    expect(stats!.incidentsTotal).toBeGreaterThanOrEqual(
      totals.sites * SCALE.incidentsPerSite,
    );
  });

  test("F3 staff: risk scores (every site, explainable factors)", async () => {
    setIdentity(f.admin);
    let entries = 0;
    await timed("riskScores (all sites)", 5, async () => {
      const scores = await first(api.sites.riskScores());
      entries = Object.keys(scores ?? {}).length;
    });
    console.log(`[perf]   riskScores returned ${entries} site entries (expect ${totals.sites + 2})`);
  });

  test("F3 staff: sites list with open-action counts", async () => {
    setIdentity(f.admin);
    await timed("sites.list (all sites)", 5, () => first(api.sites.list()));
  });

  test("F3 staff: inspections list (site join + scope filter)", async () => {
    setIdentity(f.admin);
    let rows = 0;
    await timed("inspections.list (all rows)", 5, async () => {
      rows = (await first(api.inspections.list()))!.length;
    });
    // SEC-4: the row-level surface pages — no row of the seeded set is
    // lost to the wire cap.
    expect(rows).toBeGreaterThanOrEqual(totals.inspections);
  });

  test("F3 staff: incidents + observations lists", async () => {
    setIdentity(f.admin);
    await timed("records.listIncidents", 5, () => first(api.records.listIncidents()));
    await timed("records.listObservations", 5, () => first(api.records.listObservations()));
  });

  test("F3 staff: community triage queue", async () => {
    setIdentity(f.admin);
    await timed("records.listCommunityReports", 5, () => first(api.records.listCommunityReports()));
  });

  test("F3 staff: audit log (last 200)", async () => {
    setIdentity(f.admin);
    await timed("stats.recentAuditLog (200 of 4k)", 5, () => first(api.stats.recentAuditLog()));
  });

  test("F4 field: county inspector's scoped inspections list", async () => {
    // This perf inspector owns every 5th seeded inspection across all
    // counties — the RLS-scoped list must return exactly those.
    const uid = "aaaaaaaa-7000-4000-8000-000000000001";
    const prof = await adminSql(`select role, scope, county, profile_complete from public.profiles where id = '${uid}'`);
    if (!prof[0]) throw new Error("perf inspector profile missing — seed incomplete");
    setIdentity(uid);
    let rows = 0;
    await timed("inspections.list (county-scoped inspector)", 5, async () => {
      const list = await first(api.inspections.list());
      rows = list?.length ?? 0;
    });
    console.log(`[perf]   inspector's scoped rows: ${rows} (expect ${Math.floor(totals.inspections / 5)}, profile ${JSON.stringify(prof[0])})`);
  });

  test("F5 operator: tenant-scoped compliance feed", async () => {
    setIdentity(f.opA);
    let rows = 0;
    await timed("listMyCorrectiveActions (operator scope)", 5, async () => {
      const feed = await first(api.inspections.listMyCorrectiveActions());
      rows = feed?.length ?? 0;
    });
    console.log(`[perf]   operator feed rows: ${rows}`);
  });

  test("F5 operator: notifications (derived, deadline math)", async () => {
    setIdentity(f.opA);
    await timed("records.listNotifications (operator)", 5, () => first(api.records.listNotifications()));
  });

  test("F5 operator: report incident (write path incl. dedupe probe + audit + stats refresh)", async () => {
    setIdentity(f.opA);
    const siteId = siteIds[0];
    let created = 0;
    const median = await timed("records.reportIncident (write path)", 5, async () => {
      await api.records.reportIncident({
        siteId,
        type: "near_miss",
        severity: "low",
        description: `Perf bench incident ${Date.now()}-${created++}`,
        occurredAt: Date.now(),
        clientRef: `perf-${Date.now()}-${created}`,
      });
    });
    void median;
  });

  test("F5 operator: clientRef dedupe replay (offline guarantee path)", async () => {
    setIdentity(f.opA);
    const siteId = siteIds[1];
    const ref = `perf-dedupe-${Date.now()}`;
    const id1 = await api.records.reportIncident({
      siteId, type: "injury", severity: "medium", description: "dedupe probe", occurredAt: Date.now(), clientRef: ref,
    });
    const t0 = performance.now();
    const id2 = await api.records.reportIncident({
      siteId, type: "injury", severity: "medium", description: "dedupe probe", occurredAt: Date.now(), clientRef: ref,
    });
    const ms = performance.now() - t0;
    if (id1 !== id2) throw new Error("dedupe failed");
    console.log(`[perf] PASS clientRef dedupe replay: ${ms.toFixed(0)}ms (budget 2000ms)`);
  });
});
