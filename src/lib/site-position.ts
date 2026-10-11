// ---------------------------------------------------------------------------
// Site position capture — pure helpers shared by the data layer and the UI.
//
// ONE definition of "a usable Liberian position" lives here, so the form that
// asks for it, the API that stores it and the map that plots it can never
// disagree (they previously did: the map refused what the API accepted).
// ---------------------------------------------------------------------------

import { LIBERIA_BBOX } from "./gis";

/** How a site's point position was obtained. Verification is a SEPARATE,
 *  later, geo.write-only step: a GPS fix or a map click is a claim, not proof. */
export const SITE_POSITION_SOURCES = ["device_gps", "map_pick", "manual_entry"] as const;
export type SitePositionSource = (typeof SITE_POSITION_SOURCES)[number];

export function isSitePositionSource(v: unknown): v is SitePositionSource {
  return typeof v === "string" && (SITE_POSITION_SOURCES as readonly string[]).includes(v);
}

export interface PositionProblem {
  /** Stable token the API throws as `<code>: <message>`. */
  code: "INVALID_LATITUDE" | "INVALID_LONGITUDE";
  message: string;
}

/** Why a latitude/longitude pair cannot be a Liberian position (null = fine).
 *  Either argument may be omitted to check just one axis. Liberia is WEST of
 *  the prime meridian, so its longitudes are negative; a longitude typed
 *  without its minus sign lands in Nigeria/Cameroon. */
export function liberiaPositionProblem(
  lat: number | null | undefined,
  lng: number | null | undefined,
): PositionProblem | null {
  const { minLat, maxLat, minLng, maxLng } = LIBERIA_BBOX;
  if (lat !== null && lat !== undefined && !(lat >= minLat && lat <= maxLat)) {
    return {
      code: "INVALID_LATITUDE",
      message: `${lat} is outside Liberia (latitude must be between ${minLat} and ${maxLat}).`,
    };
  }
  if (lng !== null && lng !== undefined && !(lng >= minLng && lng <= maxLng)) {
    const hint =
      lng > 0 && -lng >= minLng && -lng <= maxLng
        ? ` Liberia is west of the prime meridian — did you mean ${-lng}?`
        : "";
    return {
      code: "INVALID_LONGITUDE",
      message: `${lng} is outside Liberia (longitude must be between ${minLng} and ${maxLng}; west is negative).${hint}`,
    };
  }
  return null;
}

export type ParsedPosition =
  | { kind: "empty" }
  | { kind: "ok"; latitude: number; longitude: number }
  | { kind: "error"; error: string };

/** Validate what a person typed (or a picker produced) into the two fields. */
export function parsePositionInput(latText: string, lngText: string): ParsedPosition {
  const latRaw = latText.trim();
  const lngRaw = lngText.trim();
  if (!latRaw && !lngRaw) return { kind: "empty" };
  if (!latRaw || !lngRaw) {
    return { kind: "error", error: "Enter both latitude and longitude, or leave both empty." };
  }
  const latitude = Number(latRaw);
  const longitude = Number(lngRaw);
  if (!Number.isFinite(latitude)) {
    return { kind: "error", error: "Latitude must be a number, for example 6.43." };
  }
  if (!Number.isFinite(longitude)) {
    return { kind: "error", error: "Longitude must be a number, for example -9.43." };
  }
  const problem = liberiaPositionProblem(latitude, longitude);
  if (problem) return { kind: "error", error: problem.message };
  return { kind: "ok", latitude, longitude };
}

export type GpsQuality = "good" | "fair" | "poor";

/** Plain-language reading of a device GPS accuracy radius (metres). */
export function gpsQuality(accuracyM: number): { level: GpsQuality; label: string } {
  if (accuracyM <= 20) return { level: "good", label: "good" };
  if (accuracyM <= 100) return { level: "fair", label: "fair" };
  return { level: "poor", label: "low" };
}

/** Actionable text for a GeolocationPositionError (codes per the W3C spec). */
export function describeGeolocationError(code: number): string {
  switch (code) {
    case 1:
      return "Location permission was denied. Allow location access for this site in your browser settings, or pick the position on the map.";
    case 2:
      return "Your device could not determine its position. Move to an open area and try again, or pick the position on the map.";
    case 3:
      return "Getting your position took too long. Move to an open area and try again, or pick the position on the map.";
    default:
      return "Could not read your location. Pick the position on the map or type the coordinates.";
  }
}

/** Fixed-precision coordinate text for inputs (≈ 0.1 m at 6 decimals). */
export function formatCoordinate(n: number, digits = 6): string {
  return Number(n.toFixed(digits)).toString();
}

/** Accuracy is optional; when present it must be a finite, non-negative metre
 *  radius. Returns an error token or null. */
export function accuracyProblem(accuracyM: number | null | undefined): string | null {
  if (accuracyM === null || accuracyM === undefined) return null;
  return Number.isFinite(accuracyM) && accuracyM >= 0 ? null : "INVALID_ACCURACY";
}

/** What a position editor holds while the person is working: the two fields as
 *  TEXT (so half-typed input is representable), plus how it was obtained. */
export interface PositionDraft {
  latitude: string;
  longitude: string;
  /** Reported GPS accuracy radius in metres (device_gps only). */
  accuracyM?: number;
  source: SitePositionSource;
}

export const EMPTY_POSITION_DRAFT: PositionDraft = {
  latitude: "",
  longitude: "",
  source: "manual_entry",
};

/** Seed an editor from a stored site (blank when it has no position yet). */
export function draftFromSite(site: {
  latitude?: number | null;
  longitude?: number | null;
  geoSource?: string | null;
  geoAccuracyM?: number | null;
}): PositionDraft {
  const has = site.latitude != null && site.longitude != null;
  return {
    latitude: has ? formatCoordinate(site.latitude as number) : "",
    longitude: has ? formatCoordinate(site.longitude as number) : "",
    accuracyM: site.geoAccuracyM ?? undefined,
    source: isSitePositionSource(site.geoSource) ? site.geoSource : "manual_entry",
  };
}
