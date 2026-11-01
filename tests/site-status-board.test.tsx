// ---------------------------------------------------------------------------
// PHASE 1 — SiteStatusBoardView rendered through real React over happy-dom.
// happy-dom has no layout engine, so this pins STRUCTURE and CONTENT:
// loading / error / offline / empty / no-match states, status text that never
// relies on colour alone, critical findings staying visible, and that no
// "safe" label can appear. Visual layout needs browser testing (see report).
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { DAY_MS, STATUS_META, type SiteStatusInputs } from "../src/lib/site-status";

const NOW = Date.UTC(2026, 9, 31);
const daysAgo = (d: number) => NOW - d * DAY_MS;

const base = (over: Partial<SiteStatusInputs> = {}): SiteStatusInputs => ({
  sites: [],
  inspections: [],
  findings: [],
  actions: [],
  incidents: [],
  loadedAt: NOW,
  ...over,
});

const mkSite = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  code: `LB-${id}`,
  name,
  operatorName: "AgriLib Mining",
  organizationId: "org-a",
  county: "Bomi",
  registryStatus: "active",
  latitude: 6.85,
  longitude: -10.85,
  ...over,
});

let createRoot: typeof import("react-dom/client").createRoot;
let View: typeof import("../src/components/SiteStatusBoard").SiteStatusBoardView;
let MemoryRouter: typeof import("react-router").MemoryRouter;
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  createRoot = (await import("react-dom/client")).createRoot;
  View = (await import("../src/components/SiteStatusBoard")).SiteStatusBoardView;
  MemoryRouter = (await import("react-router")).MemoryRouter;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterAll(async () => {
  await act(async () => root.unmount());
  await GlobalRegistrator.unregister();
});

let renderSeq = 0; // fresh component instance per render → no filter state leaks between tests

async function render(props: {
  feed: SiteStatusInputs | undefined;
  timedOut?: boolean;
  online?: boolean;
  onRetry?: () => void;
}) {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(View, {
          key: ++renderSeq,
          feed: props.feed,
          timedOut: props.timedOut ?? false,
          online: props.online ?? true,
          onRetry: props.onRetry ?? (() => {}),
        }),
      ),
    );
  });
  return host.textContent ?? "";
}

describe("loading / error / offline", () => {
  test("loading: busy region, no figures", async () => {
    const text = await render({ feed: undefined });
    expect(text).toContain("Loading site status");
    expect(host.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(text).not.toContain("Open critical findings");
  });

  test("timed out while online: alert with retry that calls onRetry", async () => {
    let retried = 0;
    const text = await render({ feed: undefined, timedOut: true, onRetry: () => retried++ });
    expect(text).toContain("could not load");
    expect(host.querySelector("[role='alert']")).not.toBeNull();
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => btn.click());
    expect(retried).toBe(1);
  });

  test("timed out while offline: says so instead of blaming the server", async () => {
    const text = await render({ feed: undefined, timedOut: true, online: false });
    expect(text).toMatch(/offline/i);
  });

  test("offline with data: shows a status banner that figures may be out of date", async () => {
    const text = await render({
      feed: base({ sites: [mkSite("a", "Bomi River Wash Plant")] }),
      online: false,
    });
    expect(host.querySelector("[role='status']")).not.toBeNull();
    expect(text).toMatch(/You are offline/);
    expect(text).toContain("Bomi River Wash Plant");
  });
});

describe("empty states", () => {
  test("no visible sites: explains scope and invents nothing", async () => {
    const text = await render({ feed: base() });
    expect(text).toMatch(/No registered sites are visible to your account/);
    expect(text).toMatch(/not authorized/);
    expect(host.querySelectorAll("li a").length).toBe(0); // no site rows invented
  });

  test("freshness always disclosed with the data-read time", async () => {
    const text = await render({ feed: base({ sites: [mkSite("a", "Site A")] }) });
    expect(text).toMatch(/Data read .* on this device/);
  });
});

