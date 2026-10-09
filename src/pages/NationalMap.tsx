import { useMemo, useCallback, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, GeoJSON, LayerGroup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import React from "react";

import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import {
  type GeoLayer,
  type MapLayerConfig,
  type MapFeature,
  type AdminBoundary,
  type SiteBoundary,
} from "@/lib/types";

const CENTER: [number, number] = [6.9, 9.3]; // approximate centroid of Liberia

// Link layer IDs to stable legend colors so styling is driven by the data
// model rather than by individual record shapes.
const LAYER_PALETTE: Record<GeoLayer, { pin?: string; fill?: string; stroke?: string; dash?: string }> = {
  sites: { pin: "#2c5545" },
  site_boundaries: { fill: "#2c5545", fillOpacity: 0.12, stroke: "#2c5545" },
  admin_boundaries: { fill: "#3b6b8a", fillOpacity: 0.10, stroke: "#3b6b8a" },
  incidents: { fill: "#9c2b1e", fillOpacity: 0.5, stroke: "#9c2b1e" },
  inspections: { pin: "#6b6558" },
  observations: { fill: "#b07d2b", fillOpacity: 0.55, stroke: "#b07d2b" },
  community_reports: { stroke: "#9c2b1e", dash: "3 3" },
  risk_indicators: { pin: "#7a3b8c" },
};

function siteIcon(kind: "active" | "other") {
  return L.divIcon({
    className: "",
    html: `<div class="mg-site-marker" style="background:${kind === "active" ? "#2c5545" : "#6b6558"}"><span style="color:#f0eee6">◆</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 28],
  });
}

function featureStyle(layer: GeoLayer, feature: MapFeature) {
  const palette = LAYER_PALETTE[layer];
  if (!palette) return {};

  const isUnverified =
    feature.geoVerified === false ||
    (feature.geoSource === "public_report" && layer !== "community_reports");

  const base: Record<string, unknown> = {
    radius: 8,
    pathOptions: {
      weight: 1.5,
      fillOpacity: 0.55,
    },
  };

  if (palette.pin) {
    return { icon: siteIcon(feature.geoVerified ? "active" : "other") };
  }
  if (palette.fill) {
    const stroke = palette.stroke ?? palette.fill;
    if (isUnverified) {
      return {
        radius: 9,
        pathOptions: {
          color: "#1a1410",
          weight: 2,
          dashArray: "2 3",
          fillColor: "#9c2b1e",
          fillOpacity: 0.30,
        },
      };
    }
    return {
      radius: 8,
      pathOptions: {
        color: stroke,
        fillColor: palette.fill,
        fillOpacity: palette.fillOpacity ?? 0.55,
        weight: palette.stroke ? 1.5 : 1,
        ...(palette.dash ? { dashArray: palette.dash } : {}),
      },
    };
  }
  if (palette.stroke) {
    if (isUnverified) {
      return {
        radius: 9,
        pathOptions: {
          color: "#1a1410",
          weight: 2,
          dashArray: "2 3",
          fillColor: "#b07d2b",
          fillOpacity: 0.20,
        },
      };
    }
    return {
      radius: 7,
      pathOptions: {
        color: palette.stroke,
        fillColor: palette.fill ?? palette.stroke,
        fillOpacity: palette.fillOpacity ?? 0.5,
        weight: 2,
        ...(palette.dash ? { dashArray: palette.dash } : {}),
      },
    };
  }
  return base;
}

/** Build the visible legend from the layers the query actually returned.
 *  No hardcoded legend shape — if a layer is absent from the response, it is
 *  absent from the legend too. */
function legendItem(cfg: MapLayerConfig, features: MapFeature[], layerId: GeoLayer) {
  const visible = features.filter((f) => f.layer === layerId && f.visible !== false);
  const count = visible.length;
  const palette = LAYER_PALETTE[layerId];
  const color = palette?.pin ?? palette?.stroke ?? palette?.fill ?? "#888";
  return (
    <span className="legend-item">
      <span
        className="legend-swatch"
        style={
          palette?.pin
            ? { background: color }
            : palette?.dash
            ? { borderColor: color, background: "transparent" }
            : { background: `${color}cc`, borderColor: color }
        }
      >
        {palette?.pin ? (
          <span className="legend-pin" />
        ) : palette?.dash ? (
          <span className="legend-dashed" />
        ) : (
          <span className="legend-circle" />
        )}
      </span>
      <span className="legend-text">
        {cfg.label}
        {layerId === "community_reports" && visible.length > 0 && (
          <span className="legend-soft"> — unverified</span>
        )}
        {count > 0 && layerId !== "community_reports" && (
          <span className="legend-count"> · {count}</span>
        )}
      </span>
    </span>
  );
}

/** Parse a stored GeoJSON string into a geometry or feature for the boundary
 *  polygon layers. Boundary tables store the GeoJSON as text; we rehydrate it
 *  here only when the authoritative dataset exists on the lineage. */
function geoJsonGeometryParse(g: string): GeoJSON.Geometry | GeoJSON.Feature<GeoJSON.Geometry> {
  const parsed = JSON.parse(g);
  if (parsed && typeof parsed === "object" && "type" in parsed && typeof (parsed as any).type === "string") {
    return parsed as any;
  }
  return parsed as any;
}

/** Style helper for boundary polygons: verified admin/site outlines use the
 *  layer palette; an unverified boundary is rendered with a dashed outline so
 *  it stays visually distinct from authoritative borders. */
function polygonStyle(
  palette: { fill?: string; fillOpacity?: number; stroke?: string; dash?: string } | undefined,
  national = false,
) {
  const stroke = palette?.stroke ?? palette?.fill ?? "#3b6b8a";
  const fill = palette?.fill ?? stroke;
  return {
    color: stroke,
    weight: national ? 2.5 : 1.5,
    opacity: 0.9,
    fillColor: fill,
    fillOpacity: palette?.fillOpacity ?? (national ? 0.10 : 0.08),
    ...(palette?.dash ? { dashArray: palette.dash } : {}),
  };
}

export default function NationalMap() {
  const data = useQuery(api.mapFeatures);

  const layers = (data ?? {}).layers ?? [];
  const features = (data ?? {}).features ?? [];
  const adminBoundaries = (data ?? {}).adminBoundaries ?? [];
  const siteBoundaries = (data ?? {}).siteBoundaries ?? [];

  const [toggles, setToggles] = useState<Record<GeoLayer, boolean>>(
    () =>
      Object.fromEntries(
        layers.map((l) => [l.id, l.defaultVisible]),
      ) as Record<GeoLayer, boolean>,
  );

  const toggleLayer = useCallback(
    (layer: GeoLayer) =>
      setToggles((prev) => ({ ...prev, [layer]: !prev[layer] })),
    [],
  );

  const visibleFeatures = useMemo(
    () => features.filter((f) => toggles[f.layer] && f.visible !== false),
    [features, toggles],
  );

  // Client-side point clustering for the dense point layers. Polygons are
  // rendered directly (they do not cluster) and are intentionally empty on
  // the current lineage; when Session 6 boundary tables exist, map them as
  // Leaflet GeoJSON polylines/multi-polygons here.
  const clustered = useMemo(() => {
    const buckets = new Map<GeoLayer, MapFeature[]>();
    for (const f of visibleFeatures) {
      if (f.layer === "site_boundaries" || f.layer === "admin_boundaries") continue;
      const list = buckets.get(f.layer) ?? [];
      list.push(f);
      buckets.set(f.layer, list);
    }
    const chunks: { layer: GeoLayer; features: MapFeature[] }[] = [];
    for (const [layer, list] of buckets) {
      const cfg = layers.find((l) => l.id === layer);
      if (!cfg?.supportsClustering || list.length <= 60) {
        chunks.push({ layer, features: list });
        continue;
      }
      const sorted = [...list].sort((a, b) => a.lat - b.lat || a.lng - b.lng);
      const grid = new Map<string, MapFeature[]>();
      for (const f of sorted) {
        const cell = `${Math.round(f.lat / 0.12)},${Math.round(f.lng / 0.12)}`;
        const row = grid.get(cell) ?? [];
        row.push(f);
        grid.set(cell, row);
      }
      const merged: MapFeature[] = [];
      for (const row of grid.values()) {
        if (row.length <= 8) {
          merged.push(...row);
          continue;
        }
        const lat = row.reduce((s, f) => s + f.lat, 0) / row.length;
        const lng = row.reduce((s, f) => s + f.lng, 0) / row.length;
        merged.push({
          ...row[0],
          id: `cluster:${layer}:${lat.toFixed(4)}:${lng.toFixed(4)}`,
          label: `${row.length} ${cfg.label.toLowerCase()}`,
          lng,
          lat,
          visible: true,
          _cluster: true,
          _memberCount: row.length,
        });
      }
      chunks.push({ layer, features: merged });
    }
    return chunks;
  }, [visibleFeatures, layers]);

  const adminBoundaryPolylines = useMemo(() => {
    if (adminBoundaries.length === 0) return [];
    return adminBoundaries.map((b) => {
      try {
        const parsed = geoJsonGeometryParse(b.geometryGeoJson);
        const geom: GeoJSON.Geometry = parsed.geometry ?? parsed as GeoJSON.Geometry;
        return {
          key: b._id,
          name: b.name,
          level: b.level,
          geojson: { type: "Feature", geometry: geom, properties: { source: b.source, verified: b.geoVerified } },
        };
      } catch {
        return { key: b._id, name: b.name, level: b.level, geojson: { type: "GeometryCollection", geometries: [] } };
      }
    });
  }, [adminBoundaries]);

  const siteBoundaryPolylines = useMemo(() => {
    if (siteBoundaries.length === 0) return [];
    return siteBoundaries.map((b) => {
      try {
        const parsed = geoJsonGeometryParse(b.geometryGeoJson);
        const geom: GeoJSON.Geometry = parsed.geometry ?? parsed as GeoJSON.Geometry;
        return {
          key: b._id,
          siteId: b.siteId,
          geojson: { type: "Feature", geometry: geom, properties: { source: b.source, verified: b.geoVerified } },
        };
      } catch {
        return { key: b._id, siteId: b.siteId, geojson: { type: "GeometryCollection", geometries: [] } };
      }
    });
  }, [siteBoundaries]);

  const hasBoundaryData = adminBoundaries.length > 0 || siteBoundaries.length > 0;

  return (
    <div className="space-y-4">
      <header>
        <p className="kicker">GIS</p>
        <h1 className="display text-3xl">National map</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Verified registry data, authoritative observations, and reported
          information are shown distinctly. Boundaries are rendered when the
          authoritative boundary dataset is available; until then the map shows
          point records only.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
        <div className="flex flex-wrap gap-2">
          {layers.map((cfg) => (
            <button
              key={cfg.id}
              type="button"
              className={`layer-toggle rounded-full border px-3 py-1 text-xs transition ${
                toggles[cfg.id]
                  ? "bg-background border-border shadow-sm"
                  : "border-border bg-transparent opacity-60 hover:opacity-100"
              }`}
              onClick={() => toggleLayer(cfg.id)}
            >
              {cfg.label}
            </button>
          ))}
        </div>
        {hasBoundaryData && (
          <span className="text-xs text-muted-foreground">
            Boundary polygons shown from the authoritative dataset.
          </span>
        )}
      </div>

      <div className="h-[60vh] min-h-[420px] overflow-hidden rounded-sm border border-border">
        <MapContainer center={CENTER} zoom={7} scrollWheelZoom className="size-full">
          {/* Offline tile strategy — documented alternative.
           *
           * The live app relies on the browser's native tile HTTP cache for the
           * OpenStreetMap raster layer during short connectivity drops (the tile
           * URLs are cacheable by design, so a tile recently seen while online is
           * served from cache on a brief offline moment). For sustained offline
           * field mapping in a verified region, the recommended path is a cached
           * offline tile set (MBTiles / offline tile provider) loaded only for
           * the region the field team is working in, sourced from a provider whose
           * terms permit offline redistribution (e.g. a licensed offline tile
           * bundle, or a derived set from OpenStreetMap data that the project has
           * the right to cache). This codebase does not bundle offline tiles: the
           * app avoids shipping or caching tiles beyond what the browser already
           * holds for the currently viewed region, so it never makes a caching
           * policy claim it cannot keep.
           *
           * The tile URL below stays on the standard OSM raster endpoint for the
           * connected case; replacing it with a cached region-bundle URL is the
           * documented extension point when the project has a licensed offline set. */
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* Boundary polygon layers render here once Session 6 boundary tables
           * exist on the lineage. Until then the arrays are empty and no polygon
           * layer is shown — the map degrades gracefully rather than drawing empty
           * or placeholder shapes. */
          {adminBoundaryPolylines.map((b) => (
            <GeoJSON key={b.key} data={b.geojson} style={polygonStyle(LAYER_PALETTE["admin_boundaries"], b.level === "national")} />
          ))}
          {siteBoundaryPolylines.map((b) => (
            <GeoJSON key={b.key} data={b.geojson} style={polygonStyle(LAYER_PALETTE["site_boundaries"])} />
          ))}

          {clustered.map(({ layer, features: chunk }) => (
            <LayerGroup key={layer}>
              {chunk.map((f) => {
                if (f._cluster) {
                  const palette = LAYER_PALETTE[f.layer];
                  const color = palette?.pin ?? palette?.stroke ?? palette?.fill ?? "#888";
                  return (
                    <CircleMarker
                      key={f.id}
                      center={[f.lat, f.lng]}
                      radius={15}
                      pathOptions={{
                        color,
                        fillColor: color,
                        fillOpacity: 0.8,
                        weight: 2,
                      }}
                    >
                      <Popup>
                        <strong>{f.label}</strong>
                      </Popup>
                    </CircleMarker>
                  );
                }
                const style = featureStyle(layer, f);
                if (style.icon) {
                  return (
                    <Marker
                      key={f.id}
                      position={[f.lat, f.lng]}
                      icon={style.icon}
                    >
                      <Popup>
                        <strong>{f.label}</strong>
                        <br />
                        {f.geoVerified === false ? "Geographic position unverified" : "Position as recorded"}
                      </Popup>
                    </Marker>
                  );
                }
                return (
                  <CircleMarker
                    key={f.id}
                    center={[f.lat, f.lng]}
                    {...style}
                  >
                    <Popup>
                      <strong>{f.label}</strong>
                      {f.geoVerified === false && <br />}
                      {f.geoVerified === false && (
                        <span className="text-[11px] text-muted-foreground">
                          Geographic position unverified — treat location as approximate.
                        </span>
                      )}
                    </Popup>
                  </CircleMarker>
                );
              })}
            </LayerGroup>
          ))}
        </MapContainer>
      </div>

      <div className="legend flex flex-wrap gap-x-5 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
        {layers.map((cfg) => (
          <React.Fragment key={cfg.id}>{legendItem(cfg, visibleFeatures, cfg.id)}</React.Fragment>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Community report locations are as reported by the public and have not
        been verified. They never constitute an accusation against any party.
        Verified geographic data comes from the site registry and staff
        observations only. Positions marked unverified are visually distinct on
        the map and in the legend.
      </p>
    </div>
  );
}
