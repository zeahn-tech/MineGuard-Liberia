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

const VERSION = "v1.3.0";
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
function isTileRequest(req, url) {
  // Only requests the map's own <img> tiles made (never a script/fetch of
  // ours), for the public OSM host or our own origin (an offline bundle
  // behind VITE_TILE_URL). Other third-party hosts are left to the browser.
  if (req.destination !== "image" || !parseTile(url.pathname)) return false;
  return TILE_HOST.test(url.hostname) || url.origin === self.location.origin;
}
async function trimTiles(cache) {
  const keys = await cache.keys(); // insertion order → oldest first
  for (let i = 0; i < keys.length - TILE_CACHE_MAX_ENTRIES; i++) await cache.delete(keys[i]);
}
/** Network-first (provider headers/policy always apply online); the cache is
 *  only the offline fallback. Never fetches anything the map did not ask for.
 *  Only readable (res.ok) responses are stored: the map requests tiles in CORS
 *  mode, and an opaque response (status 0) is never cached — it cannot be
 *  validated and carries a large storage-quota padding. */
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

/** How long a page request may stall before the cached shell is shown instead. */
const NAV_NETWORK_TIMEOUT_MS = 2500;

/** Network-first for the app shell, but BOUNDED. A plain network-first fetch has
 *  no time limit: on a stalled mobile connection (weak signal, captive Wi-Fi,
 *  a tab waking from the background) the page request just hangs and the user
 *  stares at a blank screen while a perfectly good cached shell sits unused.
 *  Here the network still wins when it answers; if it has not answered within
 *  NAV_NETWORK_TIMEOUT_MS and a cached shell exists, the shell is shown and the
 *  request carries on in the background to refresh the cache for next time.
 *  With no cached shell there is nothing to fall back to, so it keeps waiting. */
function navigationResponse(req) {
  const cachedShell = () =>
    caches.match("./index.html").then((r) => r || caches.match("./"));
  // Last resort when there is neither network nor a cached shell (first ever
  // launch while offline): a readable page with a retry, never the browser's
  // "site can't be reached" dead end.
  const offlinePage = () =>
    new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        "<title>MineGuard Liberia</title>" +
        '<body style="font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center;background:#F0EEE6;color:#232019">' +
        "<main><h1 style=\"font-size:1.25rem\">Can't connect right now</h1>" +
        "<p>MineGuard needs a connection the first time it opens. Check your signal, then try again.</p>" +
        '<p><button onclick="location.reload()" style="padding:10px 18px;font-size:1rem">Try again</button></p></main>',
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  return new Promise((resolve) => {
    let settled = false;
    const settle = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      cachedShell().then((r) => {
        if (r) settle(r);
      });
    }, NAV_NETWORK_TIMEOUT_MS);
    fetch(req).then(
      (res) => {
        // Only cache a good shell — never a 404/500 page (even when it arrives
        // after the cached shell was already shown).
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          settle(res);
          return;
        }
        // The host answered with an error page ("site not found", 5xx):
        // prefer the cached app shell over showing that dead end.
        cachedShell().then((r) => settle(r || res));
      },
      () => cachedShell().then((r) => settle(r || offlinePage())),
    );
  });
}

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
    event.respondWith(navigationResponse(req));
    return;
  }

  // Map tiles: bounded, region-limited, view-driven cache (see header above).
  if (isTileRequest(req, url)) {
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
