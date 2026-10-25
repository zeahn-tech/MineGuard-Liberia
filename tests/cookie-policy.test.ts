/* eslint-disable @typescript-eslint/no-explicit-any */
// The Cookie Policy and banner must describe what the app ACTUALLY does.
// These tests fail if code and policy drift apart.
import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const walk = (d: string): string[] =>
  readdirSync(join(ROOT, d)).flatMap((f) => {
    const rel = join(d, f);
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
const SRC = walk("src").filter((f) => /\.(ts|tsx)$/.test(f));

const policy = read("src/pages/Cookies.tsx");

describe("policy lists every storage item the code uses", () => {
  test("every string literal naming a stored key ('mg.xxx') appears in the policy", () => {
    const keys = new Set<string>();
    for (const f of SRC) {
      if (f.includes("Cookies.tsx")) continue;
      for (const m of read(f).matchAll(/["'`](mg\.[a-z][a-z0-9.-]*[a-z0-9])(?:\.v\d+)?["'`]/g)) keys.add(m[0].slice(1, -1));
    }
    const missing = [...keys].filter((k) => {
      if (k.endsWith(".")) return false;
      return !policy.includes(k) && !policy.includes(k.replace(/\.v\d+$/, ""));
    });
    expect(missing).toEqual([]);
    expect(keys.size).toBeGreaterThan(5); // guard: the scan found something
  });

  test("caches opened by the worker/app are disclosed", () => {
    const sw = read("public/sw.js");
    expect(sw).toContain("mineguard-shell-");
    expect(policy).toContain("mineguard-shell-*");
    expect(sw).toContain('"mgtiles-v1"');
    expect(policy).toContain("mgtiles-v1");
  });

  test("tile cache size claim matches code", () => {
    expect(read("src/lib/map-tiles.ts")).toContain("TILE_CACHE_MAX_ENTRIES = 1500");
    expect(policy).toContain("1,500");
  });
});

describe("'we set no cookies' is true", () => {
  test("nothing writes document.cookie except the unused shadcn sidebar", () => {
    const writers = SRC.filter((f) => /document\.cookie\s*=/.test(read(f)));
    expect(writers).toEqual([join("src", "components", "ui", "sidebar.tsx")]);
  });
  test("…and that sidebar is not used anywhere", () => {
    const users = SRC.filter(
      (f) =>
        !f.endsWith(join("ui", "sidebar.tsx")) &&
        !f.endsWith(join("ui", "index.ts")) && // barrel re-export only
        /components\/ui\/sidebar|SidebarProvider/.test(read(f)),
    );
    expect(users).toEqual([]);
  });
  test("no analytics / ad / tracking SDKs in dependencies or source", () => {
    const pkg = read("package.json").toLowerCase();
    for (const n of ["google-analytics", "gtag", "mixpanel", "segment", "sentry", "posthog", "hotjar", "plausible", "facebook", "fbq", "amplitude", "clarity"]) {
      expect(pkg.includes(n)).toBe(false);
    }
    const html = read("index.html").toLowerCase();
    expect(html.includes("googletagmanager") || html.includes("analytics")).toBe(false);
  });
});

describe("third-party map tiles are opt-in everywhere", () => {
  test("only ConsentTileLayer renders a TileLayer", () => {
    const offenders = SRC.filter((f) => !f.endsWith("ConsentTileLayer.tsx") && /<TileLayer/.test(read(f)));
    expect(offenders).toEqual([]);
  });
  test("every map shows the opt-in notice", () => {
    for (const f of ["src/pages/NationalMap.tsx", "src/components/LocationPickerMap.tsx", "src/components/BoundaryPreviewMap.tsx"]) {
      const s = read(f);
      expect(s).toContain("<ConsentTileLayer />");
      expect(s).toContain("<MapTilesNotice />");
    }
  });
  test("the CSP allows the tile host only for images", () => {
    const v = read("vite.config.ts");
    expect(v).toContain("img-src 'self' data: blob: https://tile.openstreetmap.org");
    expect(/connect-src[^`"]*tile\.openstreetmap/.test(v)).toBe(false);
  });
});

describe("routes and entry points", () => {
  test("public /cookies route, banner mounted, footer links", () => {
    const main = read("src/main.tsx");
    expect(main).toContain('path="/cookies"');
    expect(main.slice(main.indexOf('path="/cookies"'), main.indexOf('path="/cookies"') + 100)).not.toContain("RequireAuth");
    expect(main).toContain("<CookieBanner />");
    const layout = read("src/components/LegalLayout.tsx");
    expect(layout).toContain('to="/cookies"');
    expect(layout).toContain("Cookie settings");
  });
});

// ------------------------------------------------------------ behaviour
class MemStore {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}
const deleted: string[] = [];

describe("consent logic", () => {
  let c: typeof import("../src/lib/consent");
  beforeEach(async () => {
    (globalThis as any).localStorage = new MemStore();
    (globalThis as any).caches = { delete: async (n: string) => { deleted.push(n); return true; } };
    deleted.length = 0;
    c = await import("../src/lib/consent");
    c.__resetConsentForTests();
  });

  test("before any choice every optional category is OFF", () => {
    expect(c.getConsent()).toEqual({ mapTiles: false, decided: false });
    expect(c.mapTilesAllowed()).toBe(false);
  });
  test("accepting turns tiles on and records version + time", () => {
    c.setConsent({ mapTiles: true });
    expect(c.mapTilesAllowed()).toBe(true);
    const stored = JSON.parse((globalThis as any).localStorage.getItem(c.CONSENT_STORAGE_KEY));
    expect(stored.v).toBe(c.CONSENT_VERSION);
    expect(typeof stored.at).toBe("string");
  });
  test("withdrawing turns tiles off AND deletes the saved tile cache", () => {
    c.setConsent({ mapTiles: true });
    c.setConsent({ mapTiles: false });
    expect(c.mapTilesAllowed()).toBe(false);
    expect(deleted).toContain("mgtiles-v1");
  });
  test("a stale/garbled/other-version record is treated as 'not decided'", () => {
    const ls = (globalThis as any).localStorage as MemStore;
    ls.setItem(c.CONSENT_STORAGE_KEY, JSON.stringify({ v: 999, mapTiles: true, at: "x" }));
    c.__resetConsentForTests();
    expect(c.getConsent().decided).toBe(false);
    ls.setItem(c.CONSENT_STORAGE_KEY, "{not json");
    c.__resetConsentForTests();
    expect(c.getConsent()).toEqual({ mapTiles: false, decided: false });
  });
});
