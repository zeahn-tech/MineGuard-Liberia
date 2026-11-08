// ---------------------------------------------------------------------------
// WORKER VOICE — photos. JPEG only, up to 3, each under ~900 KB, hidden data removed ON THE PHONE
// and checked again by the server (migration 0047), which refuses anything with metadata.
//
// What this removes: EXIF (camera, time, GPS), XMP, ICC profiles, comments, embedded thumbnails, any
// APPn/COM segment. What it cannot remove: what the picture itself shows (faces, name tags, signs,
// distinctive equipment or places). The form says so. No malware scan exists; the file is only ever
// shown to reviewers as an image, never as a download or a page.
// ---------------------------------------------------------------------------
export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 900_000;
const MAX_SIDE = 1600;
const MAX_DIM = 4096;

export type Sanitized = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/** Keep only what the picture needs: JFIF (rebuilt bare), quantization/Huffman/frame/restart tables and the scan. */
export function sanitizeJpeg(b: Uint8Array): Sanitized {
  if (b.length < 100 || b[0] !== 0xff || b[1] !== 0xd8) return { ok: false, reason: "That is not a JPEG photo." };
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  let sawFrame = false;
  let scanAt = -1;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return { ok: false, reason: "That photo could not be read." };
    const m = b[i + 1];
    const len = b[i + 2] * 256 + b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return { ok: false, reason: "That photo could not be read." };
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      const h = b[i + 5] * 256 + b[i + 6];
      const w = b[i + 7] * 256 + b[i + 8];
      if (h < 1 || w < 1 || h > MAX_DIM || w > MAX_DIM) return { ok: false, reason: "That photo is too large." };
      sawFrame = true;
    }
    if (m === 0xda) { scanAt = i; break; }
    if (m === 0xdb || m === 0xc4 || m === 0xdd || m === 0xc0 || m === 0xc1 || m === 0xc2) {
      for (let k = 0; k < 2 + len; k++) out.push(b[i + k]);
    }
    // everything else (APPn, COM, thumbnails, unknown) is dropped
    i += 2 + len;
  }
  if (scanAt < 0 || !sawFrame) return { ok: false, reason: "That photo could not be read." };
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return { ok: false, reason: "That photo is incomplete." };
  // a bare JFIF header right after SOI keeps older viewers happy, with no embedded thumbnail
  const jfif = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const scan = Array.from(b.subarray(scanAt));
  // hidden segments after the scan header cannot be stripped without decoding: refuse
  for (let k = 0; k < scan.length - 1; k++) if (scan[k] === 0xff && ((scan[k + 1] >= 0xe0 && scan[k + 1] <= 0xef) || scan[k + 1] === 0xfe)) return { ok: false, reason: "That photo carries hidden data. Take a new photo." };
  return { ok: true, bytes: Uint8Array.from([0xff, 0xd8, ...jfif, ...out.slice(2), ...scan]) };
}

export function bytesToBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface PreparedPhoto { id: string; base64: string; bytes: number; previewUrl: string }
export type PrepareResult = { ok: true; photo: PreparedPhoto } | { ok: false; reason: string };

/** Re-draw the picture (which drops all camera data and applies its rotation), shrink it, then structurally clean it. */
export async function preparePhoto(file: File): Promise<PrepareResult> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return { ok: false, reason: "Choose a photo (JPEG, PNG or WebP)." };
  if (file.size > 25_000_000) return { ok: false, reason: "That photo is too large to prepare on this phone." };
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { return { ok: false, reason: "This phone could not read that photo." }; }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, reason: "This phone could not prepare the photo." };
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  for (const q of [0.82, 0.7, 0.58, 0.46]) {
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
    if (!blob) return { ok: false, reason: "This phone could not prepare the photo." };
    const clean = sanitizeJpeg(new Uint8Array(await blob.arrayBuffer()));
    if (!clean.ok) return { ok: false, reason: clean.reason };
    if (clean.bytes.length <= MAX_PHOTO_BYTES) {
      const copy = new Uint8Array(clean.bytes);
      return { ok: true, photo: { id: crypto.randomUUID(), base64: bytesToBase64(copy), bytes: copy.length, previewUrl: URL.createObjectURL(new Blob([copy], { type: "image/jpeg" })) } };
    }
  }
  return { ok: false, reason: "That photo is still too large after shrinking. Try a simpler photo." };
}
