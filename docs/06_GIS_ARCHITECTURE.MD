# 06 — GIS Architecture

**Status:** Session 6 (GIS-1…5) implemented. **No boundary data is bundled or
fabricated** — the boundary tables ship empty and render only what an
authorized administrator loads from a stated source
[REQUIRES GOVERNMENT CONFIRMATION for the authoritative dataset].

## Map surface [IMPLEMENTED]

- Leaflet + react-leaflet; tile template from `src/lib/map-tiles.ts`
  (OpenStreetMap by default, `VITE_TILE_URL` to swap in a licensed/own source).
- Default view `[6.45, -9.4]`, zoom 7. (Liberia is **west** of the prime
  meridian; the pre-Session-6 constant `+9.3` centred the map in Nigeria.)
- All map logic that can be pure lives in `src/lib/gis.ts` (builders, styling,
  legend, clustering, filters, GeoJSON validation) and is unit-tested.

## GIS-1 — Boundaries: validated GeoJSON [IMPLEMENTED]

PostGIS was **not** chosen: it is not available on every deploy target nor in
the PGlite test harness, and the scope allows validated GeoJSON. Migration
`0015_gis.sql`:

| Table | Holds | Read scope | Write |
|-------|-------|------------|-------|
| `admin_boundaries` | one polygon per admin area (`national/region/county/district/community`), optional `admin_area_id` link to `admin_areas` | staff + operators (reference geography) | `geo.write` (admin) |
| `site_boundaries` | one outline per site (`unique(site_id)`) | **same matrix as the site** (`mg_can_access_site`) | `geo.write` (admin) |

Each row has `geometry_geojson jsonb`, `source` (required), `accuracy_m`,
`geo_verified`. A CHECK (`mg_valid_geojson_polygon`) rejects anything that is
not a closed, in-range `Polygon`/`MultiPolygon` inside the Liberia sanity
envelope (lon −11.6…−7.3, lat 4.3…8.6 — swapped lat/lng and foreign coordinates
fail). The client validator `validateGeoJsonPolygon` mirrors it and
`tests/gis.test.ts` asserts client == database on a corpus. Stored geometry
that fails validation is dropped on read, never repaired or drawn. Every
boundary write is audited in-transaction (`mg_audit_row`).

Authoring path: `api.gis.saveSiteBoundary / saveAdminBoundary /
setSiteGeoVerification` (admin only; client gate → RLS → CHECK → audit).

## GIS-2 — Layers, toggles, filters, clustering [IMPLEMENTED]

Layers: `sites`, `site_boundaries`, `admin_boundaries`, `incidents`,
`inspections`, `observations`, `community_reports`, `risk_indicators`.
`api.mapFeatures` reads **every** layer through the caller's own Postgres
session — **scoping is RLS, not client filtering**:

| Layer | Scope enforced by |
|-------|-------------------|
| sites, incidents, observations, inspections | `mg_can_access_site` (county / regional / district / site assignment / operator organization) + the inspector-owns-row rule for inspections |
| site boundaries | `mg_can_access_site(site_id)` |
| community reports | staff only **and now scoped by the staff scope matrix on county/district** (0015 closes a gap: previously every staff account read every report nationally) |
| risk indicators | staff only; derived from `mg_risk_scores` (already RLS-scoped) |

Incidents have no coordinates of their own; they, risk indicators, and
inspections/observations without their own fix are drawn at the site's registry
position and **inherit — never exceed — that position's verification**
(`geo_source = "site_position"`).

UI: per-layer toggles (defaults come from the layer config, so layers that
arrive late still get their defaults), filters by position verification level
and county, text search, zoom-aware grid clustering (cluster size shrinks per
zoom; individual points from zoom 13; a cluster of ≥3). Coordinate-less or
out-of-Liberia points are skipped, not plotted at (0,0).

## GIS-3 — Provenance fields [IMPLEMENTED]

