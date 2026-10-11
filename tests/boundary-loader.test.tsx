// ---------------------------------------------------------------------------
// BoundaryLoader — the administrator's review-and-load flow, rendered through
// real React (react-dom over happy-dom, registered only inside this file) with
// spy save functions. Pins: nothing is saved before the review passes, every
// blocker is stated, only valid selected shapes are sent, replace-vs-create is
// decided by the already-loaded data, and one failure never hides the rest.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { AdminBoundary, SiteBoundary } from "../src/lib/types";

let createRoot: typeof import("react-dom/client").createRoot;
let BoundaryLoader: typeof import("../src/components/BoundaryLoader").BoundaryLoader;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  createRoot = (await import("react-dom/client")).createRoot;
  BoundaryLoader = (await import("../src/components/BoundaryLoader")).BoundaryLoader;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const ring = (lng: number, lat: number, d = 0.1) => [
  [lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat],
];
const poly = (lng: number, lat: number) => ({ type: "Polygon", coordinates: [ring(lng, lat)] });
const feature = (geometry: unknown, properties: unknown) => ({ type: "Feature", geometry, properties });
const fc = (...features: unknown[]) => JSON.stringify({ type: "FeatureCollection", features });

const SITES = [
  { _id: "site-1", code: "MGL-BOM-0001", name: "Bomi Gold Works" },
  { _id: "site-2", code: "MGL-NIM-0002", name: "Nimba Iron" },
];

type SaveSite = (a: Record<string, unknown>) => Promise<unknown>;
type SaveAdmin = (a: Record<string, unknown>) => Promise<unknown>;

