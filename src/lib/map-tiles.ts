// ---------------------------------------------------------------------------
// OFFLINE TILE STRATEGY (GIS-5) — "cached region tiles within provider policy".
//
// PROVIDER POLICY (OpenStreetMap Tile Usage Policy): bulk downloading or
// pre-seeding tiles is prohibited/discouraged; caching of tiles a user has
// actually viewed, honouring normal HTTP semantics, is expected. Therefore:
//
//   1. NO prefetch, NO "download this region" button against tile.openstreetmap.org.
//   2. public/sw.js caches ONLY tiles the map actually requested while online,
//      ONLY inside the Liberia region (bbox below) and zoom range, in a bounded
//      cache (TILE_CACHE_MAX_ENTRIES, oldest evicted). Online = network-first
//      (provider headers/policy always apply); offline = last-seen tile.
//   3. For SUSTAINED offline field mapping the documented alternative is a
//      licensed/own offline bundle (MBTiles/PMTiles) served from our own
//      origin: set VITE_TILE_URL to that template (e.g. "/tiles/{z}/{x}/{y}.png"
//      or a tile server behind our origin) and the cache rules above apply to
//      it too. A tile server on a THIRD-PARTY origin other than OSM is not
//      intercepted by the worker (we cannot know its policy) and is left to
//      the browser's normal HTTP cache. See docs/06_GIS_ARCHITECTURE.MD
//      §Offline tiles.
//   4. Tiles are requested in CORS mode (tileCrossOrigin) — a plain <img>
//      tile request is "no-cors", whose response is OPAQUE (status 0,
//      ok=false): the worker could not tell a good tile from an error page,
//      and browsers pad opaque entries' storage cost so heavily that a
//      1,500-tile cache would exhaust the origin quota. OSM and our own
//      origin both serve tiles with CORS headers.
//
// This module is the single source of the numbers; public/sw.js duplicates
// them (a worker cannot import TS) and tests/gis.test.ts pins the two copies
// to each other.
// ---------------------------------------------------------------------------

import { LIBERIA_BBOX } from "./gis";

export const OSM_TILE_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const TILE_CACHE_NAME = "mgtiles-v1"; // NOT "mineguard-*": survives shell upgrades
export const TILE_CACHE_MAX_ENTRIES = 1500;
export const TILE_MIN_ZOOM = 5;
export const TILE_MAX_ZOOM = 14;

export function tileTemplate(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_TILE_URL?.trim() || OSM_TILE_TEMPLATE;
}

const OSM_TILE_HOST = /(^|\.)tile\.openstreetmap\.org$/;

/** `crossOrigin` value for the TileLayer: "anonymous" for tile sources that
 *  are cacheable by the worker (the public OSM host and our own origin),
 *  undefined otherwise (an unknown third-party host may not send CORS
 *  headers, and forcing CORS mode on it would stop its tiles loading). */
export function tileCrossOrigin(
  template: string = tileTemplate(),
  pageOrigin: string | undefined = typeof location !== "undefined" ? location.origin : undefined,
): "anonymous" | undefined {
  try {
    // Without a page (SSR/tests) a relative template still means "our origin".
    const base = pageOrigin ?? "https://same-origin.invalid";
    const u = new URL(template, base);
    if (OSM_TILE_HOST.test(u.hostname)) return "anonymous";
    return u.origin === new URL(base).origin ? "anonymous" : undefined;
  } catch {
    return undefined;
  }
}

export function tileAttribution(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_TILE_ATTRIBUTION?.trim() || OSM_ATTRIBUTION;
}

export function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}

export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/** Is tile z/x/y inside the cache region (Liberia bbox, zoom window)? */
export function tileInRegion(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || z < TILE_MIN_ZOOM || z > TILE_MAX_ZOOM) return false;
  const x0 = lngToTileX(LIBERIA_BBOX.minLng, z);
  const x1 = lngToTileX(LIBERIA_BBOX.maxLng, z);
  const y0 = latToTileY(LIBERIA_BBOX.maxLat, z); // north edge = smaller y
  const y1 = latToTileY(LIBERIA_BBOX.minLat, z);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** Parse /{z}/{x}/{y}.png from a tile URL path. */
export function parseTilePath(pathname: string): { z: number; x: number; y: number } | null {
  const m = /\/(\d{1,2})\/(\d+)\/(\d+)\.(?:png|jpg|jpeg|webp|pbf)$/.exec(pathname);
  if (!m) return null;
  return { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
}

export function shouldCacheTile(url: string): boolean {
  try {
    const t = parseTilePath(new URL(url).pathname);
    return !!t && tileInRegion(t.z, t.x, t.y);
  } catch {
    return false;
  }
}
