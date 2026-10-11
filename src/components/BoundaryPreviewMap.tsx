import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import { GeoJSON, MapContainer, TileLayer, useMap } from "react-leaflet";
import { LIBERIA_CENTER, boundaryStyle, parseBoundaryGeometry } from "@/lib/gis";
import { tileAttribution, tileCrossOrigin, tileTemplate } from "@/lib/map-tiles";

export interface PreviewShape {
  id: string;
  label: string;
  geometryGeoJson: string;
}

/** Fit the view to the shapes being reviewed, and re-measure after the
 *  container settles (the map lives in a collapsible section). */
function FitToShapes({ shapes }: { shapes: PreviewShape[] }) {
  const map = useMap();
  useEffect(() => {
    const t = window.setTimeout(() => {
      map.invalidateSize();
      const layers = shapes
        .map((s) => parseBoundaryGeometry(s.geometryGeoJson))
        .filter((g): g is NonNullable<typeof g> => g !== null)
        .map((g) => L.geoJSON(g));
      if (layers.length === 0) return;
      const bounds = L.featureGroup(layers).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 13 });
    }, 150);
    return () => window.clearTimeout(t);
  }, [map, shapes]);
  return null;
}

/** Review aid: draws what is ABOUT to be loaded, styled as unverified (that is
 *  what a fresh load is until someone verifies it). */
export default function BoundaryPreviewMap({
  shapes,
  kind,
}: {
  shapes: PreviewShape[];
  kind: "site_boundaries" | "admin_boundaries";
}) {
  return (
    <div
      className="h-72 w-full overflow-hidden rounded-sm border border-border"
      role="img"
      aria-label={`Preview of ${shapes.length} boundary shape${shapes.length === 1 ? "" : "s"} to be loaded`}
    >
      <MapContainer center={LIBERIA_CENTER} zoom={7} minZoom={5} className="size-full">
        <TileLayer
          attribution={tileAttribution()}
          url={tileTemplate()}
          crossOrigin={tileCrossOrigin()}
          minZoom={5}
          maxZoom={14}
        />
        <FitToShapes shapes={shapes} />
        {shapes.map((s) => {
          const geom = parseBoundaryGeometry(s.geometryGeoJson);
          return geom ? (
            <GeoJSON key={s.id} data={geom} style={boundaryStyle(kind, false)} />
          ) : null;
        })}
      </MapContainer>
    </div>
  );
}
