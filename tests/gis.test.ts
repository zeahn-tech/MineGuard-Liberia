// ---------------------------------------------------------------------------
// SESSION 6 — GIS (GIS-1…5). Acceptance:
//   (1) scope-filtered layers are PROVEN: the real data layer (backend.ts
//       mapFeatures) runs against real Postgres + RLS as admin / national
//       supervisor / county inspector / two operators / guest, and every layer
//       contains only what that identity may see;
//   (2) unverified data is visually distinct: styling, legend and clustering
//       are asserted on the same spec the map renders.
// Plus boundary validation (client mirror == SQL CHECK), provenance guards,
// and the offline tile policy (region/zoom/cache bounds; sw.js == map-tiles).
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ATTRIBUTION } from "../scripts/build-boundary-seed";
import { join } from "node:path";
import { api, refreshMapFeatures } from "../src/lib/backend";
import { __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import {
  adminExec,
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";
import {
  LIBERIA_BBOX,
  LIBERIA_CENTER,
  NO_FILTERS,
  applyFilters,
  boundaryStyle,
  buildLegend,
  clusterPoints,
  inLiberia,
  styleFor,
  symbolSvg,
  validateGeoJsonPolygon,
  verificationLevel,
} from "../src/lib/gis";
import {
  TILE_CACHE_MAX_ENTRIES,
  TILE_CACHE_NAME,
  TILE_MAX_ZOOM,
  TILE_MIN_ZOOM,
  latToTileY,
  lngToTileX,
  parseTilePath,
  shouldCacheTile,
  tileInRegion,
} from "../src/lib/map-tiles";
import { MAP_LAYER_CONFIGS, type MapFeature, type GeoLayer } from "../src/lib/types";

const ROOT = join(import.meta.dir, "..");

// ------------------------------------------------------------------ fixtures
const IDS = {
  obsA: "ababab01-0000-4000-8000-000000000001",
  obsB: "ababab01-0000-4000-8000-000000000002",
  incB: "ababab02-0000-4000-8000-000000000002",
  repBomi: "ababab03-0000-4000-8000-000000000001",
  repGcm: "ababab03-0000-4000-8000-000000000002",
  inspA: "dddddddd-0000-4000-8000-000000000001", // seeded draft, siteA, admin-owned
  bndA: "ababab04-0000-4000-8000-000000000001",
  bndB: "ababab04-0000-4000-8000-000000000002",
  admBomi: "ababab05-0000-4000-8000-000000000001",
  admGcm: "ababab05-0000-4000-8000-000000000002",
};

const POLY = (lng: number, lat: number, d = 0.05) =>
  JSON.stringify({
    type: "Polygon",
    coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]],
  });

const asAdmin = (sql: string) =>
  `set local role authenticated; set local request.jwt.claims='{"sub":"${f.admin}","role":"authenticated"}'; ${sql}; reset role; set local request.jwt.claims=''`;

function asUser(uid: string, sql: string) {
  return `set local role authenticated; set local request.jwt.claims='{"sub":"${uid}","role":"authenticated"}'; ${sql}; reset role; set local request.jwt.claims=''`;
}

async function expectDbError(script: string, token: RegExp | string) {
  let msg = "";
  try {
    await adminExec(script);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
    await adminSql("rollback").catch(() => {});
  }
  expect(msg, `expected a database error matching ${String(token)}`).not.toBe("");
  expect(msg).toMatch(token);
}

function setIdentity(uid: string | null) {
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}

function first<T>(q: { subscribe: (cb: (v: T) => void) => () => void }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      queueMicrotask(unsub);
      resolve(v);
    });
  });
}

async function feed() {
  const data = await first(api.mapFeatures());
  expect(data, "mapFeatures must resolve a payload").toBeDefined();
  return data!;
}
// All suites in one `bun test` process share ONE per-process database, so
// other suites legitimately add sites/incidents of their own. Positive
// assertions therefore run over THIS suite's fixtures (`ids`), while every
// "must be empty / must not leak" assertion stays global (`allIds`, and the
// JSON-contains checks) — scope proof is never weakened by the filter.
const FIXTURE_IDS = new Set<string>([
  f.siteA,
  f.siteB,
  f.incidentA,
  ...Object.values(IDS),
]);
const allIds = (features: MapFeature[], layer: GeoLayer) =>
  features.filter((x) => x.layer === layer).map((x) => x.id).sort();
const ids = (features: MapFeature[], layer: GeoLayer) =>
  allIds(features, layer).filter((id) => FIXTURE_IDS.has(id));
const fixtureBoundarySites = (d: { siteBoundaries: { siteId: string }[] }) =>
  d.siteBoundaries.map((b) => b.siteId).filter((id) => FIXTURE_IDS.has(id)).sort();

beforeAll(async () => {
  await getEdgeDb();
  __testSetSupabaseClient(createEdgeClient());

  // siteA: VERIFIED by an authoritative source (geo.write act as admin);
  // siteB stays unverified. Both have coordinates in the base seed.
  await adminExec(
    asAdmin(`update public.sites set geo_verified = true, geo_source = 'cadastre_2024', geo_accuracy_m = 5
              where id = '${f.siteA}'`),
  );

  await adminExec(`
    insert into public.environmental_observations
      (id, site_id, category, verification, description, observed_at, latitude, longitude, status, reported_by_id)
    values
      ('${IDS.obsA}', '${f.siteA}', 'water_pollution', 'measured', 'turbid water', now(), 6.86, -10.86, 'open', '${f.admin}'),
      ('${IDS.obsB}', '${f.siteB}', 'tailings', 'observed', 'tailings seep', now(), 7.11, -11.11, 'open', '${f.admin}');
    insert into public.incidents (id, site_id, type, severity, description, occurred_at, reported_by_id, report_source)
    values ('${IDS.incB}', '${f.siteB}', 'injury', 'high', 'worker injury', now(), '${f.admin}', 'inspector');
    update public.inspections set latitude = 6.851, longitude = -10.851, gps_accuracy_m = 12 where id = '${IDS.inspA}';
    insert into public.community_reports (id, tracking_code, category, description, county, latitude, longitude, status)
    values
      ('${IDS.repBomi}', 'CR-GIS-BOMI', 'pollution', 'brown water', 'Bomi', 6.9, -10.9, 'submitted'),
      ('${IDS.repGcm}',  'CR-GIS-GCM',  'pollution', 'dust',        'Grand Cape Mount', 7.2, -11.2, 'submitted');
    insert into public.report_tracking (tracking_code, status) values ('CR-GIS-BOMI','submitted'),('CR-GIS-GCM','submitted') on conflict do nothing;
  `);

  await adminExec(
    asAdmin(`
      insert into public.site_boundaries (id, site_id, geometry_geojson, source, geo_verified)
        values ('${IDS.bndA}', '${f.siteA}', '${POLY(-10.9, 6.8)}'::jsonb, 'cadastre_2024', true),
               ('${IDS.bndB}', '${f.siteB}', '${POLY(-11.15, 7.05)}'::jsonb, 'digitised_from_sketch', false);
      insert into public.admin_boundaries (id, name, level, geometry_geojson, source, geo_verified)
        values ('${IDS.admBomi}', 'Bomi', 'county', '${POLY(-11.0, 6.7, 0.5)}'::jsonb, 'cadastre_2024', true),
               ('${IDS.admGcm}', 'Grand Cape Mount', 'county', '${POLY(-11.3, 7.0, 0.5)}'::jsonb, 'digitised_from_sketch', false)`),
  );
});

