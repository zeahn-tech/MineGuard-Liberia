// ---------------------------------------------------------------------------
// SHA-256 — shared integrity helper for evidence (EVD-1).
//
// The digest is computed with WebCrypto's subtle API (Bun and every secure-
// context browser provide it; GitHub Pages is https, so subtle is present in
// production). Returns null when the platform has no subtle crypto — callers
// treat that as "no digest available" (the evidence.sha256 column is
// nullable by design), never as a hash mismatch.
// ---------------------------------------------------------------------------

/** Lowercase hex SHA-256 of the bytes, or null when subtle crypto is absent. */
export async function sha256Hex(
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  let buf: ArrayBuffer;
  if (data instanceof Blob) {
    buf = await data.arrayBuffer();
  } else if (data instanceof Uint8Array) {
    buf = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  } else {
    buf = data;
  }
  const digest = await subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
