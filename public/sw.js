/* ---------------------------------------------------------------------------
 * MINEGUARD LIBERIA — SERVICE WORKER
 *
 * Strategy: network-first for navigations, cache fallback so the app shell
 * still loads with no connectivity (fits the offline-first field operations
 * model — drafts live in localStorage and sync on reconnect).
 *
 * Caching is restricted to IMMUTABLE build output (hashed /assets/* bundles,
 * icons, manifest). Dev/preview module requests (/src/*, /@vite/*,
 * /@react-refresh, /node_modules/*) are never cached — a cache-first worker
 * serving those is exactly what produces a stale/broken preview.
 * Version bump busts the cache on deploy.
 * ------------------------------------------------------------------------- */

const VERSION = "v1.1.0";
const CACHE = `mineguard-shell-${VERSION}`;

// ---- Map tiles (GIS-5) — keep in sync with src/lib/map-tiles.ts (pinned by
// tests/gis.test.ts). Provider policy: ONLY tiles the map requested while
// online, ONLY inside Liberia + zoom window, bounded cache, NO prefetch.
// The cache name deliberately does not start with "mineguard-" so the shell
// upgrade in `activate` never wipes the tiles a field team already saw.
const TILE_CACHE = "mgtiles-v1";
const TILE_CACHE_MAX_ENTRIES = 1500;
const TILE_MIN_ZOOM = 5;
const TILE_MAX_ZOOM = 14;
const TILE_BBOX = { minLng: -11.6, maxLng: -7.3, minLat: 4.3, maxLat: 8.6 };
const TILE_HOST = /(^|\.)tile\.openstreetmap\.org$/;

function lngToTileX(lng, z) {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
}
function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
}
function tileInRegion(z, x, y) {
  if (!Number.isInteger(z) || z < TILE_MIN_ZOOM || z > TILE_MAX_ZOOM) return false;
  return (
    x >= lngToTileX(TILE_BBOX.minLng, z) &&
    x <= lngToTileX(TILE_BBOX.maxLng, z) &&
    y >= latToTileY(TILE_BBOX.maxLat, z) &&
    y <= latToTileY(TILE_BBOX.minLat, z)
  );
}
function parseTile(pathname) {
  const m = /\/(\d{1,2})\/(\d+)\/(\d+)\.(?:png|jpg|jpeg|webp|pbf)$/.exec(pathname);
  return m ? { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) } : null;
}
function isTileRequest(url) {
  // The configured offline origin (VITE_TILE_URL) is same-origin and handled
  // by the generic same-origin rules; this branch is the public OSM host.
  return TILE_HOST.test(url.hostname) && !!parseTile(url.pathname);
}
async function trimTiles(cache) {
  const keys = await cache.keys(); // insertion order → oldest first
  for (let i = 0; i < keys.length - TILE_CACHE_MAX_ENTRIES; i++) await cache.delete(keys[i]);
}
/** Network-first (provider headers/policy always apply online); the cache is
 *  only the offline fallback. Never fetches anything the map did not ask for. */
async function tileResponse(req, url) {
  const t = parseTile(url.pathname);
  const cache = await caches.open(TILE_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && t && tileInRegion(t.z, t.x, t.y)) {
      await cache.put(req, res.clone());
      trimTiles(cache).catch(() => {});
    }
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
}

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/pwa-192.png",
  "./icons/pwa-512.png",
  "./icons/pwa-maskable-192.png",
  "./icons/pwa-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

/** Immutable build output — safe to serve cache-first forever. */
function isCacheableAsset(pathname) {
  if (pathname.includes("/assets/")) return true; // hashed bundles
  if (pathname.includes("/icons/")) return true;
  if (pathname.endsWith("/manifest.webmanifest")) return true;
  return false;
}

/** Dev/preview module requests — must always hit the network. */
function isDevRequest(pathname) {
  return (
    pathname.startsWith("/@") || // /@vite/client, /@react-refresh, /@fs/
    pathname.startsWith("/src/") ||
    pathname.startsWith("/node_modules/") ||
    pathname.includes("/__vite") ||
    pathname.endsWith(".ts") ||
    pathname.endsWith(".tsx")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Add entries individually: cache.addAll() rejects (and aborts the whole
      // worker install) if ANY single URL 404s. A missing optional asset must
      // never stop the offline shell from installing.
      .then((cache) =>
        Promise.all(
          PRECACHE.map((u) =>
            cache.add(u).catch((e) => console.warn("[sw] precache skipped", u, e)),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("mineguard-") && k !== CACHE) // tiles (mgtiles-*) are kept
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache backend traffic — data must be live or fail loudly (the app
  // has its own offline queue for writes; reads show empty/loading states).
  if (
    url.hostname.endsWith("supabase.co") ||
    url.hostname.endsWith("supabase.in")
  ) {
    return;
  }

  // Navigations: network first, fall back to the cached shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only cache a good shell — never a 404/500 page.
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("./index.html", copy));
          }
          return res;
        })
        .catch(() =>
          caches.match("./index.html").then((r) => r || caches.match("./")),
        ),
    );
    return;
  }

  // Map tiles: bounded, region-limited, view-driven cache (see header above).
  if (isTileRequest(url)) {
    event.respondWith(tileResponse(req, url));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Dev/preview modules: never intercept. Serving an old cached module here
  // breaks the preview after edits (and can serve stale app code).
  if (isDevRequest(url.pathname)) return;

  // Immutable build assets only: cache first.
  if (isCacheableAsset(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
