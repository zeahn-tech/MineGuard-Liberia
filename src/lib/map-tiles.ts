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
//      or a tile server) and the cache rules above still apply to it. See
//      docs/06_GIS_ARCHITECTURE.MD §Offline tiles.
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
