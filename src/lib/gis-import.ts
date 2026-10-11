// ---------------------------------------------------------------------------
// Boundary import — turn a GeoJSON file (or pasted text) into reviewable
// candidates BEFORE anything is written.
//
// Pure and DOM-free so every rule is unit-tested. The same validator the
// database CHECK mirrors (validateGeoJsonPolygon) is the gate: a shape that
// would be rejected on save is reported here, on the row, with a reason.
//
// What is accepted: FeatureCollection / Feature / bare Polygon or MultiPolygon.
// What is never done: repairing, re-projecting or guessing. A shape that is not
// valid as given is reported, not "fixed" — a silently altered boundary would be
// a fabricated one.
// ---------------------------------------------------------------------------

import { LIBERIA_BBOX, validateGeoJsonPolygon } from "./gis";

export const MAX_IMPORT_BYTES = 5_000_000;
export const MAX_IMPORT_CANDIDATES = 500;

export interface BoundaryCandidate {
  /** Position in the file (stable key for row state). */
  index: number;
  /** What to call this row in the review list. */
  label: string;
  /** Name / code read from the feature's properties, if present. */
  name?: string;
  code?: string;
  geometryType?: "Polygon" | "MultiPolygon";
  /** Canonical geometry text — `{type, coordinates}` only, 2-D positions. */
  geometryGeoJson?: string;
  /** Polygons in the shape (a MultiPolygon with islands has several). */
  parts: number;
  /** Total positions across all rings (a size indicator for the reviewer). */
  vertices: number;
  /** Why this row cannot be loaded; absent when it is valid. */
  problem?: string;
}

export interface ParsedBoundaries {
  candidates: BoundaryCandidate[];
  /** The input as a whole is unusable (not JSON, too large, wrong format…). */
  fatal?: string;
}

const NAME_KEYS = [
  "name", "NAME", "Name", "shapeName", "NAME_1", "NAME_2", "NAME_3", "ADM1_EN", "ADM2_EN",
  "ADM3_EN", "admin_name", "county", "COUNTY", "district", "DISTRICT",
];
const CODE_KEYS = ["code", "CODE", "Code", "site_code", "SITE_CODE", "siteCode"];

function pickString(props: unknown, keys: string[]): string | undefined {
  if (!props || typeof props !== "object") return undefined;
  const bag = props as Record<string, unknown>;
  for (const k of keys) {
    const v = bag[k];
    if ((typeof v === "string" || typeof v === "number") && String(v).trim()) {
      return String(v).trim();
    }
  }
  return undefined;
}

/** Strip anything that is not geometry (bbox, crs, foreign members) and any
 *  altitude, so what is stored is exactly `{type, coordinates}`. */
function canonical(type: "Polygon" | "MultiPolygon", coordinates: unknown): unknown {
  const pos = (p: unknown) => (Array.isArray(p) ? p.slice(0, 2) : p);
  const ring = (r: unknown) => (Array.isArray(r) ? r.map(pos) : r);
  const poly = (c: unknown) => (Array.isArray(c) ? c.map(ring) : c);
  return {
    type,
    coordinates:
      type === "Polygon"
        ? poly(coordinates)
        : Array.isArray(coordinates)
          ? coordinates.map(poly)
          : coordinates,
  };
}

function countVertices(type: "Polygon" | "MultiPolygon", coordinates: unknown): number {
  const polys: unknown[] = type === "Polygon" ? [coordinates] : Array.isArray(coordinates) ? coordinates : [];
  let n = 0;
  for (const p of polys) {
    if (!Array.isArray(p)) continue;
    for (const r of p) if (Array.isArray(r)) n += r.length;
  }
  return n;
}

/** First position found in the geometry, for coordinate-order diagnostics. */
function firstPosition(coordinates: unknown): [number, number] | null {
  let c: unknown = coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number"
    ? [c[0], c[1]]
    : null;
}

/** Turn "the validator said no" into advice a person can act on. */
function explainInvalid(base: string, coordinates: unknown): string {
  const p = firstPosition(coordinates);
  if (p) {
    const [a, b] = p;
    const { minLat, maxLat, minLng, maxLng } = LIBERIA_BBOX;
    if (a >= minLat && a <= maxLat && b >= minLng && b <= maxLng) {
      return `${base} Positions look like [latitude, longitude]; GeoJSON requires [longitude, latitude].`;
    }
    if (a > 0 && -a >= minLng && -a <= maxLng && b >= minLat && b <= maxLat) {
      return `${base} Longitudes are positive; Liberia is west of the prime meridian, so they must be negative (for example ${-a}).`;
    }
    if (a < -180 || a > 180 || b < -90 || b > 90) {
      return `${base} Coordinates are not degrees (the file may be in a projected system such as UTM); export it as WGS84 longitude/latitude.`;
    }
  }
  return base;
}

