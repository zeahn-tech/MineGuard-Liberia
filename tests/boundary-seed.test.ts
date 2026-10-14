// ---------------------------------------------------------------------------
// Official county / district boundaries (geoBoundaries, gbOpen, simplified).
//
// Pins what was verified about the data (checksums = byte-identical to the
// publisher's files), that the committed SQL seed is exactly what the data
// produces, and that the names line up with how the application spells
// counties. The database-level behaviour of the seed itself is in gis.test.ts.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ATTRIBUTION, buildRows, buildSql, SEED_PATH } from "../scripts/build-boundary-seed";
import { sameCountyName } from "../src/lib/gis";

const DATA = join(import.meta.dir, "..", "data", "boundaries", "geoboundaries-lbr");
const sha = (file: string) => createHash("sha256").update(readFileSync(join(DATA, file))).digest("hex");

// The publisher's Git LFS object ids for geoBoundaries-LBR-ADM{1,2}_simplified.geojson
// (wmgeolab/geoBoundaries, releaseData/gbOpen/LBR/, checked 2026-10-12).
const PUBLISHED = {
  "liberia-counties.geojson": "f6f4ed18e1e29532a77325f7af84a6dacc4489d94020f2fa2a8feb12a4da9b34",
  "liberia-districts.geojson": "9708518c0e606d1d662e29493f3c85fe9053149c0f9d81cf11e81df0a7992d8b",
};
// The spellings the application itself uses (src/pages/Sites.tsx COUNTIES).
const APP_COUNTIES = [
  "Bomi", "Bong", "Gbarpolu", "Grand Bassa", "Grand Cape Mount", "Grand Gedeh", "Grand Kru",
  "Lofa", "Margibi", "Maryland", "Montserrado", "Nimba", "River Cess", "River Gee", "Sinoe",
];

describe("data integrity", () => {
  test.each(Object.entries(PUBLISHED))("%s is byte-identical to the publisher's file", (file, oid) => {
    expect(sha(file)).toBe(oid);
  });

  test("SHA256SUMS and PROVENANCE.md agree with the files (an edit cannot go unnoticed)", () => {
    const sums = readFileSync(join(DATA, "SHA256SUMS"), "utf8");
    const prov = readFileSync(join(DATA, "PROVENANCE.md"), "utf8");
    for (const file of Object.keys(PUBLISHED)) {
      expect(sums).toContain(`${sha(file)}  ${file}`);
      expect(prov).toContain(sha(file));
    }
  });

  describe("PROVENANCE.md — the publisher record, verbatim and complete", () => {
    const prov = readFileSync(join(DATA, "PROVENANCE.md"), "utf8");
    const both = (field: string, value: string) => `| \`${field}\` | ${value} | ${value} |`;
    const PINNED = "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/LBR";
    const HDX = "https://data.humdata.org/dataset/liberia-admin-level-2-boundaries";

    test("every field supplied from the official API is recorded exactly, for both ADM1 and ADM2", () => {
      expect(prov).toContain(both("boundarySource", "UNMIL, OCHA ROWCA"));
      expect(prov).toContain(
        both("boundaryLicense", "Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO)"),
      );
      expect(prov).toContain(both("boundarySourceURL", HDX));
      expect(prov).toContain(both("licenseSource", HDX));
      expect(prov).toContain(both("buildDate", "Dec 12, 2023"));
      expect(prov).toContain(both("boundaryYearRepresented", "2021"));
      expect(prov).toContain(
        `| \`downloadURL\` | ${PINNED}/ADM1/geoBoundaries-LBR-ADM1_simplified.geojson | ${PINNED}/ADM2/geoBoundaries-LBR-ADM2_simplified.geojson |`,
      );
      expect(prov).toContain("https://www.geoboundaries.org/api/current/gbOpen/LBR/ADM1/");
      expect(prov).toContain("https://www.geoboundaries.org/api/current/gbOpen/LBR/ADM2/");
    });

    test("licenseDetail is the literal 'nan' — recorded as not specified, not interpreted", () => {
      expect(prov).toContain("| `licenseDetail` | `nan` (not specified in the API) | `nan` (not specified in the API) |");
      expect(prov).toContain("read as a permission or a restriction");
    });

    test("the verification evidence names the pinned commit and ties both files to it", () => {
      expect(prov).toContain("9469f09592ced973a3448cf66b6100b741b64c0d");
      expect(prov).toContain("Tue, 12 Dec 2023 23:03:07 -0500");
      for (const oid of Object.values(PUBLISHED)) expect(prov).toContain(`${oid.slice(0, 8)}…${oid.slice(-7)}`);
      expect(prov).toContain("**MATCH**");
      expect(prov).toContain("byte-for-byte the files the publisher's");
    });

    test("what could NOT be confirmed is stated as such, never filled in", () => {
      expect(prov).toContain("HTTP 429");
      expect(prov).toContain("NOT RE-CONFIRMED");
      expect(prov).toContain("NOT VERIFIED");
      expect(prov).toContain("NOT STATED");
      expect(prov).toContain("`____-__-__`"); // the retrieval date is a blank to be filled, not an invented date
    });

    test("the source build date and the metadata retrieval date are separate rows, and never mixed", () => {
      const row = (label: string) => prov.split("\n").find((l) => l.startsWith(`| **${label}**`)) ?? "";
      expect(row("Source build date")).toContain("Dec 12, 2023");
      expect(row("Metadata retrieved from the API")).not.toContain("Dec 12, 2023");
      expect(row("Metadata retrieved from the API")).toContain("NOT STATED");
      expect(prov).toContain("## 4. Dates — kept separate");
    });

    test("the licence is kept as published and never relabelled; attribution and obligations are present", () => {
      expect(prov).toContain("https://creativecommons.org/licenses/by/3.0/igo/");
      expect(prov).toContain("must not\nbe described or labelled as CC BY 4.0");
      expect(prov).toContain(`> ${ATTRIBUTION}`);
      expect(prov).toContain("clearly identify that changes were made");
      expect(prov).toContain("Do not state or imply");
      expect(prov).toContain("https://doi.org/10.1371/journal.pone.0231866");
    });
  });
});

