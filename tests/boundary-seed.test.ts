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

  test("PROVENANCE records the publisher's actual licence and source verbatim — and says it is NOT CC BY 4.0", () => {
    const prov = readFileSync(join(DATA, "PROVENANCE.md"), "utf8");
    // geoBoundaries API record (gbOpen / LBR / ADM1 and ADM2), as reported 2026-10-13
    expect(prov).toContain("| `boundarySource` | UNMIL, OCHA ROWCA |");
    expect(prov).toContain(
      "| `boundaryLicense` | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) |",
    );
    expect(prov).toContain("| `buildDate` | Dec 12, 2023 |");
    expect(prov).toContain("| `boundaryYearRepresented` | 2021 |");
    // source URLs and the licence
    expect(prov).toContain("https://www.geoboundaries.org/api/current/gbOpen/LBR/ADM1/");
    expect(prov).toContain("https://www.geoboundaries.org/api/current/gbOpen/LBR/ADM2/");
    expect(prov).toContain("https://data.humdata.org/dataset/cod-ab-lbr");
    expect(prov).toContain("https://github.com/wmgeolab/geoBoundaries");
    expect(prov).toContain("https://creativecommons.org/licenses/by/3.0/igo/");
    // retrieval dates, attribution, and the explicit refusal to relabel
    expect(prov).toContain("## 6. Retrieval");
    expect(prov).toContain("2026-10-12");
    expect(prov).toContain("2026-10-13");
    expect(prov).toContain(`> ${ATTRIBUTION}`);
    expect(prov).toContain("must not be described or labelled as CC BY 4.0");
    // fields we do not have are marked as such, not guessed
    expect(prov).toContain("NOT RECORDED");
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