`geo_source`, `geo_accuracy_m`, `geo_verified` on sites, observations,
community reports (inspections keep `gps_accuracy_m`, gain `geo_source`,
`geo_verified`). Defaults are honest: existing coordinates are backfilled as
`registry_entry` / `device_gps` / `device_gps_or_manual` / `public_report`,
all **unverified**. Guards:

- `geo_verified` requires a non-empty `geo_source` (CHECK).
- Only the `geo.write` permission can verify a position — on insert or update
  (`mg_guard_geo_verification`); an inspector cannot self-verify.
- Moving a verified point resets it to unverified.
- Public community reports are always `reported` on the map even if
  `geo_verified` is set, unless staff triage has marked the report itself
  `verified`.

## GIS-4 — Styling by verification & a data-driven legend [IMPLEMENTED]

Three levels (fail-safe — anything not explicitly verified is *not* verified):

| Level | Meaning | Drawing |
|-------|---------|---------|
| `verified` | `geo_verified` + recorded source | solid fill, solid outline |
| `unverified` | staff/registry/device position without verification | pale fill, **dashed** outline |
| `reported` | supplied by the public, unvetted | **hollow, dotted** outline |

`styleFor(layer, level)` is the single style source; `symbolSvg` renders it for
**both** map markers and legend swatches, so the legend cannot drift from the
map. The legend is built by `buildLegend` from the features/boundaries actually
loaded and currently visible (layer toggles + filters applied): absent layer or
level ⇒ no legend entry. Clusters take the *worst* member level and show the
verified/unverified/reported split — a cluster never launders unverified points
into a verified-looking marker. Popups state level, source and accuracy.
Community-report popups state they are unverified and not an accusation.

## GIS-5 — Offline tile strategy [IMPLEMENTED — policy-bounded]

### Offline tiles

Provider policy (OpenStreetMap Tile Usage Policy): no bulk download or
pre-seeding of tiles; caching tiles a user actually viewed, honouring HTTP
semantics, is expected. Therefore:

1. **No prefetch.** There is no "download region" feature against
   `tile.openstreetmap.org`; `tests/gis.test.ts` pins that the worker's tile path
   makes exactly one fetch — the response to a tile the map itself requested.
2. **Viewed-tile cache.** `public/sw.js` caches only tiles the map requested
   while online, only inside the Liberia bbox and zoom 5–14 (`tileInRegion`),
   in a bounded cache `mgtiles-v1` (1,500 entries, oldest evicted). Online it is
   network-first (provider headers always apply); offline it serves the last
   tile seen. The cache name does not start with `mineguard-`, so shell
   upgrades never wipe tiles a field team already viewed.
3. **Sustained offline mapping (documented alternative).** For teams that must
   work for days without any connectivity, use a tile source we are *licensed*
   to hold offline (own MBTiles/PMTiles export, or a commercial offline bundle)
   served from our origin, and set `VITE_TILE_URL` (and
   `VITE_TILE_ATTRIBUTION`) to it; the same cache rules apply. No such bundle is
   shipped [REQUIRES OWNER CONFIRMATION of a provider/licence].
4. Vector data (sites, incidents, boundaries…) stays available offline through
   the app's existing offline stores; tiles are only the basemap.

Numbers live in `src/lib/map-tiles.ts`; `sw.js` duplicates them (a worker
cannot import TS) and `tests/gis.test.ts` fails if the two copies diverge.

## Not depicted (deliberate)

- Official concession/licence polygons — none exist in this system; invented
  licence areas would misrepresent legal status.
- Any boundary not loaded from a stated source — the legend and page copy say
  so when no boundary dataset is present.

## Acceptance evidence

`tests/gis.test.ts`: scope-filtered layers for admin, national supervisor,
county inspector, two operators and a guest through the real data layer on real
Postgres RLS (incl. no cross-tenant/county ids anywhere in the payload);
community-report scoping at table level; provenance guards; boundary
validation parity client↔SQL; unverified/reported styling, legend, clustering
and filters; tile region/zoom/cache policy and `sw.js`↔`map-tiles.ts` pin.
