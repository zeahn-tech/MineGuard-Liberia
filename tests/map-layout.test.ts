// ---------------------------------------------------------------------------
// The National Map must have a height on a phone.
//
// Reproduced in a real browser (headless Chromium, phone viewport, the built
// app): the Leaflet container measured 356 x 0 px, so the map was blank on a
// phone while fine on desktop. Cause: on a phone the layout is a column
// (flex-col); the map wrapper was `h-[60vh] flex-1` with the map set to
// `size-full` (height: 100%). In an auto-height column, `flex-1` replaces the
// wrapper's height and a child's PERCENTAGE height does not resolve against
// it -> 0px. Layout cannot be measured without a browser, so this pins the
// structural rule that makes the bug impossible; the measurement itself is
// recorded in docs/06.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "pages", "NationalMap.tsx"), "utf8");
const classOf = (needle: RegExp) => {
  const m = SRC.match(needle);
  expect(m, `expected to find ${needle}`).not.toBeNull();
  return m![1];
};

describe("National map sizing (phone layout)", () => {
  const wrapper = classOf(/<div className="([^"]*overflow-hidden[^"]*)">\s*<MapContainer/);

  test("the wrapper has an explicit height and does not flex-grow in the stacked layout", () => {
    expect(wrapper).toMatch(/\bh-\[60vh\]/);
    expect(wrapper).toMatch(/\bmin-h-\[\d+px\]/);
    expect(wrapper).toMatch(/\bflex-none\b/);
    // growth is allowed ONLY side-by-side (large screens), where the row stretches it
    const unprefixedFlex1 = wrapper.split(/\s+/).filter((c) => c === "flex-1");
    expect(unprefixedFlex1).toEqual([]);
    expect(wrapper).toMatch(/\blg:flex-1\b/);
  });

  test("the map fills the wrapper by positioning, not by a percentage height", () => {
    expect(wrapper).toMatch(/\brelative\b/);
    const map = classOf(/<MapContainer[^>]*className="([^"]*)"/);
    expect(map).toMatch(/\babsolute\b/);
    expect(map).toMatch(/\binset-0\b/);
    expect(map).not.toMatch(/\bsize-full\b|\bh-full\b/);
  });
});
