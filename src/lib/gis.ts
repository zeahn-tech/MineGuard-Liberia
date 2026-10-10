// ---------------------------------------------------------------------------
// GIS CORE (Session 6, GIS-1…5) — pure, framework-free, unit-testable.
//
// Everything the map renders is derived here from REAL rows:
//   * feature builders (rows → MapFeature) carrying geo_verified / source /
//     accuracy and a fail-safe verification level,
//   * one styling spec per (layer, verification level) shared by the map AND
//     the legend, so the legend can never drift from what is drawn,
//   * a legend built from the data actually loaded (no hardcoded entries),
//   * zoom-aware clustering that never hides unverified members,
//   * filters (county / verification / text) applied before legend + cluster,
//   * a client mirror of the SQL GeoJSON polygon validator (migration 0015).
//
// SCOPING is NOT done here: rows arrive already filtered by Postgres RLS
// (sites/incidents/inspections/observations via mg_can_access_site, community
// reports via the staff scope matrix, site boundaries via the site matrix).
// These functions only shape what the caller is already allowed to see.
// ---------------------------------------------------------------------------

import type {
  AdminBoundary,
  GeoLayer,
  GeoVerificationLevel,
  MapFeature,
  MapLayerConfig,
  SiteBoundary,
} from "./types";

type Row = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// ----------------------------------------------------------- provenance

/** Liberia sanity envelope (NOT a boundary) — mirrors migration 0015. */
export const LIBERIA_BBOX = { minLng: -11.6, maxLng: -7.3, minLat: 4.3, maxLat: 8.6 } as const;

/** Map default view. NOTE the negative longitude: Liberia lies WEST of the
 *  prime meridian (the previous constant used +9.3 and centred in Nigeria). */
export const LIBERIA_CENTER: [number, number] = [6.45, -9.4];

export function inLiberia(lat: number, lng: number): boolean {
  return (
    lat >= LIBERIA_BBOX.minLat &&
    lat <= LIBERIA_BBOX.maxLat &&
    lng >= LIBERIA_BBOX.minLng &&
    lng <= LIBERIA_BBOX.maxLng
  );
}

/** Fail-safe classification. Only an explicit `true` with a recorded source
 *  is "verified"; public-supplied positions are "reported"; everything else,
 *  including a missing flag, is "unverified". */
export function verificationLevel(input: {
  geoVerified?: boolean | null;
  geoSource?: string | null;
}): GeoVerificationLevel {
  const source = (input.geoSource ?? "").trim();
  if (input.geoVerified === true && source.length > 0) return "verified";
  if (source === "public_report") return "reported";
  return "unverified";
}

export const VERIFICATION_LABEL: Record<GeoVerificationLevel, string> = {
  verified: "Verified position",
  unverified: "Unverified position",
  reported: "Reported by the public — unvetted",
};

export function sourceLabel(source?: string): string {
  switch (source) {
    case "registry_entry":
      return "registry entry";
    case "device_gps":
      return "device GPS";
    case "device_gps_or_manual":
      return "device GPS or manual entry";
    case "public_report":
      return "public report";
    case "site_position":
      return "site registry position";
    case undefined:
    case "":
      return "no source recorded";
    default:
      return source.replace(/_/g, " ");
  }
}

// ------------------------------------------------------- feature builders

interface Geo {
  lat?: number;
  lng?: number;
}

function point(row: Row): Geo {
  const lat = num(row.latitude);
  const lng = num(row.longitude);
  // A (0,0)/out-of-Liberia point is a data error, never silently plotted
  // (the previous feed drew coordinate-less sites at 0,0 in the Atlantic).
  if (lat === undefined || lng === undefined || !inLiberia(lat, lng)) return {};
  return { lat, lng };
}

export function siteFeature(row: Row): MapFeature | null {
  const g = point(row);
  if (g.lat === undefined || g.lng === undefined) return null;
  const geoSource = (row.geo_source as string) ?? undefined;
  const geoVerified = row.geo_verified === true;
  return {
    id: String(row.id),
    layer: "sites",
    label: String(row.name),
    lat: g.lat,
    lng: g.lng,
    siteId: String(row.id),
    county: (row.county as string) ?? undefined,
    district: (row.district as string) ?? undefined,
    status: (row.status as string) ?? undefined,
    geoSource,
    geoAccuracyM: num(row.geo_accuracy_m),
    geoVerified,
    verification: verificationLevel({ geoVerified, geoSource }),
  };
}

type SiteIndex = Map<string, MapFeature>;

export function indexSites(features: MapFeature[]): SiteIndex {
  return new Map(features.filter((f) => f.layer === "sites").map((f) => [f.id, f]));
}

