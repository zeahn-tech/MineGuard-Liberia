# 06 — GIS Architecture

**Status:** implemented as described; boundary data requires government sources.

## Map surface [IMPLEMENTED]

- Leaflet + react-leaflet, OpenStreetMap raster tiles, Papery-filtered styling.
- Centered on Liberia (approx. 6.9°N, 9.3°E), zoom 7 default.

## Layer semantics — verified vs reported [IMPLEMENTED]

| Layer | Source | Visual | Trust semantics |
|-------|--------|--------|-----------------|
| Registry sites | `sites` table (admin-authored) | Diamond pin, dark green (active) / gray (other) | Verified registry data |
| Environmental observations | Staff records, open only | Filled circle, ochre | Trust inherited from the record's `verification` field |
| Community reports | Public submissions, pending only | Dashed outline circle, rust | Explicitly unverified; never implies wrongdoing |

Popups repeat the trust framing (e.g. "Community report — unverified").

## Coordinate provenance [IMPLEMENTED]

- Sites: entered by admins at registration; should come from authoritative
  sources [REQUIRES GOVERNMENT CONFIRMATION for official datasets].
- Inspections: device GPS with accuracy (`gpsAccuracyM`) stored alongside.
- Observations: device GPS or manual entry, marked in the record.
- Community reports: optional manual coordinates supplied by the reporter.

## Not depicted (deliberate)

- Administrative boundaries — no authoritative boundary dataset is bundled;
  fabricating one is prohibited by the master directive [PLANNED, requires
  government/verified boundary source].
- Official concession or license polygons — none exist in this system; showing
  invented license areas would misrepresent legal status.

## Future [PLANNED]

- County/district choropleths using a verified boundary file.
- Site boundary polygons (authoritative source required).
- Offline tile caching for field mapping.
