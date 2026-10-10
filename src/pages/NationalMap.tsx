import { useCallback, useMemo, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  GeoJSON,
  LayerGroup,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect } from "react";

import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import type { GeoLayer, GeoVerificationLevel, MapFeature } from "@/lib/types";
import {
  LIBERIA_CENTER,
  NO_FILTERS,
  VERIFICATION_LABEL,
  applyFilters,
  boundaryStyle,
  buildLegend,
  clusterPoints,
  countiesIn,
  parseBoundaryGeometry,
  provenanceLine,
  styleFor,
  symbolSvg,
  type ClusterOrPoint,
  type MapFilters,
} from "@/lib/gis";
import { tileAttribution, tileTemplate } from "@/lib/map-tiles";

const LEVELS: GeoVerificationLevel[] = ["verified", "unverified", "reported"];

function markerIcon(item: ClusterOrPoint): L.DivIcon {
  const f = item.feature;
  const style = styleFor(f.layer, item.level);
  const size = item.cluster ? 34 : 24;
  return L.divIcon({
    className: "mg-gis-marker",
    html: symbolSvg(style, size, item.cluster ? item.count : undefined),
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Child of MapContainer: reports the zoom to the parent (clustering is
 *  zoom-aware) and flies to a feature chosen from the side index. */
function MapBridge({
  onZoom,
  target,
}: {
  onZoom: (z: number) => void;
  target: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 11), { duration: 0.8 });
  }, [target, map]);
  return null;
}

