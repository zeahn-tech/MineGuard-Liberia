// ---------------------------------------------------------------------------
// UX STATES — rendered behaviour of the shared state components.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { SLOW_AFTER_MS, STALLED_AFTER_MS, loadPhase } from "../src/lib/load-phase";

let createRoot: typeof import("react-dom/client").createRoot;
let MemoryRouter: typeof import("react-router").MemoryRouter;
let C: {
  OfflineBanner: typeof import("../src/components/OfflineBanner").OfflineBanner;
  PageLoading: typeof import("../src/components/PageLoading").PageLoading;
  LightPathProvider: typeof import("../src/components/PageLoading").LightPathProvider;
  EmptyState: typeof import("../src/components/EmptyState").EmptyState;
  NoResults: typeof import("../src/components/NoResults").NoResults;
  FormField: typeof import("../src/components/FormField").FormField;
  PermissionNotice: typeof import("../src/components/PermissionNotice").PermissionNotice;
};

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  createRoot = (await import("react-dom/client")).createRoot;
  MemoryRouter = (await import("react-router")).MemoryRouter;
  C = {
    OfflineBanner: (await import("../src/components/OfflineBanner")).OfflineBanner,
    ...(await import("../src/components/PageLoading")),
    EmptyState: (await import("../src/components/EmptyState")).EmptyState,
    NoResults: (await import("../src/components/NoResults")).NoResults,
    FormField: (await import("../src/components/FormField")).FormField,
    PermissionNotice: (await import("../src/components/PermissionNotice")).PermissionNotice,
  };
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function mount(node: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(createElement(MemoryRouter, null, node));
  });
  return {
    host,
    text: () => host.textContent ?? "",
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("load phases", () => {
  test("thresholds: loading -> slow at 4s -> stalled at 12s; offline always wins", () => {
    expect(loadPhase(0, true)).toBe("loading");
    expect(loadPhase(SLOW_AFTER_MS - 1, true)).toBe("loading");
    expect(loadPhase(SLOW_AFTER_MS, true)).toBe("slow");
    expect(loadPhase(STALLED_AFTER_MS - 1, true)).toBe("slow");
    expect(loadPhase(STALLED_AFTER_MS, true)).toBe("stalled");
    expect(loadPhase(0, false)).toBe("offline");
    expect(loadPhase(60_000, false)).toBe("offline");
  });
});

describe("OfflineBanner", () => {
  test("renders nothing while online", async () => {
    setOnline(true);
    const h = await mount(createElement(C.OfflineBanner));
    expect(h.text()).toBe("");
    await h.unmount();
  });

  test("offline: says so, what is shown, what still works, and counts waiting items", async () => {
    setOnline(true);
    const h = await mount(createElement(C.OfflineBanner, { pending: 3 }));
    await act(async () => setOnline(false));
    expect(h.text()).toContain("You're offline.");
    expect(h.text()).toContain("Showing what was last loaded on this device");
    expect(h.text()).toContain("sent when you reconnect");
    expect(h.text()).toContain("3 items are waiting to be sent");
    expect(h.host.querySelector('[role="status"]')).not.toBeNull();
    await h.unmount();
    setOnline(true);
  });

  test("singular wording for one waiting item", async () => {
    setOnline(false);
    const h = await mount(createElement(C.OfflineBanner, { pending: 1 }));
    expect(h.text()).toContain("1 item is waiting to be sent");
    await h.unmount();
    setOnline(true);
  });

  test("read-only and public variants never promise queueing they don't have", async () => {
    setOnline(false);
    const ro = await mount(createElement(C.OfflineBanner, { variant: "readonly" }));
    expect(ro.text()).toContain("Changes need a connection");
    expect(ro.text()).not.toContain("sent when you reconnect");
    await ro.unmount();
    const pub = await mount(createElement(C.OfflineBanner, { variant: "public" }));
    expect(pub.text()).toContain("can only be sent once you reconnect");
    await pub.unmount();
    setOnline(true);
  });

  test("reconnecting shows 'Back online' instead of vanishing", async () => {
    setOnline(false);
    const h = await mount(createElement(C.OfflineBanner));
    expect(h.text()).toContain("You're offline.");
    await act(async () => setOnline(true));
    expect(h.text()).toContain("Back online");
    expect(h.text()).not.toContain("You're offline.");
    await h.unmount();
  });
});

describe("PageLoading", () => {
  test("loading: shows the SHAPE of what is coming, announced politely, with no spinner or fake progress", async () => {
    setOnline(true);
    for (const shape of ["list", "cards", "detail", "table", "form"] as const) {
      const h = await mount(createElement(C.PageLoading, { shape, label: "incidents" }));
      const status = h.host.querySelector('[role="status"]')!;
      expect(status.getAttribute("aria-busy")).toBe("true");
      expect(h.text()).toContain("Loading incidents");
      expect(h.host.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(2);
      expect(h.host.querySelector('[data-slot="progress"]')).toBeNull();
      expect(h.host.querySelector(".animate-spin")).toBeNull();
      await h.unmount();
    }
  });

  test("offline with nothing saved: explains, promises it loads on reconnect, offers the light path", async () => {
    setOnline(false);
    const h = await mount(
      createElement(
        C.LightPathProvider,
        { value: { label: "Report an incident", to: "/portal/incidents", hint: "Reports are saved on this device and sent later." } },
        createElement(C.PageLoading, { label: "incident list" }),
      ),
    );
    expect(h.text()).toContain("You're offline.");
    expect(h.text()).toContain("hasn't been opened on this device yet");
    expect(h.text()).toContain("load by itself as soon as you reconnect");
    const link = h.host.querySelector("a")!;
    expect(link.textContent).toBe("Report an incident");
    expect(link.getAttribute("href")).toBe("#/portal/incidents");
    expect(h.text()).toContain("saved on this device and sent later");
    await h.unmount();
    setOnline(true);
  });

  test("a load from this device never claims 'you're offline' or 'nothing saved'", async () => {
    setOnline(false);
    const h = await mount(createElement(C.PageLoading, { label: "your draft", local: true }));
    expect(h.text()).not.toContain("You're offline");
    expect(h.text()).not.toContain("hasn't been opened on this device");
    expect(h.text()).toContain("Loading your draft");
    await h.unmount();
    setOnline(true);
  });

  test("slow: real elapsed seconds, still-retrying reassurance, and real progress when the caller has it", async () => {
    setOnline(true);
    const realNow = Date.now;
    const base = realNow();
    let offset = 0;
    Date.now = () => base + offset;
    try {
      const h = await mount(
        createElement(C.PageLoading, { label: "incidents", progress: { loaded: 40, total: 200, unit: "incidents" } }),
      );
      offset = SLOW_AFTER_MS + 1500;
      await act(async () => {
        await sleep(650);
      });
      expect(h.text()).toContain("Still loading incidents");
      expect(h.text()).toMatch(/Waiting \d+s\./);
      expect(h.text()).toContain("keep retrying in the background");
      expect(h.text()).toContain("40 of 200 incidents loaded (20%)");
      expect(h.host.querySelector('[data-slot="progress"]')).not.toBeNull();
      // Not yet stalled: no retry button.
      expect([...h.host.querySelectorAll("button")].some((b) => /try again/i.test(b.textContent ?? ""))).toBe(false);
      await h.unmount();
    } finally {
      Date.now = realNow;
    }
  });

  test("slow without a known total: states what has loaded, never invents a percentage", async () => {
    setOnline(true);
    const realNow = Date.now;
    const base = realNow();
    let offset = 0;
    Date.now = () => base + offset;
    try {
      const h = await mount(createElement(C.PageLoading, { label: "sites", progress: { loaded: 25, unit: "sites" } }));
      offset = SLOW_AFTER_MS + 1000;
      await act(async () => {
        await sleep(650);
      });
      expect(h.text()).toContain("25 sites loaded so far");
      expect(h.text()).not.toMatch(/\d+%/);
      expect(h.host.querySelector('[data-slot="progress"]')).toBeNull();
      await h.unmount();
    } finally {
      Date.now = realNow;
    }
  });

  test("stalled: offers Try again (calling onRetry) and the light path", async () => {
    setOnline(true);
    const realNow = Date.now;
    const base = realNow();
    let offset = 0;
    Date.now = () => base + offset;
    let retried = 0;
    try {
      const h = await mount(
        createElement(C.PageLoading, {
          label: "map",
          onRetry: () => {
            retried++;
          },
          lightPath: { label: "Open the site list", to: "/portal/sites" },
        }),
      );
      offset = STALLED_AFTER_MS + 1000;
      await act(async () => {
        await sleep(650);
      });
      expect(h.text()).toContain("taking much longer than usual");
      const retry = [...h.host.querySelectorAll("button")].find((b) => /try again/i.test(b.textContent ?? ""))!;
      expect(retry).toBeDefined();
      await act(async () => retry.click());
      expect(retried).toBe(1);
      expect(h.host.querySelector('a[href="#/portal/sites"]')).not.toBeNull();
      await h.unmount();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("EmptyState", () => {
  test("says what is empty, why, and offers exactly one next step", async () => {
    const h = await mount(
      createElement(C.EmptyState, {
        title: "No incidents yet",
        why: "Nothing has been reported for the sites in your area.",
        action: { label: "Report an incident", to: "/portal/incidents" },
      }),
    );
    expect(h.text()).toContain("No incidents yet");
    expect(h.text()).toContain("Nothing has been reported");
    expect(h.host.querySelectorAll("a, button").length).toBe(1);
    expect(h.host.querySelector("a")!.textContent).toBe("Report an incident");
    await h.unmount();
  });

  test("with a click action renders a button; with none renders no control at all", async () => {
    let clicked = 0;
    const a = await mount(
      createElement(C.EmptyState, { title: "T", why: "W", action: { label: "Do it", onClick: () => clicked++ } }),
    );
    await act(async () => (a.host.querySelector("button") as HTMLButtonElement).click());
    expect(clicked).toBe(1);
    await a.unmount();
    const b = await mount(createElement(C.EmptyState, { title: "T", why: "An administrator registers sites." }));
    expect(b.host.querySelectorAll("a, button").length).toBe(0);
    await b.unmount();
  });
});

describe("NoResults", () => {
  test("names the search and offers the corrected spelling, which applies when pressed", async () => {
    let used = "";
    const h = await mount(
      createElement(C.NoResults, { query: "blu shoes", suggestion: "blue shoes", onUseSuggestion: (s: string) => (used = s) }),
    );
    expect(h.text()).toContain("No results for “blu shoes”.");
    expect(h.text()).toContain("Did you mean blue shoes?");
    await act(async () => (h.host.querySelector("button") as HTMLButtonElement).click());
    expect(used).toBe("blue shoes");
    await h.unmount();
  });

  test("with no suggestion, gives guidance and a Clear search way out", async () => {
    let cleared = 0;
    const h = await mount(createElement(C.NoResults, { query: "zzz", onClear: () => cleared++ }));
    expect(h.text()).not.toContain("Did you mean");
    expect(h.text()).toContain("Check the spelling");
    const clear = [...h.host.querySelectorAll("button")].find((b) => /clear search/i.test(b.textContent ?? ""))!;
    await act(async () => clear.click());
    expect(cleared).toBe(1);
    await h.unmount();
  });
});

describe("FormField", () => {
  test("flags its own control: aria-invalid, described by the inline message, announced as an alert", async () => {
    const h = await mount(
      createElement(
        C.FormField,
        { label: "Email", required: true, error: "An email address needs an @, like name@company.com.", id: "f-email" },
        (p: Record<string, unknown>) => createElement("input", { ...p, type: "text" }),
      ),
    );
    const input = h.host.querySelector("input")!;
    expect(input.getAttribute("id")).toBe("f-email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("f-email-error");
    const err = h.host.querySelector("#f-email-error")!;
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("needs an @");
    expect(h.host.querySelector("label")!.getAttribute("for")).toBe("f-email");
    await h.unmount();
  });

  test("no error: no aria-invalid, no alert; the hint stays", async () => {
    const h = await mount(
      createElement(
        C.FormField,
        { label: "Name", hint: "As on the registration certificate", id: "f-name" },
        (p: Record<string, unknown>) => createElement("input", p),
      ),
    );
    const input = h.host.querySelector("input")!;
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe("f-name-hint");
    expect(h.host.querySelector('[role="alert"]')).toBeNull();
    expect(h.text()).toContain("As on the registration certificate");
    await h.unmount();
  });
});

describe("PermissionNotice", () => {
  test("explains why, how to allow it, and keeps a way back", async () => {
    const h = await mount(
      createElement(
        C.PermissionNotice,
        { title: "Camera access is blocked", why: "To photograph evidence.", howToAllow: "Allow the camera in your browser's site settings." },
        createElement("button", null, "Choose a photo instead"),
      ),
    );
    expect(h.text()).toContain("Camera access is blocked");
    expect(h.text()).toContain("Why we ask: To photograph evidence.");
    expect(h.text()).toContain("To allow it: Allow the camera");
    expect(h.host.querySelector("button")!.textContent).toBe("Choose a photo instead");
    await h.unmount();
  });
});
