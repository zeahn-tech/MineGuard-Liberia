// ---------------------------------------------------------------------------
// GIS-5 — the service worker's tile path, EXECUTED (not just grepped).
//
// public/sw.js is evaluated in a vm sandbox with a fake Cache Storage and a
// scripted `fetch`, then driven with synthetic FetchEvents. This pins the
// behavior the provider policy and the offline promise depend on:
//   * only in-region, in-zoom tiles are stored; only readable (ok) responses;
//   * online is network-first, offline serves the last-seen tile;
//   * the cache is bounded (oldest evicted);
//   * exactly one network call per tile the map asked for — no prefetch;
//   * non-tile traffic is left alone.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import {
  TILE_CACHE_MAX_ENTRIES,
  TILE_CACHE_NAME,
  TILE_MAX_ZOOM,
  latToTileY,
  lngToTileX,
  shouldCacheTile,
  tileCrossOrigin,
} from "../src/lib/map-tiles";

const SW_SOURCE = readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8");
const ORIGIN = "https://app.test";

interface FakeRequest {
  method: string;
  url: string;
  mode: string;
  destination: string;
}

/** Fake Cache Storage: name → (url → response), insertion-ordered. */
function makeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (req: FakeRequest | string, res: Response) => {
        const key = typeof req === "string" ? req : req.url;
        store.delete(key); // re-put refreshes recency, like the real API
        store.set(key, res);
      },
      match: async (req: FakeRequest | string) =>
        store.get(typeof req === "string" ? req : req.url)?.clone(),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (key: { url: string }) => store.delete(key.url),
    };
  };
  return {
    stores,
    api: {
      open,
      keys: async () => [...stores.keys()],
      delete: async (n: string) => stores.delete(n),
      match: async (req: FakeRequest | string) => {
        const key = typeof req === "string" ? req : req.url;
        for (const store of stores.values()) if (store.has(key)) return store.get(key)!.clone();
        return undefined;
      },
    },
  };
}