/** Incidents have no coordinates of their own: they are drawn at their
 *  site's registry position and INHERIT that position's verification (never
 *  stronger). The source is recorded as "site_position". */
export function incidentFeature(row: Row, sites: SiteIndex): MapFeature | null {
  const site = sites.get(String(row.site_id));
  if (!site) return null;
  return {
    id: String(row.id),
    layer: "incidents",
    label: `${String(row.type).replace(/_/g, " ")} — ${site.label}`,
    lat: site.lat,
    lng: site.lng,
    siteId: site.id,
    county: site.county,
    district: site.district,
    status: (row.status as string) ?? undefined,
    severity: (row.severity as string) ?? undefined,
    geoSource: "site_position",
    geoAccuracyM: site.geoAccuracyM,
    geoVerified: site.geoVerified,
    verification: site.verification === "verified" ? "verified" : "unverified",
  };
}

export function inspectionFeature(row: Row, sites: SiteIndex): MapFeature | null {
  const site = sites.get(String(row.site_id));
  const g = point(row);
  if (!site && g.lat === undefined) return null;
  const hasOwn = g.lat !== undefined && g.lng !== undefined;
  const geoSource = hasOwn ? ((row.geo_source as string) ?? "device_gps") : "site_position";
  const geoVerified = hasOwn ? row.geo_verified === true : site?.geoVerified === true;
  return {
    id: String(row.id),
    layer: "inspections",
    label: `Inspection — ${site?.label ?? "site"}`,
    lat: hasOwn ? (g.lat as number) : (site as MapFeature).lat,
    lng: hasOwn ? (g.lng as number) : (site as MapFeature).lng,
    siteId: site?.id,
    county: site?.county,
    district: site?.district,
    status: (row.status as string) ?? undefined,
    geoSource,
    geoAccuracyM: hasOwn ? num(row.gps_accuracy_m) : site?.geoAccuracyM,
    geoVerified,
    verification: verificationLevel({ geoVerified, geoSource }),
  };
}

export function observationFeature(row: Row, sites: SiteIndex): MapFeature | null {
  const site = sites.get(String(row.site_id));
  const g = point(row);
  const hasOwn = g.lat !== undefined && g.lng !== undefined;
  if (!site && !hasOwn) return null;
  const geoSource = hasOwn ? ((row.geo_source as string) ?? "device_gps_or_manual") : "site_position";
  const geoVerified = hasOwn ? row.geo_verified === true : site?.geoVerified === true;
  return {
    id: String(row.id),
    layer: "observations",
    label: `${String(row.category).replace(/_/g, " ")} (${String(row.verification)})`,
    lat: hasOwn ? (g.lat as number) : (site as MapFeature).lat,
    lng: hasOwn ? (g.lng as number) : (site as MapFeature).lng,
    siteId: site?.id,
    county: site?.county,
    district: site?.district,
    status: (row.status as string) ?? undefined,
    geoSource,
    geoAccuracyM: hasOwn ? num(row.geo_accuracy_m) : site?.geoAccuracyM,
    geoVerified,
    verification: verificationLevel({ geoVerified, geoSource }),
  };
}

/** Community reports are ALWAYS unvetted: even if staff set geo_verified on
 *  one, the layer stays "reported" until a staff triage marks the report
 *  itself verified — and the label never implies wrongdoing. */
export function communityReportFeature(row: Row): MapFeature | null {
  const g = point(row);
  if (g.lat === undefined || g.lng === undefined) return null;
  const geoSource = (row.geo_source as string) ?? "public_report";
  const geoVerified = row.geo_verified === true;
  return {
    id: String(row.id),
    layer: "community_reports",
    label: `Community report (${String(row.category).replace(/_/g, " ")})`,
    lat: g.lat,
    lng: g.lng,
    county: (row.county as string) ?? undefined,
    district: (row.district as string) ?? undefined,
    status: (row.status as string) ?? undefined,
    geoSource,
    geoAccuracyM: num(row.geo_accuracy_m),
    geoVerified,
    verification: geoVerified && row.status === "verified" ? "verified" : "reported",
  };
}

export type RiskLevel = "low" | "moderate" | "high" | "critical";

export function riskLevelOf(score: number): RiskLevel {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "moderate";
  return "low";
}

/** Risk indicators sit on the site position and inherit its verification. Only
 *  sites with a non-zero score get an indicator (nothing is invented). */
