# MineGuard Liberia — brand assets

Logo: Liberian flag background, navy shield, county map of Liberia and a
mining pickaxe.

| Master | Used for |
|---|---|
| `mineguard-icon.svg` | Rounded app icon. Copied to `public/logo.svg` and `src/assets/logo.svg` (in-app `BrandMark`), exported to `pwa-192/512.png` and `favicon-32.png` |
| `mineguard-icon-maskable.svg` | Full-bleed with artwork inside the Android safe zone → `pwa-maskable-192/512.png` |
| `mineguard-icon-fullbleed.svg` | Square, no rounded corners (iOS rounds it itself) → `apple-touch-icon.png` (180px) |

## Re-exporting the PNGs

From the repo root (any SVG rasteriser works; shown with `rsvg-convert`):

```sh
rsvg-convert -w 192 -h 192 branding/mineguard-icon.svg           -o public/icons/pwa-192.v2.png
rsvg-convert -w 512 -h 512 branding/mineguard-icon.svg           -o public/icons/pwa-512.v2.png
rsvg-convert -w 192 -h 192 branding/mineguard-icon-maskable.svg  -o public/icons/pwa-maskable-192.v2.png
rsvg-convert -w 512 -h 512 branding/mineguard-icon-maskable.svg  -o public/icons/pwa-maskable-512.v2.png
rsvg-convert -w 180 -h 180 branding/mineguard-icon-fullbleed.svg -o public/icons/apple-touch-icon.v2.png
rsvg-convert -w 32  -h 32  branding/mineguard-icon.svg           -o public/icons/favicon-32.v2.png
cp branding/mineguard-icon.svg public/logo.svg
cp branding/mineguard-icon.svg src/assets/logo.svg
```

After changing any icon, bump `VERSION` in `public/sw.js` — icons are served
cache-first, so installed apps only refresh when the cache name changes.

## Attribution

The map is drawn from `data/boundaries/geoboundaries-lbr/liberia-counties.geojson`
(geoBoundaries ADM1, CC BY 3.0 IGO — see that folder's `PROVENANCE.md`),
simplified for icon use. The flag colours and layout follow the national flag
of Liberia. This is an independent project, not an official Government of
Liberia mark.

## Why the icon files end in `.v2.png`

Browsers and the OS cache the install-banner icon and the installed home-screen
icon by URL. Changing an icon's pixels without changing its URL leaves
existing visitors on the old artwork. When the artwork changes again, bump the
suffix (`.v3.png`), update `public/manifest.webmanifest`, `index.html` and the
`PRECACHE` list in `public/sw.js`, and bump `VERSION` in `public/sw.js`.
