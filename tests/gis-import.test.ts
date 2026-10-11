// ---------------------------------------------------------------------------
// Boundary import: the parser must give an administrator a reviewable, honest
// list — valid shapes ready to load, invalid ones with a reason they can act
// on — and must never repair, guess or fuzzy-match anything.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_CANDIDATES,
  findExistingAdminBoundary,
  matchSiteForCandidate,
  parseBoundaryGeoJson,
} from "../src/lib/gis-import";
import { validateGeoJsonPolygon } from "../src/lib/gis";

const ring = (lng: number, lat: number, d = 0.1) => [
  [lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat],
];
const polygon = (lng = -9.5, lat = 6.5) => ({ type: "Polygon", coordinates: [ring(lng, lat)] });
const feature = (geometry: unknown, properties: unknown = {}) => ({ type: "Feature", geometry, properties });
const fc = (...features: unknown[]) => ({ type: "FeatureCollection", features });
const parse = (doc: unknown) => parseBoundaryGeoJson(JSON.stringify(doc));

describe("parseBoundaryGeoJson — inputs", () => {
  test("empty input is simply empty, not an error", () => {
    expect(parseBoundaryGeoJson("   ")).toEqual({ candidates: [] });
  });

  test("text that is not JSON is rejected with advice", () => {
    const r = parseBoundaryGeoJson("<kml>not json</kml>");
    expect(r.candidates).toEqual([]);
    expect(r.fatal).toContain("not valid JSON");
  });

  test("TopoJSON and unrelated GeoJSON types are rejected as a whole", () => {
    expect(parse({ type: "Topology", objects: {} }).fatal).toContain("TopoJSON");
    expect(parse({ type: "Point", coordinates: [-9, 6] }).fatal).toContain("FeatureCollection");
    expect(parse([1, 2]).fatal).toBeDefined();
  });

  test("oversized input and over-long collections are refused up front", () => {
    expect(parseBoundaryGeoJson(" ".repeat(10) + "x".repeat(MAX_IMPORT_BYTES + 1)).fatal).toContain("larger than");
    const many = fc(...Array.from({ length: MAX_IMPORT_CANDIDATES + 1 }, () => feature(polygon())));
    expect(parse(many).fatal).toContain(`at most ${MAX_IMPORT_CANDIDATES}`);
  });
});

describe("parseBoundaryGeoJson — shapes", () => {
  test("a bare Polygon is one valid candidate in canonical form", () => {
    const r = parse(polygon());
    expect(r.fatal).toBeUndefined();
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.problem).toBeUndefined();
    expect(c.geometryType).toBe("Polygon");
    expect(c.parts).toBe(1);
    expect(c.vertices).toBe(5);
    expect(validateGeoJsonPolygon(c.geometryGeoJson).ok).toBe(true);
  });

  test("canonical form drops bbox/crs/foreign members and altitude — nothing else changes", () => {
    const messy = {
      type: "Polygon",
      bbox: [-9.5, 6.5, -9.4, 6.6],
      crs: { type: "name" },
      coordinates: [ring(-9.5, 6.5).map(([x, y]) => [x, y, 120])],
    };
    const c = parse(messy).candidates[0];
    expect(c.problem).toBeUndefined();
    expect(JSON.parse(c.geometryGeoJson as string)).toEqual({ type: "Polygon", coordinates: [ring(-9.5, 6.5)] });
  });

  test("a Feature yields its name and code from properties", () => {
    const c = parse(feature(polygon(), { NAME_1: "Bomi", code: "MGL-BOM-0001" })).candidates[0];
    expect(c.name).toBe("Bomi");
    expect(c.code).toBe("MGL-BOM-0001");
    expect(c.label).toBe("Bomi");
  });

  test("a FeatureCollection becomes one row per feature, in order, bad rows included", () => {
    const r = parse(
      fc(
        feature(polygon(-9.5, 6.5), { name: "A" }),
        feature({ type: "Point", coordinates: [-9.5, 6.5] }, { name: "B" }),
        { type: "Feature", geometry: null, properties: { name: "C" } },
        feature(polygon(-9.2, 6.8), { name: "D" }),
      ),
    );
    expect(r.candidates.map((c) => [c.index, c.label, c.problem === undefined])).toEqual([
      [0, "A", true],
      [1, "B", false],
      [2, "C", false],
      [3, "D", true],
    ]);
    expect(r.candidates[1].problem).toContain("Point");
    expect(r.candidates[2].problem).toContain("no geometry");
  });

  test("a MultiPolygon (a county with islands) is accepted whole, with its part count", () => {
    const multi = { type: "MultiPolygon", coordinates: [[ring(-9.5, 6.5)], [ring(-10.5, 6.2)]] };
    const c = parse(feature(multi, { name: "Grand Cape Mount" })).candidates[0];
    expect(c.problem).toBeUndefined();
    expect(c.geometryType).toBe("MultiPolygon");
    expect(c.parts).toBe(2);
    expect(c.vertices).toBe(10);
  });

  test("a row with no name or code is still labelled so it can be told apart", () => {
    expect(parse(fc(feature(polygon()), feature(polygon()))).candidates.map((c) => c.label)).toEqual([
      "Shape 1",
      "Shape 2",
    ]);
  });
});

