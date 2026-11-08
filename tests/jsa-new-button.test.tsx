// ---------------------------------------------------------------------------
// The "New JSA" button on the company Job Safety Analysis screen: workers
// prepare a JSA that a safety officer reviews, so the way to start one must
// never vanish silently. Rendered through real React over happy-dom.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";

let sitesImpl: () => Promise<{ id: string; name: string; code: string }[]> = async () => [];

mock.module("../src/lib/supabase", () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: { id: "worker-1" } } }) }, rpc: async () => ({ data: null, error: null }) },
}));
mock.module("../src/lib/jsa", () => ({
  RISK_LEVELS: ["low", "medium", "high", "critical"],
  jsaSites: () => sitesImpl(),
  listJsas: async () => [],
  canReview: async () => false,
  explainJsaError: (e: unknown) => String(e),
  newKey: () => "k",
  reviewJsa: async () => {},
  saveJsa: async () => "id",
  submitJsa: async () => {},
}));

let Page: typeof import("../src/pages/safety/JsaPage").default;
let MemoryRouter: typeof import("react-router").MemoryRouter;
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  Page = (await import("../src/pages/safety/JsaPage")).default;
  MemoryRouter = (await import("react-router")).MemoryRouter;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterAll(async () => {
  await act(async () => root.unmount());
  await GlobalRegistrator.unregister();
});

let seq = 0;
async function render(path: string) {
  await act(async () => {
    root.render(createElement(MemoryRouter, { key: ++seq, initialEntries: [path] }, createElement(Page)));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  return [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("New JSA"));
}

describe("New JSA button", () => {
  test("a worker with an available site sees an enabled New JSA button", async () => {
    sitesImpl = async () => [{ id: "s1", name: "Bomi Hills Pit", code: "LB-BOM-001" }];
    const btns = await render("/operate/jsa");
    expect(btns).toHaveLength(1);
    expect(btns[0].disabled).toBe(false);
  });

  test("a company member with no assignable site still sees the button, disabled, with the reason", async () => {
    sitesImpl = async () => [];
    const btns = await render("/operate/jsa");
    expect(btns).toHaveLength(1);
    expect(btns[0].disabled).toBe(true);
    expect(host.textContent).toContain("assign you to a site");
  });

  test("if the sites cannot be loaded, it says so and offers Try again", async () => {
    sitesImpl = async () => { throw new Error("boom"); };
    const btns = await render("/operate/jsa");
    expect(btns[0].disabled).toBe(true);
    expect(host.querySelector("[role='alert']")?.textContent).toContain("could not be loaded");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Try again")).toBe(true);
  });

  test("Ministry staff on the portal screen are not offered a New JSA they cannot use", async () => {
    sitesImpl = async () => [];
    expect(await render("/portal/jsa")).toHaveLength(0);
  });
});
