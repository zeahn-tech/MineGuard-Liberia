// ---------------------------------------------------------------------------
// useKeysetPage — the list pages' incremental window (SEC-4 v2).
//
// The hook had no tests and carried two latent defects the lint pass
// surfaced: it wrote refs during render and synced state from effects, and
// its first fetch depended on an auth-epoch change instead of happening on
// mount. These tests pin the contract the Incidents / Inspections pages
// rely on, rendered through real React (react-dom + a DOM from happy-dom,
// registered ONLY inside this file so no other suite sees a `window`).
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";

type Cursor = { at: number; id: string } | null;
type Page = { rows: number[]; nextCursor: Cursor; source: string };
type Feed = { rows: number[]; hasMore: boolean; loading: boolean; loadMore: () => void };

let createRoot: typeof import("react-dom/client").createRoot;
let useKeysetPage: typeof import("../src/lib/backend-react").useKeysetPage;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  createRoot = (await import("react-dom/client")).createRoot;
  useKeysetPage = (await import("../src/lib/backend-react")).useKeysetPage;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const cur = (n: number): Cursor => ({ at: n, id: `id-${n}` });
const page = (rows: number[], next: Cursor): Page => ({ rows, nextCursor: next, source: "rpc" });

/** Mounts the hook; `latest()` is the feed from the most recent render. */
async function mountHook(
  fetch: (before: Cursor) => Promise<Page>,
  pageKeys = 1,
  resetKey = "",
) {
  let latest: Feed | undefined;
  const Probe = (props: { resetKey: string; pageKeys: number }) => {
    latest = useKeysetPage<number>(fetch, props.pageKeys, props.resetKey);
    return null;
  };
  const host = document.createElement("div");
  const root: Root = createRoot(host);
  const render = (props: { resetKey: string; pageKeys: number }) =>
    act(async () => {
      root.render(createElement(Probe, props));
    });
  await render({ resetKey, pageKeys });
  return {
    latest: () => latest!,
    rerender: render,
    unmount: () => act(async () => root.unmount()),
  };
}

const settle = () => act(async () => {});

describe("useKeysetPage", () => {
  test("fetches the first page ON MOUNT — no auth-epoch change required", async () => {
    const calls: Cursor[] = [];
    const h = await mountHook(async (before) => {
      calls.push(before);
      return page([1, 2], cur(2));
    });
    await settle();
    expect(calls).toEqual([null]);
    expect(h.latest().rows).toEqual([1, 2]);
    expect(h.latest().hasMore).toBe(true);
    expect(h.latest().loading).toBe(false);
    await h.unmount();
  });

  test("loadMore walks the next page from the previous cursor, then stops at the end", async () => {
    const calls: Cursor[] = [];
    const h = await mountHook(async (before) => {
      calls.push(before);
      return before === null ? page([1, 2], cur(2)) : page([3], null);
    });
    await settle();
    await act(async () => h.latest().loadMore());
    await settle();
    expect(calls).toEqual([null, cur(2)]);
    expect(h.latest().rows).toEqual([1, 2, 3]);
    expect(h.latest().hasMore).toBe(false);

    // Past the last page: asking for more must NOT fetch again.
    await act(async () => h.latest().loadMore());
    await settle();
    expect(calls).toHaveLength(2);
    await h.unmount();
  });

  test("pageKeys > 1 pulls that many pages, strictly one request in flight at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: Cursor[] = [];
    const h = await mountHook(async (before) => {
      calls.push(before);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      const n = before === null ? 0 : before.at;
      return n >= 3 ? page([n + 1], null) : page([n + 1], cur(n + 1));
    }, 3);
    await settle();
    await settle();
    expect(maxInFlight).toBe(1);
    expect(h.latest().rows).toEqual([1, 2, 3]);
    expect(calls).toEqual([null, cur(1), cur(2)]);
    await h.unmount();
  });

  test("a failing fetch ends the feed (no retry storm) and reports not-loading", async () => {
    const realError = console.error;
    console.error = () => {};
    let calls = 0;
    const h = await mountHook(async () => {
      calls++;
      throw new Error("boom");
    });
    await settle();
    await settle();
    console.error = realError;
    expect(calls).toBe(1);
    expect(h.latest().rows).toEqual([]);
    expect(h.latest().loading).toBe(false);
    expect(h.latest().hasMore).toBe(false);
    await h.unmount();
  });

  test("a new resetKey starts a NEW stream from the first page; the old stream's late result is discarded", async () => {
    let releaseOld: (p: Page) => void = () => {};
    const calls: Array<{ key: string; before: Cursor }> = [];
    let activeKey = "a";
    const h = await mountHook(async (before) => {
      const key = activeKey;
      calls.push({ key, before });
      if (key === "a") {
        return new Promise<Page>((resolve) => {
          releaseOld = resolve; // held open: stream "a" is still in flight
        });
      }
      return page([100], null);
    }, 1, "a");

    activeKey = "b";
    await h.rerender({ resetKey: "b", pageKeys: 1 });
    await settle();
    expect(h.latest().rows).toEqual([100]);

    // Stream "a" finally answers — it must not leak into stream "b".
    await act(async () => releaseOld(page([1, 2, 3], cur(3))));
    await settle();
    expect(h.latest().rows).toEqual([100]);
    expect(calls.map((c) => c.key)).toEqual(["a", "b"]);
    expect(calls[1].before).toBeNull();
    await h.unmount();
  });

  test("unmounting mid-flight never throws or updates state afterwards", async () => {
    let release: (p: Page) => void = () => {};
    const h = await mountHook(
      () =>
        new Promise<Page>((resolve) => {
          release = resolve;
        }),
    );
    expect(h.latest().loading).toBe(true);
    await h.unmount();
    await act(async () => release(page([1], null)));
    await settle();
  });
});
