// ---------------------------------------------------------------------------
// SHARE THE APP — builds the public link and the per-channel share links.
// Nothing here sends data anywhere: each channel is a plain link the person
// taps, so they stay in control of who receives it (no tracking, no SDKs).
// ---------------------------------------------------------------------------

export const SHARE_TITLE = "MineGuard Liberia";
export const SHARE_TEXT = "MineGuard Liberia: mine safety reporting and guidance. Open the app here:";

/** Public address of the app (origin + deployment base path, e.g. GitHub Pages). */
export function appShareUrl(
  origin: string = typeof window !== "undefined" ? window.location.origin : "",
  base: string = import.meta.env.BASE_URL ?? "/",
): string {
  const path = base.startsWith("/") ? base : `/${base}`;
  return `${origin}${path}`;
}

export type ShareChannelId = "whatsapp" | "facebook" | "x" | "telegram" | "linkedin" | "sms" | "email";

export interface ShareChannel {
  id: ShareChannelId;
  label: string;
  /** Opens in a new tab/app (web links) vs. hands off to the device (mailto/sms). */
  external: boolean;
  href: (url: string, text?: string) => string;
}

const q = encodeURIComponent;

export const SHARE_CHANNELS: ShareChannel[] = [
  { id: "whatsapp", label: "WhatsApp", external: true, href: (u, t = SHARE_TEXT) => `https://wa.me/?text=${q(`${t} ${u}`)}` },
  { id: "facebook", label: "Facebook", external: true, href: (u) => `https://www.facebook.com/sharer/sharer.php?u=${q(u)}` },
  { id: "x", label: "X", external: true, href: (u, t = SHARE_TEXT) => `https://x.com/intent/post?text=${q(t)}&url=${q(u)}` },
  { id: "telegram", label: "Telegram", external: true, href: (u, t = SHARE_TEXT) => `https://t.me/share/url?url=${q(u)}&text=${q(t)}` },
  { id: "linkedin", label: "LinkedIn", external: true, href: (u) => `https://www.linkedin.com/sharing/share-offsite/?url=${q(u)}` },
  { id: "sms", label: "SMS", external: false, href: (u, t = SHARE_TEXT) => `sms:?&body=${q(`${t} ${u}`)}` },
  { id: "email", label: "Email", external: false, href: (u, t = SHARE_TEXT) => `mailto:?subject=${q(SHARE_TITLE)}&body=${q(`${t}\n\n${u}`)}` },
];
