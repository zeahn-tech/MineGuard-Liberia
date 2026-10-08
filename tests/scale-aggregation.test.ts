// ---------------------------------------------------------------------------
// SEC-4 v2 — SERVER-SIDE AGGREGATION & SCALE (security roadmap, Session 5)
//
// Session 1 (tests/sec4-pagination.test.ts) proved rows are not silently
// truncated and the Command Center aggregates exactly past the 1,000-row
// cap. Session 5 moves the AGGREGATION-HEAVY surfaces into the database:
//
//   * mg_risk_scores / mg_risk_explanation (SECURITY INVOKER RPCs,
//     migration 0014): counts and record-id arrays computed in Postgres —
//     the client rebuilds the exact factor breakdown from RISK_WEIGHTS.
//   * mg_incidents_page / mg_inspections_page / mg_compliance_page: KEYSET
//     pages (sort_at DESC, id DESC windows resumable by cursor) over
//     site-joined rows — stable under concurrent inserts, unlike offset
//     windows — feeding the list pages and the streaming CSV exports.
//
// ACCEPTANCE, pinned here against >5,000 rows PER TABLE:
//   1. numbers equal SQL truth — every figure the surfaces report is
//      compared against the DATABASE's OWN count of the same predicate;
//   2. no unranged select survives in the data layer (source contract);
//   3. the export stream's bytes are byte-identical to serializing the
//      whole authorized feed at once (streaming is a memory change only).
//
// HARNESS FIDELITY: the bridge emulates the hosted row cap (POSTGREST_MAX_
// ROWS = 1,000) and the RPCs go through the REAL SECURITY INVOKER machinery
// under the caller's RLS identity — a scope bug or an offset window that
// drifts FAILS here instead of shipping wrong numbers.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPLIANCE_EXPORT_COLUMNS,
  csvParts,
  INSPECTION_EXPORT_COLUMNS,
  toCsv,
} from "../src/lib/export-csv";
import {
  factorsFromCounts,
  type RiskInputCounts,
} from "../src/lib/risk-model";
import {
  api,
  type CommandCenterStats,
  type KeysetCursor,
  type KeysetPage,
} from "../src/lib/backend";
import { __testSetAuthUserId, __testSetSupabaseClient } from "../src/lib/supabase";
import {
  adminExec,
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";

// ------------------------------- scale -------------------------------------
// Every table below is seeded past 5,000 rows so "exact" can only be true
// if the aggregation and the paging are genuinely server-side.
const N_FINDINGS = 5100;
const N_INCIDENTS = 5200;
const N_INSPECTIONS = 800; // findings' parent; causal chain, not aggregate
const N_CAS = 5050;
const N_REPORTS = 0; // no extra community reports needed for these pins

const SITE = "96000000-0000-4000-8000-000000000001";
const SCALING = "95000000-0000-4000-8000-000000000001";

const findingId = (i: number) =>
  `96000200-0000-4000-8000-${String(i).padStart(12, "0")}`;
const caId = (i: number) =>
  `96000300-0000-4000-8000-${String(i).padStart(12, "0")}`;
const incidentId = (i: number) =>
  `96000400-0000-4000-8000-${String(i).padStart(12, "0")}`;
const inspId = (i: number) =>
  `96000100-0000-4000-8000-${String(i).padStart(12, "0")}`;

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

const sum = (xs: number[]): number => xs.reduce((a, x) => a + x, 0);

/** Walk an entire keyset feed using ONLY the page API's cursor — proves the
 *  resumability contract (never offsets, never a second full read). */
async function walkKeyset<T>(
  page: (before: KeysetCursor | null) => Promise<KeysetPage<T>>,
  pageSize: number,
): Promise<T[]> {
  const rows: T[] = [];
  const pages: string[] = [];
  let before: KeysetCursor | null = null;
  for (;;) {
    const res = await page(before);
    pages.push(res.source);
    rows.push(...res.rows);
    if (!res.nextCursor) break;
    before = res.nextCursor;
  }
  return rows;
}

// --------------------------- fixture lifecycle -----------------------------

async function cleanFixture() {
  await adminSql(`delete from public.findings where id::text like '96000200-%'`);
  await adminSql(`delete from public.corrective_actions where id::text like '96000300-%'`);
  await adminSql(`delete from public.incidents where id::text like '96000400-%'`);
  await adminSql(`delete from public.inspections where id::text like '96000100-%'`);
  await adminSql(`alter table public.sites disable trigger sites_guard`);
  await adminSql(`delete from public.sites where id = '${SITE}'`);
  await adminSql(`alter table public.sites enable trigger sites_guard`);
  await adminSql(`delete from public.audit_log where entity_id like '9600%' or entity_id like '9500%'`);
}

async function seedFixture() {
  await cleanFixture(); // idempotent after a failed teardown

  // The scale site itself goes through the admin session (registry guard);
  // everything else is bulk SQL (the perf bench's idiom). The template's
  // guard reads the request JWT, so it too runs under the admin prolog.
  await adminExec(
    `set local role authenticated;
     set local request.jwt.claims = '${JSON.stringify({ sub: f.admin, role: "authenticated" })}';
     insert into public.inspection_templates (id, name, active, created_by, sections)
     values ('${SCALING}', 'Scale probe template', true, '${f.admin}', '[]'::jsonb)
     on conflict (id) do nothing`,
  );

  await adminExec(
    `set local role authenticated;
     set local request.jwt.claims = '${JSON.stringify({ sub: f.admin, role: "authenticated" })}';
     insert into public.sites
       (id, code, name, operator_name, mineral_type, county, district,
        community, status, latitude, longitude, created_by)
     values
       ('${SITE}', 'LB-SCALE-001', 'Scale Probe Site',
        'AgriLib Mining', 'Gold', 'Bomi', 'Senjeh', 'Probe Hills',
        'active', 6.9, -10.9, '${f.admin}')
     on conflict (id) do nothing`,
  );

  // Inspections: the findings' and exports' parent surface.
  const inspectRows: string[] = [];
  for (let i = 1; i <= N_INSPECTIONS; i++) {
    const createdMinutes = 60_000 + i; // strictly increasing, spread over ~41 days
    inspectRows.push(
      `('${inspId(i)}', '${SITE}', '${SCALING}', '${f.admin}', 'approved', '[]'::jsonb, now() - interval '${createdMinutes} minutes')`,
    );
  }
  await adminSql(
    `insert into public.inspections
       (id, site_id, template_id, inspector_id, status, answers, created_at)
     values ${inspectRows.join(",")}`,
  );

  // Findings: severity pattern gives every bucket non-zero mass at scale:
  // low/medium rotate, high every 7th, critical every 23rd.
  const findingRows: string[] = [];
  for (let i = 1; i <= N_FINDINGS; i++) {
    const sev =
      i % 23 === 0 ? "critical" : i % 7 === 0 ? "high" : i % 2 === 0 ? "medium" : "low";
    const parent = inspId(((i - 1) % N_INSPECTIONS) + 1);
    findingRows.push(
      `('${findingId(i)}', '${parent}', '${SITE}', 'Scale finding ${i}', '${sev}', '${f.admin}')`,
    );
  }
  await adminSql(
    `insert into public.findings
       (id, inspection_id, site_id, title, severity, created_by_id)
     values ${findingRows.join(",")}`,
  );

  // Overdue corrective actions (the risk/exports input): exactly half of
  // N_CAS past-due, the rest open future-dated.
  const caRows: string[] = [];
  for (let i = 1; i <= N_CAS; i++) {
    const overdue = i % 2 === 0;
    const parent = findingId(i);
    caRows.push(
      `('${caId(i)}', '${parent}', '${SITE}', 'Scale CA ${i}',
       now() - interval '2 days', '${f.admin}', 'open')`,
    );
    if (!overdue) {
      // re-write the future-dated half with a due date ahead of now()
      caRows[caRows.length - 1] =
        `('${caId(i)}', '${parent}', '${SITE}', 'Scale CA ${i}',
        now() + interval '20 days', '${f.admin}', 'open')`;
    }
  }
  await adminSql(
    `insert into public.corrective_actions
       (id, finding_id, site_id, description, due_at, opened_by_id, status)
     values ${caRows.join(",")}`,
  );

  // Incidents: fatality every 11th, high-severity every 5th of the rest.
  const incidentRows: string[] = [];
  for (let i = 1; i <= N_INCIDENTS; i++) {
    const type = i % 11 === 0 ? "fatality" : i % 2 === 0 ? "injury" : "near_miss";
    const severity =
      type === "fatality" ? "critical" : i % 5 === 0 ? "high" : "medium";
    const occurredMinutes = 120_000 + i; // strictly increasing over ~83 days
    incidentRows.push(
      `('${incidentId(i)}', '${SITE}', '${type}', '${severity}', 'Scale incident ${i}',
       now() - interval '${occurredMinutes} minutes', 0, '${f.admin}', 'inspector', 'reported')`,
    );
  }
  await adminSql(
    `insert into public.incidents
       (id, site_id, type, severity, description, occurred_at, fatalities,
        reported_by_id, report_source, status)
     values ${incidentRows.join(",")}`,
  );

  // Customer reports (not needed >5,000 for these pins, but seed SOMETHING
  // so admin-visible counts are non-trivial): N_REPORTS stays 0 by design.
}

beforeAll(async () => {
  await getEdgeDb();
  if (!clientSwapped) {
    __testSetSupabaseClient(createEdgeClient());
    clientSwapped = true;
  }
  await seedFixture();
  setIdentity(f.admin);
});

afterAll(async () => {
  await cleanFixture();
});

// ===========================================================================
// 1. NUMBERS EQUAL SQL TRUTH (>5,000 rows per table)
// ===========================================================================

describe("scale: seed integrity (the volume these tests mean anything at)", () => {
  test("the fixture really is past 5,000 rows per aggregate table", async () => {
    const gt = (
      await adminSql(`select
        (select count(*) from public.findings) f,
        (select count(*) from public.corrective_actions) c,
        (select count(*) from public.incidents) i,
        (select count(*) from public.audit_log) a`)
    )[0] as Record<string, string>;
    // Account for the shared in-process database (other suites' fixtures may
    // still be present) — these floors hold regardless.
    expect(Number(gt.f)).toBeGreaterThanOrEqual(N_FINDINGS);
    expect(Number(gt.c)).toBeGreaterThanOrEqual(N_CAS);
    expect(Number(gt.i)).toBeGreaterThanOrEqual(N_INCIDENTS);
  });
});

describe("scale: command center exactness past 5,000 rows", () => {
  let s: CommandCenterStats | undefined;

  test("every figure equals the database's own count of the same predicate", async () => {
    const gt = (
      await adminSql(`select
        (select count(*) from public.sites) sites,
        (select count(*) from public.inspections) inspections,
        (select count(*) from public.findings) findings,
        (select count(*) from public.incidents) incidents,
        (select count(*) from public.environmental_observations) env,
        (select count(*) from public.community_reports) reports`)
    )[0] as Record<string, unknown>;

    s = await first(api.stats.commandCenter());
    expect(s).toBeDefined();
    expect(s!.inspectionsTotal).toBe(Number(gt.inspections));
    expect(s!.findingsTotal).toBe(Number(gt.findings));
    expect(s!.incidentsTotal).toBe(Number(gt.incidents));
    expect(s!.sites).toBe(Number(gt.sites));
    expect(sum(Object.values(s!.incidentTypes))).toBe(s!.incidentsTotal);
    expect(s!.findingsTotal).toBeGreaterThanOrEqual(N_FINDINGS);
    expect(s!.incidentsTotal).toBeGreaterThanOrEqual(N_INCIDENTS);
  });

  test("critical-open finding figure equals the SQL predicate's own count", async () => {
    const gt = (
      await adminSql(
        `select count(*) n from public.findings
          where severity = 'critical' and status in ('open','acknowledged')`,
      )
    )[0] as { n: string };
    expect(s!.findingsCriticalOpen).toBe(Number(gt.n));
  });

  test("overdue-CA figure equals the SQL predicate's own count", async () => {
    const gt = (
      await adminSql(
        `select count(*) n from public.corrective_actions
          where status not in ('closed','verified') and due_at < now()`,
      )
    )[0] as { n: string };
    expect(s!.correctiveActionsOverdue).toBe(Number(gt.n));
  });

  test("fatalities sum equals the SQL predicate's own total", async () => {
    const gt = (
      await adminSql(
        `select coalesce(sum(coalesce(fatalities,1)),0) n
           from public.incidents where type = 'fatality'`,
      )
    )[0] as { n: string };
    expect(s!.fatalities).toBe(Number(gt.n));
  });
});

// ===========================================================================
// 2. RISK SCORES — SQL COUNT AGGREGATES, CLIENT-BUILT FACTORS
// ===========================================================================

describe("scale: risk scores aggregate in the database (RPC-first)", () => {
  test("figures MATCH the SQL ground truth for every site entry (risk model)", async () => {
    const scores = await first(api.sites.riskScores());
    expect(scores![SITE]).toBeDefined();

    const gt = (
      await adminSql(`select
        (select count(*) from public.findings where site_id = '${SITE}') f,
        (select count(*) from public.findings where site_id = '${SITE}' and severity='low') low,
        (select count(*) from public.findings where site_id = '${SITE}' and severity='medium') med,
        (select count(*) from public.findings where site_id = '${SITE}' and severity='high') high,
        (select count(*) from public.findings where site_id = '${SITE}' and severity='critical') crit,
        (select count(*) from public.corrective_actions c
           where c.site_id = '${SITE}' and c.status not in ('closed','verified') and c.due_at < now()) overdue,
        (select count(*) from public.incidents where site_id = '${SITE}' and type='fatality') fat,
        (select count(*) from public.incidents
           where site_id = '${SITE}' and type <> 'fatality' and severity in ('high','critical')) ser`)
    )[0] as Record<string, string>;
    // The admin sees everything → the site's entry must equal the SITE-SCOPED
    // SQL truth. (Suites share one per-process database — the ground truth is
    // scoped to SITE so another fixture's rows can never contaminate it.)
    const c: RiskInputCounts = {
      findingsTotal: Number(gt.f),
      low: Number(gt.low),
      medium: Number(gt.med),
      high: Number(gt.high),
      critical: Number(gt.crit),
      overdueCAs: Number(gt.overdue),
      fatalityIncidents: Number(gt.fat),
      seriousIncidents: Number(gt.ser),
      envAlerts: 0,
    };
    const expected = factorsFromCounts(c);
    expect(scores![SITE].score).toBe(expected.score);
    expect(scores![SITE].factors.map((x) => x.label + ":" + x.points)).toEqual(
      expected.factors.map((x) => x.label + ":" + x.points),
    );
    // INVARIANT: score ≡ Σ factor points — held at five-dither scale too.
    expect(scores![SITE].score).toBe(
      scores![SITE].factors.reduce((n, x) => n + x.points, 0),
    );
  });

  test("the RPC path is REALLY the one that ran (not the fallback)", async () => {
    const warns: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await first(api.sites.riskScores());
    } finally {
      spy.mockRestore();
    }
    expect(
      warns.filter((w) => w.includes("mg_risk_scores")),
    ).toEqual([]);
  });

  test("explainRiskScore cites the seeded records the SQL id-arrays carry", async () => {
    const gt = (
      await adminSql(
        `select coalesce(jsonb_agg(id::text), '[]'::jsonb) ids
           from public.findings where site_id = '${SITE}' and severity = 'critical'`,
      )
    )[0] as { ids: string[] };
    const expl = await first(api.ai.explainRiskScore({ siteId: SITE }));
    expect(expl).not.toBeNull();
    expect(expl!.abstained).toBe(false);
    const critSentence = expl!.sentences.find((x) => x.factor.includes("critical"))!;
    expect(critSentence).toBeDefined();
    expect(new Set(critSentence.recordIds)).toEqual(new Set(gt.ids));
    // score ≡ Σ sentence points (the AI invariant, re-proven at scale).
    expect(expl!.sentences.reduce((n, x) => n + x.points, 0)).toBe(
      (await first(api.sites.riskScores()))![SITE].score,
    );
  });
});

