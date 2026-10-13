// ---------------------------------------------------------------------------
// Build the SQL seed for the official Liberian county / district boundaries.
//
//   bun scripts/build-boundary-seed.ts            # (re)write the seed file
//   bun scripts/build-boundary-seed.ts --check    # fail if the committed seed is stale
//
// Input:  data/boundaries/geoboundaries-lbr/*.geojson  (see PROVENANCE.md there)
// Output: supabase/seeds/liberia_boundaries_geoboundaries.sql
//
// Every shape is validated with the SAME importer the Map Boundaries page uses
// (so the seed can never contain something the app would refuse), and the
// build FAILS rather than skipping a bad shape. Nothing in the geometry or the
// properties is altered. Output is deterministic: boundary ids are name-based
// UUIDs derived from geoBoundaries' own `shapeID`, so re-running the seed can
// never create a duplicate.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBoundaryGeoJson } from "../src/lib/gis-import";

const ROOT = join(import.meta.dir, "..");
const DATA = join(ROOT, "data", "boundaries", "geoboundaries-lbr");
export const SEED_PATH = join(ROOT, "supabase", "seeds", "liberia_boundaries_geoboundaries.sql");

/** Fixed namespace for the name-based (v5) boundary ids. Never change it:
 *  it is what makes the ids — and therefore re-runs — stable. */
const NAMESPACE = "7c3f1a52-96d4-4b0e-8a27-3d5e1c9b4f60";

/** Attribution exactly as required by the data's licence (CC BY 3.0 IGO) and
 *  recorded in PROVENANCE.md §5: original sources, the publisher through which
 *  they were obtained, the fact the geometry is simplified (a change), and the
 *  licence by name. Stored as each boundary's `source` and shown on the map. */
export const ATTRIBUTION =
  "UNMIL; OCHA ROWCA, via geoBoundaries gbOpen (William & Mary geoLab, www.geoboundaries.org); simplified geometry; CC BY 3.0 IGO";

const FILES = [
  { file: "liberia-counties.geojson", level: "county", shapeType: "ADM1" },
  { file: "liberia-districts.geojson", level: "district", shapeType: "ADM2" },
] as const;

function uuidV5(name: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(ns).update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

interface Row {
  id: string;
  name: string;
  level: string;
  source: string;
  geometry: string;
}

export function buildRows(): Row[] {
  const rows: Row[] = [];
  for (const spec of FILES) {
    const text = readFileSync(join(DATA, spec.file), "utf8");
    const parsed = parseBoundaryGeoJson(text);
    if (parsed.fatal) throw new Error(`${spec.file}: ${parsed.fatal}`);
    const doc = JSON.parse(text) as {
      features: Array<{ properties: { shapeName?: string; shapeID?: string; shapeType?: string } }>;
    };
    if (doc.features.length !== parsed.candidates.length) {
      throw new Error(`${spec.file}: parsed ${parsed.candidates.length} of ${doc.features.length} features`);
    }
    for (const c of parsed.candidates) {
      const props = doc.features[c.index].properties;
      if (c.problem || !c.geometryGeoJson) throw new Error(`${spec.file} #${c.index} (${c.label}): ${c.problem}`);
      if (props.shapeType !== spec.shapeType)
        throw new Error(`${spec.file} #${c.index}: expected ${spec.shapeType}, found ${props.shapeType}`);
      if (!props.shapeName?.trim() || !props.shapeID?.trim())
        throw new Error(`${spec.file} #${c.index}: missing shapeName/shapeID`);
      rows.push({
        id: uuidV5(`geoBoundaries:LBR:${spec.shapeType}:${props.shapeID}`),
        name: props.shapeName.trim(),
        level: spec.level,
        source: ATTRIBUTION,
        geometry: c.geometryGeoJson,
      });
    }
  }
  const ids = new Set(rows.map((r) => r.id));
  const keys = new Set(rows.map((r) => `${r.level}:${r.name.toLowerCase()}`));
  if (ids.size !== rows.length) throw new Error("duplicate boundary ids");
  if (keys.size !== rows.length) throw new Error("duplicate (level, name) pairs");
  if (rows.some((r) => r.geometry.includes("$gj$"))) throw new Error("geometry contains the dollar-quote tag");
  return rows;
}

export function buildSql(rows: Row[]): string {
  const counts = FILES.map((f) => `${rows.filter((r) => r.level === f.level).length} ${f.level} boundaries`).join(", ");
  const values = rows
    .map((r) => `  (${sqlText(r.id)}::uuid, ${sqlText(r.name)}, ${sqlText(r.level)}, $gj$${r.geometry}$gj$::jsonb, ${sqlText(r.source)})`)
    .join(",\n");
  return `-- ===========================================================================
-- MINEGUARD LIBERIA — official county / district boundaries (seed)
--
-- GENERATED by scripts/build-boundary-seed.ts from
-- data/boundaries/geoboundaries-lbr/ — do not edit by hand; see PROVENANCE.md
-- there for the source, checksums, licence and attribution requirements.
--
-- Data licence: Creative Commons Attribution 3.0 Intergovernmental
-- Organisations (CC BY 3.0 IGO); source UNMIL, OCHA ROWCA (publisher record).
-- Not CC BY 4.0. Attribution is stored as each boundary's source.
--
-- Loads ${counts} from geoBoundaries (gbOpen, simplified), as published:
-- geometry and names unchanged, loaded UNVERIFIED (geo_verified = false).
--
-- Safe to run more than once, and safe next to boundaries an administrator
-- already loaded by hand:
--   * a boundary with the same level and name already present is left alone
--     (never duplicated, never overwritten);
--   * ids are derived from geoBoundaries' shapeID, so a re-run is a no-op.
-- Requires migrations 0001-0016 (the boundary tables). Run it with:
--   SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts supabase/seeds/liberia_boundaries_geoboundaries.sql
-- ===========================================================================

do $$
begin
  if to_regclass('public.admin_boundaries') is null then
    raise exception using
      message = 'Boundary seed cannot run: public.admin_boundaries does not exist.',
      detail  = 'The boundary tables are created by migration 0015_gis.sql. Apply migrations 0001-0016 first (supabase/checks/migration_state.sql shows what is applied).',
      hint    = 'Check you are connected to the project whose ref matches src/lib/supabase.ts.';
  end if;
end $$;

insert into public.admin_boundaries (id, name, level, geometry_geojson, source, geo_verified)
select v.id, v.name, v.level, v.geom, v.source, false
  from (values
${values}
  ) as v(id, name, level, geom, source)
 where not exists (
   select 1 from public.admin_boundaries b
    where b.level = v.level and lower(btrim(b.name)) = lower(btrim(v.name))
 )
on conflict (id) do nothing;

select level, count(*) as boundaries
  from public.admin_boundaries
 where source = ${sqlText(ATTRIBUTION)}
 group by level
 order by level;
`;
}

if (import.meta.main) {
  const sql = buildSql(buildRows());
  if (process.argv.includes("--check")) {
    const current = (() => {
      try {
        return readFileSync(SEED_PATH, "utf8");
      } catch {
        return "";
      }
    })();
    if (current !== sql) {
      console.error(`STALE: ${SEED_PATH} does not match the data. Run: bun scripts/build-boundary-seed.ts`);
      process.exit(1);
    }
    console.error("OK: seed is up to date");
  } else {
    writeFileSync(SEED_PATH, sql);
    console.error(`Wrote ${SEED_PATH} (${(sql.length / 1024).toFixed(0)} KB)`);
  }
}