// ===========================================================================
// GIS-1/2 — SCOPE-FILTERED LAYERS, through the real data layer + RLS
// ===========================================================================
describe("GIS scope filtering (real backend.ts over real Postgres RLS)", () => {
  test("admin sees every layer, nationally", async () => {
    setIdentity(f.admin);
    const d = await feed();
    expect(ids(d.features, "sites")).toEqual([f.siteA, f.siteB].sort());
    expect(ids(d.features, "incidents")).toEqual([f.incidentA, IDS.incB].sort());
    expect(ids(d.features, "observations")).toEqual([IDS.obsA, IDS.obsB].sort());
    expect(ids(d.features, "community_reports")).toEqual([IDS.repBomi, IDS.repGcm].sort());
    expect(ids(d.features, "inspections")).toContain(IDS.inspA);
    expect(fixtureBoundarySites(d)).toEqual([f.siteA, f.siteB].sort());
    expect(d.adminBoundaries.map((b) => b.name).sort()).toEqual(["Bomi", "Grand Cape Mount"]);
    expect(d.features.some((x) => x.layer === "risk_indicators")).toBe(true);
  });

  test("national supervisor sees the same national picture", async () => {
    setIdentity(f.national);
    const d = await feed();
    expect(ids(d.features, "sites")).toEqual([f.siteA, f.siteB].sort());
    expect(ids(d.features, "community_reports")).toEqual([IDS.repBomi, IDS.repGcm].sort());
  });

  test("county inspector (Bomi) sees ONLY Bomi on every layer", async () => {
    setIdentity(f.county);
    const d = await feed();
    expect(ids(d.features, "sites")).toEqual([f.siteA]);
    expect(ids(d.features, "incidents")).toEqual([f.incidentA]);
    expect(ids(d.features, "observations")).toEqual([IDS.obsA]);
    expect(ids(d.features, "community_reports")).toEqual([IDS.repBomi]);
    expect(fixtureBoundarySites(d)).toEqual([f.siteA]);
    for (const x of d.features) {
      if (x.county) expect(x.county).toBe("Bomi");
      expect(x.siteId).not.toBe(f.siteB);
    }
    // nothing from the other county leaks through ANY layer
    const all = JSON.stringify(d);
    for (const other of [f.siteB, IDS.incB, IDS.obsB, IDS.repGcm, IDS.bndB]) {
      expect(all).not.toContain(other);
    }
  });

  test("operator A sees own tenant only; no community reports, no risk layer", async () => {
    setIdentity(f.opA);
    const d = await feed();
    expect(ids(d.features, "sites")).toEqual([f.siteA]);
    expect(ids(d.features, "incidents")).toEqual([f.incidentA]);
    expect(ids(d.features, "observations")).toEqual([IDS.obsA]);
    expect(allIds(d.features, "community_reports")).toEqual([]);
    expect(allIds(d.features, "risk_indicators")).toEqual([]);
    expect(fixtureBoundarySites(d)).toEqual([f.siteA]);
    const all = JSON.stringify(d);
    for (const other of [f.siteB, IDS.incB, IDS.obsB, IDS.repGcm, IDS.repBomi, IDS.bndB]) {
      expect(all).not.toContain(other);
    }
  });

  test("operator B is isolated from operator A symmetrically", async () => {
    setIdentity(f.opB);
    const d = await feed();
    expect(ids(d.features, "sites")).toEqual([f.siteB]);
    expect(ids(d.features, "incidents")).toEqual([IDS.incB]);
    expect(allIds(d.features, "community_reports")).toEqual([]);
    expect(JSON.stringify(d)).not.toContain(f.siteA);
  });

  test("guest / role-less account sees no feature on any layer", async () => {
    setIdentity(f.guest);
    const d = await feed();
    expect(d.features).toEqual([]);
    expect(d.siteBoundaries).toEqual([]);
    expect(d.adminBoundaries).toEqual([]);
  });

  test("community reports are scoped in the DATABASE, not only in the client", async () => {
    // The raw table as the county inspector (what a hostile client could ask).
    const rows = await adminExec(
      asUser(f.county, `select id from public.community_reports order by id`),
    ).catch(() => []);
    void rows;
    const db = await getEdgeDb();
    await db.exec(`begin; set local role authenticated;
      set local request.jwt.claims='{"sub":"${f.county}","role":"authenticated"}';`);
    const res = await db.query<{ id: string }>(`select id from public.community_reports`);
    await db.exec(`rollback`);
    const seen = res.rows.map((r) => r.id);
    expect(seen).toContain(IDS.repBomi);
    expect(seen).not.toContain(IDS.repGcm);
  });
});

// ===========================================================================
// GIS-3 — provenance fields + verification fail-safes (database guards)
// ===========================================================================
describe("geo_verified / geo_source / geo_accuracy_m", () => {
  test("features carry provenance from the row", async () => {
    setIdentity(f.admin);
    const d = await feed();
    const a = d.features.find((x) => x.id === f.siteA)!;
    expect(a.geoVerified).toBe(true);
    expect(a.geoSource).toBe("cadastre_2024");
    expect(a.geoAccuracyM).toBe(5);
    expect(a.verification).toBe("verified");
    const b = d.features.find((x) => x.id === f.siteB)!;
    expect(b.geoVerified).toBe(false);
    expect(b.geoSource).toBe("registry_entry"); // honest backfilled default
    expect(b.verification).toBe("unverified");
    const insp = d.features.find((x) => x.id === IDS.inspA)!;
    expect(insp.geoSource).toBe("device_gps");
    expect(insp.geoAccuracyM).toBe(12);
  });

  test("incidents/risk inherit the site position and never exceed its trust", async () => {
    setIdentity(f.admin);
    const d = await feed();
    const incA = d.features.find((x) => x.id === f.incidentA)!;
    const incB = d.features.find((x) => x.id === IDS.incB)!;
    expect(incA.verification).toBe("verified"); // siteA verified
    expect(incB.verification).toBe("unverified"); // siteB unverified
    expect(incB.geoSource).toBe("site_position");
    const riskB = d.features.find((x) => x.id === `risk:${f.siteB}`);
    if (riskB) expect(riskB.verification).toBe("unverified");
  });

  test("community reports are 'reported' (unvetted) — never verified by default", async () => {
    setIdentity(f.admin);
    const d = await feed();
    for (const r of d.features.filter((x) => x.layer === "community_reports")) {
      expect(r.verification).toBe("reported");
      expect(r.geoSource).toBe("public_report");
    }
  });

  test("a position without a recorded source cannot be verified (CHECK)", async () => {
    await expectDbError(
      asAdmin(`update public.sites set geo_verified = true, geo_source = '  ' where id = '${f.siteB}'`),
      /geo_verified_needs_source/,
    );
  });

  test("only geo.write may verify a position (inspector cannot, on insert or update)", async () => {
    const OBS = "ababab01-0000-4000-8000-0000000000aa";
    // INSERT as the county inspector with a pre-verified position → refused.
    await expectDbError(
      asUser(
        f.county,
        `insert into public.environmental_observations
           (id, site_id, category, verification, description, observed_at, latitude, longitude, reported_by_id, geo_verified, geo_source)
         values ('${OBS}', '${f.siteA}', 'waste', 'observed', 'x', now(), 6.86, -10.86, '${f.county}', true, 'self_declared')`,
      ),
      /geo\.write required to verify a position/,
    );
    // An unverified insert by the same inspector is fine…
    await adminExec(
      asUser(
        f.county,
        `insert into public.environmental_observations
           (id, site_id, category, verification, description, observed_at, latitude, longitude, reported_by_id)
         values ('${OBS}', '${f.siteA}', 'waste', 'observed', 'x', now(), 6.86, -10.86, '${f.county}')`,
      ),
    );
    const [row] = await adminSql(`select geo_verified, geo_source from public.environmental_observations where id = '${OBS}'`);
    expect(row).toEqual({ geo_verified: false, geo_source: "device_gps_or_manual" });
    // …but cannot promote it afterwards.
    await expectDbError(
      asUser(f.county, `update public.environmental_observations set geo_verified = true, geo_source = 'self_declared' where id = '${OBS}'`),
      /geo\.write required to verify a position/,
    );
    // admin (geo.write) can.
    await adminExec(
      asAdmin(`update public.environmental_observations set geo_verified = true, geo_source = 'gnss_survey' where id = '${OBS}'`),
    );
    const [after] = await adminSql(`select geo_verified from public.environmental_observations where id = '${OBS}'`);
    expect(after.geo_verified).toBe(true);
    await adminSql(`delete from public.environmental_observations where id = '${OBS}'`);
  });

  test("an inspector cannot verify a community report's position either", async () => {
    // Blocked (by the triage guard and/or the geo guard) — never succeeds.
    await expectDbError(
      asUser(f.county, `update public.community_reports set geo_verified = true, geo_source = 'self' where id = '${IDS.repBomi}'`),
      /geo\.write required|NOT_REVIEWABLE|row-level|permission/i,
    );
  });

  test("a default source is stamped when a position arrives without one", async () => {
    const rows = await adminSql(
      `insert into public.community_reports (tracking_code, category, description, county, latitude, longitude)
       values ('CR-GIS-DEF', 'pollution', 'x', 'Bomi', 6.8, -10.8)
       returning geo_source, geo_verified`,
    );
    expect(rows[0]).toEqual({ geo_source: "public_report", geo_verified: false });
  });

  test("moving a verified site invalidates its verification", async () => {
    await adminExec(asAdmin(`update public.sites set latitude = 6.8501 where id = '${f.siteA}'`));
    const [row] = await adminSql(`select geo_verified from public.sites where id = '${f.siteA}'`);
    expect(row.geo_verified).toBe(false);
    // restore for the remaining tests
    await adminExec(
      asAdmin(`update public.sites set latitude = 6.85, geo_verified = true, geo_source = 'cadastre_2024' where id = '${f.siteA}'`),
    );
  });

  test("verificationLevel is fail-safe", () => {
    expect(verificationLevel({})).toBe("unverified");
    expect(verificationLevel({ geoVerified: true })).toBe("unverified"); // no source
    expect(verificationLevel({ geoVerified: true, geoSource: "cadastre" })).toBe("verified");
    expect(verificationLevel({ geoVerified: false, geoSource: "public_report" })).toBe("reported");
  });
});