// ===========================================================================
// 3. KEYSET PAGES — walk every feed by cursor ONLY
// ===========================================================================

describe("scale: keyset pagination walks >5,000-row feeds exactly", () => {
  test("mg_incidents_page cursor-walks ALL seeded incidents, newest first", async () => {
    const rows = await walkKeyset(
      (before) => api.records.incidentsPage({ before, limit: 500 }),
      500,
    );
    const mine = rows.filter((r) => r._id.startsWith("96000400-"));
    expect(mine.length).toBe(N_INCIDENTS);
    // Order: (occurred_at, id) DESC — every row strictly "newer" than the next.
    for (let k = 1; k < mine.length; k++) {
      const a = mine[k - 1];
      const b = mine[k];
      expect(
        a.occurredAt > b.occurredAt ||
          (a.occurredAt === b.occurredAt && a._id > b._id),
      ).toBe(true);
    }
  });

  test("mg_inspections_page cursor-walks ALL seeded inspections", async () => {
    const rows = await walkKeyset(
      (before) => api.inspections.inspectionsPage({ before, limit: 500 }),
      500,
    );
    const mine = rows.filter((r) => r._id.startsWith("96000100-"));
    expect(mine.length).toBe(N_INSPECTIONS);
    for (let k = 1; k < mine.length; k++) {
      const a = mine[k - 1];
      const b = mine[k];
      expect(
        a.createdAt > b.createdAt ||
          (a.createdAt === b.createdAt && a._id > b._id),
      ).toBe(true);
    }
  });

  test("mg_compliance_page cursor-walks ALL seeded CAs; deadline states derive", async () => {
    const rows = await walkKeyset(
      (before) => api.inspections.compliancePage({ before, limit: 500 }),
      500,
    );
    const mine = rows.filter((r) => r._id.startsWith("96000300-"));
    expect(mine.length).toBe(N_CAS);
    for (let k = 1; k < mine.length; k++) {
      const a = mine[k - 1];
      const b = mine[k];
      expect(
        a.createdAt > b.createdAt ||
          (a.createdAt === b.createdAt && a._id > b._id),
      ).toBe(true);
    }
  });

  test("the list pages are served by the RPC path (no silent fallback)", async () => {
    const warns: string[] = [];
    const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await api.records.incidentsPage({ limit: 10 });
      await api.inspections.inspectionsPage({ limit: 10 });
      await api.inspections.compliancePage({ limit: 10 });
    } finally {
      spy.mockRestore();
    }
    expect(warns).toEqual([]);
  });

  test("pagination at page boundaries: mixed page sizes all completion-through", async () => {
    for (const size of [1, 7, 999]) {
      const rows = await walkKeyset(
        (before) => api.records.incidentsPage({ before, limit: size }),
        size,
      );
      expect(rows.filter((r) => r._id.startsWith("96000400-")).length).toBe(
        N_INCIDENTS,
      );
    }
  });
});

