# Liberia administrative boundaries — provenance, licence and attribution

Record last updated **2026-10-13**. The licence below is quoted exactly as the
publisher records it. These files are **not** CC BY 4.0.

How each statement is known — nothing here is inferred from a file name:

* **PUBLISHER RECORD** — a field of the official geoBoundaries API record,
  copied by the project owner. The assistant tried to re-fetch the API on
  2026-10-13 and received **HTTP 429** (rate limited), so these values are
  recorded **as supplied**, not independently re-confirmed.
* **CHECKED** — verified by the assistant against a primary source on the date
  given.
* **NOT STATED / NOT VERIFIED** — not provided, or could not be checked. Left
  blank on purpose; never guessed.

## 1. The files

| File | Level | Features | Geometry | Size | SHA-256 |
|---|---|---|---|---|---|
| `liberia-counties.geojson` | ADM1 (counties) | 15 | 15 Polygon | 297,059 B | `f6f4ed18e1e29532a77325f7af84a6dacc4489d94020f2fa2a8feb12a4da9b34` |
| `liberia-districts.geojson` | ADM2 (districts) | 136 | 135 Polygon, 1 MultiPolygon (Commonwealth, 2 parts) | 668,191 B | `9708518c0e606d1d662e29493f3c85fe9053149c0f9d81cf11e81df0a7992d8b` |

GeoJSON `FeatureCollection`s, CRS `urn:ogc:def:crs:OGC:1.3:CRS84` (WGS84
longitude/latitude), 2-D positions, extent lng −11.5004…−7.3686 / lat
4.3540…8.5525. Properties are the geoBoundaries schema: `shapeName`,
`shapeISO`, `shapeID`, `shapeGroup` (`LBR`), `shapeType` (`ADM1` / `ADM2`). The
files carry no licence or source metadata of their own. County names, district
names and all `shapeID`s are unique. The county file spells **"Rivercess"**; the
application uses "River Cess" (the map matches county names ignoring spaces).

## 2. Publisher record (geoBoundaries API, `gbOpen`, `LBR`)

**PUBLISHER RECORD**, supplied by the project owner from the official API
records:

* ADM1 — <https://www.geoboundaries.org/api/current/gbOpen/LBR/ADM1/>
* ADM2 — <https://www.geoboundaries.org/api/current/gbOpen/LBR/ADM2/>

| Field | ADM1 (counties) | ADM2 (districts) |
|---|---|---|
| `boundarySource` | UNMIL, OCHA ROWCA | UNMIL, OCHA ROWCA |
| `boundaryLicense` | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) | Creative Commons Attribution 3.0 Intergovernmental Organisations (CC BY 3.0 IGO) |
| `boundarySourceURL` | https://data.humdata.org/dataset/liberia-admin-level-2-boundaries | https://data.humdata.org/dataset/liberia-admin-level-2-boundaries |
| `licenseSource` | https://data.humdata.org/dataset/liberia-admin-level-2-boundaries | https://data.humdata.org/dataset/liberia-admin-level-2-boundaries |
| `licenseDetail` | `nan` (not specified in the API) | `nan` (not specified in the API) |
| `downloadURL` | https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/LBR/ADM1/geoBoundaries-LBR-ADM1_simplified.geojson | https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/LBR/ADM2/geoBoundaries-LBR-ADM2_simplified.geojson |
| `buildDate` | Dec 12, 2023 | Dec 12, 2023 |
| `boundaryYearRepresented` | 2021 | 2021 |

Notes on the values, without interpretation beyond what is stated:

* `licenseDetail` is the literal text `nan` — the API returned no licence detail
  (it is a missing-value marker, not a licence term). It is recorded as "not
  specified" and is **not** read as a permission or a restriction; the licence
  is `boundaryLicense`.
* The ADM1 (counties) record's `boundarySourceURL` / `licenseSource` name the
  HDX dataset whose address says "admin-level-2" — recorded verbatim. That
  dataset covers administrative levels 0–2 (see §3), so it is the source
  dataset for both levels.
* The `downloadURL` pins **commit `9469f09`**; it is the file this repository's
  copy was compared against (§3).

## 3. Verification of the local files against the publisher record