// ===========================================================================
// GIS-1 — boundaries are validated (client mirror == database CHECK)
// ===========================================================================
describe("boundary validation", () => {
  const good = JSON.parse(POLY(-10.5, 6.5));
  const cases: [string, unknown, boolean][] = [
    ["valid polygon", good, true],
    ["valid multipolygon", { type: "MultiPolygon", coordinates: [good.coordinates, JSON.parse(POLY(-9.5, 6.2)).coordinates] }, true],
    ["swapped lat/lng", { type: "Polygon", coordinates: [[[6, -10], [6.1, -10], [6.1, -9.9], [6, -10]]] }, false],
    ["unclosed ring", { type: "Polygon", coordinates: [[[-10, 6], [-10, 7], [-9, 7], [-9, 6]]] }, false],
    ["too few positions", { type: "Polygon", coordinates: [[[-10, 6], [-9, 6], [-10, 6]]] }, false],
    ["outside Liberia", { type: "Polygon", coordinates: [[[3, 6], [3, 7], [4, 7], [3, 6]]] }, false],
    ["a Point", { type: "Point", coordinates: [-10, 6] }, false],
    ["a Feature wrapper", { type: "Feature", geometry: good, properties: {} }, false],
    ["empty object", {}, false],
  ];

  for (const [name, geom, ok] of cases) {
    test(`${name}: client says ${ok}, database CHECK agrees`, async () => {
      expect(validateGeoJsonPolygon(geom).ok).toBe(ok);
      const [r] = await adminSql(
        `select public.mg_valid_geojson_polygon('${JSON.stringify(geom)}'::jsonb) as v`,
      );
      expect(r.v).toBe(ok);
    });
  }

  test("invalid geometry cannot be stored (CHECK on site_boundaries)", async () => {
    await expectDbError(
      asAdmin(`insert into public.site_boundaries (site_id, geometry_geojson, source)
               select id, '{"type":"Point","coordinates":[-10,6]}'::jsonb, 'x' from public.sites limit 1`),
      /geometry_geojson_check|violates check/i,
    );
  });

  test("boundaries need a source", async () => {
    await expectDbError(
      asAdmin(`insert into public.admin_boundaries (name, level, geometry_geojson, source)
               values ('Nimba', 'county', '${POLY(-8.6, 7.4)}'::jsonb, '')`),
      /source_check|violates check/i,
    );
  });

  test("only geo.write may author boundaries; county inspector cannot", async () => {
    await expectDbError(
      asUser(f.county, `insert into public.site_boundaries (site_id, geometry_geojson, source)
                        values ('${f.siteB}', '${POLY(-11.0, 7.0)}'::jsonb, 'x')`),
      /row-level security|permission|policy/i,
    );
  });

  test("no boundary data is seeded by the migration itself (nothing fabricated)", async () => {
    const sql = readFileSync(join(ROOT, "supabase/migrations/0015_gis.sql"), "utf8");
    expect(sql).not.toMatch(/insert\s+into\s+public\.(admin|site)_boundaries/i);
  });

  test("boundary tables grant no DELETE to client roles and nothing to anon (0016)", async () => {
    // Deletes are not audited (SEC-1 records INSERT/UPDATE) and 0009 revoked
    // them platform-wide; boundaries must follow the same posture.
    for (const table of ["admin_boundaries", "site_boundaries"]) {
      const [row] = await adminSql(
        `select has_table_privilege('authenticated', 'public.${table}', 'DELETE') as del,
                has_table_privilege('authenticated', 'public.${table}', 'INSERT') as ins,
                has_table_privilege('authenticated', 'public.${table}', 'UPDATE') as upd,
                has_table_privilege('anon', 'public.${table}', 'SELECT') as anon_sel`,
      );
      expect(row).toEqual({ del: false, ins: true, upd: true, anon_sel: false });
    }
  });

  test("a stored-invalid geometry would be dropped, not drawn", async () => {
    const { parseBoundaryGeometry } = await import("../src/lib/gis");
    expect(parseBoundaryGeometry('{"type":"Point","coordinates":[-10,6]}')).toBeNull();
    expect(parseBoundaryGeometry("not json")).toBeNull();
    expect(parseBoundaryGeometry(POLY(-10, 6))).not.toBeNull();
  });
});

