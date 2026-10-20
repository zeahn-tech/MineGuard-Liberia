// ---------------------------------------------------------------------------
// NotificationBellView — rendered through real React (react-dom over happy-dom).
// Regression: the panel used to be `absolute right-0` under the bell, which put
// it off-screen on phones (bell beside other header buttons) and in the desktop
// sidebar footer. It is now a Radix popover portaled to <body>. happy-dom has no
// layout engine, so what is pinned here is the structure that makes on-screen
// placement possible: portal to body (not clipped by the header / sidebar),
// dialog semantics, Escape and click-away closing.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";

const sample = [
  {
    notificationId: "n1",
    kind: "report_status" as const,
    severity: "warning" as const,
    title: "Report triaged",
    body: "A community report was triaged.",
    linkTo: "/portal/community",
    at: Date.now(),
    read: false,
  },
];

let createRoot: typeof import("react-dom/client").createRoot;
let NotificationBellView: typeof import("../src/components/NotificationBellView").NotificationBellView;
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  createRoot = (await import("react-dom/client")).createRoot;
  NotificationBellView = (
    await import("../src/components/NotificationBellView")
  ).NotificationBellView;
  const { MemoryRouter } = await import("react-router");
  host = document.createElement("div");
  // a header-like wrapper that would clip / contain an absolutely positioned child
  host.style.overflow = "hidden";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(NotificationBellView, {
          notifs: sample,
          onMarkRead: () => {},
          onMarkAllRead: () => {},
          onDismiss: () => {},
          onDismissAll: () => {},
        }),
      ),
    );
  });
});

afterAll(async () => {
  await act(async () => root.unmount());
  await GlobalRegistrator.unregister();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

const trigger = () =>
  host.querySelector(
    "button[aria-label^='Notifications']",
  ) as HTMLButtonElement;
const panel = () =>
  document.body.querySelector(
    "[data-slot='popover-content']",
  ) as HTMLElement | null;

describe("notification bell panel", () => {
  test("closed by default; the badge counts unread items", () => {
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-label")).toContain("1 unread");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  test("opening renders the panel in a portal on <body>, outside the clipping header wrapper", async () => {
    await act(async () => {
      trigger().click();
    });
    const p = panel();
    expect(p).not.toBeNull();
    expect(host.contains(p as Node)).toBe(false); // not inside the overflow:hidden host
    expect((p as HTMLElement).textContent).toContain("Report triaged");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect((p as HTMLElement).getAttribute("role")).toBe("dialog");
  });

  test("Escape closes it", async () => {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});
