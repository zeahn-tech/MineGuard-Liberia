// ---------------------------------------------------------------------------
// APP SHARING — lets a person tell others about MineGuard Liberia through the
// social / messaging apps they already use.
//
// Design rules:
//  * We always share the app's PUBLIC landing address, never the page the person
//    is on. Deep links can carry record ids or tracking codes that must not leak.
//  * Targets are plain links (https:, mailto:, sms:) the browser opens. No third
//    party SDK or script is loaded (the production CSP is `script-src 'self'`), and
//    nothing is sent to any network by us — the share happens in the other app.
//  * The Web Share API is offered where available (phones: the OS share sheet lists
//    every installed app); the link list below is the fallback and the desktop path.
//  * Wording never claims to be an official Government of Liberia system.
// ---------------------------------------------------------------------------

export const SHARE_TITLE = "MineGuard Liberia";

/** Short, neutral invitation text. Kept short: some apps truncate long prefilled text. */
export const SHARE_MESSAGE =
  "MineGuard Liberia: mining safety information, community reports and worker voice, in one app.";

export const SHARE_EMAIL_SUBJECT = "Have a look at MineGuard Liberia";

export type ShareTargetId =
  | "whatsapp"
  | "facebook"
  | "x"
  | "telegram"
  | "linkedin"
  | "sms"
  | "email";

export interface ShareTarget {
  id: ShareTargetId;
  label: string;
  /** Fully encoded address that opens the other app / site with the text prefilled. */
  href: string;
  /** mailto: and sms: hand off to an installed app; the rest open a new tab. */
  opensInNewTab: boolean;
}

/** `PUBLIC_APP_URL` (build-time) wins so a custom domain can be shared even when
 *  the app is opened from another address (e.g. a staging or preview host). */
export function getShareUrl(
  opts: { origin?: string; baseUrl?: string; override?: string } = {},
): string {
  const override = (opts.override ?? import.meta.env.VITE_PUBLIC_APP_URL ?? "").trim();
  if (override) {
    try {
      const u = new URL(override);
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {
      /* fall through to the origin-based address */
    }
  }
  const origin =
    opts.origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  const base = opts.baseUrl ?? import.meta.env.BASE_URL ?? "/";
  const path = base.startsWith("/") ? base : `/${base}`;
  return `${origin}${path.endsWith("/") ? path : `${path}/`}`;
}

/** The ordered list of "share to…" links for `url`. */
export function buildShareTargets(
  url: string,
  message: string = SHARE_MESSAGE,
): ShareTarget[] {
  const u = encodeURIComponent(url);
  const m = encodeURIComponent(message);
  const withUrl = encodeURIComponent(`${message} ${url}`);
  return [
    {
      id: "whatsapp",
      label: "WhatsApp",
      href: `https://wa.me/?text=${withUrl}`,
      opensInNewTab: true,
    },
    {
      id: "facebook",
      label: "Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
      opensInNewTab: true,
    },
    {
      id: "x",
      label: "X",
      href: `https://twitter.com/intent/tweet?text=${m}&url=${u}`,
      opensInNewTab: true,
    },
    {
      id: "telegram",
      label: "Telegram",
      href: `https://t.me/share/url?url=${u}&text=${m}`,
      opensInNewTab: true,
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
      opensInNewTab: true,
    },
    {
      id: "sms",
      label: "SMS",
      // `?&body=` is the form that works on both iOS and Android.
      href: `sms:?&body=${withUrl}`,
      opensInNewTab: false,
    },
    {
      id: "email",
      label: "Email",
      href: `mailto:?subject=${encodeURIComponent(SHARE_EMAIL_SUBJECT)}&body=${withUrl}`,
      opensInNewTab: false,
    },
  ];
}

export function canUseNativeShare(
  nav: Pick<Navigator, "share"> | undefined = typeof navigator !== "undefined"
    ? navigator
    : undefined,
): boolean {
  return !!nav && typeof nav.share === "function";
}

export type NativeShareResult = "shared" | "cancelled" | "unsupported" | "failed";

/** Opens the operating system share sheet. A person closing the sheet is not an error. */
export async function nativeShare(
  url: string,
  nav: Pick<Navigator, "share"> | undefined = typeof navigator !== "undefined"
    ? navigator
    : undefined,
): Promise<NativeShareResult> {
  if (!nav || typeof nav.share !== "function") return "unsupported";
  try {
    await nav.share({ title: SHARE_TITLE, text: SHARE_MESSAGE, url });
    return "shared";
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    return "failed";
  }
}

/** Copies `text` to the clipboard. Falls back to a hidden textarea for older
 *  browsers and non-secure contexts. Returns whether the copy succeeded. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied or insecure context — try the fallback */
  }
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
