# Liberia administrative boundaries — provenance and licence status

Recorded 2026-10-12. Everything below is marked **VERIFIED** (checked against
the publisher's own repository in this session) or **NOT VERIFIED** (could not
be checked). Nothing here is inferred from a file name.

## The files

| File | Level | Features | Geometry | Size | SHA-256 |
|---|---|---|---|---|---|
| `liberia-counties.geojson` | ADM1 (counties) | 15 | 15 Polygon | 297,059 B | `f6f4ed18e1e29532a77325f7af84a6dacc4489d94020f2fa2a8feb12a4da9b34` |
| `liberia-districts.geojson` | ADM2 (districts) | 136 | 135 Polygon, 1 MultiPolygon (Commonwealth, 2 parts) | 668,191 B | `9708518c0e606d1d662e29493f3c85fe9053149c0f9d81cf11e81df0a7992d8b` |

Structure: GeoJSON `FeatureCollection`, CRS `urn:ogc:def:crs:OGC:1.3:CRS84`
(WGS84 longitude/latitude), 2-D positions, extent lng −11.5004…−7.3686,
lat 4.3540…8.5525 (entirely inside Liberia). Feature properties are exactly the
geoBoundaries schema: `shapeName`, `shapeISO`, `shapeID`, `shapeGroup` (`LBR`),
`shapeType` (`ADM1` / `ADM2`). County `shapeISO` is filled (`LR-BM` …);
district `shapeISO` is empty. All 15 county names, 136 district names and all
`shapeID`s are unique. The county file spells **"Rivercess"** (the application
list uses "River Cess"; the map matches county names ignoring spaces).

The files contain **no licence or source metadata of their own**.

## Source — VERIFIED

Both files are **byte-for-byte identical** (full SHA-256 and size) to the
publisher's files in <https://github.com/wmgeolab/geoBoundaries>, path
`releaseData/gbOpen/LBR/`:

| Publisher file | Git LFS oid (sha256) | size |
|---|---|---|
| `ADM1/geoBoundaries-LBR-ADM1_simplified.geojson` | `f6f4ed18e1e2…4da9b34` | 297059 |
| `ADM2/geoBoundaries-LBR-ADM2_simplified.geojson` | `9708518c0e60…7992d8b` | 668191 |

i.e. the **geoBoundaries `gbOpen` release, simplified geometry**, produced by
William & Mary geoLab (<https://www.geoboundaries.org/>). (Compared 2026-10-12
against the `main` branch pointer files; the geoBoundaries release/build
version of these exact files is **NOT VERIFIED** — it is in the per-file
metadata, see below.)

## Licence — partly verified

| Statement | Status | Evidence |
|---|---|---|
| The geoBoundaries project releases its outputs under **CC BY 4.0** | VERIFIED | `LICENSE` in the repository; README: "open license (CC BY 4.0 / ODbL)" |
| `gbOpen` is the "CC BY 4.0 compliant" open release (as opposed to `gbHumanitarian` / `gbAuthoritative`, which can have more restrictive terms) | VERIFIED | geoBoundaries API documentation |
| **Each boundary keeps the original licence of its primary source**, which varies by boundary and may be ODbL, CC BY or CC BY-SA | VERIFIED | geoBoundaries documentation (`boundaryLicense`, `licenseDetail`, `licenseSource`, `boundarySource`, `boundarySourceURL`) |
| **Liberia's own `boundaryLicense` / `boundarySource` / build date** | **NOT VERIFIED** | The per-file `…-metaData.json` files exist but are Git LFS pointers whose content was not reachable from the build environment |
| The HDX "Liberia – Subnational Administrative Boundaries" (OCHA COD-AB, source UNMIL) is licensed CC BY 3.0 IGO | VERIFIED for that HDX dataset | HDX dataset page. That these geoBoundaries files derive from it is **NOT VERIFIED** (an old geoBoundaries licence-review issue lists Liberia ADM0–2; its resolution was not retrieved) |

**Action to close the gap (owner):** open
<https://www.geoboundaries.org/api/current/gbOpen/LBR/ADM1/> and `…/ADM2/`
(JSON) and record `boundaryLicense`, `boundarySource`, `boundarySourceURL` and
`buildDate` in the table above.

**What this means in the meantime.** This repository is **public**, so keeping
these files here is redistribution. Every licence geoBoundaries names for
`gbOpen` (CC BY, CC BY-SA, ODbL) permits redistribution **with attribution**,
which is given (below, in each boundary's stored source, and on the map).
Obligations that may additionally apply depending on the record you find:

* **CC BY 4.0 / CC BY 3.0 IGO:** attribution and a link to the licence
  (<https://creativecommons.org/licenses/by/4.0/>), and indicate changes — none
  were made to the data (see below).
* **CC BY-SA or ODbL:** the *data files* (not the application code) must be
  kept under that licence when redistributed, with the licence notice; ODbL
  additionally requires attribution of the database and that adapted databases
  stay open.

If the record shows terms you cannot meet, remove `data/boundaries/` and
`supabase/seeds/liberia_boundaries_geoboundaries.sql` from the repository and
load the data from the original source instead (the Map Boundaries page).

## Required attribution (shown on the National map and stored as each boundary's source)

> Boundaries: geoBoundaries (gbOpen), William & Mary geoLab — www.geoboundaries.org

## Changes made to the data

None. The geometry and properties are loaded as published; only the loader
adds the level (`county` / `district`), the source line, and `geo_verified = false`
(the boundaries are **not** marked verified: nobody has checked them against an
authoritative in-country source).
