import { Button } from "@/components/ui/button";
import {
  acceptInstall,
  dismissInstallBanner,
  getInstallView,
  subscribeInstall,
} from "@/lib/install-prompt";
import { Share, SquarePlus, X } from "lucide-react";
import { useSyncExternalStore } from "react";

/** "Install MineGuard" banner. Pacing lives in src/lib/install-prompt.ts. */
export function InstallBanner() {
  const { visible, mode } = useSyncExternalStore(subscribeInstall, getInstallView, getInstallView);
  if (!visible || !mode) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="install-title"
      aria-describedby="install-desc"
      className="paper fixed inset-x-3 z-[60] mx-auto max-w-md border border-border p-4 shadow-lg sm:right-4 sm:left-auto sm:mx-0"
      style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <button
        type="button"
        onClick={dismissInstallBanner}
        aria-label="Dismiss install prompt"
        className="absolute top-2 right-2 inline-flex size-8 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <X className="size-4" />
      </button>

      <div className="flex min-w-0 items-start gap-3 pr-8">
        <img
          src={`${import.meta.env.BASE_URL}icons/pwa-192.v2.png`}
          alt=""
          width={44}
          height={44}
          className="size-11 shrink-0 rounded-md border border-border"
        />
        <div className="min-w-0">
          <h2 id="install-title" className="display text-base leading-tight">
            Install MineGuard Liberia
          </h2>
          {mode === "native" ? (
            <p id="install-desc" className="mt-1 text-sm break-words text-muted-foreground">
              Add the app to your device for one-tap access, faster loading and offline field
              work.
            </p>
          ) : (
            <div id="install-desc" className="mt-1 text-sm text-muted-foreground">
              <p>Add it to your Home Screen for one-tap access and offline field work:</p>
              <ol className="mt-1.5 space-y-1">
                <li className="flex items-center gap-1.5">
                  1. Tap <Share className="size-4 shrink-0" aria-label="Share" /> in Safari&apos;s
                  toolbar
                </li>
                <li className="flex items-center gap-1.5">
                  2. Choose <SquarePlus className="size-4 shrink-0" aria-hidden="true" />
                  <span className="font-medium text-foreground">Add to Home Screen</span>
                </li>
              </ol>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={dismissInstallBanner}>
          {mode === "ios" ? "Got it" : "Not now"}
        </Button>
        {mode === "native" && (
          <Button type="button" size="sm" onClick={() => void acceptInstall()}>
            Install app
          </Button>
        )}
      </div>
    </div>
  );
}