export function riskIndicatorFeature(
  site: MapFeature,
  score: number,
): MapFeature | null {
  if (!(score > 0)) return null;
  return {
    id: `risk:${site.id}`,
    layer: "risk_indicators",
    label: `Risk ${score} (${riskLevelOf(score)}) — ${site.label}`,
    lat: site.lat,
    lng: site.lng,
    siteId: site.id,
    county: site.county,
    district: site.district,
    riskScore: score,
    riskLevel: riskLevelOf(score),
    geoSource: "site_position",
    geoAccuracyM: site.geoAccuracyM,
    geoVerified: site.geoVerified,
    verification: site.verification === "verified" ? "verified" : "unverified",
  };
}

// ------------------------------------------------------------ boundaries

export interface GeoJsonCheck {
  ok: boolean;
  error?: string;
}

function validPosition(p: unknown): boolean {
  if (!Array.isArray(p) || p.length < 2) return false;
  const [lng, lat] = p as unknown[];
  return typeof lng === "number" && typeof lat === "number" && inLiberia(lat, lng);
}

function validRing(r: unknown): boolean {
  if (!Array.isArray(r) || r.length < 4) return false;
  if (!r.every(validPosition)) return false;
  const a = r[0] as number[];
  const b = r[r.length - 1] as number[];
  return a[0] === b[0] && a[1] === b[1];
}

function validPolygon(c: unknown): boolean {
  return Array.isArray(c) && c.length >= 1 && c.every(validRing);
}

/** Client mirror of public.mg_valid_geojson_polygon (migration 0015). Accepts
 *  a geometry object or its JSON text. A bare Polygon/MultiPolygon only —
 *  Features/collections are rejected so one shape = one stored contract. */
export function validateGeoJsonPolygon(input: unknown): GeoJsonCheck {
  let g: unknown = input;
  if (typeof input === "string") {
    try {
      g = JSON.parse(input);
    } catch {
      return { ok: false, error: "not valid JSON" };
    }
  }
  if (!g || typeof g !== "object") return { ok: false, error: "not a GeoJSON object" };
  const geom = g as { type?: unknown; coordinates?: unknown };
  if (geom.type === "Polygon") {
    return validPolygon(geom.coordinates)
      ? { ok: true }
      : { ok: false, error: "Polygon rings must be closed, ≥4 positions, [lng,lat] inside Liberia" };
  }
  if (geom.type === "MultiPolygon") {
    const c = geom.coordinates;
    return Array.isArray(c) && c.length >= 1 && c.every(validPolygon)
      ? { ok: true }
      : { ok: false, error: "MultiPolygon members invalid (closed rings, [lng,lat] inside Liberia)" };
  }
  return { ok: false, error: "geometry must be Polygon or MultiPolygon" };
}

/** Parse stored boundary geometry; invalid stored data is dropped (and
 *  reported) rather than drawn — never repaired or guessed. */
