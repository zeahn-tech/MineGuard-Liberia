import { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, CircleMarker } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";

const CENTER: [number, number] = [6.9, 9.3]; // approximate centroid of Liberia

function siteIcon(kind: "active" | "other") {
  return L.divIcon({
    className: "",
    html: `<div class="mg-site-marker" style="background:${kind === "active" ? "#2c5545" : "#6b6558"}"><span style="color:#f0eee6">◆</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 28],
  });
}

export default function NationalMap() {
  const sites = useQuery(api.sites.list);
  const observations = useQuery(api.records.listObservations);
  const reports = useQuery(api.records.listCommunityReports);

  const siteMarkers = useMemo(
    () =>
      (sites ?? []).filter(
        (s) => s.latitude != null && s.longitude != null,
      ),
    [sites],
  );
  const obsMarkers = useMemo(
    () =>
      (observations ?? []).filter(
        (o) => o.latitude != null && o.longitude != null && o.status !== "resolved",
      ),
    [observations],
  );
  const reportMarkers = useMemo(
    () =>
      (reports ?? []).filter(
        (r) => r.latitude != null && r.longitude != null && (r.status === "submitted" || r.status === "under_review"),
      ),
    [reports],
  );

  return (
    <div className="space-y-4">
      <header>
        <p className="kicker">GIS</p>
        <h1 className="display text-3xl">National map</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Verified registry data and reported information are shown distinctly.
          Marker positions are as recorded; boundaries are not depicted.
        </p>
      </header>

      <div className="flex flex-wrap gap-4 border-y border-border py-2.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-sm bg-[#2c5545]" /> Verified registry site (active)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-sm bg-[#6b6558]" /> Registry site (other status)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-full bg-[#b07d2b]" /> Environmental observation (open)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-full border-2 border-dashed border-[#9c2b1e]" /> Community report (unverified)
        </span>
      </div>

      <div className="h-[60vh] min-h-[420px] overflow-hidden rounded-sm border border-border">
        <MapContainer center={CENTER} zoom={7} scrollWheelZoom className="size-full">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {siteMarkers.map((s) => (
            <Marker
              key={s._id}
              position={[s.latitude as number, s.longitude as number]}
              icon={siteIcon(s.status === "active" ? "active" : "other")}
            >
              <Popup>
                <strong>{s.name}</strong>
                <br />
                <span className="font-mono text-[11px]">{s.code}</span>
                <br />
                {s.operatorName} · {s.county}
                <br />
                Status: {s.status.replace(/_/g, " ")}
              </Popup>
            </Marker>
          ))}
          {obsMarkers.map((o) => (
            <CircleMarker
              key={o._id}
              center={[o.latitude as number, o.longitude as number]}
              radius={7}
              pathOptions={{ color: "#b07d2b", fillColor: "#b07d2b", fillOpacity: 0.55, weight: 1.5 }}
            >
              <Popup>
                <strong>Environmental observation</strong>
                <br />
                {o.category.replace(/_/g, " ")} · verification: {o.verification}
                <br />
                {o.siteCode}
              </Popup>
            </CircleMarker>
          ))}
          {reportMarkers.map((r) => (
            <CircleMarker
              key={r._id}
              center={[r.latitude as number, r.longitude as number]}
              radius={7}
              pathOptions={{ color: "#9c2b1e", fillColor: "transparent", weight: 2, dashArray: "3 3" }}
            >
              <Popup>
                <strong>Community report — unverified</strong>
                <br />
                <span className="font-mono text-[11px]">{r.trackingCode}</span>
                <br />
                {r.category.replace(/_/g, " ")} · {r.county}
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Community report locations are as reported by the public and have not been
        verified. They never constitute an accusation against any party. Verified
        geographic data comes from the site registry and staff observations only.
      </p>
    </div>
  );
}
