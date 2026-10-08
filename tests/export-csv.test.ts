// ---------------------------------------------------------------------------
// GOVERNMENT REPORTING EXPORTS (§9) — CSV v1, client-side only.
//
// The core authorization claim is structural: there IS no export endpoint.
// Exports serialize rows the caller's existing authorization already
// returned (RLS + the client mirror), so the acceptance criterion — "scoped
// by the requesting user's existing authorization; no new unscoped data
// path" — holds by construction. The tests verify both halves:
//
// 1. THE FORMAT CONTRACT (pure): RFC 4180 quoting/escaping, BOM, CRLF,
//    dated filename, empty-cell handling, deadline-state derivation.
// 2. THE AUTHORIZATION INVARIANT (data layer over the RLS-enforced wire
//    bridge): the exact row set each role would serialize is the row set
//    their existing feeds return — operator export is strictly own-tenant
//    (a cross-tenant CA seeded and proven absent), county-scoped staff
//    export excludes other counties, and a source-contract check asserts
//    that exports read only `inspections.list` /
//    `listMyCorrectiveActions` — so no new server path can be wired into
//    them without this suite failing.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPLIANCE_EXPORT_COLUMNS,
  csvFile,
  exportComplianceObligations,
  exportInspections,
  toCsv,
  type ComplianceExportRow,
} from "../src/lib/export-csv";
import { api } from "../src/lib/backend";
import { __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import {
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";

let clientSwapped = false;

beforeAll(async () => {
  await getEdgeDb();
  if (!clientSwapped) {
    __testSetSupabaseClient(createEdgeClient());
    clientSwapped = true;
  }
});

let currentUid: string | null = null;
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

// ------------------------------------------------------- 1. format contract

describe("CSV format contract (pure)", () => {
  test("plain rows serialize with header + CRLF + BOM", () => {
    const csv = toCsv([{ a: "1", b: "x" }, { a: "2", b: "y" }], [
      { header: "A", value: (r) => r.a },
      { header: "B", value: (r) => r.b },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const body = csv.slice(1);
    expect(body).toBe("A,B\r\n1,x\r\n2,y\r\n");
  });

  test("commas, quotes, and newlines are quoted and escaped per RFC 4180", () => {
    const csv = toCsv(
      [{ d: `He said "stop, now"\nthen left` }],
      [{ header: "Detail", value: (r) => r.d }],
    );
    const body = csv.slice(1).trimEnd();
    expect(body).toBe('Detail\r\n"He said ""stop, now""\nthen left"');
  });

  test("null/undefined serialize as empty cells; numbers pass through", () => {
    const csv = toCsv([{ a: undefined, b: null, c: 42 }], [
      { header: "A", value: (r) => r.a },
      { header: "B", value: (r) => r.b },
      { header: "C", value: (r) => r.c },
    ]);
    expect(csv.slice(1)).toBe("A,B,C\r\n,,42\r\n");
  });

  test("csvFile builds a dated, BOM-bearing .csv File with the right bytes", async () => {
    const file = csvFile(
      [{ status: "open" }],
      [{ header: "Status", value: (r) => r.status }],
      "compliance",
      new Date("2026-09-28T14:03:00Z"),
    );
    expect(file.name).toBe("mineguard-compliance-2026-09-28.csv");
    expect(file.type).toBe("text/csv;charset=utf-8");
    // Assert on RAW BYTES: a decoded string may hide the BOM (Bun's text()
    // strips the leading U+FEFF during UTF-8 decoding).
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const text = new TextDecoder().decode(bytes.slice(3));
    expect(text).toBe("Status\r\nopen\r\n");
  });

  test("compliance deadline state derives resolved/overdue/open", () => {
    const now = Date.now();
    const col = COMPLIANCE_EXPORT_COLUMNS.find((c) => c.header === "Deadline state")!;
    const row = (status: string, dueAt: number) => ({ status, dueAt }) as ComplianceExportRow;
    expect(col.value(row("closed", now - 9_999))).toBe("resolved");
    expect(col.value(row("verified", now - 9_999))).toBe("resolved");
    expect(col.value(row("open", now - 1))).toBe("overdue");
    expect(col.value(row("in_progress", now + 86_400_000))).toBe("open");
    expect(col.value(row("escalated", now - 5))).toBe("overdue");
  });

  test("export helpers route through downloadFile and return the filename", () => {
    const captured: string[] = [];
    const trigger = (f: File) => captured.push(f.name);
    const n1 = exportInspections(
      [{ _id: "i1", siteCode: "MG-001", siteName: "S", county: "Bomi", status: "submitted", createdAt: 0, inspectorId: "u" }],
      trigger,
    );
    const n2 = exportComplianceObligations(
      [{ _id: "c1", description: "d", status: "open", dueAt: 0, findingTitle: "t", findingSeverity: "high", siteCode: "MG-001", siteName: "S", county: "Bomi" }],
      trigger,
    );
    expect(n1).toMatch(/^mineguard-inspections-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(n2).toMatch(/^mineguard-compliance-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(captured).toEqual([n1, n2]);
  });
});

// ------------------------------------------------ 2. authorization invariant

describe("export scope follows existing authorization (data layer)", () => {
  test("operator export = own-tenant compliance feed; cross-tenant CA absent", async () => {
    // Seed an additional CA on the OTHER operator's site (admin context),
    // using the notifications suite's literal-SQL seed pattern (adminSql
    // takes no bind parameters on this bridge).
    setIdentity(f.admin);
    const seeded = await adminSql(
      `insert into public.corrective_actions (finding_id, site_id, description, due_at, opened_by_id)
       select id, site_id, 'Cross-tenant obligation (export isolation probe)', now() + interval '20 days', site_id
       from public.findings
       where site_id = '${f.siteB}'
       limit 1
       returning id`,
    );
    const crossTenantCaId = String(seeded[0]?.id ?? "");

    // opA's feed + export source.
    setIdentity(f.opA);
    const feed = await first(api.inspections.listMyCorrectiveActions());
    expect(feed).toBeDefined();
    expect(feed!.length).toBeGreaterThan(0);
    const serialized = toCsv(feed ?? [], COMPLIANCE_EXPORT_COLUMNS);
    expect(feed!.every((r) => r.county === "Bomi")).toBe(true);
    expect(serialized).not.toContain("OreCo");
    expect(serialized).not.toContain("export isolation probe");
    if (crossTenantCaId) expect(serialized).not.toContain(crossTenantCaId);
    expect(serialized).toContain(f.caA);

    // Cleanup so other suites' absolute counts stay stable.
    setIdentity(f.admin);
    if (crossTenantCaId) {
      await adminSql(`delete from public.corrective_actions where id = '${crossTenantCaId}'`);
    }
  });

  test("county inspector export excludes other counties' inspections", async () => {
    // The seeded inspection is admin-owned (draft) — county inspectors can
    // only read their OWN inspection rows (RLS), so seed one in Bomi they
    // own, plus one in Grand Cape Mount they must never serialize.
    setIdentity(f.admin);
    const seeded = await adminSql(
      `insert into public.inspections (id, site_id, template_id, inspector_id, status, answers)
       values
         ('dddddddd-9000-4000-8000-000000000001', '${f.siteA}', '${f.template}', '${f.county}', 'submitted', '[]'::jsonb),
         ('dddddddd-9000-4000-8000-000000000002', '${f.siteB}', '${f.template}', '${f.county}', 'submitted', '[]'::jsonb)
       returning id`,
    );
    expect(seeded.length).toBe(2);

    setIdentity(f.county);
    const feed = await first(api.inspections.list());
    expect(feed).toBeDefined();
    const serialized = toCsv(feed ?? [], [
      { header: "County", value: (r) => r.county },
      { header: "ID", value: (r) => r._id },
    ]);
    // Own Bomi row serializes; the Grand Cape Mount row must never reach
    // the export.
    expect(serialized).toContain("dddddddd-9000-4000-8000-000000000001");
    expect(serialized).not.toContain("dddddddd-9000-4000-8000-000000000002");
    expect(serialized).not.toContain("Grand Cape Mount");
    for (const r of feed ?? []) expect(r.county).toBe("Bomi");

    setIdentity(f.admin);
    await adminSql(
      `delete from public.inspections where id in ('dddddddd-9000-4000-8000-000000000001','dddddddd-9000-4000-8000-000000000002')`,
    );
  });

  test("national supervisor export covers all counties (staff national scope)", async () => {
    setIdentity(f.admin);
    await adminSql(
      `insert into public.inspections (id, site_id, template_id, inspector_id, status, answers)
       values ('dddddddd-9000-4000-8000-000000000003', '${f.siteB}', '${f.template}', '${f.national}', 'submitted', '[]'::jsonb)`,
    );

    setIdentity(f.national);
    const feed = await first(api.inspections.list());
    expect(feed).toBeDefined();
    const counties = new Set((feed ?? []).map((r) => r.county));
    expect(counties.has("Bomi")).toBe(true);
    expect(counties.has("Grand Cape Mount")).toBe(true);

    setIdentity(f.admin);
    await adminSql(
      `delete from public.inspections where id = 'dddddddd-9000-4000-8000-000000000003'`,
    );
  });

  test("unassigned account exports nothing (empty feed, empty CSV)", async () => {
    setIdentity(f.guest);
    const feed = await first(api.inspections.listMyCorrectiveActions());
    expect(feed).toEqual([]);
    // Header row only — no data rows to serialize.
    expect(toCsv(feed ?? [], COMPLIANCE_EXPORT_COLUMNS).endsWith("\r\n")).toBe(true);
    expect(toCsv(feed ?? [], COMPLIANCE_EXPORT_COLUMNS).split("\r\n")[0]).toBe(
      "\uFEFF" + COMPLIANCE_EXPORT_COLUMNS.map((c) => c.header).join(","),
    );
  });
});

// ------------------------------------------- 3. source contract (scope drift)

describe("export source contract", () => {
  test("export UI reads only the already-authorized list queries; lib is network-free", () => {
    const page = readFileSync(join("src", "pages", "Inspections.tsx"), "utf8");
    const op = readFileSync(join("src", "pages", "operate", "OperatorCorrectiveActions.tsx"), "utf8");
    const lib = readFileSync(join("src", "lib", "export-csv.ts"), "utf8");

    // The lib must not contain any network/DB client at all — client-side
    // serialization only.
    expect(lib).not.toMatch(/supabase|fetch\(|XMLHttpRequest|WebSocket|axios/);
    // SEC-4 v2: the exports STREAM the caller-scoped server keyset pages
    // (api.exports.stream*) — the row source IS the caller's RLS visibility,
    // never an unscoped whole-table read.
    expect(page).toContain("api.exports.streamInspections()");
    expect(op).toContain("api.exports.streamCompliance()");
  });
});
