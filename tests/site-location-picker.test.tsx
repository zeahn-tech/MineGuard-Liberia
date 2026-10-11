// ---------------------------------------------------------------------------
// SiteLocationPicker — capturing a REAL position. Rendered through real React
// (react-dom over happy-dom, registered only inside this file) with a stubbed
// device GPS, so the behaviors an administrator relies on are pinned:
// the fix is recorded with its source and accuracy, failures are explained and
// never invent a position, edits switch the recorded source, and auto-locate
// never triggers a surprise permission prompt.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, useState } from "react";
import type { Root } from "react-dom/client";
import type { PositionDraft } from "../src/lib/site-position";

let createRoot: typeof import("react-dom/client").createRoot;
let SiteLocationPicker: typeof import("../src/components/SiteLocationPicker").SiteLocationPicker;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  createRoot = (await import("react-dom/client")).createRoot;
  SiteLocationPicker = (await import("../src/components/SiteLocationPicker")).SiteLocationPicker;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

type GeoCallbacks = {
  ok: (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void;
  err: (e: { code: number; message: string }) => void;
};

interface Harness {
  host: HTMLElement;
  latest: () => PositionDraft;
  geoCalls: () => number;
  /** Resolve / fail the most recent getCurrentPosition request. */
  fix: (latitude: number, longitude: number, accuracy: number) => Promise<void>;
  fail: (code: number) => Promise<void>;
  unmount: () => Promise<void>;
}

function setGeolocation(impl: unknown) {
  Object.defineProperty(globalThis.navigator, "geolocation", { value: impl, configurable: true });
}
function setPermissions(state: string | null) {
  Object.defineProperty(globalThis.navigator, "permissions", {
    value: state === null ? undefined : { query: async () => ({ state }) },
    configurable: true,
  });
}

const EMPTY: PositionDraft = { latitude: "", longitude: "", source: "manual_entry" };

async function mount(initial: PositionDraft = EMPTY, props: { autoLocate?: boolean } = {}): Promise<Harness> {
  let pending: GeoCallbacks | null = null;
  let calls = 0;
  setGeolocation({
    getCurrentPosition: (ok: GeoCallbacks["ok"], err: GeoCallbacks["err"]) => {
      calls++;
      pending = { ok, err };
    },
  });
  let current = initial;
  const Wrapper = () => {
    const [value, setValue] = useState(initial);
    current = value;
    return createElement(SiteLocationPicker, { value, onChange: setValue, ...props });
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(createElement(Wrapper));
  });
  return {
    host,
    latest: () => current,
    geoCalls: () => calls,
    fix: async (latitude, longitude, accuracy) => {
      await act(async () => pending?.ok({ coords: { latitude, longitude, accuracy } }));
    },
    fail: async (code) => {
      await act(async () => pending?.err({ code, message: "x" }));
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const button = (h: Harness, text: string) =>
  [...h.host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const input = (h: Harness, label: string) =>
  [...h.host.querySelectorAll("label")]
    .find((l) => l.textContent === label)
    ?.getAttribute("for") as string;
const field = (h: Harness, label: string) => h.host.querySelector(`[id="${input(h, label)}"]`) as HTMLInputElement;
const click = (el: Element) => act(async () => (el as HTMLElement).click());
async function typeInto(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const text = (h: Harness) => h.host.textContent ?? "";

afterEach(() => {
  setPermissions(null);
});

describe("SiteLocationPicker", () => {
  test("a GPS fix fills both fields and records source + accuracy", async () => {
    const h = await mount();
    await click(button(h, "Use my current location"));
    expect(text(h)).toContain("Locating…");
    await h.fix(6.31234567, -10.80123456, 8.46);
    expect(h.latest()).toEqual({ latitude: "6.312346", longitude: "-10.801235", accuracyM: 8.5, source: "device_gps" });
    expect(field(h, "Latitude").value).toBe("6.312346");
    expect(text(h)).toContain("GPS accuracy ±8.5 m (good)");
    expect(text(h)).toContain("Recorded as: device GPS · unverified");
    await h.unmount();
  });

  test("a denied permission is explained, offers the map, and invents no position", async () => {
    const h = await mount();
    await click(button(h, "Use my current location"));
    await h.fail(1);
    expect(text(h)).toContain("permission was denied");
    expect(text(h)).toContain("pick the position on the map");
    expect(h.latest()).toEqual(EMPTY);
    await h.unmount();
  });

  test("a rough fix is accepted but clearly flagged as too imprecise", async () => {
    const h = await mount();
    await click(button(h, "Use my current location"));
    await h.fix(6.3, -10.8, 450);
    expect(h.latest().source).toBe("device_gps");
    expect(text(h)).toContain("too rough for a site position");
    await h.unmount();
  });

  test("a fix from outside Liberia is shown with the reason it cannot be used", async () => {
    const h = await mount();
    await click(button(h, "Use my current location"));
    await h.fix(48.85, 2.35, 10); // Paris
    expect(text(h)).toContain("outside Liberia");
    expect(h.host.querySelector('[role="alert"]')).not.toBeNull();
    await h.unmount();
  });

  test("editing a GPS value by hand switches the source to manual entry and drops the accuracy", async () => {
    const h = await mount();
    await click(button(h, "Use my current location"));
    await h.fix(6.3, -10.8, 8);
    await typeInto(field(h, "Latitude"), "6.31");
    expect(h.latest()).toMatchObject({ latitude: "6.31", longitude: "-10.8", source: "manual_entry" });
    expect(h.latest().accuracyM).toBeUndefined();
    expect(text(h)).not.toContain("GPS accuracy");
    await h.unmount();
  });

  test("a longitude typed without its minus sign is caught on the spot, with the fix", async () => {
    const h = await mount();
    await typeInto(field(h, "Latitude"), "6.43");
    await typeInto(field(h, "Longitude"), "9.43");
    expect(text(h)).toContain("did you mean -9.43");
    expect(field(h, "Longitude").getAttribute("aria-invalid")).toBe("true");
    await typeInto(field(h, "Longitude"), "-9.43");
    expect(text(h)).not.toContain("did you mean");
    expect(text(h)).toContain("Recorded as: typed in manually");
    await h.unmount();
  });

  test("a device with no geolocation says so instead of failing silently", async () => {
    const h = await mount();
    setGeolocation(undefined);
    await click(button(h, "Use my current location"));
    expect(text(h)).toContain("Could not read your location");
    await h.unmount();
  });

  test("a result that arrives after unmount is ignored (no crash, no update)", async () => {
    const h = await mount();
    await click(button(h, "Use my current location"));
    await h.unmount();
    await h.fix(6.3, -10.8, 5);
  });

  test("auto-locate runs ONLY when permission is already granted", async () => {
    setPermissions("granted");
    const granted = await mount(EMPTY, { autoLocate: true });
    await act(async () => {});
    expect(granted.geoCalls()).toBe(1);
    await granted.unmount();

    setPermissions("prompt");
    const prompt = await mount(EMPTY, { autoLocate: true });
    await act(async () => {});
    expect(prompt.geoCalls()).toBe(0); // never a surprise permission prompt
    await prompt.unmount();

    setPermissions(null); // Permissions API unavailable
    const none = await mount(EMPTY, { autoLocate: true });
    await act(async () => {});
    expect(none.geoCalls()).toBe(0);
    await none.unmount();
  });

  test("auto-locate never overwrites a position that is already there", async () => {
    setPermissions("granted");
    const h = await mount({ latitude: "6.4", longitude: "-9.4", source: "manual_entry" }, { autoLocate: true });
    await act(async () => {});
    expect(h.geoCalls()).toBe(0);
    await h.unmount();
  });
});