function loadWorker(fetchImpl: (req: FakeRequest) => Promise<Response>) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const caches = makeCaches();
  let fetchCalls = 0;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const sandbox = {
    self: {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = fn;
      },
      location: { origin: ORIGIN },
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
    caches: caches.api,
    fetch: (req: FakeRequest) => {
      fetchCalls++;
      return fetchImpl(req);
    },
    URL,
    Math,
    Number,
    Promise,
    Response,
    console,
    // Timers the test fires by hand, so a 5 s stall is simulated instantly.
    setTimeout: (fn: () => void) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  };
  vm.runInNewContext(SW_SOURCE, sandbox);

  /** Dispatch a fetch event; resolves to the response, or null when the
   *  worker did not handle (respondWith never called). */
  async function dispatch(request: Partial<FakeRequest> & { url: string }) {
    let responded: Promise<Response> | null = null;
    listeners.fetch({
      request: { method: "GET", mode: "no-cors", destination: "image", ...request },
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    return responded ? await (responded as Promise<Response>) : null;
  }
  return {
    dispatch,
    tileStore: () => caches.stores.get(TILE_CACHE_NAME) ?? new Map<string, Response>(),
    shellStore: () =>
      [...caches.stores.entries()].find(([name]) => name.startsWith("mineguard-shell-"))?.[1] ??
      new Map<string, Response>(),
    fetchCalls: () => fetchCalls,
    /** Fire every pending timer (i.e. "the time limit has now elapsed"). */
    fireTimers: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    pendingTimers: () => timers.size,
  };
}

const okTile = () => new Response("png-bytes", { status: 200 });
const z = 10;
const liberiaTile = (x = lngToTileX(-10.8, z), y = latToTileY(6.3, z)) =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

describe("service worker tile cache (executed)", () => {
  test("an in-region tile is fetched ONCE, returned, and stored", async () => {
    const w = loadWorker(async () => okTile());
    const url = liberiaTile();
    const res = await w.dispatch({ url });
    expect(await res!.text()).toBe("png-bytes");
    expect(w.fetchCalls()).toBe(1); // no prefetch of neighbours
    expect([...w.tileStore().keys()]).toEqual([url]);
  });

  test("out-of-region and out-of-zoom tiles are served but never stored", async () => {
    const w = loadWorker(async () => okTile());
    const paris = `https://tile.openstreetmap.org/${z}/${lngToTileX(2.35, z)}/${latToTileY(48.85, z)}.png`;
    const tooDeep = `https://tile.openstreetmap.org/15/${lngToTileX(-10.8, 15)}/${latToTileY(6.3, 15)}.png`;
    for (const url of [paris, tooDeep]) {
      const res = await w.dispatch({ url });
      expect(res).not.toBeNull();
    }
    expect(w.tileStore().size).toBe(0);
  });

  test("error and opaque responses are never stored", async () => {
    const opaque = { ok: false, status: 0, type: "opaque", clone: () => opaque } as unknown as Response;
    const responses = [new Response("slow down", { status: 429 }), opaque];
    const w = loadWorker(async () => responses.shift()!);
    await w.dispatch({ url: liberiaTile(1, 1) });
    await w.dispatch({ url: liberiaTile() });
    expect(w.tileStore().size).toBe(0);
  });

  test("online is network-first (a cached copy never shadows a live tile)", async () => {
    let body = "v1";
    const w = loadWorker(async () => new Response(body));
    const url = liberiaTile();
    await w.dispatch({ url });
    body = "v2";
    const res = await w.dispatch({ url });
    expect(await res!.text()).toBe("v2");
    expect(w.fetchCalls()).toBe(2);
  });

  test("offline serves the last-seen tile; an unseen tile fails (no invention)", async () => {
    let online = true;
    const w = loadWorker(async () => {
      if (!online) throw new TypeError("network down");
      return okTile();
    });
    const seen = liberiaTile();
    await w.dispatch({ url: seen });
    online = false;
    const res = await w.dispatch({ url: seen });
    expect(await res!.text()).toBe("png-bytes");
    await expect(w.dispatch({ url: liberiaTile(1, 2) })).rejects.toThrow("network down");
  });

  test("the cache is bounded: the oldest tiles are evicted first", async () => {
    const w = loadWorker(async () => okTile());
    // Zoom 14 (the deepest cached level) has far more in-region tiles than the
    // cache bound, so every URL below is a distinct, cacheable tile.
    const zDeep = TILE_MAX_ZOOM;
    const x0 = lngToTileX(-10.8, zDeep);
    const y0 = latToTileY(6.3, zDeep);
    const extra = 5;
    const urls: string[] = [];
    for (let i = 0; i < TILE_CACHE_MAX_ENTRIES + extra; i++) {
      const url = `https://tile.openstreetmap.org/${zDeep}/${x0 + (i % 100)}/${y0 + Math.floor(i / 100)}.png`;
      expect(shouldCacheTile(url)).toBe(true); // guard: the data really is in-region
      urls.push(url);
      await w.dispatch({ url });
    }
    // trimming runs un-awaited after each put — let the last one finish
    await new Promise((r) => setTimeout(r, 20));
    expect(new Set(urls).size).toBe(urls.length);
    expect(w.tileStore().size).toBeLessThanOrEqual(TILE_CACHE_MAX_ENTRIES);
    expect(w.tileStore().has(urls[0])).toBe(false); // oldest gone
    expect(w.tileStore().has(urls[urls.length - 1])).toBe(true); // newest kept
  });

  test("our own origin's tile bundle (VITE_TILE_URL) is cached under the same rules", async () => {
    const w = loadWorker(async () => okTile());
    const url = `${ORIGIN}/tiles/${z}/${lngToTileX(-10.8, z)}/${latToTileY(6.3, z)}.png`;
    await w.dispatch({ url });
    expect(w.tileStore().has(url)).toBe(true);
  });

  test("non-tile traffic is not intercepted: other hosts, scripts, non-GET", async () => {
    const w = loadWorker(async () => okTile());
    const thirdParty = `https://tiles.example.org/${z}/${lngToTileX(-10.8, z)}/${latToTileY(6.3, z)}.png`;
    expect(await w.dispatch({ url: thirdParty })).toBeNull();
    expect(await w.dispatch({ url: liberiaTile(), destination: "script" })).toBeNull();
    expect(await w.dispatch({ url: liberiaTile(), method: "POST" })).toBeNull();
    expect(w.fetchCalls()).toBe(0);
    expect(w.tileStore().size).toBe(0);
  });
});

describe("tileCrossOrigin (tiles must be readable to be cacheable)", () => {
  const page = "https://app.test";
  test("OSM and our own origin load tiles in CORS mode", () => {
    expect(tileCrossOrigin("https://tile.openstreetmap.org/{z}/{x}/{y}.png", page)).toBe("anonymous");
    expect(tileCrossOrigin("/tiles/{z}/{x}/{y}.png", page)).toBe("anonymous");
    expect(tileCrossOrigin("https://app.test/tiles/{z}/{x}/{y}.png", page)).toBe("anonymous");
    expect(tileCrossOrigin("/tiles/{z}/{x}/{y}.png", undefined)).toBe("anonymous");
  });
  test("an unknown third-party host is left in default mode (it may not send CORS headers)", () => {
    expect(tileCrossOrigin("https://tiles.example.org/{z}/{x}/{y}.png", page)).toBeUndefined();
    expect(tileCrossOrigin("https://tiles.example.org/{z}/{x}/{y}.png", undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The app shell: network-first, but a stalled network must not hold the page
// hostage (a phone on weak data stared at a blank screen while a good cached
// shell sat unused).
// ---------------------------------------------------------------------------
describe("service worker navigation (executed)", () => {
  const NAV = { url: `${ORIGIN}/`, mode: "navigate", destination: "document" };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const text = async (res: Response | null) => (res ? await res.text() : null);

  /** A fetch the test settles by hand. */
  function deferredFetch() {
    let resolve!: (r: Response) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { fetch: () => p, resolve, reject };
  }

  test("when the network answers, the page comes from the network and the shell is refreshed", async () => {
    const w = loadWorker(async () => new Response("fresh shell"));
    const res = await w.dispatch(NAV);
    expect(await text(res)).toBe("fresh shell");
    await flush();
    expect(await w.shellStore().get("./index.html")?.text()).toBe("fresh shell");
  });

  test("a STALLED network falls back to the cached shell after the time limit — and still refreshes the cache when it finally answers", async () => {
    // One worker: the first visit succeeds (seeding the cache), the second stalls.
    let mode: "ok" | "stall" = "ok";
    let release!: (r: Response) => void;
    const w = loadWorker(() =>
      mode === "ok"
        ? Promise.resolve(new Response("old shell"))
        : new Promise<Response>((r) => {
            release = r;
          }),
    );
    expect(await text(await w.dispatch(NAV))).toBe("old shell");
    await flush();

    mode = "stall";
    const pending = w.dispatch(NAV);
    w.fireTimers(); // the time limit elapses with no answer
    expect(await text(await pending)).toBe("old shell"); // shown instead of a blank page

    release(new Response("new shell")); // the network eventually answers…
    await flush();
    await flush();
    expect(await w.shellStore().get("./index.html")?.text()).toBe("new shell"); // …and refreshes the cache
  });

  test("with NO cached shell there is nothing to fall back to, so it keeps waiting for the network", async () => {
    const net = deferredFetch();
    const w = loadWorker(net.fetch);
    let settled = false;
    const pending = w.dispatch(NAV).then((r) => {
      settled = true;
      return r;
    });
    w.fireTimers();
    await flush();
    expect(settled).toBe(false); // not resolved with `undefined`
    net.resolve(new Response("first ever shell"));
    expect(await text(await pending)).toBe("first ever shell");
  });

  test("an offline failure serves the cached shell; with nothing cached it is a readable offline page, not a browser dead end", async () => {
    let online = true;
    const w = loadWorker(async () => {
      if (!online) throw new TypeError("offline");
      return new Response("shell");
    });
    expect(await text(await w.dispatch(NAV))).toBe("shell");
    await flush();
    online = false;
    expect(await text(await w.dispatch(NAV))).toBe("shell");

    const empty = loadWorker(async () => {
      throw new TypeError("offline");
    });
    const res = (await empty.dispatch(NAV)) as Response;
    expect(res.type).not.toBe("error");
    expect(res.status).toBe(503);
    expect(await text(res)).toContain("Can't connect right now");
  });

  test("a server error page is replaced by the cached shell and never becomes the cached shell", async () => {
    let status = 200;
    const w = loadWorker(async () => new Response(status === 200 ? "good shell" : "Bad Gateway", { status }));
    expect(await text(await w.dispatch(NAV))).toBe("good shell");
    await flush();
    status = 502;
    // "Site not found" / 5xx from the host must not trap an installed app:
    // the last good shell is served instead...
    expect(await text(await w.dispatch(NAV))).toBe("good shell");
    await flush();
    expect(await w.shellStore().get("./index.html")?.text()).toBe("good shell");
  });

  test("a server error page with nothing cached is still shown (nothing better to serve)", async () => {
    const w = loadWorker(async () => new Response("Bad Gateway", { status: 502 }));
    const res = (await w.dispatch(NAV)) as Response;
    expect(res.status).toBe(502);
    await flush();
    expect(w.shellStore().get("./index.html")).toBeUndefined();
  });

  test("an answered request leaves no timer behind", async () => {
    const w = loadWorker(async () => new Response("shell"));
    await w.dispatch(NAV);
    expect(w.pendingTimers()).toBe(0);
  });
});