| # | Check | Result | When / how |
|---|---|---|---|
| 1 | `liberia-counties.geojson` vs the file at the pinned `ADM1` `downloadURL` (commit `9469f09`) | **MATCH** — Git LFS pointer `oid sha256:f6f4ed18…4da9b34`, size 297059 = local SHA-256 and size | CHECKED 2026-10-13, publisher's pointer file at that commit |
| 2 | `liberia-districts.geojson` vs the file at the pinned `ADM2` `downloadURL` | **MATCH** — oid `9708518c…7992d8b`, size 668191 = local SHA-256 and size | CHECKED 2026-10-13, same method |
| 3 | The same two files on the publisher's `main` branch | **MATCH** (unchanged since the pinned commit) | CHECKED 2026-10-12 |
| 4 | Pinned commit identity and date vs `buildDate: Dec 12, 2023` | **CONSISTENT** — commit `9469f09592ced973a3448cf66b6100b741b64c0d`, "gB Core Data Update 2023-12-12 23:03", dated Tue, 12 Dec 2023 23:03:07 -0500 | CHECKED 2026-10-13, commit header |
| 5 | Feature counts vs the source dataset (HDX COD-AB: "level 1 contains 15 feature(s)", "level 2 contains 136 feature(s)") | **CONSISTENT** — 15 counties, 136 districts | CHECKED 2026-10-13, HDX organisation page text. (The same text also contains a second, evidently mislabelled "level 2 … 260" line; it was not relied on.) |
| 6 | `shapeGroup`, `shapeType` in the local files | **CONSISTENT** — every feature is `LBR`, and `ADM1` / `ADM2` respectively | CHECKED 2026-10-12, local inspection |
| 7 | Source and licence at the cited HDX URL | **CONSISTENT** — the page at `…/dataset/liberia-admin-level-2-boundaries` is titled *Liberia – Subnational Administrative Boundaries* ("Liberia administrative level 0-2 definitive and edge-matched administrative boundaries"), **Source: UNMIL**, **Contributor: OCHA West and Central Africa (ROWCA)**, methodology "acquired from UNMIL; enhanced by OCHA", licence reference `http://creativecommons.org/licenses/by/3.0/igo/legalcode` | CHECKED 2026-10-13 via search-engine copy of the page (direct fetch was blocked by HDX bot detection). The dataset also appears at `…/dataset/cod-ab-lbr` under the same title; that the two addresses are the same dataset is **NOT VERIFIED** beyond the identical title, description, source, contributor and licence |
| 8 | The API records themselves (all fields in §2) | **NOT RE-CONFIRMED** — API returned HTTP 429 | Attempted 2026-10-13 |
| 9 | `boundaryYearRepresented: 2021` | **NOT VERIFIED** — only in the publisher record | — |
| 10 | The per-file `…-metaData.json` content in the publisher's repository | **NOT VERIFIED** — stored in Git LFS and not reachable | — |

Conclusion: **the local files are byte-for-byte the files the publisher's
record points to** (checks 1–2); their build date, feature counts and source are
consistent with the record (4–7). What is not independently confirmed is the API
text itself (8–10), which rests on the project owner's copy.

## 4. Dates — kept separate

| Date | What it is | Value |
|---|---|---|
| **Source build date** | when geoBoundaries built this release (`buildDate`; the pinned commit is dated the same day) | **Dec 12, 2023** |
| **Year represented** | the year the boundaries describe (`boundaryYearRepresented`) | **2021** |
| **Metadata retrieved from the API** | when the owner copied the §2 values from the API | **NOT STATED** by the person who retrieved it — to be filled in: `____-__-__` |
| Metadata reported to the assistant | when the §2 values were supplied for this record | 2026-10-13 |
| Files obtained and supplied | | 2026-10-12 |
| Hash comparison with the publisher's `main` pointers | | 2026-10-12 |
| Pinned-commit pointer, commit header, HDX and licence-text checks | | 2026-10-13 |

## 5. Licence

**Creative Commons Attribution 3.0 Intergovernmental Organisations
(CC BY 3.0 IGO)** — exactly as `boundaryLicense` states.
Licence page <https://creativecommons.org/licenses/by/3.0/igo/>; legal code
<http://creativecommons.org/licenses/by/3.0/igo/legalcode>; licence source cited
by the publisher: <https://data.humdata.org/dataset/liberia-admin-level-2-boundaries>.