async function mount(
  opts: {
    saveSite?: SaveSite;
    saveAdmin?: SaveAdmin;
    adminBoundaries?: AdminBoundary[];
    siteBoundaries?: SiteBoundary[];
    loaded?: boolean;
  } = {},
) {
  const siteCalls: Record<string, unknown>[] = [];
  const adminCalls: Record<string, unknown>[] = [];
  const saveSite: SaveSite = async (a) => {
    siteCalls.push(a);
    return opts.saveSite?.(a);
  };
  const saveAdmin: SaveAdmin = async (a) => {
    adminCalls.push(a);
    return opts.saveAdmin?.(a);
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(BoundaryLoader, {
        sites: SITES,
        adminBoundaries: opts.adminBoundaries ?? [],
        siteBoundaries: opts.siteBoundaries ?? [],
        loaded: opts.loaded ?? true,
        saveSite: saveSite as never,
        saveAdmin: saveAdmin as never,
      }),
    );
  });
  const text = () => host.textContent ?? "";
  const byId = (id: string) => host.querySelector(`[id="${id}"]`) as HTMLInputElement & HTMLTextAreaElement;
  const loadButton = () =>
    [...host.querySelectorAll("button")].find((b) => /^Load \d+ boundar|^Loading/.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
  return {
    host, siteCalls, adminCalls, text, byId, loadButton,
    paste: (value: string) => setValue(byId("boundary-text"), value, HTMLTextAreaElement.prototype),
    setSource: (value: string) => setValue(byId("boundary-source"), value, HTMLInputElement.prototype),
    setAccuracy: (value: string) => setValue(byId("boundary-accuracy"), value, HTMLInputElement.prototype),
    click: (el: Element) => act(async () => (el as HTMLElement).click()),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

async function setValue(el: HTMLElement, value: string, proto: object) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const goodAndBad = fc(
  feature(poly(-9.5, 6.5), { name: "Bomi Gold Works", code: "MGL-BOM-0001" }),
  feature(poly(-8.7, 7.5), { name: "Nimba Iron" }),
  feature({ type: "Point", coordinates: [-9, 6] }, { name: "Not a shape" }),
);

describe("BoundaryLoader — review before anything is saved", () => {
  test("shows the summary, matches sites by code/name, and saves NOTHING until asked", async () => {
    const h = await mount();
    await h.paste(goodAndBad);
    expect(h.text()).toContain("Found 3 shapes");
    expect(h.text()).toContain("2 valid");
    expect(h.text()).toContain("1 with problems");
    expect(h.text()).toContain("Point geometries cannot be loaded"); // the reason, on the row
    expect(h.siteCalls).toHaveLength(0);
    await h.unmount();
  });

  test("every blocker is stated, and Load stays disabled until they are cleared", async () => {
    const h = await mount();
    await h.paste(goodAndBad);
    expect(h.loadButton()?.disabled).toBe(true);
    expect(h.text()).toContain("Say where this data came from");
    await h.setSource("Liberia Land Authority, 2024");
    expect(h.loadButton()?.disabled).toBe(false);
    await h.setAccuracy("-5");
    expect(h.text()).toContain("Accuracy must be a number of metres");
    expect(h.loadButton()?.disabled).toBe(true);
    await h.setAccuracy("12.5");
    expect(h.loadButton()?.disabled).toBe(false);
    await h.unmount();
  });

  test("garbage input is explained and offers nothing to load", async () => {
    const h = await mount();
    await h.paste("<kml/>");
    expect(h.text()).toContain("not valid JSON");
    expect(h.loadButton()).toBeUndefined();
    await h.unmount();
  });
});

describe("BoundaryLoader — loading site outlines", () => {
  test("sends only the valid, matched shapes — canonical geometry, trimmed source, accuracy, unverified by default", async () => {
    const h = await mount();
    await h.paste(goodAndBad);
    await h.setSource("  Liberia Land Authority, 2024  ");
    await h.setAccuracy("12.5");
    await h.click(h.loadButton()!);
    expect(h.siteCalls).toHaveLength(2);
    expect(h.siteCalls[0]).toMatchObject({
      siteId: "site-1",
      source: "Liberia Land Authority, 2024",
      accuracyM: 12.5,
      geoVerified: false,
    });
    expect(h.siteCalls[1]).toMatchObject({ siteId: "site-2" });
    expect(JSON.parse(h.siteCalls[0].geometryGeoJson as string)).toEqual(poly(-9.5, 6.5));
    expect(h.text()).toContain("✓ Outline saved");
    await h.unmount();
  });

  test("the verified box is honoured", async () => {
    const h = await mount();
    await h.paste(fc(feature(poly(-9.5, 6.5), { code: "MGL-BOM-0001" })));
    await h.setSource("Survey 2024");
    await h.click(h.host.querySelector('[id="boundary-verified"]')!);
    await h.click(h.loadButton()!);
    expect(h.siteCalls[0]).toMatchObject({ geoVerified: true });
    await h.unmount();
  });

  test("a shape for a site that already has an outline says it REPLACES it", async () => {
    const h = await mount({
      siteBoundaries: [{ _id: "sb1", siteId: "site-1", geometryGeoJson: "{}", source: "old", geoVerified: false, createdAt: 0 } as SiteBoundary],
    });
    await h.paste(fc(feature(poly(-9.5, 6.5), { code: "MGL-BOM-0001" })));
    await h.setSource("New survey");
    await h.click(h.loadButton()!);
    expect(h.text()).toContain("Replaced the previous outline");
    await h.unmount();
  });

  test("two shapes aimed at one site are blocked (a site has one outline)", async () => {
    const h = await mount();
    await h.paste(
      fc(
        feature(poly(-9.5, 6.5), { code: "MGL-BOM-0001" }),
        feature(poly(-9.4, 6.6), { code: "MGL-BOM-0001" }),
      ),
    );
    await h.setSource("x");
    expect(h.text()).toContain("point at the same site");
    expect(h.loadButton()?.disabled).toBe(true);
    await h.unmount();
  });

  test("a shape that matches no site is blocked until a site is chosen — no guessing", async () => {
    const h = await mount();
    await h.paste(fc(feature(poly(-9.5, 6.5), { name: "Mystery pit" })));
    await h.setSource("x");
    expect(h.text()).toContain("Choose the site for every selected shape");
    expect(h.loadButton()?.disabled).toBe(true);
    await h.unmount();
  });

  test("unticking a shape leaves it out", async () => {
    const h = await mount();
    await h.paste(goodAndBad);
    await h.setSource("x");
    await h.click(h.host.querySelector('[aria-label="Load Nimba Iron"]')!);
    expect(h.loadButton()?.textContent).toBe("Load 1 boundary");
    await h.click(h.loadButton()!);
    expect(h.siteCalls.map((c) => c.siteId)).toEqual(["site-1"]);
    await h.unmount();
  });

  test("one failure never hides the others: each row reports its own result, the prefix is stripped", async () => {
    const h = await mount({
      saveSite: async (a) => {
        if (a.siteId === "site-2") throw new Error("FORBIDDEN: geo.write required");
      },
    });
    await h.paste(goodAndBad);
    await h.setSource("x");
    await h.click(h.loadButton()!);
    expect(h.siteCalls).toHaveLength(2); // the second was still attempted
    expect(h.text()).toContain("✓ Outline saved");
    expect(h.text()).toContain("✕ geo.write required");
    expect(h.text()).not.toContain("FORBIDDEN:");
    expect(h.loadButton()?.disabled).toBe(false); // can retry
    await h.unmount();
  });
});

describe("BoundaryLoader — administrative areas", () => {
  async function toAdminTab(h: Awaited<ReturnType<typeof mount>>) {
    const tab = [...h.host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Administrative areas")!;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
  }

  test("names come from the file and a new area is CREATED at the chosen level", async () => {
    const h = await mount();
    await toAdminTab(h);
    await h.paste(fc(feature(poly(-9.5, 6.5), { NAME_1: "Bomi" }), feature(poly(-10.5, 6.9), { NAME_1: "Bong" })));
    await h.setSource("LISGIS 2022");
    await h.click(h.loadButton()!);
    expect(h.adminCalls).toHaveLength(2);
    expect(h.adminCalls[0]).toMatchObject({ name: "Bomi", level: "county", id: undefined, source: "LISGIS 2022" });
    expect(h.text()).toContain("✓ Boundary created");
    await h.unmount();
  });

  test("an area that is already loaded (same level + name) is REPLACED in place — never duplicated", async () => {
    const existing = { _id: "ab-1", name: "Bomi", level: "county", geometryGeoJson: "{}", source: "old", geoVerified: false, createdAt: 0 } as AdminBoundary;
    const h = await mount({ adminBoundaries: [existing] });
    await toAdminTab(h);
    await h.paste(fc(feature(poly(-9.5, 6.5), { NAME_1: "bomi" })));
    expect(h.text()).toContain("is already loaded — this will replace it");
    await h.setSource("LISGIS 2024");
    await h.click(h.loadButton()!);
    expect(h.adminCalls[0]).toMatchObject({ id: "ab-1", name: "bomi" });
    expect(h.text()).toContain("Replaced the existing boundary");
    await h.unmount();
  });

  test("two shapes with the same name at one level are blocked", async () => {
    const h = await mount();
    await toAdminTab(h);
    await h.paste(fc(feature(poly(-9.5, 6.5), { name: "Bomi" }), feature(poly(-9.2, 6.8), { name: "BOMI" })));
    await h.setSource("x");
    expect(h.text()).toContain("same name at this level");
    await h.unmount();
  });
});

describe("BoundaryLoader — what is already loaded", () => {
  test("says plainly that the map layers are empty when nothing is loaded", async () => {
    const h = await mount();
    expect(h.text()).toContain("No boundaries are loaded yet");
    await h.unmount();
  });
  test("shows a loading state while the lists are still being fetched", async () => {
    const h = await mount({ loaded: false });
    expect(h.text()).toContain("Loading…");
    expect(h.text()).not.toContain("No boundaries are loaded yet");
    await h.unmount();
  });
});
