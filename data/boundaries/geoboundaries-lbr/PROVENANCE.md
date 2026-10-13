# Liberia administrative boundaries — provenance, licence and attribution

Record last updated **2026-10-13**. Every statement is tagged with how it is
known. Nothing is inferred from a file name, and the licence below is quoted
exactly as the publisher states it — it is **not** CC BY 4.0.

* **PUBLISHER RECORD** — a field of the geoBoundaries API metadata for these
  boundaries, as read by the project owner (see "Retrieval").
* **CHECKED** — verified by the assistant against a primary source on the
  date given.
* **NOT RECORDED** — exists in the publisher record but has not been copied
  here yet. Do not guess it; copy it from the API.

## 1. The files

| File | Level | Features | Geometry | Size | SHA-256 |
|---|---|---|---|---|---|
| `liberia-counties.geojson` | ADM1 (counties) | 15 | 15 Polygon | 297,059 B | `f6f4ed18e1e29532a77325f7af84a6dacc4489d94020f2fa2a8feb12a4da9b34` |
| `liberia-districts.geojson` | ADM2 (districts) | 136 | 135 Polygon, 1 MultiPolygon (Commonwealth, 2 parts) | 668,191 B | `9708518c0e606d1d662e29493f3c85fe9053149c0f9d81cf11e81df0a7992d8b` |

GeoJSON `FeatureCollection`s, CRS `urn:ogc:def:crs:OGC:1.3:CRS84` (WGS84
longitude/latitude), 2-D positions, extent lng −11.5004…−7.3686 / lat
4.3540…8.5525. Properties are the geoBoundaries schema: `shapeName`,
`shapeISO`, `shapeID`, `shapeGroup` (`LBR`), `shapeType` (`ADM1`/`ADM2`). The
files carry no licence or source metadata of their own. County names, district
names and all `shapeID`s are unique. The county file spells **"Rivercess"**; the
application uses "River Cess" (the map matches county names ignoring spaces).

## 2. Where the data comes from

