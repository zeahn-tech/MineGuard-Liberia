// ---------------------------------------------------------------------------
// LEGAL DOCUMENT METADATA — single source for the Terms and Privacy pages.
//
// Bump LEGAL_VERSION + LEGAL_UPDATED whenever either document changes in
// substance (tests pin the format so the two cannot drift apart).
//
// The program office's public contact address is deployment configuration, not
// source code: set VITE_LEGAL_CONTACT_EMAIL at build time. When it is unset the
// pages direct people to the program office that gave them access instead of
// showing a made-up address.
// ---------------------------------------------------------------------------

export const LEGAL_VERSION = "1.0";
/** ISO date the current wording took effect. */
export const LEGAL_UPDATED = "2026-10-24";

export const LEGAL_PRODUCT = "MineGuard Liberia";

export function legalContactEmail(): string | null {
  const raw = import.meta.env.VITE_LEGAL_CONTACT_EMAIL?.trim();
  return raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

export function formatLegalDate(iso: string = LEGAL_UPDATED): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
