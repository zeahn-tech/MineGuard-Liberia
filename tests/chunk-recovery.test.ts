// ---------------------------------------------------------------------------
// Stale app shell recovery: after a deploy, a phone holding the old shell asks
// for lazy page chunks that no longer exist and shows a blank screen. One
// automatic reload fixes it; more than one could loop forever.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { CHUNK_RELOAD_KEY, installChunkRecovery } from "../src/lib/chunk-recovery";

function setup(opts: { storageBroken?: boolean } = {}) {
  let handler: ((e: { preventDefault(): void }) => void) | undefined;
  const target = {
    addEventListener(type: string, fn: (e: { preventDefault(): void }) => void) {
      if (type === "vite:preloadError") handler = fn;
    },
  };
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => {
      if (opts.storageBroken) throw new Error("denied");
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.storageBroken) throw new Error("denied");
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
  let reloads = 0;
  installChunkRecovery(target, store, () => reloads++);
  let prevented = 0;
  const fire = () => handler!({ preventDefault: () => prevented++ });
  return { fire, data, reloads: () => reloads, prevented: () => prevented };
}

describe("installChunkRecovery", () => {
  test("a failed chunk load reloads the page once and marks the session", () => {
    const t = setup();
    t.fire();
    expect(t.reloads()).toBe(1);
    expect(t.data.has(CHUNK_RELOAD_KEY)).toBe(true);
  });

  test("it handles the event itself (the error is not re-thrown as unhandled)", () => {
    const t = setup();
    t.fire();
    expect(t.prevented()).toBe(1);
  });

  test("a second failure in the same session does NOT reload again (no infinite loop)", () => {
    const t = setup();
    t.fire();
    t.fire();
    t.fire();
    expect(t.reloads()).toBe(1);
    expect(t.prevented()).toBe(3);
  });

  test("with no usable storage it cannot guard against a loop, so it never reloads", () => {
    const t = setup({ storageBroken: true });
    t.fire();
    expect(t.reloads()).toBe(0);
  });
});
