// ---------------------------------------------------------------------------
// Licence grace period card (migration 0067) — rendered through real React (react-dom over happy-dom) with a spy save
// function. The database is the real gate (tests/grace-period-control.test.ts); these pin the screen: hidden when the account
// does not hold the permission, validation before anything is sent, a plain-words confirmation, a separate switch-off action,
// and friendly errors. Source contracts at the end pin where the card is (and is not) mounted.
// ---------------------------------------------------------------------------
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { GraceStatusResult } from "../src/lib/backend";

let createRoot: typeof import("react-dom/client").createRoot;
let View: typeof import("../src/components/LicenceGraceCardView").LicenceGraceCardView;
let lib: typeof import("../src/lib/licence-grace");
let root: Root | null = null;
let host: HTMLElement;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  createRoot = (await import("react-dom/client")).createRoot;
  View = (await import("../src/components/LicenceGraceCardView")).LicenceGraceCardView;
  lib = await import("../src/lib/licence-grace");
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = "";
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const ok = (over: Partial<{ until: string | null; isActive: boolean; daysLeft: number | null; companiesWithoutLicence: number }> = {}): GraceStatusResult => ({
  state: "ok",
  status: { until: "2026-12-28", isActive: true, daysLeft: 30, companiesWithoutLicence: 7, ...over },
});

async function mount(result: GraceStatusResult | undefined, setGrace: (a: { until: string | null; reason: string }) => Promise<unknown> = async () => {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(View, { result, setGrace })));
}
const text = () => document.body.textContent ?? "";
const buttons = () => [...document.body.querySelectorAll("button")] as HTMLButtonElement[];
const byLabel = (re: RegExp) => buttons().find((b) => re.test(b.textContent ?? ""));
const click = (el: Element | undefined) => act(async () => { (el as HTMLElement).click(); });
async function type(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
const TODAY = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};
const days = () => [...document.body.querySelectorAll("td[data-day]")] as HTMLElement[];
const isDisabled = (td: HTMLElement) => td.classList.contains("rdp-disabled") || (td.querySelector("button") as HTMLButtonElement | null)?.disabled === true;
/** open the picker and choose the first enabled day that is after today */
async function pickFutureDay() {
  await click(byLabel(/Choose a date/));
  const td = days().find((d) => !isDisabled(d) && d.dataset.day! > TODAY());
  expect(td).toBeTruthy();
  await click(td!.querySelector("button")!);
  return td!.dataset.day as string;
}