geoBoundaries states **CC BY 4.0** for *its own outputs* and calls `gbOpen`
"CC BY 4.0 compliant", but each boundary keeps the **original source's** licence
in `boundaryLicense`. For this data that is CC BY 3.0 IGO. **These files must not
be described or labelled as CC BY 4.0, and the licence must not be altered or
re-stated as anything else.** (The legal code was read in full on 2026-10-13;
the requirements below come from it.)

CC BY 3.0 IGO permits worldwide, royalty-free use, **including commercial use**,
reproduction, distribution and **adaptation** (§3). It has **no non-commercial,
no-derivatives and no share-alike condition**, so it places no terms on the
application code, which is MIT-licensed separately.

| § | Requirement | How this project meets it |
|---|---|---|
| 4(b) | Credit: keep copyright notices; the attributions the licensor asks for; the title of the Work; the licensor's URI where specified; for an adaptation, a credit identifying the use of the Work | Attribution text in §6, stored as every boundary's `source` and shown on the National map; title and URIs in this file |
| 3(b) | In an adaptation, **clearly identify that changes were made** | The credit states the geometry is simplified; the application stores only name and geometry and draws them in its own style (§8) |
| 4(a) | When redistributing, include a copy of, or the URI for, the licence; keep intact notices referring to the licence and the disclaimer; do not sublicense; add no technical restrictions | This repository is **public**: the licence URI is in this file next to the data; the data files are redistributed under CC BY 3.0 IGO, not MIT |
| 4(b) | **Do not state or imply** that UNMIL, OCHA, geoBoundaries or others endorse MineGuard Liberia or this use | Credits are worded as sources only |
| 5, 6 | Provided "as is"; no warranty; liability limited | Boundaries are loaded **unverified**; the map says so |
| 8(g), 8(h) | No waiver of the licensor's or user's privileges and immunities; where the licensor is an IGO, disputes go to mediation, then arbitration under the UNCITRAL rules | Nothing to implement; the adopting institution should be aware (§9) |

## 6. Required attribution

Stored verbatim as `source` on every loaded boundary and shown in the National
map's "Boundary data:" line:

> UNMIL; OCHA ROWCA, via geoBoundaries gbOpen (William & Mary geoLab, www.geoboundaries.org); simplified geometry; CC BY 3.0 IGO

(`boundarySource` is "UNMIL, OCHA ROWCA"; the credit above keeps both, names the
publisher through which the data was obtained, identifies the change, and names
the licence as the publisher records it.) geoBoundaries also asks that its use be
credited and cited (<https://doi.org/10.1371/journal.pone.0231866>, Runfola et
al., 2020, PLOS ONE 15(4)); cite it in any report or publication that uses these
boundaries.

## 7. Chain of custody

```
UNMIL  →  OCHA ROWCA (HDX COD-AB)  →  geoBoundaries gbOpen (William & Mary geoLab)  →  these files
original   enhanced by OCHA             build Dec 12, 2023 (commit 9469f09);              byte-identical
source     ("acquired from UNMIL;       simplified geometry                               to the pinned file
           enhanced by OCHA")
```

## 8. Changes made to the data

**None to the files in this directory.** Loading them into the application
(`scripts/build-boundary-seed.ts`) keeps each feature's geometry unchanged and
stores only `shapeName` as the name, the level (`county` / `district`) and the
attribution; the other properties (`shapeISO`, `shapeID`, `shapeGroup`,
`shapeType`) and the `crs` member are not stored (the seed's ids are derived
from `shapeID`). The geometry was simplified by geoBoundaries, not by this
project. Boundaries are loaded **unverified** (`geo_verified = false`): nobody has
checked them against an authoritative in-country source, and they represent 2021.

## 9. Project acceptance

**[REQUIRES GOVERNMENT CONFIRMATION]** — `docs/16_PILOT_READINESS.MD` lists
"Boundary/licensing datasets" among the decisions the adopting institution must
confirm before a pilot. Nothing in this project requires CC BY 4.0, and CC BY
3.0 IGO does not conflict with the MIT application code or with a public
repository, provided §5 is followed. Whether the institution accepts CC BY 3.0
IGO (including its IGO-specific immunity and dispute clauses) is its decision, not
a technical one.

Status: **loaded in this repository; not yet applied to the live database.** If
the data is not accepted, delete `data/boundaries/` and
`supabase/seeds/liberia_boundaries_geoboundaries.sql`, and load a different
dataset through the Map Boundaries page.
