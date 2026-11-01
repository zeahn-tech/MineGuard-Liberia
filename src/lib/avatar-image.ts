// ---------------------------------------------------------------------------
// Profile photo preparation (browser). Whatever the person picks becomes a small
// square JPEG before it leaves the device:
//   * the size/type limits are checked first (and enforced again by the private
//     storage bucket: JPEG only, 2 MB, own file only);
//   * redrawing onto a canvas DROPS the original's metadata, including GPS location;
//   * a phone photo of several MB becomes ~30-80 KB.
// ---------------------------------------------------------------------------

export const AVATAR_SIZE = 384; // px, square
export const AVATAR_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const AVATAR_ACCEPT = "image/jpeg,image/png,image/webp";
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export function validateAvatarFile(file: { type: string; size: number }): string | null {
  if (!ALLOWED.has(file.type)) return "Choose a JPEG, PNG or WebP picture.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > AVATAR_MAX_SOURCE_BYTES) return "That picture is larger than 10 MB. Choose a smaller one.";
  return null;
}

/** The centred square to cut from a width x height image. */
export function squareCrop(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

export async function prepareAvatar(file: File): Promise<Blob> {
  const problem = validateAvatarFile(file);
  if (problem) throw new Error(problem);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That picture could not be read. Try another one.");
  });
  const { sx, sy, side } = squareCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(AVATAR_SIZE, side);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser cannot prepare pictures.");
  ctx.fillStyle = "#ffffff"; // PNG/WebP transparency becomes white, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
  if (!blob) throw new Error("The picture could not be prepared.");
  return blob;
}

export function initialsOf(name: string | null | undefined, email: string | null | undefined): string {
  const source = (name ?? "").trim() || (email ?? "").split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}
