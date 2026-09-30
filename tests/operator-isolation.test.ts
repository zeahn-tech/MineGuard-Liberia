// ---------------------------------------------------------------------------
// OPERATOR PORTAL — structural isolation (Priority B §20, acceptance).
//
// The directive requires a DEDICATED operator experience with strict tenant
// isolation — not a conditionally-hidden staff view. These tests verify the
// structural claim at both layers:
//
// LAYER 1 — ROUTES: the operator section is its own routed subtree
// (/operate/*) with its own layout and gate (RequireOperator), and the staff
// portal is gated by RequireStaff. The router configuration itself is
// asserted: every /portal/* route is wrapped in RequireStaff, every
// /operate/* route in RequireOperator (via OperatorLayout). An operator
// account therefore CANNOT render any staff surface — the guard redirects
// before the page code runs.
//
// LAYER 2 — QUERIES: as the operator identity, every staff-only backend
// surface is exercised through the REAL data layer over the wire bridge and
// must fail closed — FORBIDDEN (client guard), empty-without-error (scoped
// list contract), or RLS-denied. Queries that legitimately serve operators
// (own sites, own findings, own obligations, own incidents) are asserted to
// contain ONLY own-tenant rows.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/** Assert fn rejects with a message containing token. */
async function expectError(fn: () => Promise<unknown>, token: string) {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    expect(msg).toContain(token);
    return;
  }
  throw new Error(`expected error containing "${token}", but the call succeeded`);
}

/** Capture console.error so live()-swallowed denials can be asserted. */
async function withCapturedErrors<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
  try {
    return { result: await fn(), errors };
  } finally {
    spy.mockRestore();
  }
}

// ===========================================================================
// LAYER 1 — ROUTE ISOLATION (structural, asserted against the router source)
// ===========================================================================