// ===========================================================================
// GIS-1/3 — the admin authoring API (data layer → RLS → audit)
// ===========================================================================
describe("api.gis (admin authoring path)", () => {
  async function expectApiError(fn: () => Promise<unknown>, token: string) {
    let msg = "";
    try {
      await fn();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain(token);
  }

  test("admin saves a validated site boundary; it is audited and then scoped on read", async () => {
    setIdentity(f.admin);
    const saved = await api.gis.saveSiteBoundary({
      siteId: f.siteA,
      geometryGeoJson: POLY(-10.88, 6.82, 0.03),
      source: "gnss_survey_2026",
      accuracyM: 3,
      geoVerified: true,
    });
    expect(saved.siteId).toBe(f.siteA);
    expect(saved.geoVerified).toBe(true);
    // replacing keeps ONE outline per site
    await api.gis.saveSiteBoundary({ siteId: f.siteA, geometryGeoJson: POLY(-10.88, 6.82, 0.04), source: "gnss_survey_2026" });
    const [{ n }] = await adminSql(`select count(*)::int n from public.site_boundaries where site_id = '${f.siteA}'`);
    expect(n).toBe(1);
    const audit = await adminSql(
      `select count(*)::int n from public.audit_log where entity_type = 'site_boundaries' and entity_id = '${saved._id}'`,
    );
    expect((audit[0] as { n: number }).n).toBeGreaterThanOrEqual(2); // insert + update
  });

  test("invalid geometry / missing source are rejected before and by the database", async () => {
    setIdentity(f.admin);
    await expectApiError(
      () => api.gis.saveSiteBoundary({ siteId: f.siteA, geometryGeoJson: '{"type":"Point","coordinates":[-10,6]}', source: "x" }),
      "INVALID_GEOMETRY",
    );
    await expectApiError(
      () => api.gis.saveSiteBoundary({ siteId: f.siteA, geometryGeoJson: POLY(-10.9, 6.8), source: "  " }),
      "INVALID_SOURCE",
    );
    await expectApiError(
      () => api.gis.saveAdminBoundary({ name: "Nowhere", level: "county", geometryGeoJson: JSON.stringify({ type: "Polygon", coordinates: [[[6, -10], [6.1, -10], [6.1, -9.9], [6, -10]]] }), source: "x" }),
      "INVALID_GEOMETRY",
    );
  });

  test("non-admins cannot author boundaries or verify positions (client gate)", async () => {
    for (const uid of [f.county, f.national, f.opA]) {
      setIdentity(uid);
      await expectApiError(
        () => api.gis.saveSiteBoundary({ siteId: f.siteA, geometryGeoJson: POLY(-10.9, 6.8), source: "x" }),
        "FORBIDDEN",
      );
      await expectApiError(
        () => api.gis.setSiteGeoVerification({ siteId: f.siteA, geoVerified: true, source: "x" }),
        "FORBIDDEN",
      );
    }
    setIdentity(f.admin);
  });

  test("verifying a position needs a source; withdrawing verification works", async () => {
    setIdentity(f.admin);
    await expectApiError(
      () => api.gis.setSiteGeoVerification({ siteId: f.siteB, geoVerified: true, source: " " }),
      "INVALID_SOURCE",
    );
    const v = await api.gis.setSiteGeoVerification({ siteId: f.siteB, geoVerified: true, source: "field_survey", accuracyM: 8 });
    expect(v.geoVerified).toBe(true);
    expect(v.geoAccuracyM).toBe(8);
    const d = await feed();
    expect(d.features.find((x) => x.id === f.siteB)!.verification).toBe("verified");
    expect(d.features.find((x) => x.id === IDS.incB)!.verification).toBe("verified"); // inherits
    const w = await api.gis.setSiteGeoVerification({ siteId: f.siteB, geoVerified: false, source: "field_survey" });
    expect(w.geoVerified).toBe(false);
    expect((await feed()).features.find((x) => x.id === IDS.incB)!.verification).toBe("unverified");
  });

  test("a boundary for a site the caller cannot see is NOT_FOUND-masked on read", async () => {
    // county inspector must never receive siteB's outline even though it exists
    setIdentity(f.county);
    const d = await feed();
    expect(d.siteBoundaries.some((b) => b.siteId === f.siteB)).toBe(false);
    setIdentity(f.admin);
  });
});

// ===========================================================================
// GIS-2/4 — styling, legend, clustering, filters (visually distinct unverified)
// ===========================================================================
describe("unverified data is visually distinct", () => {
  const layers = (Object.keys({
    sites: 1, incidents: 1, inspections: 1, observations: 1, community_reports: 1, risk_indicators: 1,
  }) as GeoLayer[]);

  test("every layer: verified / unverified / reported have pairwise different styles", () => {
    for (const l of layers) {
      const v = styleFor(l, "verified");
      const u = styleFor(l, "unverified");
      const r = styleFor(l, "reported");
      expect(v.dashArray).toBeUndefined();
      expect(u.dashArray).toBeDefined();
      expect(r.dashArray).toBeDefined();
      expect(u.dashArray).not.toBe(r.dashArray);
      expect(v.fillOpacity).toBeGreaterThan(u.fillOpacity);
      expect(u.fillOpacity).toBeGreaterThan(r.fillOpacity);
      const svgs = [symbolSvg(v), symbolSvg(u), symbolSvg(r)];
      expect(new Set(svgs).size).toBe(3);
    }
  });

  test("boundaries: unverified outline is dashed + fainter than verified", () => {
    const v = boundaryStyle("site_boundaries", true);
    const u = boundaryStyle("site_boundaries", false);
    expect("dashArray" in v).toBe(false);
    expect("dashArray" in u).toBe(true);
    expect(v.fillOpacity).toBeGreaterThan(u.fillOpacity);
  });

  const mk = (id: string, layer: GeoLayer, level: MapFeature["verification"], lat = 6.5, lng = -9.5, county = "Bomi"): MapFeature => ({
    id, layer, label: id, lat, lng, county, verification: level, geoVerified: level === "verified",
  });

  test("legend lists only what the loaded, visible data contains", () => {
    const features = [mk("s1", "sites", "verified"), mk("s2", "sites", "unverified"), mk("s3", "sites", "unverified"), mk("r1", "community_reports", "reported")];
    const vis = { sites: true, community_reports: true, incidents: true } as Partial<Record<GeoLayer, boolean>>;
    const legend = buildLegend(MAP_LAYER_CONFIGS, features, { admin: [], site: [] }, vis);
    const keys = legend.map((e) => `${e.layer}:${e.level}:${e.count}`);
    expect(keys).toEqual(["sites:verified:1", "sites:unverified:2", "community_reports:reported:1"]);
    // layers without data (incidents) and hidden layers are NOT in the legend
    expect(legend.some((e) => e.layer === "incidents")).toBe(false);
    // swatch style == map style for the same (layer, level)
    for (const e of legend) expect(e.style).toEqual(styleFor(e.layer, e.level as never));
  });

  test("legend follows toggles and filters", () => {
    const features = [mk("s1", "sites", "verified"), mk("s2", "sites", "unverified")];
    const onlyUnverified = applyFilters(features, { ...NO_FILTERS, levels: ["unverified"] });
    const legend = buildLegend(MAP_LAYER_CONFIGS, onlyUnverified, { admin: [], site: [] }, { sites: true });
    expect(legend.map((e) => e.level)).toEqual(["unverified"]);
    expect(buildLegend(MAP_LAYER_CONFIGS, features, { admin: [], site: [] }, { sites: false })).toEqual([]);
  });

  test("boundary legend entries come from real boundary rows", () => {
    const b = (id: string, v: boolean) => ({ _id: id, siteId: id, geometryGeoJson: "{}", source: "s", geoVerified: v, createdAt: 0 });
    const legend = buildLegend(MAP_LAYER_CONFIGS, [], { admin: [], site: [b("a", true), b("b", false), b("c", false)] }, { site_boundaries: true });
    expect(legend.map((e) => `${e.note}:${e.count}`)).toEqual(["verified boundary:1", "unverified boundary:2"]);
  });

  test("filters: county + verification + text", () => {
    const features = [
      mk("alpha", "sites", "verified", 6.5, -9.5, "Bomi"),
      mk("beta", "sites", "unverified", 6.6, -9.6, "Bomi"),
      mk("gamma", "sites", "unverified", 7.0, -8.5, "Nimba"),
    ];
    expect(applyFilters(features, { counties: ["Nimba"], levels: [], text: "" }).map((x) => x.id)).toEqual(["gamma"]);
    expect(applyFilters(features, { counties: [], levels: ["unverified"], text: "bet" }).map((x) => x.id)).toEqual(["beta"]);
    expect(applyFilters(features, NO_FILTERS)).toHaveLength(3);
  });

  test("clustering never launders unverified points into a verified cluster", () => {
    const pts = [
      mk("a", "sites", "verified", 6.5, -9.5),
      mk("b", "sites", "verified", 6.5001, -9.5001),
      mk("c", "sites", "unverified", 6.5002, -9.5002),
    ];
    const out = clusterPoints(pts, 7, true);
    expect(out).toHaveLength(1);
    expect(out[0].cluster).toBe(true);
    expect(out[0].count).toBe(3);
    expect(out[0].level).toBe("unverified"); // worst member wins
    expect(out[0].byLevel).toEqual({ verified: 2, unverified: 1, reported: 0 });
    // an all-verified cluster stays verified
    expect(clusterPoints(pts.slice(0, 2).concat(mk("d", "sites", "verified", 6.5003, -9.5003)), 7)[0].level).toBe("verified");
  });

  test("clustering never merges features of different layers (a cluster is styled as one layer)", () => {
    const pts = [
      mk("s1", "sites", "verified", 6.5, -9.5),
      mk("s2", "sites", "verified", 6.5001, -9.5001),
      mk("i1", "incidents", "verified", 6.5002, -9.5002),
      mk("i2", "incidents", "verified", 6.5003, -9.5003),
      mk("i3", "incidents", "verified", 6.5004, -9.5004),
    ];
    const out = clusterPoints(pts, 7, true);
    // 3 incidents form ONE incidents cluster; the 2 sites stay individual
    // (below the 3-member minimum) instead of joining the incidents cluster.
    expect(out.filter((o) => o.cluster)).toHaveLength(1);
    expect(out.find((o) => o.cluster)?.feature.layer).toBe("incidents");
    expect(out.find((o) => o.cluster)?.memberIds.sort()).toEqual(["i1", "i2", "i3"]);
    expect(out.filter((o) => !o.cluster).map((o) => o.feature.id).sort()).toEqual(["s1", "s2"]);
  });

  test("clustering: zoom-aware, off when disabled, individual points when zoomed in", () => {
    const pts = Array.from({ length: 5 }, (_, i) => mk(`p${i}`, "sites", "verified", 6.5 + i * 0.0001, -9.5));
    expect(clusterPoints(pts, 7)).toHaveLength(1);
    expect(clusterPoints(pts, 7, false)).toHaveLength(5);
    expect(clusterPoints(pts, 14)).toHaveLength(5);
    // two points never form a cluster (min 3)
    expect(clusterPoints(pts.slice(0, 2), 7)).toHaveLength(2);
  });

  test("map defaults: Liberia is WEST of the prime meridian", () => {
    expect(LIBERIA_CENTER[1]).toBeLessThan(0);
    expect(inLiberia(LIBERIA_CENTER[0], LIBERIA_CENTER[1])).toBe(true);
    expect(inLiberia(6.9, 9.3)).toBe(false); // the pre-Session-6 constant
  });

  test("the page renders markers and legend from the single shared renderer", () => {
    const src = readFileSync(join(ROOT, "src/pages/NationalMap.tsx"), "utf8");
    expect(src).toContain("symbolSvg(e.style");
    expect(src).toContain("symbolSvg(style, size");
    expect(src).toContain("buildLegend(");
    expect(src).toContain("clusterPoints(");
    expect(src).not.toMatch(/LAYER_PALETTE/);
  });
});

// ===========================================================================
// Why a map can be EMPTY: unusable coordinates (the sign of a longitude)
// ===========================================================================
describe("site coordinates: nothing silently unmappable", () => {
  const SITE_BAD = "ababab06-0000-4000-8000-000000000001";
  const SITE_DEMO = "ababab06-0000-4000-8000-000000000002";
  const SITE_REAL = "ababab06-0000-4000-8000-000000000003";
  const DEMO_NOTE = "Synthetic demonstration record — not real operational data.";
  const insertSite = (id: string, code: string, name: string, lng: number, notes: string | null) =>
    adminSql(
      `insert into public.sites (id, code, name, operator_name, county, status, latitude, longitude, notes, created_by)
       values ('${id}', '${code}', '${name}', 'Test Op', 'Bomi', 'active', 6.8, ${lng}, ${notes ? `'${notes}'` : "null"}, '${f.admin}')`,
    );
  // Sites are never deleted by the app (a guard trigger enforces it), so test
  // teardown skips row triggers for the duration — the shared per-process DB
  // must not keep these probe sites for other suites.
  const dropSites = (...ids: string[]) =>
    adminExec(
      `set session_replication_role = replica;
       delete from public.sites where id in (${ids.map((i) => `'${i}'`).join(", ")});
       set session_replication_role = origin;`,
    );
  const cleanup = () => dropSites(SITE_BAD, SITE_DEMO, SITE_REAL);
  async function expectApiRejects(fn: () => Promise<unknown>, ...tokens: string[]) {
    let msg = "";
    try {
      await fn();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg, "expected the call to be rejected").not.toBe("");
    for (const t of tokens) expect(msg).toContain(t);
  }

  test("every seeded demo site sits inside Liberia (positive longitudes were Nigeria)", async () => {
    const { DEMO_SITE_DEFS } = await import("../src/lib/backend");
    expect(DEMO_SITE_DEFS.length).toBeGreaterThan(0);
    for (const d of DEMO_SITE_DEFS) {
      expect(inLiberia(d.lat, d.lng), `${d.name} (${d.lat}, ${d.lng})`).toBe(true);
    }
  });

  test("registering a site with a longitude missing its minus sign is refused, with a fix hint", async () => {
    setIdentity(f.admin);
    const base = { name: "Coord Probe", operatorName: "Probe Op", county: "Bomi" };
    await expectApiRejects(
      () => api.sites.create({ ...base, latitude: 6.43, longitude: 9.43 }),
      "INVALID_LONGITUDE",
      "did you mean -9.43",
    );
    await expectApiRejects(
      () => api.sites.create({ ...base, latitude: 60, longitude: -9.43 }),
      "INVALID_LATITUDE",
    );
    // editing an existing site is held to the same rule
    await expectApiRejects(
      () => api.sites.update({ siteId: f.siteA, longitude: 9.43 }),
      "INVALID_LONGITUDE",
    );
  });

  test("a correctly signed site is accepted and appears on the map as unverified", async () => {
    setIdentity(f.admin);
    const id = await api.sites.create({
      name: "Coord Probe OK",
      operatorName: "Probe Op",
      county: "Bomi",
      latitude: 6.43,
      longitude: -9.43,
    });
    try {
      const d = await feed();
      const mapped = d.features.find((x) => x.id === id);
      expect(mapped?.layer).toBe("sites");
      expect(mapped?.verification).toBe("unverified");
    } finally {
      await dropSites(id);
    }
  });

  test("a site that already has unusable coordinates is NOT plotted but IS counted for the user", async () => {
    await insertSite(SITE_BAD, "MGL-BOM-9901", "Positive Longitude Probe", 9.43, null);
    try {
      setIdentity(f.admin);
      const d = await feed();
      expect(d.features.find((x) => x.id === SITE_BAD)).toBeUndefined(); // never plotted in Nigeria
      expect(d.excluded.sites ?? 0).toBeGreaterThanOrEqual(1); // …but the page can say so
    } finally {
      await cleanup();
    }
  });

  test("migration 0017 repairs ONLY labelled demo rows (real data is never touched)", async () => {
    await insertSite(SITE_DEMO, "MGL-BOM-9902", "Demo Probe — Zorzor", 9.4236, DEMO_NOTE);
    await insertSite(SITE_REAL, "MGL-BOM-9903", "Real Operator Site", 9.4236, null);
    try {
      const sql = readFileSync(join(ROOT, "supabase/migrations/0017_fix_demo_site_longitudes.sql"), "utf8");
      await adminExec(sql);
      await adminExec(sql); // idempotent
      const rows = await adminSql(
        `select id, longitude from public.sites where id in ('${SITE_DEMO}', '${SITE_REAL}') order by id`,
      );
      expect(rows).toEqual([
        { id: SITE_DEMO, longitude: -9.4236 },
        { id: SITE_REAL, longitude: 9.4236 },
      ]);
    } finally {
      await cleanup();
    }
  });
});

// ===========================================================================
// Capturing a real position (GPS / map pick / typed) — API contract
// ===========================================================================
describe("site position capture and provenance", () => {
  const created: string[] = [];
  const dropSites = (...ids: string[]) =>
    adminExec(
      `set session_replication_role = replica;
       delete from public.sites where id in (${ids.map((i) => `'${i}'`).join(", ")});
       set session_replication_role = origin;`,
    );
  afterAll(async () => {
    if (created.length) await dropSites(...created);
  });
  const mkSite = async (extra: Record<string, unknown> = {}) => {
    setIdentity(f.admin);
    const id = await api.sites.create({
      name: `Position Probe ${created.length}`,
      operatorName: "Probe Op",
      county: "Bomi",
      ...extra,
    });
    created.push(id);
    return id;
  };
  const geoRow = async (id: string) =>
    (
      await adminSql(
        `select latitude, longitude, geo_source, geo_accuracy_m, geo_verified from public.sites where id = '${id}'`,
      )
    )[0];
  async function rejects(fn: () => Promise<unknown>, ...tokens: string[]) {
    let msg = "";
    try {
      await fn();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg, "expected a rejection").not.toBe("");
    for (const t of tokens) expect(msg).toContain(t);
  }

  test("a GPS-captured site stores its source and accuracy, stays unverified, and shows its provenance on the map", async () => {
    const id = await mkSite({ latitude: 6.31, longitude: -10.8, geoSource: "device_gps", geoAccuracyM: 8.5 });
    expect(await geoRow(id)).toMatchObject({
      geo_source: "device_gps",
      geo_accuracy_m: 8.5,
      geo_verified: false,
    });
    const mapped = (await feed()).features.find((x) => x.id === id);
    expect(mapped?.verification).toBe("unverified");
    expect(mapped?.geoSource).toBe("device_gps");
    expect(mapped?.geoAccuracyM).toBe(8.5);
  });

  test("a position typed with no source is recorded honestly as manual entry", async () => {
    const id = await mkSite({ latitude: 6.4, longitude: -10.7 });
    expect(await geoRow(id)).toMatchObject({ geo_source: "manual_entry", geo_accuracy_m: null });
  });

  test("a site with no position has no provenance either", async () => {
    const id = await mkSite();
    expect(await geoRow(id)).toMatchObject({ latitude: null, geo_source: null, geo_accuracy_m: null });
  });

  test("a position is a PAIR; bad source and negative accuracy are refused", async () => {
    setIdentity(f.admin);
    const base = { name: "Pair Probe", operatorName: "Probe Op", county: "Bomi" };
    await rejects(() => api.sites.create({ ...base, latitude: 6.4 }), "INVALID_POSITION");
    await rejects(() => api.sites.create({ ...base, longitude: -10.7 }), "INVALID_POSITION");
    await rejects(
      () => api.sites.create({ ...base, latitude: 6.4, longitude: -10.7, geoSource: "satellite" as never }),
      "INVALID_SOURCE",
    );
    await rejects(
      () => api.sites.create({ ...base, latitude: 6.4, longitude: -10.7, geoAccuracyM: -1 }),
      "INVALID_ACCURACY",
    );
    const id = await mkSite({ latitude: 6.4, longitude: -10.7 });
    await rejects(() => api.sites.update({ siteId: id, latitude: null }), "INVALID_POSITION");
    await rejects(() => api.sites.update({ siteId: id, geoAccuracyM: Number.NaN }), "INVALID_ACCURACY");
  });

  test("an EXISTING site gets its position set later (the registered-without-coordinates case)", async () => {
    const id = await mkSite();
    setIdentity(f.admin);
    await api.sites.update({ siteId: id, latitude: 6.55, longitude: -10.55, geoSource: "map_pick" });
    expect(await geoRow(id)).toMatchObject({ latitude: 6.55, longitude: -10.55, geo_source: "map_pick" });
    expect((await feed()).features.some((x) => x.id === id)).toBe(true);
  });

  test("moving a point replaces its provenance and withdraws an earlier verification", async () => {
    const id = await mkSite({ latitude: 6.3, longitude: -10.9, geoSource: "device_gps", geoAccuracyM: 5 });
    setIdentity(f.admin);
    await api.gis.setSiteGeoVerification({ siteId: id, geoVerified: true, source: "survey 2026-10", accuracyM: 3 });
    expect((await geoRow(id)).geo_verified).toBe(true);

    await api.sites.update({ siteId: id, latitude: 6.35, longitude: -10.85, geoSource: "map_pick" });
    expect(await geoRow(id)).toMatchObject({
      latitude: 6.35,
      geo_source: "map_pick",
      geo_accuracy_m: null, // the old GPS accuracy described the OLD place
      geo_verified: false,
    });
  });

  test("editing something else never touches the position's provenance", async () => {
    const id = await mkSite({ latitude: 6.3, longitude: -10.9, geoSource: "device_gps", geoAccuracyM: 5 });
    setIdentity(f.admin);
    await api.sites.update({ siteId: id, notes: "Reviewed" });
    expect(await geoRow(id)).toMatchObject({ geo_source: "device_gps", geo_accuracy_m: 5 });
  });

  test("clearing the position clears its provenance; the map then counts the site as unmapped", async () => {
    const id = await mkSite({ latitude: 6.3, longitude: -10.9, geoSource: "device_gps", geoAccuracyM: 5 });
    setIdentity(f.admin);
    await api.sites.update({ siteId: id, latitude: null, longitude: null });
    expect(await geoRow(id)).toMatchObject({ latitude: null, longitude: null, geo_source: null, geo_accuracy_m: null });
    const d = await feed();
    expect(d.features.some((x) => x.id === id)).toBe(false);
    expect(d.excluded.sites ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("only an administrator can set a site's position", async () => {
    const id = await mkSite({ latitude: 6.3, longitude: -10.9 });
    setIdentity(f.county); // county inspector
    await rejects(() => api.sites.update({ siteId: id, latitude: 6.4, longitude: -10.8 }), "FORBIDDEN");
    setIdentity(f.opA); // operator
    await rejects(() => api.sites.update({ siteId: id, latitude: 6.4, longitude: -10.8 }), "FORBIDDEN");
    expect(await geoRow(id)).toMatchObject({ latitude: 6.3, longitude: -10.9 });
  });
});

describe("loading boundaries: replace in place", () => {
  test("saveAdminBoundary with an id REPLACES the geometry — no duplicate row, provenance updated", async () => {
    setIdentity(f.admin);
    const first = await api.gis.saveAdminBoundary({
      name: "Replace Probe County",
      level: "county",
      geometryGeoJson: POLY(-10.2, 6.2),
      source: "first upload",
    });
    const second = await api.gis.saveAdminBoundary({
      id: first._id,
      name: "Replace Probe County",
      level: "county",
      geometryGeoJson: POLY(-10.3, 6.3),
      source: "corrected upload",
      accuracyM: 25,
    });
    expect(second._id).toBe(first._id);
    const rows = await adminSql(`select source, accuracy_m, geometry_geojson from public.admin_boundaries where name = 'Replace Probe County'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "corrected upload", accuracy_m: 25 });
    expect(JSON.stringify(rows[0].geometry_geojson)).toContain("-10.3");
  });

  test("replacing an unknown boundary id fails with NOT_FOUND instead of silently doing nothing", async () => {
    setIdentity(f.admin);
    let msg = "";
    try {
      await api.gis.saveAdminBoundary({
        id: "ababab06-0000-4000-8000-0000000000ff",
        name: "Ghost",
        level: "county",
        geometryGeoJson: POLY(-10.2, 6.2),
        source: "x",
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("NOT_FOUND");
  });
});

// ===========================================================================
// The map must reflect YOUR OWN edits without waiting for realtime
// ===========================================================================
describe("live queries refresh after this client's own writes", () => {
  const created: string[] = [];
  const dropSites = (...ids: string[]) =>
    adminExec(
      `set session_replication_role = replica;
       delete from public.sites where id in (${ids.map((i) => `'${i}'`).join(", ")});
       set session_replication_role = origin;`,
    );
  afterAll(async () => {
    if (created.length) await dropSites(...created);
  });

  /** Subscribe like a page does; resolves with the first payload satisfying
   *  `ok`, failing the test if none arrives in time. No realtime exists in this
   *  harness, so only the local-write signal can deliver the update. */
  function untilPayload<T>(
    handle: { subscribe: (cb: (v: T | undefined) => void) => () => void },
    ok: (v: T) => boolean,
    ms = 4000,
  ) {
    let unsub = () => {};
    const done = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no matching update within ${ms} ms`)), ms);
      unsub = handle.subscribe((v) => {
        if (v !== undefined && ok(v)) {
          clearTimeout(timer);
          resolve(v);
        }
      });
    });
    return { done, stop: () => unsub() };
  }

  async function newSite() {
    setIdentity(f.admin);
    const id = await api.sites.create({ name: "Refresh Probe", operatorName: "Probe Op", county: "Bomi" });
    created.push(id);
    return id;
  }

  test("a site given a position appears on an ALREADY-OPEN map, then shows as verified", async () => {
    const id = await newSite();
    const map = api.mapFeatures();
    const first = untilPayload(map, () => true);
    const initial = await first.done;
    expect(initial.features.some((x) => x.id === id)).toBe(false); // not on the map yet
    first.stop();

    // Keep ONE subscription open across the edits — the page, not a new fetch.
    let latest = initial;
    const stop = map.subscribe((v) => {
      if (v) latest = v;
    });
    const wait = async (ok: (v: typeof initial) => boolean) => {
      const t0 = Date.now();
      while (!ok(latest)) {
        if (Date.now() - t0 > 4000) throw new Error("the open map never refreshed");
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      await api.sites.update({ siteId: id, latitude: 6.5, longitude: -10.7, geoSource: "device_gps", geoAccuracyM: 6 });
      await wait((v) => v.features.some((x) => x.id === id));
      expect(latest.features.find((x) => x.id === id)?.verification).toBe("unverified");

      await api.gis.setSiteGeoVerification({ siteId: id, geoVerified: true, source: "surveyed with a GPS receiver", accuracyM: 2 });
      await wait((v) => v.features.find((x) => x.id === id)?.verification === "verified");

      await api.gis.saveSiteBoundary({ siteId: id, geometryGeoJson: POLY(-10.7, 6.5, 0.01), source: "survey" });
      await wait((v) => v.siteBoundaries.some((b) => b.siteId === id));

      const adminB = await api.gis.saveAdminBoundary({ name: "Refresh Probe Area", level: "district", geometryGeoJson: POLY(-10.8, 6.4), source: "x" });
      await wait((v) => v.adminBoundaries.some((b) => b._id === adminB._id));
    } finally {
      stop();
    }
  });

  test("an open site page (a different live query) refreshes after the position is saved", async () => {
    const id = await newSite();
    const page = api.sites.get({ siteId: id });
    let latest: { latitude?: number | null; geoVerified?: boolean } | null | undefined;
    const stop = page.subscribe((v) => {
      latest = v;
    });
    try {
      await untilPayload(page, (v) => v !== null && v.latitude == null).done;
      await api.sites.update({ siteId: id, latitude: 6.6, longitude: -10.6 });
      const t0 = Date.now();
      while (latest?.latitude !== 6.6) {
        if (Date.now() - t0 > 4000) throw new Error("the open site page never refreshed");
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      stop();
    }
  });

  test("the Refresh button re-reads data changed OUTSIDE this client (another person's edit)", async () => {
    const id = await newSite();
    const map = api.mapFeatures();
    let latest: Awaited<ReturnType<typeof feed>> | undefined;
    const stop = map.subscribe((v) => {
      if (v) latest = v;
    });
    try {
      const t0 = Date.now();
      while (!latest) {
        if (Date.now() - t0 > 4000) throw new Error("map never loaded");
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(latest.features.some((x) => x.id === id)).toBe(false);
      // Somebody else (or a script) sets the position directly in the database:
      await adminSql(`update public.sites set latitude = 6.7, longitude = -10.5 where id = '${id}'`);
      refreshMapFeatures();
      const t1 = Date.now();
      while (!latest.features.some((x) => x.id === id)) {
        if (Date.now() - t1 > 4000) throw new Error("Refresh did not re-read the map");
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      stop();
    }
  });

  test("unsubscribing detaches the listener (a closed page must not keep re-fetching)", async () => {
    const id = await newSite();
    let calls = 0;
    const stop = api.sites.get({ siteId: id }).subscribe(() => {
      calls++;
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    const before = calls;
    await api.sites.update({ siteId: id, notes: "after close" });
    await new Promise((r) => setTimeout(r, 700)); // longer than the 300 ms debounce
    expect(calls).toBe(before);
  });

  test("boundary tables are published to Realtime (0018), so other people's loads refresh an open map", async () => {
    const rows = await adminSql(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('admin_boundaries', 'site_boundaries') order by 1`,
    );
    expect(rows.map((r) => r.tablename)).toEqual(["admin_boundaries", "site_boundaries"]);
  });
});

// ===========================================================================
// Official boundaries seed — the REAL geoBoundaries data through the real DB
// ===========================================================================
describe("official county/district boundaries seed", () => {
  const SEED = readFileSync(join(ROOT, "supabase/seeds/liberia_boundaries_geoboundaries.sql"), "utf8");
  const wipe = () =>
    adminSql(
      `delete from public.admin_boundaries where source like '${ATTRIBUTION}%' or source = 'manual load (seed test)'`,
    );
  // The shared per-process DB already holds other suites' boundary fixtures
  // (e.g. a county called "Bomi"), which the seed — correctly — leaves alone.
  // Set them aside for this block so the counts below are exact, and restore
  // them afterwards so no other test notices.
  let stash = "[]";
  beforeAll(async () => {
    const [row] = (await adminSql(
      `select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb)::text as j from public.admin_boundaries b`,
    )) as Array<{ j: string }>;
    stash = row.j;
    await adminSql(`delete from public.admin_boundaries`);
  });
  const seeded = async () =>
    (await adminSql(
      `select level, count(*)::int as n from public.admin_boundaries where source like '${ATTRIBUTION}%' group by level order by level`,
    )) as Array<{ level: string; n: number }>;
  afterAll(async () => {
    await adminSql(`delete from public.admin_boundaries`);
    await adminSql(
      `insert into public.admin_boundaries
         select * from jsonb_populate_recordset(null::public.admin_boundaries, $stash$${stash}$stash$::jsonb)`,
    );
  });

  test("applies: 15 counties + 136 districts pass the database's own geometry CHECK, loaded UNVERIFIED with attribution", async () => {
    await wipe();
    await adminExec(SEED);
    expect(await seeded()).toEqual([
      { level: "county", n: 15 },
      { level: "district", n: 136 },
    ]);
    const [flags] = (await adminSql(
      `select count(*) filter (where geo_verified)::int as verified,
              count(*) filter (where created_by is not null)::int as authored
         from public.admin_boundaries where source like '${ATTRIBUTION}%'`,
    )) as Array<{ verified: number; authored: number }>;
    expect(flags).toEqual({ verified: 0, authored: 0 });
  });

  test("re-running the seed is a no-op (nothing duplicated, nothing changed)", async () => {
    await adminExec(SEED);
    await adminExec(SEED);
    expect(await seeded()).toEqual([
      { level: "county", n: 15 },
      { level: "district", n: 136 },
    ]);
  });

  test("the National map feed carries them, with their source, for everyone entitled to read boundaries", async () => {
    setIdentity(f.admin);
    const admin = await feed();
    const official = admin.adminBoundaries.filter((b) => b.source.startsWith(ATTRIBUTION));
    expect(official.filter((b) => b.level === "county")).toHaveLength(15);
    expect(official.filter((b) => b.level === "district")).toHaveLength(136);
    expect(official.every((b) => b.geoVerified === false)).toBe(true);

    setIdentity(f.county); // staff inspector
    expect((await feed()).adminBoundaries.filter((b) => b.source.startsWith(ATTRIBUTION))).toHaveLength(151);
    setIdentity(f.opA); // operator: reference geography is readable
    expect((await feed()).adminBoundaries.filter((b) => b.source.startsWith(ATTRIBUTION))).toHaveLength(151);
    setIdentity(f.guest);
    expect((await feed()).adminBoundaries).toEqual([]);
  });

  test("a boundary an administrator already loaded by hand is left alone — never duplicated or overwritten", async () => {
    await wipe();
    await adminSql(
      `insert into public.admin_boundaries (name, level, geometry_geojson, source)
       values ('BOMI', 'county', '${POLY(-10.8, 6.5)}'::jsonb, 'manual load (seed test)')`,
    );
    await adminExec(SEED);
    const bomi = await adminSql(
      `select source from public.admin_boundaries where level = 'county' and lower(name) = 'bomi'`,
    );
    expect(bomi).toEqual([{ source: "manual load (seed test)" }]); // theirs, untouched, only one
    expect(await seeded()).toEqual([
      { level: "county", n: 14 }, // every county except the one already there
      { level: "district", n: 136 },
    ]);
  });

  test("on a database without the boundary tables the seed stops with a plain explanation", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    let msg = "";
    try {
      await db.exec(SEED);
    } catch (e) {
      msg = (e as { message?: string }).message ?? "";
    }
    expect(msg).toContain("Boundary seed cannot run");
    await db.close();
  });
});

// ===========================================================================
// GIS-5 — offline tile strategy (within provider policy)
// ===========================================================================
describe("offline tile strategy", () => {
  test("region/zoom window: Monrovia tiles cache; the Atlantic, Europe and other zooms do not", () => {
    const z = 10;
    const x = lngToTileX(-10.8, z);
    const y = latToTileY(6.3, z);
    expect(tileInRegion(z, x, y)).toBe(true);
    expect(tileInRegion(z, lngToTileX(2.35, z), latToTileY(48.85, z))).toBe(false); // Paris
    expect(tileInRegion(z, lngToTileX(-30, z), latToTileY(0, z))).toBe(false); // mid-Atlantic
    expect(tileInRegion(TILE_MIN_ZOOM - 1, 0, 0)).toBe(false);
    expect(tileInRegion(TILE_MAX_ZOOM + 1, lngToTileX(-10.8, 15), latToTileY(6.3, 15))).toBe(false);
  });

  test("shouldCacheTile only accepts in-region tile URLs", () => {
    const z = 9;
    const ok = `https://tile.openstreetmap.org/${z}/${lngToTileX(-9.4, z)}/${latToTileY(6.4, z)}.png`;
    expect(shouldCacheTile(ok)).toBe(true);
    expect(shouldCacheTile(`https://tile.openstreetmap.org/${z}/0/0.png`)).toBe(false);
    expect(shouldCacheTile("https://example.com/not-a-tile")).toBe(false);
    expect(parseTilePath("/9/1/2.png")).toEqual({ z: 9, x: 1, y: 2 });
  });

  test("public/sw.js carries the SAME policy numbers as src/lib/map-tiles.ts", () => {
    const sw = readFileSync(join(ROOT, "public/sw.js"), "utf8");
    expect(sw).toContain(`const TILE_CACHE = "${TILE_CACHE_NAME}"`);
    expect(sw).toContain(`TILE_CACHE_MAX_ENTRIES = ${TILE_CACHE_MAX_ENTRIES}`);
    expect(sw).toContain(`TILE_MIN_ZOOM = ${TILE_MIN_ZOOM}`);
    expect(sw).toContain(`TILE_MAX_ZOOM = ${TILE_MAX_ZOOM}`);
    expect(sw).toContain(
      `TILE_BBOX = { minLng: ${LIBERIA_BBOX.minLng}, maxLng: ${LIBERIA_BBOX.maxLng}, minLat: ${LIBERIA_BBOX.minLat}, maxLat: ${LIBERIA_BBOX.maxLat} }`,
    );
  });

  test("policy: the worker never prefetches tiles and survives shell upgrades", () => {
    const sw = readFileSync(join(ROOT, "public/sw.js"), "utf8");
    // The only tile network call is the response to a request the map made.
    const tileFn = sw.slice(sw.indexOf("async function tileResponse"), sw.indexOf("const PRECACHE"));
    expect(tileFn).toContain("fetch(req)");
    expect(tileFn.match(/fetch\(/g)?.length).toBe(1);
    expect(tileFn).not.toMatch(/addAll|cache\.add\(|for \(|while \(|\.map\(/);
    // tile cache name must not be swept by the shell-version cleanup
    expect(TILE_CACHE_NAME.startsWith("mineguard-")).toBe(false);
    expect(sw).toContain('k.startsWith("mineguard-") && k !== CACHE');
  });

  test("the page uses the configurable tile template + documents the alternative", () => {
    const src = readFileSync(join(ROOT, "src/pages/NationalMap.tsx"), "utf8");
    expect(src).toContain("tileTemplate()");
    const doc = readFileSync(join(ROOT, "docs/06_GIS_ARCHITECTURE.MD"), "utf8");
    expect(doc).toMatch(/Offline tiles/);
    expect(doc).toMatch(/VITE_TILE_URL/);
  });
});
