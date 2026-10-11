import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { LocateFixed, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sourceLabel } from "@/lib/gis";
import {
  describeGeolocationError,
  formatCoordinate,
  gpsQuality,
  parsePositionInput,
  type PositionDraft,
} from "@/lib/site-position";
import { useLatest } from "@/lib/use-latest";

// Leaflet is heavy and only needed once someone opens the map.
const LocationPickerMap = lazy(() => import("./LocationPickerMap"));

type GpsState =
  | { phase: "idle" }
  | { phase: "locating" }
  | { phase: "error"; message: string };

/**
 * Three ways to give a site a REAL position, all producing the same draft:
 *   • "Use my current location" — device GPS (with its reported accuracy);
 *   • "Pick on map"             — click, for sites registered from an office;
 *   • typing                    — decimal degrees.
 * Every edit records how the position was obtained. A captured position is a
 * claim, not proof: it stays UNVERIFIED until an administrator verifies it.
 */
export function SiteLocationPicker({
  value,
  onChange,
  disabled,
  autoLocate,
}: {
  value: PositionDraft;
  onChange: (next: PositionDraft) => void;
  disabled?: boolean;
  /** Try the device GPS on mount — only when the browser has ALREADY granted
   *  location permission (never triggers a surprise permission prompt). */
  autoLocate?: boolean;
}) {
  const ids = { lat: useId(), lng: useId() };
  const [gps, setGps] = useState<GpsState>({ phase: "idle" });
  const [showMap, setShowMap] = useState(false);
  const onChangeRef = useLatest(onChange);
  const hasValueRef = useLatest(Boolean(value.latitude || value.longitude));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const parsed = parsePositionInput(value.latitude, value.longitude);
  const point = parsed.kind === "ok" ? { lat: parsed.latitude, lng: parsed.longitude } : null;

  const locate = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGps({ phase: "error", message: describeGeolocationError(0) });
      return;
    }
    setGps({ phase: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!alive.current) return;
        setGps({ phase: "idle" });
        onChangeRef.current({
          latitude: formatCoordinate(pos.coords.latitude),
          longitude: formatCoordinate(pos.coords.longitude),
          accuracyM: Math.round(pos.coords.accuracy * 10) / 10,
          source: "device_gps",
        });
      },
      (err) => {
        if (!alive.current) return;
        setGps({ phase: "error", message: describeGeolocationError(err.code) });
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  };
  const locateRef = useLatest(locate);

  useEffect(() => {
    if (!autoLocate || typeof navigator === "undefined" || !navigator.permissions) return;
    void navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        if (status.state === "granted" && alive.current && !hasValueRef.current) {
          locateRef.current();
        }
      })
      .catch(() => {
        /* Permissions API unsupported for geolocation — the button still works. */
      });
  }, [autoLocate, hasValueRef, locateRef]);

  const typed = (field: "latitude" | "longitude") => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [field]: e.target.value, source: "manual_entry", accuracyM: undefined });

  const picked = (lat: number, lng: number) =>
    onChange({
      latitude: formatCoordinate(lat),
      longitude: formatCoordinate(lng),
      source: "map_pick",
      accuracyM: undefined,
    });

  const quality =
    value.source === "device_gps" && value.accuracyM !== undefined
      ? gpsQuality(value.accuracyM)
      : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={locate}
          disabled={disabled || gps.phase === "locating"}
        >
          <LocateFixed className="size-4" />
          {gps.phase === "locating" ? "Locating…" : "Use my current location"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShowMap((v) => !v)}
          disabled={disabled}
          aria-expanded={showMap}
        >
          <MapPin className="size-4" />
          {showMap ? "Hide map" : "Pick on map"}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={ids.lat}>Latitude</Label>
          <Input
            id={ids.lat}
            value={value.latitude}
            onChange={typed("latitude")}
            placeholder="e.g. 6.43"
            inputMode="decimal"
            disabled={disabled}
            aria-invalid={parsed.kind === "error"}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={ids.lng}>Longitude</Label>
          <Input
            id={ids.lng}
            value={value.longitude}
            onChange={typed("longitude")}
            placeholder="e.g. -9.43"
            inputMode="decimal"
            disabled={disabled}
            aria-invalid={parsed.kind === "error"}
          />
        </div>
      </div>

      <div aria-live="polite" className="space-y-1 text-[11px] leading-relaxed">
        {gps.phase === "error" && <p className="text-destructive">{gps.message}</p>}
        {parsed.kind === "error" && (
          <p className="text-destructive" role="alert">
            {parsed.error}
          </p>
        )}
        {quality && (
          <p className={quality.level === "poor" ? "text-destructive" : "text-muted-foreground"}>
            GPS accuracy ±{value.accuracyM} m ({quality.label}).
            {quality.level === "poor" &&
              " This is too rough for a site position — move into the open and try again, or pick it on the map."}
          </p>
        )}
        {parsed.kind === "ok" && (
          <p className="text-muted-foreground">
            Recorded as: {sourceLabel(value.source)} · unverified until an administrator verifies it.
          </p>
        )}
        {parsed.kind === "empty" && gps.phase !== "error" && (
          <p className="text-muted-foreground">
            Decimal degrees. Liberia is west of the prime meridian, so longitude is negative. A site
            without a position does not appear on the map.
          </p>
        )}
      </div>

      {showMap && (
        <Suspense fallback={<p className="py-6 text-center text-xs text-muted-foreground">Loading map…</p>}>
          <LocationPickerMap position={point} onPick={picked} />
        </Suspense>
      )}
    </div>
  );
}