**CHECKED (2026-10-12):** both files are **byte-for-byte identical** (full
SHA-256 and size) to the publisher's files in
<https://github.com/wmgeolab/geoBoundaries> —
`releaseData/gbOpen/LBR/ADM1/geoBoundaries-LBR-ADM1_simplified.geojson`
(Git LFS oid `f6f4ed18…4da9b34`, 297059 B) and
`releaseData/gbOpen/LBR/ADM2/geoBoundaries-LBR-ADM2_simplified.geojson`
(oid `9708518c…7992d8b`, 668191 B): the geoBoundaries **gbOpen** release,
**simplified** geometry, by William & Mary geoLab (<https://www.geoboundaries.org/>).

Chain of custody, as the publisher records it:

```
UNMIL  →  OCHA ROWCA  →  geoBoundaries gbOpen (William & Mary geoLab)  →  these files
(original source)   (humanitarian data holder)   (build Dec 12, 2023; simplified)
```

**CHECKED (2026-10-13), corroborating:** the HDX dataset
*Liberia – Subnational Administrative Boundaries* (OCHA COD-AB),
<https://data.humdata.org/dataset/cod-ab-lbr>, shows **Source: UNMIL**,
**Contributor: OCHA West and Central Africa (ROWCA)** and the licence
**"Creative Commons Attribution for Intergovernmental Organisations"** (HDX's
name for the CC BY IGO licence; the dataset's structured metadata, seen
2026-10-11, references the 3.0 IGO legal code
<http://creativecommons.org/licenses/by/3.0/igo/legalcode>). The dataset covers
"administrative level 0-2" (country, county, district) — the same levels as these
files — and its shapefile resource is dated 11 February 2021. This is consistent
with the geoBoundaries record below; it does not replace it: the licence that
applies to these files is the one geoBoundaries records for them.

## 3. Publisher metadata (geoBoundaries API, `gbOpen`, `LBR`)

**PUBLISHER RECORD** — identical for **ADM1** and **ADM2**:

| Field | Value |
|---|---|
| `boundarySource` | UNMIL, OCHA ROWCA |
| `boundaryLicense` | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) |
| `buildDate` | Dec 12, 2023 |
| `boundaryYearRepresented` | 2021 |

**NOT RECORDED** (copy from the same API responses, then delete this note):
`boundarySourceURL`, `licenseSource`, `licenseDetail`, `boundaryID`,
`downloadURL`, `simplifiedGeometryGeoJSON`, `sourceDataUpdateDate`.

API endpoints (JSON):
<https://www.geoboundaries.org/api/current/gbOpen/LBR/ADM1/> and
<https://www.geoboundaries.org/api/current/gbOpen/LBR/ADM2/>. Note the API
describes the *current* release; this repository's copy is pinned by the
SHA-256 values in section 1 and reflects the build date above.

## 4. Licence

**Creative Commons Attribution 3.0 Intergovernmental Organisations
(CC BY 3.0 IGO)** — <https://creativecommons.org/licenses/by/3.0/igo/>, legal
code <http://creativecommons.org/licenses/by/3.0/igo/legalcode>.

The geoBoundaries project states **CC BY 4.0** for *its own outputs*, and calls
`gbOpen` "CC BY 4.0 compliant"; but each boundary keeps the **original
source's** licence in `boundaryLicense`. For this data that is CC BY 3.0 IGO.
**These files must not be described or labelled as CC BY 4.0.** (The licence
text was read in full on 2026-10-13; the requirements below are taken from it.)

What CC BY 3.0 IGO permits: worldwide, royalty-free use, **including
commercial use**, reproduction, distribution and **adaptation** (§3). There is
**no non-commercial, no-derivatives and no share-alike condition** — it places
no terms on the application code, which is MIT-licensed separately.

What it requires of anyone using or redistributing the data:

| § | Requirement | How this project meets it |
|---|---|---|
| 4(b) | Credit: keep copyright notices; the attributions the licensor asks for; the title of the Work; the licensor's URI where specified; for an adaptation, a credit identifying the use of the Work | Attribution text below, stored as every boundary's `source` and shown on the National map; title and URIs in this file |
| 3(b) | In an adaptation, **clearly identify that changes were made** | The credit says the geometry is simplified; the application stores only name and geometry and draws them in its own style (§7) |
| 4(a) | When redistributing, include a copy of, or the URI for, the licence; keep intact notices referring to the licence and to the disclaimer; do not sublicense; do not add technical restrictions | This repository is **public**: the licence URI is in this file next to the data; the data files are redistributed under CC BY 3.0 IGO, not MIT |
| 4(b) | **Do not state or imply** that UNMIL, OCHA, geoBoundaries or others endorse MineGuard Liberia or this use | Credits are worded as sources only |
| 5, 6 | Provided "as is" — no warranty of accuracy; liability limited | Boundaries are loaded **unverified**; the map says so |
| 8(g), 8(h) | The licence does not waive any privileges and immunities of the licensor or user; where the licensor is an IGO, disputes go to mediation, then arbitration under the UNCITRAL rules | Nothing to implement; the adopting institution should be aware (see §8) |

## 5. Required attribution

Stored verbatim as `source` on every loaded boundary and shown in the
National map's "Boundary data:" line:

> UNMIL; OCHA ROWCA, via geoBoundaries gbOpen (William & Mary geoLab, www.geoboundaries.org); simplified geometry; CC BY 3.0 IGO

geoBoundaries also asks that its use be credited and cited
(<https://doi.org/10.1371/journal.pone.0231866>, Runfola et al., 2020, PLOS ONE
15(4)); cite it in any report or publication that uses these boundaries.

## 6. Retrieval

| What | When | By |
|---|---|---|
| The two GeoJSON files obtained and supplied | 2026-10-12 | project owner |
| SHA-256 / size compared with the publisher's files | 2026-10-12 | assistant (publisher's Git LFS pointer files) |
| `boundarySource`, `boundaryLicense`, `buildDate`, `boundaryYearRepresented` read from the geoBoundaries API (ADM1 and ADM2) | reported 2026-10-13 (date of the query itself not stated) | project owner |
| HDX *Liberia – Subnational Administrative Boundaries* page (source, contributor, licence) | 2026-10-13 | assistant |
| CC BY 3.0 IGO legal code read in full | 2026-10-13 | assistant |

## 7. Changes made to the data

**None to the files in this directory.** Loading them into the application
(`scripts/build-boundary-seed.ts`) keeps each feature's geometry unchanged and
stores only `shapeName` as the name, the level (`county` / `district`) and the
attribution; other properties (`shapeISO`, `shapeID`, `shapeGroup`, `shapeType`)
and the `crs` member are not stored (the seed's ids are derived from `shapeID`).
The geometry itself was simplified by geoBoundaries, not by this project.
Boundaries are loaded **unverified** (`geo_verified = false`): nobody has
checked them against an authoritative in-country source, and they are a 2021
representation.

## 8. Project acceptance

**[REQUIRES GOVERNMENT CONFIRMATION]** — `docs/16_PILOT_READINESS.MD` lists
"Boundary/licensing datasets" among the decisions the adopting institution must
confirm before a pilot. Nothing in this project requires CC BY 4.0, and CC BY
3.0 IGO does not conflict with the MIT application code or with a public
repository, provided §4 above is followed. Whether the institution accepts CC
BY 3.0 IGO (including its IGO-specific immunity and dispute clauses) is its
decision, not a technical one.

Status: **loaded in this repository; not yet applied to the live database.**
If the data is not accepted, delete `data/boundaries/` and
`supabase/seeds/liberia_boundaries_geoboundaries.sql`, and load a different
dataset through the Map Boundaries page.