describe("the seed", () => {
  const rows = buildRows();

  test("covers every shape: 15 counties and 136 districts, all valid, none skipped", () => {
    expect(rows.filter((r) => r.level === "county")).toHaveLength(15);
    expect(rows.filter((r) => r.level === "district")).toHaveLength(136);
  });

  test("the committed SQL is exactly what the data produces (regenerate with scripts/build-boundary-seed.ts)", () => {
    expect(readFileSync(SEED_PATH, "utf8")).toBe(buildSql(rows));
  });

  test("ids are stable name-based UUIDs and unique (a re-run can never duplicate)", () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(151);
    for (const r of rows) expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(buildRows().map((r) => r.id)).toEqual(rows.map((r) => r.id)); // deterministic
  });

  test("every boundary carries the licence-required attribution as its source — CC BY 3.0 IGO, never 4.0", () => {
    for (const r of rows) {
      expect(r.source).toBe(ATTRIBUTION);
      expect(r.source).toContain("UNMIL; OCHA ROWCA");
      expect(r.source).toContain("simplified geometry"); // the change must be identified (§3(b))
      expect(r.source).toContain("CC BY 3.0 IGO");
      expect(r.source).not.toContain("4.0");
    }
  });

  test("the seed's own header states the real licence", () => {
    const sql = readFileSync(SEED_PATH, "utf8");
    expect(sql).toContain("Creative Commons Attribution 3.0 Intergovernmental");
    expect(sql).toContain("Not CC BY 4.0");
  });

  test("nothing in the application labels this data as CC BY 4.0", () => {
    const files = new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(import.meta.dir, "..", "src") });
    const offenders = [...files].filter((f) =>
      /CC[ -]BY[ -]4\.0/i.test(readFileSync(join(import.meta.dir, "..", "src", f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("the seed never marks anything verified and never overwrites or deletes", () => {
    const sql = readFileSync(SEED_PATH, "utf8");
    expect(sql).toContain("geo_verified");
    expect(sql).toMatch(/select v\.id, v\.name, v\.level, v\.geom, v\.source, false/);
    expect(sql).toContain("on conflict (id) do nothing");
    expect(sql).toContain("where not exists");
    expect(sql.replace(/\$gj\$[\s\S]*?\$gj\$/g, "")).not.toMatch(/\b(delete|update|truncate|drop)\b/i);
  });

  test("geometry is loaded exactly as published (canonical form only — no alteration)", () => {
    const published = JSON.parse(readFileSync(join(DATA, "liberia-counties.geojson"), "utf8"));
    const seeded = rows.find((r) => r.name === "Bomi")!;
    const original = published.features.find((f: { properties: { shapeName: string } }) => f.properties.shapeName === "Bomi");
    expect(JSON.parse(seeded.geometry)).toEqual({ type: original.geometry.type, coordinates: original.geometry.coordinates });
  });
});

describe("county names", () => {
  const counties = buildRows().filter((r) => r.level === "county").map((r) => r.name);

  test("every published county corresponds to exactly one of the application's counties", () => {
    for (const name of counties) {
      expect(APP_COUNTIES.filter((c) => sameCountyName(c, name))).toHaveLength(1);
    }
    for (const c of APP_COUNTIES) expect(counties.filter((n) => sameCountyName(c, n))).toHaveLength(1);
  });

  test("the one spelling difference — 'Rivercess' vs 'River Cess' — is the same county", () => {
    expect(counties).toContain("Rivercess");
    expect(sameCountyName("River Cess", "Rivercess")).toBe(true);
  });

  test("matching ignores case, spaces and punctuation but is not fuzzy", () => {
    expect(sameCountyName("grand  cape mount", "Grand Cape Mount")).toBe(true);
    expect(sameCountyName("Grand-Gedeh", "Grand Gedeh")).toBe(true);
    expect(sameCountyName("Grand Gedeh", "Grand Kru")).toBe(false);
    expect(sameCountyName("Bong", "Bomi")).toBe(false);
    expect(sameCountyName("", "")).toBe(false);
    expect(sameCountyName("Nimba", "Nimbaa")).toBe(false);
  });
});
