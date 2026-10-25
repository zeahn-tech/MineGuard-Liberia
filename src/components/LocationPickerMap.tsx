import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import { ConsentTileLayer, MapTilesNotice } from "@/components/ConsentTileLayer";
import { MapContainer, Marker, useMap, useMapEvents } from "react-leaflet";
import { LIBERIA_BBOX, LIBERIA_CENTER, styleFor, symbolSvg } from "@/lib/gis";

/** Whole-country view with a little slack; the picker can't be panned away. */
const BOUNDS: L.LatLngBoundsExpression = [
  [LIBERIA_BBOX.minLat - 0.3, LIBERIA_BBOX.minLng - 0.3],
  [LIBERIA_BBOX.maxLat + 0.3, LIBERIA_BBOX.maxLng + 0.3],
];

// An UNVERIFIED site marker: a position picked here is a claim, not proof.
const PICK_ICON = L.divIcon({
  className: "mg-gis-marker",
  html: symbolSvg(styleFor("sites", "unverified"), 26),
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

/** Inside a Dialog the map mounts before its box has a size; Leaflet then
 *  renders grey tiles until told to re-measure. */
function SizeFix() {
  const map = useMap();
  useEffect(() => {
    const t = window.setTimeout(() => map.invalidateSize(), 150);
    const onResize = () => map.invalidateSize();
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
  }, [map]);
  return null;
}

function ClickToPick({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6)));
    },
  });
  return null;
}

/** Re-centre when the position changes from OUTSIDE the map (GPS fix, typing). */
function Follow({ position }: { position: { lat: number; lng: number } | null }) {
  const map = useMap();
  const lat = position?.lat;
  const lng = position?.lng;
  useEffect(() => {
    if (lat === undefined || lng === undefined) return;
    if (!map.getBounds().contains([lat, lng])) map.setView([lat, lng], Math.max(map.getZoom(), 12));
  }, [map, lat, lng]);
  return null;
}

export default function LocationPickerMap({
  position,
  onPick,
}: {
  position: { lat: number; lng: number } | null;
  onPick: (lat: number, lng: number) => void;
}) {
  return (
    <div
      className="relative h-64 w-full overflow-hidden rounded-sm border border-border"
      role="application"
      aria-label="Map: click to set the site position"
    >
      <MapContainer
        center={position ? [position.lat, position.lng] : LIBERIA_CENTER}
        zoom={position ? 12 : 7}
        minZoom={6}
        maxBounds={BOUNDS}
        className="size-full"
      >
        <ConsentTileLayer />
        <SizeFix />
        <ClickToPick onPick={onPick} />
        <Follow position={position} />
        {position && <Marker position={[position.lat, position.lng]} icon={PICK_ICON} />}
      </MapContainer>
      <MapTilesNotice />
    </div>
  );
}