describe("states", () => {
  test("loading: skeleton, no controls", async () => {
    await mount(undefined);
    expect(document.body.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(byLabel(/Save grace date/)).toBeUndefined();
  });
  test("an account without the permission gets no card at all (admin/registrar only; company users never see it)", async () => {
    await mount({ state: "forbidden" });
    expect(document.body.textContent).toBe("");
  });
  test("error: a clear message, no controls", async () => {
    await mount({ state: "error" });
    expect(text()).toContain("could not be loaded");
    expect(byLabel(/Save grace date/)).toBeUndefined();
  });
  test("shows the date, active status, days left and the companies still without a licence number", async () => {
    await mount(ok());
    expect(document.querySelector("[data-testid='grace-until']")!.textContent).toBe("28 December 2026");
    expect(text()).toContain("Active");
    expect(text()).toContain("30");
    expect(text()).toContain("7");
  });
  test("off: shows Off, not active, and the switch-off action is disabled", async () => {
    await mount(ok({ until: null, isActive: false, daysLeft: null }));
    expect(document.querySelector("[data-testid='grace-until']")!.textContent).toBe("Off");
    expect(text()).toContain("Not active");
    expect(byLabel(/Switch off grace period/)!.disabled).toBe(true);
  });
});

describe("saving a date", () => {
  test("nothing is sent without a date or with a short reason; the messages say why", async () => {
    const calls: unknown[] = [];
    await mount(ok(), async (a) => { calls.push(a); });
    await click(byLabel(/Save grace date/));
    expect(text()).toContain("Choose the last day");
    expect(text()).toContain("at least 5 characters");
    await pickFutureDay();
    await type("grace-reason", "abc");
    await click(byLabel(/Save grace date/));
    expect(text()).toContain("at least 5 characters");
    expect(document.body.querySelector("[role='alertdialog']")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("past days cannot be picked", async () => {
    await mount(ok());
    await click(byLabel(/Choose a date/));
    const past = days().filter((d) => d.dataset.day! < TODAY());
    expect(past.length).toBeGreaterThan(0);
    expect(past.every(isDisabled)).toBe(true);
    expect(isDisabled(days().find((d) => d.dataset.day === TODAY())!)).toBe(false); // today itself is allowed
  });

  test("a valid date and reason ask for confirmation in plain words, and only Confirm sends", async () => {
    const calls: { until: string | null; reason: string }[] = [];
    await mount(ok(), async (a) => { calls.push(a); });
    const d = await pickFutureDay();
    await type("grace-reason", "Ministry extended the deadline");
    await click(byLabel(/Save grace date/));
    const dialog = document.body.querySelector("[role='alertdialog']")!;
    expect(dialog.textContent).toContain("Companies without a licence number can request new sites until");
    expect(dialog.textContent).toContain("After that they cannot until a licence number is recorded. Existing sites are not affected.");
    expect(calls).toHaveLength(0);
    await click(byLabel(/^\s*Cancel/));
    expect(calls).toHaveLength(0);
    await click(byLabel(/Save grace date/));
    await click(byLabel(/^\s*Confirm/));
    expect(calls).toEqual([{ until: d, reason: "Ministry extended the deadline" }]);
  });

  test("server refusals are shown in friendly words", async () => {
    await mount(ok(), async () => { throw new Error("The date is too far ahead. Choose a date within 365 days from today."); });
    await pickFutureDay();
    await type("grace-reason", "Ministry extended the deadline");
    await click(byLabel(/Save grace date/));
    await click(byLabel(/^\s*Confirm/));
    expect(document.body.querySelector("[role='alert']")!.textContent).toContain("too far ahead");
  });
});

describe("switching off", () => {
  test("is a separate action with its own confirmation and the same reason requirement", async () => {
    const calls: { until: string | null; reason: string }[] = [];
    await mount(ok(), async (a) => { calls.push(a); });
    await click(byLabel(/Switch off grace period/));
    expect(text()).toContain("at least 5 characters"); // reason first
    expect(document.body.querySelector("[role='alertdialog']")).toBeNull();
    await type("grace-reason", "All licence numbers recorded");
    await click(byLabel(/Switch off grace period/));
    const dialog = document.body.querySelector("[role='alertdialog']")!;
    expect(dialog.textContent).toContain("will no longer be able to request new sites");
    expect(calls).toHaveLength(0);
    await click(byLabel(/^\s*Switch off$/));
    expect(calls).toEqual([{ until: null, reason: "All licence numbers recorded" }]);
  });
});

describe("pure helpers", () => {
  test("reason rules: 5 to 300 characters after trimming", () => {
    expect(lib.graceReasonProblem("    ab  ")).toBeDefined();
    expect(lib.graceReasonProblem("abcde")).toBeUndefined();
    expect(lib.graceReasonProblem("x".repeat(300))).toBeUndefined();
    expect(lib.graceReasonProblem("x".repeat(301))).toBeDefined();
  });
  test("dates are formatted as calendar dates, never shifted by time zone; the cap mirrors the database", () => {
    expect(lib.formatGraceDate("2027-01-31")).toBe("31 January 2027");
    expect(lib.GRACE_MAX_DAYS).toBe(365);
    expect(readFileSync(join(import.meta.dir, "..", "supabase/migrations/0067_grace_period_control.sql"), "utf8")).toContain("c_max_grace_days constant integer := 365");
  });
});

describe("where the card is mounted", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
  test("only on the Ministry Companies page, which is limited to administrators and registrars", () => {
    const s = read("src/pages/Companies.tsx");
    expect(s).toContain("<LicenceGraceCard />");
    expect(s).toMatch(/user\.role !== "admin" && user\.role !== "registrar"/);
  });
  test("no company-facing screen references the grace controls or the status call", () => {
    for (const f of ["src/pages/operate/OperatorSiteRequests.tsx", "src/pages/operate/OperatorCompany.tsx", "src/pages/operate/OperatorLayout.tsx", "src/pages/operate/OperatorOverview.tsx"]) {
      const s = read(f);
      expect(s).not.toContain("LicenceGraceCard");
      expect(s).not.toContain("graceStatus");
      expect(s).not.toContain("setGraceUntil");
    }
  });
  test("the client calls only the two 0067 functions and never touches platform_settings directly", () => {
    const s = read("src/lib/backend.ts");
    expect(s).toContain('supabase.rpc("mg_set_licence_grace_until"');
    expect(s).toContain('supabase.rpc("mg_licence_grace_status")');
    expect(s).not.toMatch(/from\("platform_settings"\)/);
  });
  test("friendly messages exist for FORBIDDEN, REASON_REQUIRED, PAST_DATE and MAX_GRACE_EXCEEDED", () => {
    const s = read("src/lib/backend.ts");
    for (const code of ["FORBIDDEN", "REASON_REQUIRED", "PAST_DATE", "MAX_GRACE_EXCEEDED"]) expect(s).toMatch(new RegExp(`${code}: "`));
  });
});
