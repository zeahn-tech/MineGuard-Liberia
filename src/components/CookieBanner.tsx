import { onConsentReopen, setConsent, useConsent } from "@/lib/consent";
import { useEffect, useState } from "react";
import { Link } from "react-router";

/**
 * Storage notice + choice. Non-blocking (nothing is hidden behind it), both
 * buttons carry equal visual weight, and nothing optional runs before a choice.
 * Shown on first visit, and again from the "Cookie settings" footer link.
 */
export function CookieBanner() {
  const consent = useConsent();
  const [reopened, setReopened] = useState(false);

  useEffect(() => onConsentReopen(() => setReopened(true)), []);

  if (consent.decided && !reopened) return null;

  const choose = (mapTiles: boolean) => {
    setConsent({ mapTiles });
    setReopened(false);
  };

  return (
    <div
      role="region"
      aria-label="Cookie and storage settings"
      className="fixed inset-x-0 bottom-0 z-[2000] border-t border-border bg-background p-3 shadow-lg md:inset-x-auto md:right-4 md:bottom-4 md:max-w-md md:rounded-sm md:border"
    >
      <p className="text-sm font-medium">Cookies and storage</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        MineGuard sets <strong>no cookies</strong> and runs <strong>no analytics or advertising</strong>.
        It stores only what the app needs on your device: your sign-in, saved offline work and an app
        copy. One optional item: the <strong>map background</strong> is loaded from OpenStreetMap, which
        will see your network address and the area you view. It stays off unless you accept.{" "}
        <Link to="/cookies" className="underline underline-offset-4">
          Cookie policy
        </Link>
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => choose(false)}
          className="min-h-10 rounded-sm border border-border px-3 text-sm font-medium hover:bg-muted"
        >
          Essential only
        </button>
        <button
          type="button"
          onClick={() => choose(true)}
          className="min-h-10 rounded-sm border border-border px-3 text-sm font-medium hover:bg-muted"
        >
          Allow map background
        </button>
      </div>
      {consent.decided && (
        <p className="mt-2 text-xs text-muted-foreground">
          Currently: map background {consent.mapTiles ? "allowed" : "off"}.
        </p>
      )}
    </div>
  );
}