describe("route isolation: /portal is staff-gated, /operate is operator-gated", () => {
  const mainSrc = readFileSync(join(import.meta.dir, "..", "src", "main.tsx"), "utf8");

  test("the staff portal route is wrapped in RequireStaff (not merely RequireAuth)", () => {
    expect(mainSrc).toContain("RequireStaff");
    expect(mainSrc).toMatch(/path="\/portal"[\s\S]{0,160}RequireStaff/);
  });

  test("the operator section is its own routed subtree under /operate", () => {
    expect(mainSrc).toMatch(/path="\/operate"/);
    expect(mainSrc).toContain("OperatorLayout");
    expect(mainSrc).toMatch(/path="\/operate"[\s\S]{0,600}OperatorOverview/);
  });

  test("every operator navigation tab is a link to a registered /operate route", () => {
    const layoutSrc = readFileSync(
      join(import.meta.dir, "..", "src", "pages", "operate", "OperatorLayout.tsx"),
      "utf8",
    );
    const start = mainSrc.indexOf('path="/operate"');
    const end = mainSrc.indexOf("{/* Authenticated STAFF portal");
    const routeBlock = mainSrc.slice(start, end);
    const navPaths = [...layoutSrc.matchAll(/\{ to: "(\/operate[^\"]*)", label:/g)].map(
      ([, path]) => path,
    );

    expect(navPaths).toEqual([
      "/operate",
      "/operate/sites",
      "/operate/findings",
      "/operate/corrective-actions",
      "/operate/incidents",
      "/operate/security",
    ]);
    expect(layoutSrc).toContain("<NavLink");
    expect(layoutSrc).toContain("to={item.to}");
    expect((layoutSrc.match(/<OperatorNavLinks/g) ?? []).length).toBe(2);

    for (const path of navPaths) {
      if (path === "/operate") {
        expect(routeBlock).toContain("<Route index");
      } else {
        expect(routeBlock).toContain(`path="${path.slice("/operate/".length)}"`);
      }
    }
  });

  test("no staff page is routed inside the /operate subtree", () => {
    // From the /operate block up to the staff-portal comment: no staff page
    // component may appear.
    const start = mainSrc.indexOf('path="/operate"');
    const end = mainSrc.indexOf("{/* Authenticated STAFF portal");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = mainSrc.slice(start, end);
    for (const staffPage of ["CommandCenter", "NationalMap", "Audit", "Inspections", "Environment", "Community", "PortalLayout", "Security"]) {
      expect(block).not.toContain(`<${staffPage}`);
    }
  });

  test("the layout gate chain: RequireOperator wraps the operator shell; PortalLayout no longer branches on operator identity", () => {
    const layoutSrc = readFileSync(
      join(import.meta.dir, "..", "src", "pages", "operate", "OperatorLayout.tsx"),
      "utf8",
    );
    expect(layoutSrc).toContain("RequireOperator");
    const portalSrc = readFileSync(
      join(import.meta.dir, "..", "src", "pages", "PortalLayout.tsx"),
      "utf8",
    );
    expect(portalSrc).not.toContain("OPERATOR_NAV");
    expect(portalSrc).not.toContain("/portal/operate");
  });

  test("guards redirect identities to the right section (operator→/operate, staff gate→/portal)", () => {
    const guardSrc = readFileSync(
      join(import.meta.dir, "..", "src", "components", "RequireAuth.tsx"),
      "utf8",
    );
    expect(guardSrc).toMatch(/RequireStaff[\s\S]*ROLES\.OPERATOR[\s\S]*Navigate\s+to="\/operate"/);
    expect(guardSrc).toMatch(/RequireOperator[\s\S]*Navigate\s+to="\/portal"/);
  });

  test("auth and profile changes notify React subscribers without a page reload", () => {
    const authSrc = readFileSync(join(import.meta.dir, "..", "src", "lib", "supabase.ts"), "utf8");
    const reactSrc = readFileSync(join(import.meta.dir, "..", "src", "lib", "backend-react.ts"), "utf8");

    expect(authSrc).toContain("const becameReady = !authReady;");
    expect(authSrc).toContain("if (changed || becameReady)");
    expect(reactSrc).toMatch(/onAuthStateChangedSupabase\(\(uid\) => \{[\s\S]*?authEpoch\+\+;\s*notifyAuthEpochChanged\(\);/);
    expect(reactSrc).toMatch(/onProfileVersionChanged\(\(\) => \{\s*authEpoch\+\+;\s*notifyAuthEpochChanged\(\);/);
  });

  test("sign-in without returnTo lands each identity in its own section", () => {
    const authSrc = readFileSync(join(import.meta.dir, "..", "src", "pages", "Auth.tsx"), "utf8");
    expect(authSrc).toMatch(/role === "operator"\) return "\/operate"/);
  });
});

// ===========================================================================
// LAYER 2 — QUERY ISOLATION (fail-closed through the real data layer)
// ===========================================================================

describe("query isolation: operator identity vs staff-only surfaces", () => {
  test("command center: operator gets own-tenant figures, never staff aggregates", async () => {
    setIdentity(f.opA);
    const [s, ownSites] = await Promise.all([
      first(api.stats.commandCenter()),
      first(api.sites.list()),
    ]);
    // The figure must equal the operator's OWN tenant site count (other
    // suites commit extra AgriLib sites; the invariant is "own tenant only",
    // not a fixed number — staff-wide would be strictly larger).
    expect(s!.sites).toBe(ownSites!.length);
    expect(s!.communityReports).toBe(0); // staff-only queue: empty for operators
  });

  test("audit log: staff surface → empty for operator (client guard; no staff rows leak)", async () => {
    setIdentity(f.opA);
    const { result, errors } = await withCapturedErrors(() => first(api.stats.recentAuditLog()));
    expect(result).toEqual([]);
    // The RLS denial is logged (swallowed live query) OR the guard returned
    // empty; either way NOTHING from the staff audit trail is visible.
    if (result!.length === 0 && errors.length > 0) {
      expect(errors.some((m) => m.includes("FORBIDDEN") || m.includes("42501"))).toBe(true);
    }
  });

  test("user directory + provisioning + role assignment: FORBIDDEN for operator", async () => {
    setIdentity(f.opA);
    const dir = await withCapturedErrors(() => first(api.stats.listUsers()));
    expect(dir.result).toBeUndefined();
    expect(dir.errors.some((m) => m.includes("FORBIDDEN"))).toBe(true);

    await expectError(() =>
      api.stats.provisionByEmail({ email: "x@x.test", role: "inspector", scope: "county" }),
    "FORBIDDEN");
    await expectError(() =>
      api.stats.setUserRole({ userId: f.guest, role: "admin" }),
    "FORBIDDEN");
  });

  test("site registry writes: create/status FORBIDDEN for operator", async () => {
    setIdentity(f.opA);
    await expectError(() =>
      api.sites.create({ name: "Nope", operatorName: "X", county: "Bomi" }),
    "FORBIDDEN");
    await expectError(() =>
      api.sites.setStatus({ siteId: f.siteA, status: "closed" }),
    "FORBIDDEN");
  });

  test("community report queue + triage: staff-only → empty queue, triage FORBIDDEN", async () => {
    setIdentity(f.opA);
    const queue = await first(api.records.listCommunityReports());
    expect(queue).toEqual([]);
    await expectError(() =>
      api.records.triageCommunityReport({ reportId: "00000000-0000-4000-8000-000000000000", decision: "dismissed" }),
    "FORBIDDEN");
  });

  test("environmental observation status (staff surface): FORBIDDEN for operator", async () => {
    setIdentity(f.opA);
    await expectError(() =>
      api.records.setObservationStatus({ observationId: "00000000-0000-4000-8000-000000000000", status: "open" }),
    "FORBIDDEN");
  });

  test("inspection review + finding resolution (staff surfaces): FORBIDDEN for operator", async () => {
    setIdentity(f.opA);
    await expectError(() =>
      api.inspections.review({ inspectionId: f.inspection, decision: "approved" }),
    "FORBIDDEN");
    await expectError(() =>
      api.inspections.updateFindingStatus({ findingId: f.findingA, status: "resolved" }),
    "FORBIDDEN");
  });

  test("seed + storage footprint (admin surfaces): FORBIDDEN for operator", async () => {
    setIdentity(f.opA);
    await expectError(() => api.seed.seedIfEmpty(), "FORBIDDEN");
    const fp = await withCapturedErrors(() => first(api.evidence.storageFootprint()));
    expect(fp.result).toBeUndefined();
    expect(fp.errors.some((m) => m.includes("FORBIDDEN"))).toBe(true);
  });

  test("risk scores (staff analytics): operator gets own-tenant-only view", async () => {
    setIdentity(f.opA);
    const [scores, ownSites] = await Promise.all([
      first(api.sites.riskScores()),
      first(api.sites.list()),
    ]);
    const ownIds = new Set(ownSites!.map((s) => s._id));
    const keys = Object.keys(scores ?? {});
    expect(keys.length).toBe(ownIds.size);
    for (const siteId of keys) {
      expect(ownIds.has(siteId)).toBe(true);
    }
  });

  test("incident status setting (staff surface): FORBIDDEN for operator", async () => {
    setIdentity(f.opA);
    await expectError(() =>
      api.records.setIncidentStatus({ incidentId: f.incidentA, status: "investigating" }),
    "FORBIDDEN");
  });
});

describe("operator surfaces: strictly own-tenant through the operator section's queries", () => {
  test("sites.list: exactly the operator's tenant rows (server-scoped)", async () => {
    setIdentity(f.opA);
    const sites = await first(api.sites.list());
    expect(sites!.length).toBeGreaterThanOrEqual(1);
    expect(sites!.every((s) => s.operatorName === "AgriLib Mining")).toBe(true);
    expect(sites!.some((s) => s._id === f.siteB)).toBe(false);

    // Detail of another tenant's site is null-masked (existence masking).
    const masked = await first(api.sites.get({ siteId: f.siteB }));
    expect(masked).toBeNull();
  });

  test("findings feed: only own-tenant findings, joined with site identity", async () => {
    setIdentity(f.opA);
    const feed = await first(api.inspections.listMyFindings());
    expect(feed!.length).toBeGreaterThanOrEqual(1);
    expect(feed!.every((x) => x.siteId === f.siteA)).toBe(true);
    expect(feed![0].siteCode).toBeTruthy();

    // A finding on the other tenant never appears for opA.
    setIdentity(f.admin);
    const other = await adminSql(
      `insert into public.findings (inspection_id, site_id, title, severity, created_by_id)
       values ('${f.inspection}', '${f.siteB}', 'Iso probe B', 'low', '${f.admin}') returning id`,
    );
    setIdentity(f.opA);
    const feed2 = await first(api.inspections.listMyFindings());
    expect(feed2!.some((x) => x._id === String(other[0].id))).toBe(false);
    setIdentity(f.admin);
    await adminSql(`delete from public.findings where id = '${other[0].id}'`);
  });

  test("incidents list: only own-tenant incidents", async () => {
    setIdentity(f.opA);
    const inc = await first(api.records.listIncidents());
    expect(inc!.length).toBeGreaterThanOrEqual(1);
    expect(inc!.every((i) => i.siteId === f.siteA)).toBe(true);
  });

  test("corrective-action feed: only own-tenant obligations", async () => {
    setIdentity(f.opA);
    const feed = await first(api.inspections.listMyCorrectiveActions());
    expect(feed!.every((o) => o.siteId === f.siteA)).toBe(true);
  });

  test("operator incident submission + document upload: authorized on OWN site, FORBIDDEN cross-tenant", async () => {
    setIdentity(f.opA);
    const id = await api.records.reportIncident({
      siteId: f.siteA,
      type: "equipment_accident",
      severity: "low",
      description: "Operator section e2e submission",
      occurredAt: Date.now(),
    });
    expect(id).toBeTruthy();

    // Document submission (evidence) against the OWN site — authorized.
    const rowId = await api.evidence.upload({
      file: new Blob([new Uint8Array(16)]),
      fileName: "op-section-report.pdf",
      mimeType: "application/pdf",
      parentType: "incident",
      parentId: id,
      siteId: f.siteA,
    });
    const row = await adminSql(
      `select kind, parent_type from public.evidence where id = '${rowId}'`,
    );
    expect(row[0].kind).toBe("document");
    expect(row[0].parent_type).toBe("incident");

    // …but the same call against ANOTHER tenant's site is FORBIDDEN.
    await expectError(() =>
      api.evidence.upload({
        file: new Blob([new Uint8Array(4)]),
        fileName: "cross.pdf",
        mimeType: "application/pdf",
        parentType: "incident",
        parentId: id,
        siteId: f.siteB,
      }),
    "FORBIDDEN");
  });
});
