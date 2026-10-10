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

import { beforeAll, describe, expect, test } from "bun:test";
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