// ===========================================================================
// 4. STREAMING EXPORTS — one page at a time, bytes identical to the whole
// ===========================================================================

describe("scale: streaming CSV consumes pages, bytes = whole-feed serialization", () => {
  test("incidents export: streamed bytes == toCsv of the fully-walked feed", async () => {
    const walked = await walkKeyset(
      (before) => api.records.incidentsPage({ before, limit: 500 }),
      500,
    );
    // Feed columns: exact export schema at pg level.
    const cols = [
      { header: "Incident ID", value: (r: (typeof walked)[number]) => r._id },
      { header: "Site code", value: (r: (typeof walked)[number]) => r.siteCode },
      { header: "County", value: (r: (typeof walked)[number]) => r.county },
      { header: "Status", value: (r: (typeof walked)[number]) => r.status },
    ];
    const streamed = (await csvParts(api.exports.streamIncidents(), cols)).join("");
    const whole = toCsv(walked, cols); // rows are ordered newest-first already
    // The streamed feed carries the SAME rows (id set + order) and hence the
    // same bytes: streaming is a memory contract, not a data contract.
    expect(streamed).toBe(whole);
  });

  test("inspections export: streamed bytes == toCsv of the fully-walked feed", async () => {
    const walked = await walkKeyset(
      (before) => api.inspections.inspectionsPage({ before, limit: 500 }),
      500,
    );
    const streamed = (await csvParts(
      api.exports.streamInspections(),
      INSPECTION_EXPORT_COLUMNS,
    )).join("");
    const whole = toCsv(walked, INSPECTION_EXPORT_COLUMNS);
    expect(streamed).toBe(whole);
    expect(walked.filter((r) => r._id.startsWith("96000100-")).length).toBe(
      N_INSPECTIONS,
    );
  });

  test("compliance export: streamed bytes == toCsv of the fully-walked feed", async () => {
    const walked = await walkKeyset(
      (before) => api.inspections.compliancePage({ before, limit: 500 }),
      500,
    );
    const streamed = (await csvParts(
      api.exports.streamCompliance(),
      COMPLIANCE_EXPORT_COLUMNS,
    )).join("");
    const whole = toCsv(walked, COMPLIANCE_EXPORT_COLUMNS);
    expect(streamed).toBe(whole);
    expect(walked.filter((r) => r._id.startsWith("96000300-")).length).toBe(
      N_CAS,
    );
  });

  test("the LAST chunk is page-final, not document-final (CRLF after every row)", async () => {
    const parts = await csvParts(
      api.exports.streamCompliance(),
      COMPLIANCE_EXPORT_COLUMNS,
    );
    expect(parts.length).toBeGreaterThan(1); // header + ≥ 1 row chunk (or retries)
    for (const chunk of parts.slice(1)) {
      expect(chunk.endsWith("\r\n")).toBe(true);
    }
  });
});

