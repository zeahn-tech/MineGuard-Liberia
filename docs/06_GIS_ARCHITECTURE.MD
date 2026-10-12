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

Boundary writes are INSERT/UPDATE only (`geo.write`). Migration
`0016_gis_boundary_hardening.sql` removes the `DELETE` grant 0015 had given
the client roles (0009 revoked deletes platform-wide, and the audit trail
records INSERT/UPDATE only) and all `anon` access; correcting a boundary is an
audited update, removing one is a privileged maintenance action.

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
zoom; individual points from zoom 13; a cluster of ≥3; clusters never merge across layers). Coordinate-less or
out-of-Liberia points are skipped, not plotted at (0,0).

## Capturing a site's real position

A site's map position is captured, not just typed. The shared
`SiteLocationPicker` (site registration, and the administrator's **Set /
Edit location** dialog on a site's page) offers three ways, all recorded with
how the position was obtained:

| Method | Recorded `geo_source` | Notes |
|---|---|---|
| "Use my current location" | `device_gps` | high-accuracy browser geolocation; the reported accuracy radius is stored in `geo_accuracy_m` and read back as good (≤ 20 m) / fair (≤ 100 m) / low (> 100 m, flagged as too rough). Needs HTTPS and the browser's permission. |
| "Pick on map" | `map_pick` | click the map (restricted to Liberia) — for sites registered from an office. |
| typed latitude/longitude | `manual_entry` | validated live (Liberia envelope; the "did you mean -9.43?" hint for a missing minus sign). |

Auto-locate on opening the registration dialog happens **only if the browser
has already granted location permission** — never a surprise prompt.

A captured position is a *claim*: it is stored **unverified**. An administrator
can tick "verified against an authoritative source" (a source is mandatory) —
that goes through `api.gis.setSiteGeoVerification` (`geo.write`). Changing a
position through `api.sites.update` replaces its provenance (the old accuracy
described the old place), and withdraws any earlier verification. Latitude and
longitude are a pair — a half position is rejected. The registry flags sites
with no position ("Not on the map"), which is how existing sites registered
without coordinates are found and fixed.

## Loading boundaries (administrators)

**Map Boundaries** (`/portal/boundaries`, admin-only nav entry; the page also
refuses non-admins) loads outlines from GeoJSON — a file (≤ 5 MB) or pasted text.
Flow: **choose → review → source and load**; nothing is saved before the review.

- Accepted: `FeatureCollection`, `Feature`, bare `Polygon` / `MultiPolygon`
  (island counties are fine). Canonicalised to `{type, coordinates}` with 2-D
  positions (bbox/crs/altitude dropped); never repaired or re-projected.
- Each shape is validated with the same rules as the database CHECK. A bad one
  is listed with an actionable reason (missing minus sign, `[lat, lng]` order,
  projected coordinates, unclosed ring, outside Liberia, wrong geometry type)
  and never blocks the good ones. Shapefile/KML/TopoJSON are refused with advice.
- **Site outlines** tab: each shape is matched to a registered site by site
  code, then by *exact* name (ambiguous or near-miss names match nothing — a
  wrong outline is worse than none); the administrator confirms or chooses.
  One outline per site; two shapes aimed at one site are blocked.
- **Administrative areas** tab: name (from `name`/`NAME_1`/… properties,
  editable) + level. An area with the same level and name is **replaced in
  place** (audited update), never duplicated; boundaries cannot be deleted.
- A **source** is required; accuracy is optional; "verified" is opt-in (loaded
  boundaries are drawn as unverified otherwise). A map preview shows what is
  about to be loaded. Rows save one at a time and each reports its own result.
- "Already loaded" lists what exists; until something is loaded the boundary
  layers on the National Map are empty (the toggles show `(0)`).

### Where boundary data comes from

The page carries a "Where do I get this data?" panel. Administrative areas:
**geoBoundaries** (open, CC BY 4.0 — credit it in the Source field; GeoJSON
direct, ADM1 = counties, ADM2 = districts, a simplified file if > 5 MB) and the
**OCHA/HDX "Liberia – Subnational Administrative Boundaries"** shapefile
(check the licence on the dataset page). Site outlines have no public source:
own survey, or the concession/permit boundary from the licensing authority or
operator. Conversion to GeoJSON (WGS84 / EPSG:4326): mapshaper.org (in-browser;
`-proj wgs84` if not in degrees), QGIS (Export → Save Features As → GeoJSON,
EPSG:4326) or `ogr2ogr -f GeoJSON -t_srs EPSG:4326 out.geojson in.shp`. Names
are read at the deepest level a file carries (geoBoundaries `shapeName`, HDX
`ADMn_EN`, GADM `NAME_n`), so a district row is named for the district, not its
county.

### Why an edit may not show immediately — and the fix

Screens read through a shared query cache that keeps a screen's last result for
90 s, and re-reads on a Realtime event. Realtime is best-effort (it can be off
for a project, still connecting, or delayed), so a write made **by this
client** now signals every live query watching those tables to re-read at once
(`notifyLocalWrite` in `backend.ts`; covered by `tests/gis.test.ts`, which fails
without it). Changes made by *other* people still arrive via Realtime —
migration `0018` adds the two boundary tables to the publication — and the
National map has a **Refresh** button for the case where Realtime is not
connected.

**Why a layer can be empty.** A point is plotted only if it has coordinates
inside Liberia (lat 4.3…8.6, lng −11.6…−7.3). Liberia is **west** of the prime
meridian, so longitudes are **negative** — `9.43` (no minus sign) is Nigeria and
is never plotted at a guessed place. To keep that from being a silent failure:
`api.sites.create/update` reject out-of-Liberia coordinates with an actionable
message ("did you mean -9.43?"); `api.mapFeatures` returns an `excluded` count
per layer and the page shows how many visible records were left off and why;
each layer toggle shows how many records it holds (`(0)` = nothing loaded —
boundary layers stay empty until an administrator loads a boundary dataset via
`api.gis.*`). Migration `0017` corrected the six demo sites an earlier seed had
stored with positive longitudes (labelled demo rows only).

**Scale note.** `api.mapFeatures` pages through each layer's full (RLS-scoped)
row set and builds features client-side — correct and simple at the current
data volume. Past roughly tens of thousands of rows per layer the next step is
a server-side viewport/aggregate RPC (bbox + zoom → clustered counts), keeping
the same RLS scoping; the pure builders in `src/lib/gis.ts` would not change.

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
   `tile.openstreetmap.org`; `tests/map-tiles-worker.test.ts` executes the
   worker and pins that it makes exactly one fetch per tile the map itself
   requested.
2. **Viewed-tile cache.** `public/sw.js` caches only tiles the map requested
   while online, only inside the Liberia bbox and zoom 5–14 (`tileInRegion`),
   in a bounded cache `mgtiles-v1` (1,500 entries, oldest evicted). Online it is
   network-first (provider headers always apply); offline it serves the last
   tile seen and never invents one. The cache name does not start with
   `mineguard-`, so shell upgrades never wipe tiles a field team already
   viewed. Only readable (`ok`) responses are stored — tiles are requested in
   CORS mode (`tileCrossOrigin`) because a plain `<img>` request is `no-cors`:
   its response is opaque (status 0), cannot be validated, and browsers pad its
   storage cost so heavily that the cache would exhaust the origin quota. OSM
   and our own origin both send CORS headers.
3. **Sustained offline mapping (documented alternative).** For teams that must
   work for days without any connectivity, use a tile source we are *licensed*
   to hold offline (own MBTiles/PMTiles export, or a commercial offline bundle)
   served from **our origin**, and set `VITE_TILE_URL` (and
   `VITE_TILE_ATTRIBUTION`) to it; the same cache rules apply to same-origin
   tiles. A tile server on a *third-party* origin other than OSM is not
   intercepted by the worker (we cannot know its policy) and is left to the
   browser's HTTP cache. No such bundle is shipped
   [REQUIRES OWNER CONFIRMATION of a provider/licence].
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
and filters; tile region/zoom/cache policy and the `sw.js`↔`map-tiles.ts` pin.
`tests/map-tiles-worker.test.ts` runs `sw.js` itself against a fake Cache
Storage: in-region-only storage, `ok`-only storage, network-first online,
last-seen offline, the 1,500-entry bound with oldest-first eviction, same-origin
bundle handling, and no interception of non-tile traffic.