export default function NationalMap() {
  const data = useQuery(api.mapFeatures);
  const layers = useMemo(() => data?.layers ?? [], [data]);
  const features = useMemo(() => data?.features ?? [], [data]);
  const adminBoundaries = useMemo(() => data?.adminBoundaries ?? [], [data]);
  const siteBoundaries = useMemo(() => data?.siteBoundaries ?? [], [data]);

  // Toggles are OVERRIDES on top of each layer's default, so layers that
  // arrive after first render get their defaults (no empty initial state).
  const [overrides, setOverrides] = useState<Partial<Record<GeoLayer, boolean>>>({});
  const visibleLayers = useMemo(
    () =>
      Object.fromEntries(layers.map((l) => [l.id, overrides[l.id] ?? l.defaultVisible])) as Record<
        GeoLayer,
        boolean
      >,
    [layers, overrides],
  );
  const toggleLayer = useCallback(
    (id: GeoLayer, current: boolean) => setOverrides((p) => ({ ...p, [id]: !current })),
    [],
  );

  const [filters, setFilters] = useState<MapFilters>(NO_FILTERS);
  const [zoom, setZoom] = useState(7);
  const [focus, setFocus] = useState<{ id: string; lat: number; lng: number } | null>(null);

  const counties = useMemo(() => countiesIn(features), [features]);

  const visibleFeatures = useMemo(
    () => applyFilters(features.filter((f) => visibleLayers[f.layer]), filters),
    [features, visibleLayers, filters],
  );

  const items = useMemo(() => {
    const byLayer = new Map<GeoLayer, MapFeature[]>();
    for (const f of visibleFeatures) byLayer.set(f.layer, [...(byLayer.get(f.layer) ?? []), f]);
    const out: { layer: GeoLayer; items: ClusterOrPoint[] }[] = [];
    for (const [layer, list] of byLayer) {
      const cfg = layers.find((l) => l.id === layer);
      out.push({ layer, items: clusterPoints(list, zoom, !!cfg?.supportsClustering) });
    }
    return out;
  }, [visibleFeatures, layers, zoom]);

  const siteCounty = useMemo(
    () => new Map(features.filter((f) => f.layer === "sites").map((f) => [f.id, f.county])),
    [features],
  );
  const shownSiteBoundaries = useMemo(
    () =>
      visibleLayers.site_boundaries
        ? siteBoundaries.filter(
            (b) => !filters.counties.length || filters.counties.includes(siteCounty.get(b.siteId) ?? ""),
          )
        : [],
    [siteBoundaries, visibleLayers, filters.counties, siteCounty],
  );
  const shownAdminBoundaries = useMemo(
    () =>
      visibleLayers.admin_boundaries
        ? adminBoundaries.filter(
            (b) => b.level !== "county" || !filters.counties.length || filters.counties.includes(b.name),
          )
        : [],
    [adminBoundaries, visibleLayers, filters.counties],
  );
  const levelFilteredBoundary = (verified: boolean) =>
    !filters.levels.length || filters.levels.includes(verified ? "verified" : "unverified");

  const legend = useMemo(
    () =>
      buildLegend(
        layers,
        visibleFeatures,
        {
          admin: shownAdminBoundaries.filter((b) => levelFilteredBoundary(b.geoVerified)),
          site: shownSiteBoundaries.filter((b) => levelFilteredBoundary(b.geoVerified)),
        },
        visibleLayers,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layers, visibleFeatures, shownAdminBoundaries, shownSiteBoundaries, visibleLayers, filters.levels],
  );

  const unverifiedCount = visibleFeatures.filter((f) => f.verification !== "verified").length;
  const hasBoundaryData = adminBoundaries.length > 0 || siteBoundaries.length > 0;

  const searchResults = useMemo(() => {
    const rank = (f: MapFeature) => (f.verification === "verified" ? 1 : 0);
    return [...visibleFeatures].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }, [visibleFeatures]);

  const toggleCounty = (c: string) =>
    setFilters((p) => ({
      ...p,
      counties: p.counties.includes(c) ? p.counties.filter((x) => x !== c) : [...p.counties, c],
    }));
  const toggleLevel = (l: GeoVerificationLevel) =>
    setFilters((p) => ({
      ...p,
      levels: p.levels.includes(l) ? p.levels.filter((x) => x !== l) : [...p.levels, l],
    }));

  return (
    <div className="space-y-4">
      <header>
        <p className="kicker">GIS</p>
        <h1 className="display text-3xl">National map</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Only records you are authorized to see are shown. Verified positions are drawn solid;
          unverified positions are dashed and pale; unvetted public reports are dotted and hollow.
          {!hasBoundaryData &&
            " No authoritative boundary dataset has been loaded yet, so the map shows point records only."}
        </p>
      </header>

      <div className="space-y-2 border-b border-border pb-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Map layers">
          {layers.map((cfg) => {
            const on = visibleLayers[cfg.id];
            return (
              <button
                key={cfg.id}
                type="button"
                aria-pressed={on}
                className={`layer-toggle rounded-full border px-3 py-1 text-xs transition ${
                  on ? "bg-background border-border shadow-sm" : "border-border bg-transparent opacity-60 hover:opacity-100"
                }`}
                onClick={() => toggleLayer(cfg.id, on)}
              >
                {cfg.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Position verification filter">
          <span className="text-muted-foreground">Position:</span>
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={filters.levels.includes(l)}
              onClick={() => toggleLevel(l)}
              className={`rounded-full border px-2.5 py-0.5 ${
                filters.levels.includes(l) ? "bg-accent border-ring" : "border-border opacity-70 hover:opacity-100"
              }`}
            >
              {VERIFICATION_LABEL[l]}
            </button>
          ))}
          {counties.length > 0 && <span className="ml-2 text-muted-foreground">County:</span>}
          {counties.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={filters.counties.includes(c)}
              onClick={() => toggleCounty(c)}
              className={`rounded-full border px-2.5 py-0.5 ${
                filters.counties.includes(c) ? "bg-accent border-ring" : "border-border opacity-70 hover:opacity-100"
              }`}
            >
              {c}
            </button>
          ))}
          {(filters.counties.length > 0 || filters.levels.length > 0) && (
            <button type="button" className="underline" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="h-[60vh] min-h-[420px] flex-1 overflow-hidden rounded-sm border border-border">
          <MapContainer center={LIBERIA_CENTER} zoom={7} scrollWheelZoom className="size-full">
            {/* Offline tiles: see src/lib/map-tiles.ts + public/sw.js — viewed
             *  tiles inside Liberia are cached (bounded, no prefetch) per the
             *  provider's tile usage policy; VITE_TILE_URL swaps in a licensed
             *  offline bundle. */}
            <TileLayer attribution={tileAttribution()} url={tileTemplate()} minZoom={5} maxZoom={14} />
            <MapBridge onZoom={setZoom} target={focus} />

            {shownAdminBoundaries
              .filter((b) => levelFilteredBoundary(b.geoVerified))
              .map((b) => {
                const geom = parseBoundaryGeometry(b.geometryGeoJson);
                if (!geom) return null;
                return (
                  <GeoJSON
                    key={`${b._id}:${b.geoVerified}`}
                    data={geom}
                    style={boundaryStyle("admin_boundaries", b.geoVerified, b.level === "national")}
                  >
                    <Popup>
                      <strong>{b.name}</strong> ({b.level})
                      <br />
                      {b.geoVerified ? "Verified boundary" : "Unverified boundary"} · source: {b.source}
                    </Popup>
                  </GeoJSON>
                );
              })}
            {shownSiteBoundaries
              .filter((b) => levelFilteredBoundary(b.geoVerified))
              .map((b) => {
                const geom = parseBoundaryGeometry(b.geometryGeoJson);
                if (!geom) return null;
                return (
                  <GeoJSON
                    key={`${b._id}:${b.geoVerified}`}
                    data={geom}
                    style={boundaryStyle("site_boundaries", b.geoVerified)}
                  >
                    <Popup>
                      Site outline — {b.geoVerified ? "verified" : "unverified"} · source: {b.source}
                    </Popup>
                  </GeoJSON>
                );
              })}

            {items.map(({ layer, items: chunk }) => (
              <LayerGroup key={layer}>
                {chunk.map((it) => (
                  <Marker key={it.feature.id} position={[it.feature.lat, it.feature.lng]} icon={markerIcon(it)}>
                    <Popup>
                      <strong>{it.feature.label}</strong>
                      <br />
                      {it.cluster ? (
                        <span className="text-[11px]">
                          {it.byLevel.verified} verified · {it.byLevel.unverified} unverified ·{" "}
                          {it.byLevel.reported} reported — zoom in for individual records.
                        </span>
                      ) : (
                        <span className="text-[11px]">{provenanceLine(it.feature)}</span>
                      )}
                      {!it.cluster && it.feature.layer === "community_reports" && (
                        <>
                          <br />
                          <span className="text-[11px]">
                            Reported by the public; location unverified. Not an accusation.
                          </span>
                        </>
                      )}
                    </Popup>
                  </Marker>
                ))}
              </LayerGroup>
            ))}
          </MapContainer>
        </div>

        <aside className="w-full shrink-0 overflow-hidden rounded-sm border border-border bg-card lg:w-80">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="kicker">Feature index</span>
            <span className="text-xs text-muted-foreground">
              {searchResults.length} shown · {unverifiedCount} not verified
            </span>
          </div>
          <div className="border-b border-border p-2">
            <input
              value={filters.text}
              onChange={(e) => setFilters((p) => ({ ...p, text: e.target.value }))}
              placeholder="Search visible features…"
              aria-label="Search map features"
              className="w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-ring"
            />
          </div>
          <ul className="max-h-[45vh] divide-y divide-border overflow-y-auto">
            {searchResults.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                No visible features match the current layers and filters.
              </li>
            )}
            {searchResults.slice(0, 120).map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setFocus({ id: f.id, lat: f.lat, lng: f.lng })}
                  className={`w-full px-3 py-2 text-left text-xs transition hover:bg-accent ${
                    focus?.id === f.id ? "bg-accent" : ""
                  }`}
                >
                  <span className="block truncate font-medium">{f.label}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {layers.find((l) => l.id === f.layer)?.label ?? f.layer} · {VERIFICATION_LABEL[f.verification]}
                  </span>
                </button>
              </li>
            ))}
            {searchResults.length > 120 && (
              <li className="px-3 py-2 text-center text-[10px] text-muted-foreground">
                {searchResults.length - 120} more — refine the filters to narrow this list.
              </li>
            )}
          </ul>
        </aside>
      </div>

      <div
        className="legend flex flex-wrap gap-x-5 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground"
        aria-label="Map legend"
      >
        {legend.length === 0 && <span>No features in the current view.</span>}
        {legend.map((e) => (
          <span key={`${e.layer}:${e.level}`} className="legend-item inline-flex items-center gap-1.5">
            <span
              className="legend-swatch"
              // Same renderer as the map markers (gis.symbolSvg).
              dangerouslySetInnerHTML={{ __html: symbolSvg(e.style, 18) }}
            />
            <span className="legend-text">
              {e.label} — {e.note}
              <span className="legend-count"> · {e.count}</span>
            </span>
          </span>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Community report locations are as reported by the public and have not been verified; they
        never constitute an accusation against any party. A position is "verified" only when an
        authorized administrator has recorded an authoritative source for it. Incidents, risk
        indicators and inspections without their own GPS fix are drawn at the site's registry
        position and are never shown as more certain than that position.
      </p>
    </div>
  );
}