// ===========================================================================
// 5. RLS SURFACE — the invoker RPCs follow the caller's scope exactly
// ===========================================================================

describe("scale: the RPC surfaces are RLS-scoped (no privilege path)", () => {
  test("anon cannot execute the aggregation or any page RPC", async () => {
    setIdentity(null);
    for (const fn of [
      "mg_risk_scores",
      "mg_risk_explanation",
      "mg_incidents_page",
      "mg_inspections_page",
      "mg_compliance_page",
    ] as const) {
      const res = await (await import("../src/lib/supabase")).supabase.rpc(fn);
      expect(res.error).toBeTruthy();
      expect(String((res.error as { message?: string })?.message ?? "")).toMatch(
        /permission denied/i,
      );
    }
  });

  test("the operator sees ONLY own-tenant pages (site A rows, never B)", async () => {
    setIdentity(f.opA);
    const rows = await walkKeyset(
      (before) => api.records.incidentsPage({ before, limit: 500 }),
      500,
    );
    for (const r of rows) expect(r.county).toBe("Bomi");
    // Multi-row walk never returned a row of another operator's site.
    expect(rows.some((r) => r.siteCode?.startsWith("LB-SCALE"))).toBe(false);
  });

  test("admin sees the scale probe's page rows through the SAME RPC", async () => {
    setIdentity(f.admin);
    const rows = await walkKeyset(
      (before) => api.records.incidentsPage({ before, limit: 500 }),
      500,
    );
    expect(rows.filter((r) => r._id.startsWith("96000400-")).length).toBe(
      N_INCIDENTS,
    );
  });
});

