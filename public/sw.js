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

const VERSION = "v1.0.2";
const CACHE = `mineguard-shell-${VERSION}`;

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
      .then((cache) => cache.addAll(PRECACHE))
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
            .filter((k) => k.startsWith("mineguard-") && k !== CACHE)
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

  // Never cache Firebase traffic — data must be live or fail loudly (the app
  // has its own offline queue for writes; reads show empty/loading states).
  if (
    url.hostname.endsWith("firebaseio.com") ||
    url.hostname.endsWith("googleapis.com") ||
    url.hostname.endsWith("firebaseapp.com") ||
    url.hostname.endsWith("firebasestorage.app") ||
    url.hostname.endsWith("cloudfunctions.net")
  ) {
    return;
  }

  // Navigations: network first, fall back to the cached shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() =>
          caches.match("./index.html").then((r) => r || caches.match("./")),
        ),
    );
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
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
  }
});