function toCandidate(
  index: number,
  geometry: unknown,
  properties: unknown,
): BoundaryCandidate {
  const name = pickString(properties, NAME_KEYS);
  const code = pickString(properties, CODE_KEYS);
  const label = name ?? code ?? `Shape ${index + 1}`;
  const base = { index, label, name, code, parts: 0, vertices: 0 };

  if (!geometry || typeof geometry !== "object") {
    return { ...base, problem: "This feature has no geometry." };
  }
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type !== "Polygon" && g.type !== "MultiPolygon") {
    const what = typeof g.type === "string" ? g.type : "unknown";
    return {
      ...base,
      problem: `${what} geometries cannot be loaded as boundaries — only Polygon and MultiPolygon.`,
    };
  }
  const canon = canonical(g.type, g.coordinates);
  const check = validateGeoJsonPolygon(canon);
  const parts = g.type === "Polygon" ? 1 : Array.isArray(g.coordinates) ? g.coordinates.length : 0;
  const vertices = countVertices(g.type, g.coordinates);
  if (!check.ok) {
    return {
      ...base,
      geometryType: g.type,
      parts,
      vertices,
      problem: explainInvalid(`Not a valid boundary: ${check.error}.`, g.coordinates),
    };
  }
  return {
    ...base,
    geometryType: g.type,
    geometryGeoJson: JSON.stringify(canon),
    parts,
    vertices,
  };
}

export function parseBoundaryGeoJson(text: string): ParsedBoundaries {
  const trimmed = text.trim();
  if (!trimmed) return { candidates: [] };
  if (trimmed.length > MAX_IMPORT_BYTES) {
    return {
      candidates: [],
      fatal: `This input is larger than ${Math.round(MAX_IMPORT_BYTES / 1_000_000)} MB. Split it into smaller files (for example one per county).`,
    };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return {
      candidates: [],
      fatal: "This is not valid JSON. Load a .geojson or .json file (not a shapefile, KML or CSV).",
    };
  }
  if (!doc || typeof doc !== "object") {
    return { candidates: [], fatal: "This is not a GeoJSON object." };
  }
  const root = doc as { type?: unknown; features?: unknown; geometry?: unknown; properties?: unknown };

  if (root.type === "Topology") {
    return { candidates: [], fatal: "TopoJSON is not supported. Export the boundaries as plain GeoJSON." };
  }
  if (root.type === "FeatureCollection") {
    if (!Array.isArray(root.features)) {
      return { candidates: [], fatal: "This FeatureCollection has no features list." };
    }
    if (root.features.length > MAX_IMPORT_CANDIDATES) {
      return {
        candidates: [],
        fatal: `This file has ${root.features.length} features; load at most ${MAX_IMPORT_CANDIDATES} at a time.`,
      };
    }
    return {
      candidates: root.features.map((f, i) => {
        const feat = (f ?? {}) as { geometry?: unknown; properties?: unknown };
        return toCandidate(i, feat.geometry, feat.properties);
      }),
    };
  }
  if (root.type === "Feature") {
    return { candidates: [toCandidate(0, root.geometry, root.properties)] };
  }
  if (root.type === "Polygon" || root.type === "MultiPolygon") {
    return { candidates: [toCandidate(0, root, undefined)] };
  }
  return {
    candidates: [],
    fatal: "Not a GeoJSON FeatureCollection, Feature, Polygon or MultiPolygon.",
  };
}

// ----------------------------------------------------------------- matching

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

/** Which registered site a shape most likely outlines — by site code first,
 *  then by exact (case-insensitive) name. Never fuzzy: a wrong guess would put
 *  one site's outline on another. Ambiguous names match nothing. */
export function matchSiteForCandidate(
  candidate: { name?: string; code?: string },
  sites: ReadonlyArray<{ _id: string; code: string; name: string }>,
): string | undefined {
  if (candidate.code) {
    const hit = sites.find((s) => norm(s.code) === norm(candidate.code as string));
    if (hit) return hit._id;
  }
  if (candidate.name) {
    const hits = sites.filter((s) => norm(s.name) === norm(candidate.name as string));
    if (hits.length === 1) return hits[0]._id;
  }
  return undefined;
}

/** An already-loaded administrative boundary with the same level and name —
 *  loading again REPLACES it instead of creating a duplicate. */
export function findExistingAdminBoundary(
  name: string,
  level: string,
  existing: ReadonlyArray<{ _id: string; name: string; level: string }>,
): string | undefined {
  const hit = existing.find((b) => b.level === level && norm(b.name) === norm(name));
  return hit?._id;
}
