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
  adminExec,
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

// ---------------------------------------------------------------------------
// SEC-5/SITE-1 — the four adversarial isolation cases from the security
// roadmap's Session 2, driven through the REAL data layer (api.*) rather
// than SQL: this is the exact path the UI consumes, so a regression in
// canAccessSite / the row mappers / the RLS wiring surfaces here, and the
// server-side proof for each lives in tests/rls.test.ts.
// ---------------------------------------------------------------------------
describe("SEC-5/SITE-1 adversarial isolation through the data layer", () => {
  /** The org-rename cascade is SECURITY INVOKER: sites_rescope re-derives
   *  display names and then backfills scope stamps onto findings/CAs/
   *  incidents, whose lifecycle guards read the SESSION's JWT. Statements
   *  that touch operator_name therefore run with the admin's claims — the
   *  same prolog tests/rls.test.ts uses inside withRole. */
  const adminClaims = (sql: string) =>
    adminExec(
      `set local role authenticated;
       set local request.jwt.claims = '{"sub":"${f.admin}","role":"authenticated"}';
       ${sql}`,
    );

  test("renamed operator: display follows the rename, tenancy keyed on the UUID does not move", async () => {
    const orgRows = await adminSql(
      `select organization_id from public.sites where id = '${f.siteA}'`,
    );
    expect(orgRows[0].organization_id).not.toBeNull();
    const orgId = String(orgRows[0].organization_id);
    try {
      await adminClaims(
        `update public.organizations set name = 'AgriLib Renamed Ltd' where id = '${orgId}'`,
      );

      setIdentity(f.opA);
      const sites = await first(api.sites.list());
      expect(sites!.some((s) => s._id === f.siteA)).toBe(true);
      // Every visible row follows the renamed display…
      expect(sites!.every((s) => s.operatorName === "AgriLib Renamed Ltd")).toBe(true);
      // …while the sibling tenant stays masked.
      expect(await first(api.sites.get({ siteId: f.siteB }))).toBeNull();

      setIdentity(f.opB);
      const b = await first(api.sites.list());
      expect(b!.some((s) => s._id === f.siteB)).toBe(true);
      expect(b!.every((s) => s.operatorName === "OreCo Liberia")).toBe(true);
    } finally {
      await adminClaims(
        `update public.organizations set name = 'AgriLib Mining' where id = '${orgId}'`,
      );
    }
  });

  test("same-name operators: a same-named sibling tenant's site never leaks into the feed", async () => {
    // A second registry row deliberately sharing AgriLib's display name.
    // Organizations are never deleted (mg_guard_org_write: "rename
    // instead"), so the sibling stays — harmless, because name-based
    // resolution always prefers the OLDEST match (the fixture tenant).
    const orgRows = await adminSql(
      `insert into public.organizations (name) values ('AgriLib Mining') returning id`,
    );
    const sibling = String(orgRows[0].id);
    const own = await adminSql(
      `select organization_id from public.sites where id = '${f.siteA}'`,
    );
    expect(own[0].organization_id).not.toBeNull();
    const orgId = String(own[0].organization_id);
    try {
      // Re-point the fixture site at the same-named sibling: the display
      // string stays byte-identical while the TENANT UUID changes.
      await adminClaims(
        `update public.sites set organization_id = '${sibling}' where id = '${f.siteA}'`,
      );
      const shown = await adminSql(
        `select operator_name, organization_id from public.sites where id = '${f.siteA}'`,
      );
      expect(shown[0].operator_name).toBe("AgriLib Mining");
      expect(String(shown[0].organization_id)).toBe(sibling);

      setIdentity(f.opA);
      const sites = await first(api.sites.list());
      // The row's display is IDENTICAL to the operator's own tenant — yet
      // it is gone from the feed (tenancy keyed on the name would leak it)…
      expect(sites!.some((s) => s._id === f.siteA)).toBe(false);
      expect(await first(api.sites.get({ siteId: f.siteA }))).toBeNull();
      // Every row still visible belongs to the operator's REAL tenant.
      expect(sites!.every((s) => s.operatorName === "AgriLib Mining")).toBe(true);

      // The sibling tenant does not gain it either…
      setIdentity(f.opB);
      const b = await first(api.sites.list());
      expect(b!.some((s) => s._id === f.siteA)).toBe(false);

      // …while admin (national scope) still sees the whole registry.
      setIdentity(f.admin);
      const all = await first(api.sites.list());
      expect(all!.some((s) => s._id === f.siteA)).toBe(true);
    } finally {
      // Restore the binding — display cascades back automatically.
      await adminClaims(
        `update public.sites set organization_id = '${orgId}' where id = '${f.siteA}'`,
      );
    }
  });

  test("site-scoped staff: exactly the assigned sites through api.sites.list, writes stay denied", async () => {
    // A fresh inspector bound through explicit site membership (scope='site'
    // — the value 0010 implemented).
    const created = await adminSql(
      `insert into auth.users (id, email, raw_user_meta_data)
         values (gen_random_uuid(), 'sitescoped@edge.test', '{}'::jsonb) returning id`,
    );
    const uid = String(created[0].id);
    try {
      await adminSql(
        `update public.profiles set role = 'inspector', scope = 'site',
                profile_complete = true where id = '${uid}'`,
      );

      setIdentity(uid);
      // No assignment recorded → sees NO sites (empty, not an error).
      expect(await first(api.sites.list())).toEqual([]);

      // Admin grants exactly one site…
      await adminSql(
        `insert into public.site_assignments (user_id, site_id, assigned_by)
           values ('${uid}', '${f.siteA}', '${f.admin}')`,
      );
      setIdentity(uid);
      const sites = await first(api.sites.list());
      expect(sites!.map((s) => s._id)).toEqual([f.siteA]);
      expect(await first(api.sites.get({ siteId: f.siteB }))).toBeNull();

      // Assignment grants visibility, never write authority: the edit API
      // stays admin-only for this persona.
      await expectError(() => api.sites.update({ siteId: f.siteA, notes: "x" }), "FORBIDDEN");
    } finally {
      await adminSql(`delete from public.site_assignments where user_id = '${uid}'`);
      await adminSql(`delete from public.audit_log where entity_id = '${uid}'`);
      await adminSql(`delete from public.profiles where id = '${uid}'`);
    }
  });

  test("cross-county: county inspector reads own county only; the edit API denies every non-admin", async () => {
    setIdentity(f.county);
    const sites = await first(api.sites.list());
    expect(sites!.length).toBeGreaterThanOrEqual(1);
    expect(sites!.some((s) => s._id === f.siteA)).toBe(true); // Bomi
    expect(sites!.every((s) => s.county === "Bomi")).toBe(true);
    expect(sites!.some((s) => s._id === f.siteB)).toBe(false); // Grand Cape Mount
    expect(await first(api.sites.get({ siteId: f.siteB }))).toBeNull();
    await expectError(() => api.sites.update({ siteId: f.siteB, notes: "cross" }), "FORBIDDEN");
    await expectError(() => api.sites.update({ siteId: f.siteA, notes: "cross" }), "FORBIDDEN");

    setIdentity(f.opA);
    await expectError(() => api.sites.update({ siteId: f.siteA, notes: "tenant" }), "FORBIDDEN");
    await expectError(() => api.sites.update({ siteId: f.siteB, notes: "tenant" }), "FORBIDDEN");

    setIdentity(f.guest);
    await expectError(() => api.sites.update({ siteId: f.siteA, notes: "guest" }), "FORBIDDEN");

    // None of the denied paths moved the fixture rows.
    const row = await adminSql(
      `select notes from public.sites where id = '${f.siteA}'`,
    );
    expect(row[0].notes).not.toBe("tenant");
    expect(row[0].notes).not.toBe("cross");
  });
});
