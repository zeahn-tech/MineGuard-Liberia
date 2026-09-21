// One-shot generator: PWA icons for MineGuard Liberia (Papery theme).
// Drawn procedurally — shield + check on paper (#F0EEE6), ink (#232019).
// Run: bun scripts/generate-icons.ts   (dev dependency only: pngjs)
import { PNG } from "pngjs";
import { writeFileSync, mkdirSync } from "node:fs";

const PAPER: [number, number, number] = [0xf0, 0xee, 0xe6];
const INK: [number, number, number] = [0x23, 0x20, 0x19];
const RUST: [number, number, number] = [0x9a, 0x3b, 0x26];

type RGBA = [number, number, number, number];

/** Signed distance helpers for anti-aliased procedural drawing. */
function sdSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  const dx = px - (ax + bax * h);
  const dy = py - (ay + bay * h);
  return Math.hypot(dx, dy);
}

/** Shield outline: classic badge shape within [0,1] coords, returns distance to the edge (negative inside). */
function shieldSDF(x: number, y: number): number {
  // Shield centered horizontally; top at 0.12, bottom point at 0.92.
  const top = 0.12;
  const bottom = 0.92;
  const halfTop = 0.36;
  const cx = 0.5;

  // Distance to top edge (outside above)
  const insideTop = y - top; // positive inside
  // Side edges taper from halfTop at top to halfTop*0.42 at bottom point
  const t = Math.max(0, Math.min(1, (y - top) / (bottom - top)));
  const halfWidth = halfTop * (1 - 0.58 * t);

  const insideLeft = x - (cx - halfWidth); // positive inside
  const insideRight = (cx + halfWidth) - x;

  // Bottom point: below 0.78 the shape converges to a V at (cx, bottom).
  let insideBottom: number;
  if (y <= 0.78) {
    insideBottom = 0.78 - y + 10; // not binding
  } else {
    const vt = (y - 0.78) / (bottom - 0.78);
    const vHalf = halfTop * (1 - 0.58 * ((0.78 - top) / (bottom - top))) * (1 - vt);
    insideBottom = Math.min(x - (cx - vHalf), (cx + vHalf) - x);
  }

  return Math.min(insideTop, insideLeft, insideRight, insideBottom);
}

function coverage(dist: number): number {
  // 1px smoothstep around the shape edge.
  return Math.max(0, Math.min(1, 0.5 - dist));
}

function blend(base: RGBA, over: RGBA): RGBA {
  const a = over[3];
  return [
    over[0] * a + base[0] * (1 - a),
    over[1] * a + base[1] * (1 - a),
    over[2] * a + base[2] * (1 - a),
    Math.max(base[3], a),
  ];
}

function drawIcon(size: number, maskable: boolean): Buffer {
  const png = new PNG({ width: size, height: size });
  const scale = size / 512;
  const data = png.data;

  // Safe area: maskable icons need ~10% padding on every edge.
  const pad = maskable ? 0.1 : 0;
  const inner = (v: number) => pad + v * (1 - 2 * pad);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Normalized coordinates inside the safe area.
      const u = (px / size - pad) / (1 - 2 * pad);
      const v = (py / size - pad) / (1 - 2 * pad);

      let color: RGBA = [...PAPER, 255] as RGBA;

      // Shield fill (ink) with 2.5px edge AA.
      const sd = shieldSDF(u, v);
      const shieldCov = coverage(sd / ((2.5 * scale) / 512 / (1 - 2 * pad) || 1e-9));
      if (shieldCov > 0) {
        color = blend(color, [...INK, shieldCov * 255] as RGBA);
      }

      // Inner paper shield (outline effect): a slightly smaller shield cut.
      const sdInner = shieldSDF((u - 0.5) * 0.86 + 0.5, (v - 0.51) * 0.86 + 0.51);
      const innerCov = coverage(sdInner / ((2.5 * scale) / 512 / (1 - 2 * pad) || 1e-9));
      if (innerCov > 0) {
        color = blend(color, [...PAPER, innerCov * 255] as RGBA);
      }

      // Checkmark (rust) as a thick polyline, coordinates in shield space.
      const sw = 0.075; // stroke half-width in shield space
      const d1 = sdSegment(u, v, inner(0.3), inner(0.55), inner(0.44), inner(0.7));
      const d2 = sdSegment(u, v, inner(0.44), inner(0.7), inner(0.72), inner(0.3));
      const stroke = Math.min(d1, d2);
      // Note: inner() is linear so no distortion; compute in normalized units.
      const strokeCov = coverage((stroke - sw) / ((2.5 * scale) / 512 / (1 - 2 * pad) || 1e-9));
      if (strokeCov > 0) {
        color = blend(color, [...RUST, strokeCov * 255] as RGBA);
      }

      const idx = (py * size + px) * 4;
      data[idx] = Math.round(color[0]);
      data[idx + 1] = Math.round(color[1]);
      data[idx + 2] = Math.round(color[2]);
      data[idx + 3] = Math.round(color[3]);
    }
  }

  return PNG.sync.write(png);
}

mkdirSync("public/icons", { recursive: true });

const variants: [string, number, boolean][] = [
  ["pwa-192.png", 192, false],
  ["pwa-512.png", 512, false],
  ["pwa-maskable-192.png", 192, true],
  ["pwa-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, false],
  ["favicon-32.png", 32, false],
];

for (const [name, size, maskable] of variants) {
  writeFileSync(`public/icons/${name}`, drawIcon(size, maskable));
  console.log(`wrote public/icons/${name} (${size}px${maskable ? ", maskable" : ""})`);
}