describe("status rendering", () => {
  const feed = base({
    sites: [
      mkSite("crit", "Critical Site"),
      mkSite("none", "Silent Site"),
      mkSite("old", "Old Data Site"),
      mkSite("ok", "Recent Site", { latitude: undefined, longitude: undefined }),
    ],
    inspections: [
      { siteId: "crit", status: "approved", reviewedAt: daysAgo(3), createdAt: daysAgo(5) },
      { siteId: "old", status: "approved", reviewedAt: daysAgo(400), createdAt: daysAgo(402) },
      { siteId: "ok", status: "approved", reviewedAt: daysAgo(10), createdAt: daysAgo(12) },
    ],
    findings: [{ siteId: "crit", severity: "critical", status: "open" }],
    actions: [{ siteId: "crit", status: "open", dueAt: daysAgo(2) }],
  });

  test("each status is shown with a text label AND a glyph (never colour alone)", async () => {
    await render({ feed });
    const html = host.innerHTML;
    for (const k of ["review_now", "insufficient", "stale", "recent_information"] as const) {
      expect(host.textContent).toContain(STATUS_META[k].label);
      expect(html).toContain(STATUS_META[k].glyph);
    }
    // glyphs are decorative to assistive tech; the label carries the meaning
    expect(host.querySelector("span[aria-hidden='true']")).not.toBeNull();
  });

  test("a silent site is 'Information insufficient', never safe", async () => {
    const text = await render({ feed });
    const li = [...host.querySelectorAll("li")].find((l) => l.textContent?.includes("Silent Site"))!;
    expect(li.textContent).toContain("Information insufficient");
    expect(li.textContent).toContain("none on record");
    // The site's own row never uses the word "safe" (the method disclosure
    // legitimately says there is no such status, so only the row is checked).
    expect(li.textContent).not.toMatch(/safe/i);
    expect(text).toContain("Silent Site");
  });

  test("critical finding and overdue action stay visible on the flagged site", async () => {
    await render({ feed });
    const li = [...host.querySelectorAll("li")].find((l) => l.textContent?.includes("Critical Site"))!;
    expect(li.textContent).toContain("1 open critical finding(s)");
    expect(li.textContent).toContain("1 overdue action(s)");
    expect(li.textContent).toContain("Requires immediate review");
  });

  test("most urgent first", async () => {
    await render({ feed });
    const names = [...host.querySelectorAll("li a")].map((a) => a.textContent);
    expect(names[0]).toBe("Critical Site");
    expect(names[names.length - 1]).toBe("Recent Site");
  });

  test("verified vs company-submitted are labelled separately; missing position is stated", async () => {
    await render({ feed });
    const li = [...host.querySelectorAll("li")].find((l) => l.textContent?.includes("Recent Site"))!;
    expect(li.textContent).toContain("Verified: last approved inspection");
    expect(li.textContent).toContain("Company-submitted: last submission");
    expect(li.textContent).toContain("no valid map position on record");
  });

  test("site name links to the existing site page", async () => {
    await render({ feed });
    const a = [...host.querySelectorAll("li a")].find((x) => x.textContent === "Critical Site")!;
    expect(a.getAttribute("href")).toBe("/portal/sites/crit");
  });

  test("summary lists critical findings and staleness window", async () => {
    const text = await render({ feed });
    expect(text).toContain("Open critical findings");
    expect(text).toContain("Staleness window");
    expect(text).toContain("No approved inspection");
  });

  test("method disclosure states there is no safe status", async () => {
    await render({ feed });
    const d = host.querySelector("details")!;
    expect(d.textContent).toMatch(/no "safe" status/);
    expect(d.textContent).toMatch(/never as safe/);
  });
});

describe("filters (keyboard-operable controls with state)", () => {
  const feed = base({
    sites: [
      mkSite("a", "Alpha Site", { county: "Bomi" }),
      mkSite("b", "Bravo Site", { county: "Nimba", organizationId: "org-b", operatorName: "OreCo" }),
    ],
    findings: [{ siteId: "a", severity: "critical", status: "open" }],
  });

  test("status chips expose aria-pressed and filter the list", async () => {
    await render({ feed });
    const group = host.querySelector("[aria-label='Status filter']")!;
    const chip = [...group.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(STATUS_META.review_now.label),
    )!;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    await act(async () => chip.click());
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    const names = [...host.querySelectorAll("li a")].map((a) => a.textContent);
    expect(names).toEqual(["Alpha Site"]);
  });

  test("county and company groups appear only when there is a choice", async () => {
    await render({ feed });
    expect(host.querySelector("[aria-label='County filter']")).not.toBeNull();
    expect(host.querySelector("[aria-label='Company filter']")).not.toBeNull();
    await render({ feed: base({ sites: [mkSite("a", "Alpha Site")] }) });
    expect(host.querySelector("[aria-label='County filter']")).toBeNull();
    expect(host.querySelector("[aria-label='Company filter']")).toBeNull();
  });

  test("filters with no match show an empty state and a clear control", async () => {
    await render({ feed });
    const chip = [...host.querySelectorAll("[aria-label='Status filter'] button")].find((b) =>
      b.textContent?.includes(STATUS_META.recent_information.label),
    )!;
    await act(async () => chip.click());
    expect(host.textContent).toContain("No sites match these filters");
    const clear = [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear filters")!;
    await act(async () => clear.click());
    expect(host.querySelectorAll("li a").length).toBe(2);
  });

  test("form controls are labelled", async () => {
    await render({ feed });
    for (const el of host.querySelectorAll("select, input")) {
      expect(el.closest("label"), "control must sit inside a <label>").not.toBeNull();
    }
  });
});

describe("large lists", () => {
  test("paginates (25 at a time) and offers 'Show more'", async () => {
    const sites = Array.from({ length: 60 }, (_, i) => mkSite(`s${i}`, `Site ${String(i).padStart(2, "0")}`));
    await render({ feed: base({ sites }) });
    expect(host.querySelectorAll("li a").length).toBe(25);
    expect(host.textContent).toContain("Showing 25 of 60");
    const more = [...host.querySelectorAll("button")].find((b) => b.textContent === "Show more")!;
    await act(async () => more.click());
    expect(host.querySelectorAll("li a").length).toBe(50);
  });
});
