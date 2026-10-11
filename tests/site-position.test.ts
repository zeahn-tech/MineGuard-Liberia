// ---------------------------------------------------------------------------
// Site position helpers — the single definition of "a usable Liberian
// position" shared by the form, the API and the map.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import {
  accuracyProblem,
  describeGeolocationError,
  draftFromSite,
  formatCoordinate,
  gpsQuality,
  isSitePositionSource,
  liberiaPositionProblem,
  parsePositionInput,
} from "../src/lib/site-position";
import { inLiberia } from "../src/lib/gis";

describe("liberiaPositionProblem", () => {
  test("accepts Liberian positions and tolerates either axis omitted", () => {
    expect(liberiaPositionProblem(6.43, -9.43)).toBeNull();
    expect(liberiaPositionProblem(6.43, undefined)).toBeNull();
    expect(liberiaPositionProblem(null, -9.43)).toBeNull();
  });
  test("a longitude missing its minus sign names the fix", () => {
    const p = liberiaPositionProblem(6.43, 9.43);
    expect(p?.code).toBe("INVALID_LONGITUDE");
    expect(p?.message).toContain("did you mean -9.43");
  });
  test("a positive longitude that is far from Liberia gets no misleading hint", () => {
    expect(liberiaPositionProblem(6.43, 100)?.message).not.toContain("did you mean");
  });
  test("an out-of-range latitude is reported as latitude", () => {
    expect(liberiaPositionProblem(60, -9.43)?.code).toBe("INVALID_LATITUDE");
  });
  test("NaN is never a usable axis", () => {
    expect(liberiaPositionProblem(Number.NaN, -9.43)?.code).toBe("INVALID_LATITUDE");
    expect(liberiaPositionProblem(6.4, Number.NaN)?.code).toBe("INVALID_LONGITUDE");
  });
  test("agrees with the map's own inLiberia on every edge", () => {
    for (const [lat, lng] of [[4.3, -11.6], [8.6, -7.3], [4.29, -9], [6, -7.29], [6, -11.61], [0, 0]]) {
      expect(liberiaPositionProblem(lat, lng) === null).toBe(inLiberia(lat, lng));
    }
  });
});

describe("parsePositionInput", () => {
  test("both blank = no position (a site may be registered without one)", () => {
    expect(parsePositionInput("", "  ")).toEqual({ kind: "empty" });
  });
  test("one blank is an error — a point is a pair", () => {
    expect(parsePositionInput("6.4", "")).toMatchObject({ kind: "error" });
    expect(parsePositionInput("", "-9.4")).toMatchObject({ kind: "error" });
  });
  test("non-numbers are refused by axis", () => {
    expect((parsePositionInput("abc", "-9.4") as { error: string }).error).toContain("Latitude");
    expect((parsePositionInput("6.4", "x") as { error: string }).error).toContain("Longitude");
    expect(parsePositionInput("Infinity", "-9.4")).toMatchObject({ kind: "error" });
  });
  test("valid input parses to numbers, trimming whitespace", () => {
    expect(parsePositionInput(" 6.43 ", " -9.43 ")).toEqual({ kind: "ok", latitude: 6.43, longitude: -9.43 });
  });
  test("an out-of-Liberia pair carries the actionable message", () => {
    expect((parsePositionInput("6.43", "9.43") as { error: string }).error).toContain("did you mean -9.43");
  });
});

describe("GPS helpers", () => {
  test("accuracy bands", () => {
    expect(gpsQuality(5).level).toBe("good");
    expect(gpsQuality(20).level).toBe("good");
    expect(gpsQuality(21).level).toBe("fair");
    expect(gpsQuality(100).level).toBe("fair");
    expect(gpsQuality(101).level).toBe("poor");
  });
  test("every geolocation error code has actionable advice that offers the map as a way out", () => {
    for (const code of [1, 2, 3, 0]) expect(describeGeolocationError(code)).toMatch(/map|coordinates/);
    expect(describeGeolocationError(1)).toContain("permission");
  });
  test("coordinates are formatted without trailing noise", () => {
    expect(formatCoordinate(6.4300001)).toBe("6.43");
    expect(formatCoordinate(-9.123456789)).toBe("-9.123457");
  });
  test("accuracy must be a finite non-negative number when present", () => {
    expect(accuracyProblem(undefined)).toBeNull();
    expect(accuracyProblem(null)).toBeNull();
    expect(accuracyProblem(0)).toBeNull();
    expect(accuracyProblem(12.5)).toBeNull();
    expect(accuracyProblem(-1)).toBe("INVALID_ACCURACY");
    expect(accuracyProblem(Number.NaN)).toBe("INVALID_ACCURACY");
    expect(accuracyProblem(Infinity)).toBe("INVALID_ACCURACY");
  });
});

describe("draftFromSite / sources", () => {
  test("a site with a position seeds the editor, keeping its provenance", () => {
    expect(draftFromSite({ latitude: 6.4, longitude: -9.4, geoSource: "device_gps", geoAccuracyM: 7 })).toEqual({
      latitude: "6.4",
      longitude: "-9.4",
      accuracyM: 7,
      source: "device_gps",
    });
  });
  test("a site with no position seeds an empty editor", () => {
    expect(draftFromSite({ latitude: null, longitude: null })).toMatchObject({ latitude: "", longitude: "", source: "manual_entry" });
  });
  test("a registry-era source label falls back to manual entry (it is not a capture method)", () => {
    expect(draftFromSite({ latitude: 6.4, longitude: -9.4, geoSource: "registry_entry" }).source).toBe("manual_entry");
  });
  test("only the three capture methods are accepted", () => {
    expect(["device_gps", "map_pick", "manual_entry"].every(isSitePositionSource)).toBe(true);
    expect(isSitePositionSource("registry_entry")).toBe(false);
    expect(isSitePositionSource(undefined)).toBe(false);
  });
});
