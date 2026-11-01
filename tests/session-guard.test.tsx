// ---------------------------------------------------------------------------
// SESSION GUARD + useFormDraft — rendered through real React over happy-dom.
// The point of both: a timeout must never cost anyone their work, and the
// person must be told, with a chance to stay, before it happens.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, useEffect, useState, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { ACTIVITY_KEY } from "../src/lib/session-expiry";

let createRoot: typeof import("react-dom/client").createRoot;
let R: typeof import("react-router");
let SessionGuard: typeof import("../src/components/SessionGuard").SessionGuard;
let useFormDraft: typeof import("../src/hooks/use-form-draft").useFormDraft;
let DRAFT_DEBOUNCE_MS: number;
let drafts: typeof import("../src/lib/form-drafts");
let supa: typeof import("../src/lib/supabase");
let store: typeof import("../src/lib/offline-store");

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  createRoot = (await import("react-dom/client")).createRoot;
  R = await import("react-router");
  SessionGuard = (await import("../src/components/SessionGuard")).SessionGuard;
  const h = await import("../src/hooks/use-form-draft");
  useFormDraft = h.useFormDraft;
  DRAFT_DEBOUNCE_MS = h.DRAFT_DEBOUNCE_MS;
  drafts = await import("../src/lib/form-drafts");
  supa = await import("../src/lib/supabase");
  store = await import("../src/lib/offline-store");
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  localStorage.clear();
  store.__resetOfflineStore();
  supa.__testSetAuthUserId(null);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = (ms: number) => act(async () => void (await sleep(ms)));

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