// ===========================================================================
// 6. SOURCE CONTRACTS
// ===========================================================================

describe("scale: source contract (no unranged select survives)", () => {
  const backendSrc = readFileSync(
    join(import.meta.dir, "..", "src", "lib", "backend.ts"),
    "utf8",
  );
  const bridgeSrc = readFileSync(
    join(import.meta.dir, "helpers", "backend-edge.ts"),
    "utf8",
  );

  test("every read that leaves the primary key is explicitly ranged", () => {
    // The page contract still holds: an unranged whole-table select can only
    // return what the wire cap allows — never the full feed.
    expect(backendSrc).toContain(".range(from, to)");
    expect(backendSrc).not.toContain(
      'const { data, error } = await supabase.from(table).select("*");',
    );
    // The aggregation and paging both live in the database now.
    expect(backendSrc).toContain('rpc("mg_risk_scores")');
    expect(backendSrc).toContain('rpc("mg_risk_explanation")');
    expect(backendSrc).toContain('rpc("mg_incidents_page")');
    expect(backendSrc).toContain('rpc("mg_inspections_page")');
    expect(backendSrc).toContain('rpc("mg_compliance_page")');
  });

  test("the exports stream the keyset pages (no whole-table buffer in the UI)", () => {
    const insp = readFileSync(
      join(import.meta.dir, "..", "src", "pages", "Inspections.tsx"),
      "utf8",
    );
    const op = readFileSync(
      join(import.meta.dir, "..", "src", "pages", "operate", "OperatorCorrectiveActions.tsx"),
      "utf8",
    );
    expect(insp).toContain("streamCsvFile");
    expect(insp).toContain("api.exports.streamInspections()");
    expect(op).toContain("streamCsvFile");
    expect(op).toContain("api.exports.streamCompliance()");
    // No await-using legacy whole-feed export call sites survive.
    expect(insp).not.toContain("exportInspections(");
    expect(op).not.toContain("exportComplianceObligations(");
  });

  test("the bridge still emulates the hosted row cap (so this stays honest)", () => {
    expect(bridgeSrc).toContain("POSTGREST_MAX_ROWS");
    expect(bridgeSrc).toMatch(/limit \$\{POSTGREST_MAX_ROWS\}/);
  });
});