export function parseBoundaryGeometry(
  stored: unknown,
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  const g = typeof stored === "string" ? safeParse(stored) : stored;
  return validateGeoJsonPolygon(g).ok ? (g as GeoJSON.Polygon | GeoJSON.MultiPolygon) : null;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function adminBoundaryFromRow(b: Row): AdminBoundary {
  return {
    _id: String(b.id),
    name: String(b.name),
    level: (b.level as AdminBoundary["level"]) ?? "county",
    parentId: (b.parent_id as string) ?? undefined,
    geometryGeoJson:
      typeof b.geometry_geojson === "string"
        ? b.geometry_geojson
        : JSON.stringify(b.geometry_geojson ?? null),
    source: String(b.source ?? ""),
    accuracyM: num(b.accuracy_m),
    geoVerified: b.geo_verified === true,
    createdAt: b.created_at ? Date.parse(String(b.created_at)) || 0 : 0,
  };
}

export function siteBoundaryFromRow(b: Row): SiteBoundary {
  return {
    _id: String(b.id),
    siteId: String(b.site_id),
    geometryGeoJson:
      typeof b.geometry_geojson === "string"
        ? b.geometry_geojson
        : JSON.stringify(b.geometry_geojson ?? null),
    source: String(b.source ?? ""),
    accuracyM: num(b.accuracy_m),
    geoVerified: b.geo_verified === true,
    createdAt: b.created_at ? Date.parse(String(b.created_at)) || 0 : 0,
  };
}

// ---------------------------------------------------------------- styling

export type MarkerShape = "diamond" | "circle" | "ring" | "square";

export interface StyleSpec {
  shape: MarkerShape;
  color: string; // stroke / pin colour
  fill: string;
  fillOpacity: number;
  weight: number;
  dashArray?: string;
  radius: number;
}

const LAYER_COLOR: Record<GeoLayer, string> = {
  sites: "#2c5545",
  site_boundaries: "#2c5545",
  admin_boundaries: "#3b6b8a",
  incidents: "#9c2b1e",
  inspections: "#6b6558",
  observations: "#b07d2b",
  community_reports: "#9c2b1e",
  risk_indicators: "#7a3b8c",
};

const LAYER_SHAPE: Record<GeoLayer, MarkerShape> = {
  sites: "diamond",
  site_boundaries: "square",
  admin_boundaries: "square",
  incidents: "circle",
  inspections: "square",
  observations: "circle",
  community_reports: "ring",
  risk_indicators: "diamond",
};

/** ONE style per (layer, level) — used by the map markers, boundary
 *  polygons and the legend swatches alike.
 *    verified   solid fill, solid dark outline
 *    unverified pale fill, DASHED outline  (visibly provisional)
 *    reported   no fill, DOTTED outline    (visibly unvetted) */
export function styleFor(layer: GeoLayer, level: GeoVerificationLevel): StyleSpec {
  const color = LAYER_COLOR[layer];
  const shape = LAYER_SHAPE[layer];
  switch (level) {
    case "verified":
      return { shape, color, fill: color, fillOpacity: 0.85, weight: 2, radius: 8 };
    case "unverified":
      return { shape, color, fill: color, fillOpacity: 0.2, weight: 2, dashArray: "5 3", radius: 9 };
    case "reported":
    default:
      return { shape, color, fill: "transparent", fillOpacity: 0, weight: 2, dashArray: "1 4", radius: 9 };
  }
}

export function boundaryStyle(
  layer: "site_boundaries" | "admin_boundaries",
  verified: boolean,
  national = false,
) {
  const s = styleFor(layer, verified ? "verified" : "unverified");
  return {
    color: s.color,
    weight: national ? 2.5 : s.weight - 0.5,
    opacity: 0.9,
    fillColor: s.color,
    fillOpacity: verified ? 0.12 : 0.04,
    ...(s.dashArray ? { dashArray: s.dashArray } : {}),
  };
}

// ---------------------------------------------------------------- filters

export interface MapFilters {
  counties: string[]; // empty = all
  levels: GeoVerificationLevel[]; // empty = all
  text: string;
}

export const NO_FILTERS: MapFilters = { counties: [], levels: [], text: "" };

export function applyFilters(features: MapFeature[], f: MapFilters): MapFeature[] {
  const q = f.text.trim().toLowerCase();
  return features.filter((x) => {
    if (f.counties.length && !(x.county && f.counties.includes(x.county))) return false;
    if (f.levels.length && !f.levels.includes(x.verification)) return false;
    if (q && !x.label.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function countiesIn(features: MapFeature[]): string[] {
  return [...new Set(features.map((f) => f.county).filter((c): c is string => !!c))].sort();
}

// ------------------------------------------------------------- clustering

export interface ClusterOrPoint {
  feature: MapFeature;
  cluster: boolean;
  count: number;
  /** member counts by verification level — a cluster is NEVER drawn as
   *  verified unless every member is. */
  byLevel: Record<GeoVerificationLevel, number>;
  /** worst (least trusted) level among members */
  level: GeoVerificationLevel;
  memberIds: string[];
}

const LEVEL_RANK: Record<GeoVerificationLevel, number> = { verified: 0, unverified: 1, reported: 2 };

export function cellSizeForZoom(zoom: number): number {
  // 0.12° at zoom 7 (the original grid), halving per zoom step.
  return Math.max(0.002, 0.12 * Math.pow(2, 7 - zoom));
}

/** Zoom after which points are always shown individually. */
export const CLUSTER_MAX_ZOOM = 13;

export function clusterPoints(
  features: MapFeature[],
  zoom: number,
  enabled = true,
  minMembers = 3,
): ClusterOrPoint[] {
  const single = (f: MapFeature): ClusterOrPoint => ({
    feature: f,
    cluster: false,
    count: 1,
    byLevel: {
      verified: f.verification === "verified" ? 1 : 0,
      unverified: f.verification === "unverified" ? 1 : 0,
      reported: f.verification === "reported" ? 1 : 0,
    },
    level: f.verification,
    memberIds: [f.id],
  });
  if (!enabled || zoom >= CLUSTER_MAX_ZOOM) return features.map(single);

  const size = cellSizeForZoom(zoom);
  const cells = new Map<string, MapFeature[]>();
  for (const f of features) {
    const key = `${Math.floor(f.lat / size)}:${Math.floor(f.lng / size)}`;
    const list = cells.get(key) ?? [];
    list.push(f);
    cells.set(key, list);
  }
  const out: ClusterOrPoint[] = [];
  for (const members of cells.values()) {
    if (members.length < minMembers) {
      out.push(...members.map(single));
      continue;
    }
    const byLevel: Record<GeoVerificationLevel, number> = { verified: 0, unverified: 0, reported: 0 };
    let worst: GeoVerificationLevel = "verified";
    for (const m of members) {
      byLevel[m.verification] += 1;
      if (LEVEL_RANK[m.verification] > LEVEL_RANK[worst]) worst = m.verification;
    }
    const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const lng = members.reduce((s, m) => s + m.lng, 0) / members.length;
    const first = members[0];
    out.push({
      feature: {
        ...first,
        id: `cluster:${first.layer}:${lat.toFixed(4)}:${lng.toFixed(4)}`,
        label: `${members.length} features`,
        lat,
        lng,
        verification: worst,
        geoVerified: worst === "verified",
      },
      cluster: true,
      count: members.length,
      byLevel,
      level: worst,
      memberIds: members.map((m) => m.id),
    });
  }
  return out;
}

// ----------------------------------------------------------------- legend

export interface LegendEntry {
  layer: GeoLayer;
  label: string;
  level: GeoVerificationLevel | "boundary";
  count: number;
  style: StyleSpec;
  note: string;
}

/** Legend from the REAL, currently visible data: one entry per (layer ×
 *  verification level) that actually has features. Absent → not listed. */
export function buildLegend(
  layers: MapLayerConfig[],
  features: MapFeature[],
  boundaries: { admin: AdminBoundary[]; site: SiteBoundary[] },
  visibleLayers: Partial<Record<GeoLayer, boolean>>,
): LegendEntry[] {
  const entries: LegendEntry[] = [];
  for (const cfg of layers) {
    if (!visibleLayers[cfg.id]) continue;
    if (cfg.id === "admin_boundaries" || cfg.id === "site_boundaries") {
      const list = cfg.id === "admin_boundaries" ? boundaries.admin : boundaries.site;
      for (const verified of [true, false]) {
        const count = list.filter((b) => b.geoVerified === verified).length;
        if (!count) continue;
        entries.push({
          layer: cfg.id,
          label: cfg.label,
          level: "boundary",
          count,
          style: styleFor(cfg.id, verified ? "verified" : "unverified"),
          note: verified ? "verified boundary" : "unverified boundary",
        });
      }
      continue;
    }
    for (const level of ["verified", "unverified", "reported"] as GeoVerificationLevel[]) {
      const count = features.filter((f) => f.layer === cfg.id && f.verification === level).length;
      if (!count) continue;
      entries.push({
        layer: cfg.id,
        label: cfg.label,
        level,
        count,
        style: styleFor(cfg.id, level),
        note: VERIFICATION_LABEL[level],
      });
    }
  }
  return entries;
}

// ------------------------------------------------------------- map popups

export function provenanceLine(f: MapFeature): string {
  const acc = f.geoAccuracyM !== undefined ? ` · ±${Math.round(f.geoAccuracyM)} m` : "";
  return `${VERIFICATION_LABEL[f.verification]} · source: ${sourceLabel(f.geoSource)}${acc}`;
}

// ------------------------------------------------------------ symbol SVG

/** The ONE symbol renderer: map markers and legend swatches both call this,
 *  so what the legend shows is by construction what the map draws. */
export function symbolSvg(style: StyleSpec, size = 22, badge?: number): string {
  const c = size / 2;
  const r = size / 2 - style.weight - 1;
  const dash = style.dashArray ? ` stroke-dasharray="${style.dashArray}"` : "";
  const common = `fill="${style.fill}" fill-opacity="${style.fillOpacity}" stroke="${style.color}" stroke-width="${style.weight}"${dash}`;
  let shape: string;
  switch (style.shape) {
    case "diamond":
      shape = `<polygon points="${c},${c - r} ${c + r},${c} ${c},${c + r} ${c - r},${c}" ${common}/>`;
      break;
    case "square":
      shape = `<rect x="${c - r}" y="${c - r}" width="${2 * r}" height="${2 * r}" ${common}/>`;
      break;
    case "ring":
    case "circle":
    default:
      shape = `<circle cx="${c}" cy="${c}" r="${r}" ${common}/>`;
  }
  const label =
    badge !== undefined
      ? `<text x="${c}" y="${c + 4}" text-anchor="middle" font-size="${Math.round(size / 2.6)}" font-weight="700" fill="#1a1410">${badge}</text>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${shape}${label}</svg>`;
}
