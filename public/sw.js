/* ---------------------------------------------------------------------------
 * MINEGUARD LIBERIA — SERVICE WORKER
 *
 * Strategy: network-first for navigations, cache fallback so the app shell
 * still loads with no connectivity (fits the offline-first field operations
 * model — drafts live in localStorage and sync on reconnect).
 * Version bump busts the cache on deploy.
 * ------------------------------------------------------------------------- */

const VERSION = "v1.0.1";
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

  // Same-origin assets: cache first (hashed filenames are immutable).
  if (url.origin === self.location.origin) {
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