async function mount(node: ReactElement, path = "/portal/incidents") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(createElement(R.MemoryRouter, { initialEntries: [path] }, node));
  });
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const dialogText = () => document.body.textContent ?? "";
const buttonByText = (re: RegExp) =>
  [...document.body.querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement | undefined;

function Where() {
  const l = R.useLocation();
  return createElement("p", { "data-testid": "where" }, `${l.pathname}${l.search}`);
}

describe("SessionGuard", () => {
  test("stays silent while the person is active", async () => {
    setOnline(true);
    let expired = 0;
    const h = await mount(
      createElement(SessionGuard, { limitMs: 3000, warnMs: 1500, tickMs: 100, onExpire: async () => void expired++ }),
    );
    await settle(400);
    expect(dialogText()).not.toContain("Are you still there?");
    expect(expired).toBe(0);
    await h.unmount();
  });

  test("warns before signing out: says why, shows a countdown, offers to stay — and Stay really keeps them in", async () => {
    setOnline(true);
    let expired = 0;
    const h = await mount(
      createElement(SessionGuard, { limitMs: 2000, warnMs: 1500, tickMs: 100, onExpire: async () => void expired++ }),
    );
    await settle(900); // idle > 500ms -> inside the 1500ms warning window
    expect(dialogText()).toContain("Are you still there?");
    expect(dialogText()).toContain("30 minutes of inactivity");
    expect(dialogText()).toContain("kept on this device");
    expect(document.querySelector('[data-testid="idle-countdown"]')?.textContent).toMatch(/^0:0\d$/);
    expect(expired).toBe(0);

    await act(async () => buttonByText(/stay signed in/i)!.click());
    expect(dialogText()).not.toContain("Are you still there?");
    await settle(900);
    // Activity was reset: not expired even though the original limit has passed.
    expect(expired).toBe(0);
    await h.unmount();
  });

  test("after the limit it signs out exactly once and sends the person to sign in, remembering where they were", async () => {
    setOnline(true);
    let expired = 0;
    const h = await mount(
      createElement(
        "div",
        null,
        createElement(SessionGuard, { limitMs: 700, warnMs: 300, tickMs: 100, onExpire: async () => void expired++ }),
        createElement(Where),
      ),
      "/portal/incidents?tab=open",
    );
    await settle(1200);
    expect(expired).toBe(1);
    const where = document.querySelector('[data-testid="where"]')!.textContent!;
    expect(where.startsWith("/auth?returnTo=")).toBe(true);
    expect(decodeURIComponent(where)).toContain("/portal/incidents?tab=open");
    await settle(400);
    expect(expired).toBe(1); // never twice
    await h.unmount();
  });

  test("activity anywhere (even another tab) keeps the session alive", async () => {
    setOnline(true);
    let expired = 0;
    const h = await mount(
      createElement(SessionGuard, { limitMs: 800, warnMs: 300, tickMs: 100, onExpire: async () => void expired++ }),
    );
    for (let i = 0; i < 4; i++) {
      await settle(300);
      window.dispatchEvent(new Event("pointerdown")); // this tab
    }
    expect(expired).toBe(0);
    for (let i = 0; i < 4; i++) {
      await settle(300);
      localStorage.setItem(ACTIVITY_KEY, String(Date.now())); // another tab
    }
    expect(expired).toBe(0);
    await h.unmount();
  });

  test("offline: sign-out is deferred (a field worker must not be stranded), then happens on reconnect", async () => {
    setOnline(false);
    let expired = 0;
    const h = await mount(
      createElement(SessionGuard, { limitMs: 500, warnMs: 200, tickMs: 100, onExpire: async () => void expired++ }),
    );
    await settle(1000);
    expect(expired).toBe(0);
    await act(async () => setOnline(true));
    await settle(300);
    expect(expired).toBe(1);
    await h.unmount();
  });

  test("'Sign out now' in the dialog signs out immediately and returns to the landing page", async () => {
    setOnline(true);
    let now = 0;
    let expired = 0;
    const h = await mount(
      createElement(
        "div",
        null,
        createElement(SessionGuard, {
          limitMs: 5000,
          warnMs: 4900,
          tickMs: 100,
          onExpire: async () => void expired++,
          onSignOutNow: async () => void now++,
        }),
        createElement(Where),
      ),
    );
    await settle(500);
    expect(dialogText()).toContain("Are you still there?");
    await act(async () => buttonByText(/sign out now/i)!.click());
    await settle(100);
    expect(now).toBe(1);
    expect(expired).toBe(0);
    expect(document.querySelector('[data-testid="where"]')!.textContent).toBe("/");
    await h.unmount();
  });
});

type Form = { description: string; count: string };
const BLANK: Form = { description: "", count: "" };

function Probe({ onHook }: { onHook: (d: ReturnType<typeof useFormDraft<Form>>) => void }) {
  const d = useFormDraft<Form>("probe-form", BLANK);
  onHook(d);
  return createElement("span", null, d.form.description);
}

describe("useFormDraft", () => {
  test("saves what the person typed, and puts it back after a sign-out and return", async () => {
    supa.__testSetAuthUserId("worker-1");
    let hook!: ReturnType<typeof useFormDraft<Form>>;
    const a = await mount(createElement(Probe, { onHook: (d) => (hook = d) }));
    await settle(50);
    await act(async () => hook.setForm({ description: "Rockfall at the north pit", count: "2" }));
    await settle(DRAFT_DEBOUNCE_MS + 250);
    expect((await drafts.loadFormDraft<Form>("worker-1", "probe-form"))?.data.description).toBe("Rockfall at the north pit");
    await a.unmount();

    // …later (new visit): the same person gets their words back.
    let hook2!: ReturnType<typeof useFormDraft<Form>>;
    const b = await mount(createElement(Probe, { onHook: (d) => (hook2 = d) }));
    await settle(150);
    expect(hook2.form.description).toBe("Rockfall at the north pit");
    expect(hook2.form.count).toBe("2");
    expect(hook2.restoredAt).not.toBeNull();
    expect(hook2.hasDraft).toBe(true);
    await b.unmount();
  });

  test("another person signing in on the same device does not get the draft", async () => {
    supa.__testSetAuthUserId("worker-1");
    let hook!: ReturnType<typeof useFormDraft<Form>>;
    const a = await mount(createElement(Probe, { onHook: (d) => (hook = d) }));
    await settle(50);
    await act(async () => hook.setForm({ description: "A's private words", count: "" }));
    await settle(DRAFT_DEBOUNCE_MS + 250);
    await a.unmount();

    supa.__testSetAuthUserId("worker-2");
    let hook2!: ReturnType<typeof useFormDraft<Form>>;
    const b = await mount(createElement(Probe, { onHook: (d) => (hook2 = d) }));
    await settle(150);
    expect(hook2.form.description).toBe("");
    expect(hook2.restoredAt).toBeNull();
    await b.unmount();
  });

  test("clearDraft after a successful submit leaves nothing to restore", async () => {
    supa.__testSetAuthUserId("worker-1");
    let hook!: ReturnType<typeof useFormDraft<Form>>;
    const a = await mount(createElement(Probe, { onHook: (d) => (hook = d) }));
    await settle(50);
    await act(async () => hook.setForm({ description: "to be submitted", count: "" }));
    await settle(DRAFT_DEBOUNCE_MS + 250);
    await act(async () => {
      hook.setForm(BLANK);
      hook.clearDraft();
    });
    await settle(DRAFT_DEBOUNCE_MS + 250);
    expect(await drafts.loadFormDraft("worker-1", "probe-form")).toBeNull();
    await a.unmount();
  });

  test("discardDraft resets to blank and forgets it", async () => {
    supa.__testSetAuthUserId("worker-1");
    let hook!: ReturnType<typeof useFormDraft<Form>>;
    const a = await mount(createElement(Probe, { onHook: (d) => (hook = d) }));
    await settle(50);
    await act(async () => hook.setForm({ description: "throw away", count: "1" }));
    await settle(DRAFT_DEBOUNCE_MS + 250);
    await act(async () => hook.discardDraft());
    await settle(DRAFT_DEBOUNCE_MS + 250);
    expect(hook.form).toEqual(BLANK);
    expect(hook.hasDraft).toBe(false);
    expect(await drafts.loadFormDraft("worker-1", "probe-form")).toBeNull();
    await a.unmount();
  });

  test("unmounting before the debounce fires still saves (closing the form never loses typing)", async () => {
    supa.__testSetAuthUserId("worker-1");
    let hook!: ReturnType<typeof useFormDraft<Form>>;
    const a = await mount(createElement(Probe, { onHook: (d) => (hook = d) }));
    await settle(50);
    await act(async () => hook.setForm({ description: "typed then navigated away", count: "" }));
    await a.unmount(); // well before DRAFT_DEBOUNCE_MS
    await settle(200);
    expect((await drafts.loadFormDraft<Form>("worker-1", "probe-form"))?.data.description).toBe("typed then navigated away");
  });

  test("a form its parent hides in the SAME batch as a successful submit does NOT write the submitted text back as a draft", async () => {
    supa.__testSetAuthUserId("worker-1");
    let hook!: ReturnType<typeof useFormDraft<Form>>;
    let hide!: () => void;
    function Host({
      onHook,
      onReady,
    }: {
      onHook: (d: ReturnType<typeof useFormDraft<Form>>) => void;
      onReady: (hideForm: () => void) => void;
    }) {
      const [show, setShow] = useState(true);
      useEffect(() => {
        onReady(() => setShow(false));
      }, [onReady]);
      return show ? createElement(Probe, { onHook }) : createElement("span", null, "sent");
    }
    const a = await mount(
      createElement(Host, {
        onHook: (d) => (hook = d),
        onReady: (fn) => (hide = fn),
      }),
    );
    await settle(50);
    await act(async () => hook.setForm({ description: "already sent to the server", count: "1" }));
    await settle(30); // typed text is now the form's current value
    // Exactly what OperatorIncidentForm does on success: reset, clear, and let
    // the parent unmount the form — all in one batch, so the form's effects
    // never get to refresh their "latest value" before the cleanup runs.
    await act(async () => {
      hook.setForm(BLANK);
      hook.clearDraft();
      hide();
    });
    await settle(DRAFT_DEBOUNCE_MS + 250);
    expect(await drafts.loadFormDraft("worker-1", "probe-form")).toBeNull();
    await a.unmount();
  });

  test("signed out: behaves like plain useState and stores nothing", async () => {
    supa.__testSetAuthUserId(null);
    let hook!: ReturnType<typeof useFormDraft<Form>>;
    const a = await mount(createElement(Probe, { onHook: (d) => (hook = d) }));
    await settle(50);
    await act(async () => hook.setForm({ description: "nobody is signed in", count: "" }));
    await settle(DRAFT_DEBOUNCE_MS + 250);
    expect(hook.form.description).toBe("nobody is signed in");
    expect(await drafts.loadFormDraft("anyone", "probe-form")).toBeNull();
    await a.unmount();
  });
});