describe("parseBoundaryGeoJson — invalid shapes are explained, never repaired", () => {
  const problem = (geometry: unknown) => parse(feature(geometry)).candidates[0].problem as string;

  test("an unclosed ring is reported", () => {
    const open = { type: "Polygon", coordinates: [ring(-9.5, 6.5).slice(0, 4)] };
    expect(problem(open)).toContain("Not a valid boundary");
    expect(parse(feature(open)).candidates[0].geometryGeoJson).toBeUndefined(); // never "closed for them"
  });

  test("positive longitudes (the missing minus sign) get the fix spelled out", () => {
    const msg = problem({ type: "Polygon", coordinates: [ring(9.5, 6.5)] });
    expect(msg).toContain("positive");
    expect(msg).toContain("-9.5");
  });

  test("[lat, lng] order is recognised and explained", () => {
    const swapped = { type: "Polygon", coordinates: [ring(-9.5, 6.5).map(([x, y]) => [y, x])] };
    expect(problem(swapped)).toContain("[latitude, longitude]");
  });

  test("projected (non-degree) coordinates are recognised and explained", () => {
    const utm = { type: "Polygon", coordinates: [[[500000, 700000], [500100, 700000], [500100, 700100], [500000, 700100], [500000, 700000]]] };
    expect(problem(utm)).toContain("projected");
  });

  test("a shape outside Liberia is rejected", () => {
    expect(problem({ type: "Polygon", coordinates: [ring(2.3, 48.8)] })).toContain("Not a valid boundary");
  });

  test("a bad row never poisons the good ones around it", () => {
    const r = parse(fc(feature(polygon(-9.5, 6.5), { name: "ok1" }), feature({ type: "Polygon", coordinates: [] }), feature(polygon(-9.2, 6.8), { name: "ok2" })));
    expect(r.candidates.filter((c) => !c.problem).map((c) => c.name)).toEqual(["ok1", "ok2"]);
  });
});

describe("matching — exact, never fuzzy", () => {
  const sites = [
    { _id: "s1", code: "MGL-BOM-0001", name: "Bomi Gold Works" },
    { _id: "s2", code: "MGL-NIM-0002", name: "Nimba Iron" },
    { _id: "s3", code: "MGL-NIM-0003", name: "Nimba Iron" }, // same name twice
  ];

  test("site code wins, case- and space-insensitively", () => {
    expect(matchSiteForCandidate({ code: " mgl-bom-0001 " }, sites)).toBe("s1");
  });
  test("exact name is used when there is no code", () => {
    expect(matchSiteForCandidate({ name: "bomi  gold works" }, sites)).toBe("s1");
  });
  test("an ambiguous name matches nothing (a wrong outline is worse than none)", () => {
    expect(matchSiteForCandidate({ name: "Nimba Iron" }, sites)).toBeUndefined();
  });
  test("a near-miss name does not match", () => {
    expect(matchSiteForCandidate({ name: "Bomi Gold" }, sites)).toBeUndefined();
    expect(matchSiteForCandidate({}, sites)).toBeUndefined();
  });
  test("an unknown code falls back to the name, but an unknown pair matches nothing", () => {
    expect(matchSiteForCandidate({ code: "NOPE", name: "Bomi Gold Works" }, sites)).toBe("s1");
    expect(matchSiteForCandidate({ code: "NOPE", name: "Other" }, sites)).toBeUndefined();
  });

  test("an administrative boundary is 'already loaded' only for the same level AND name", () => {
    const existing = [
      { _id: "b1", name: "Bomi", level: "county" },
      { _id: "b2", name: "Bomi", level: "district" },
    ];
    expect(findExistingAdminBoundary(" bomi ", "county", existing)).toBe("b1");
    expect(findExistingAdminBoundary("Bomi", "district", existing)).toBe("b2");
    expect(findExistingAdminBoundary("Bomi", "community", existing)).toBeUndefined();
    expect(findExistingAdminBoundary("Bong", "county", existing)).toBeUndefined();
  });
});
