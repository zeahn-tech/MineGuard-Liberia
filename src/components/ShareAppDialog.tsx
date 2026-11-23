import { useMemo, useState } from "react";
import { Check, Copy, Mail, MessageCircle, MessageSquare, Send, Share2, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  SHARE_MESSAGE,
  buildShareTargets,
  canUseNativeShare,
  copyToClipboard,
  getShareUrl,
  nativeShare,
  type ShareTargetId,
} from "@/lib/share";

// Generic icons on purpose: brand logos are not part of the icon set and we do
// not ship third-party brand assets. The app name is always spelled out.
const TARGET_ICON: Record<ShareTargetId, LucideIcon> = {
  whatsapp: MessageCircle,
  facebook: Users,
  x: Send,
  telegram: Send,
  linkedin: Users,
  sms: MessageSquare,
  email: Mail,
};

export function ShareAppDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const url = useMemo(() => getShareUrl(), []);
  const targets = useMemo(() => buildShareTargets(url), [url]);
  const [copied, setCopied] = useState(false);
  const nativeAvailable = canUseNativeShare();

  async function handleCopy() {
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopied(true);
      toast.success("Link copied", { description: "Paste it into any chat or post." });
      window.setTimeout(() => setCopied(false), 2500);
    } else {
      toast.error("Couldn't copy the link", {
        description: "Select the link in the box and copy it by hand.",
      });
    }
  }

  async function handleNative() {
    const result = await nativeShare(url);
    if (result === "shared") onOpenChange(false);
    else if (result === "failed")
      toast.error("Couldn't open the share menu", {
        description: "Use one of the apps below, or copy the link.",
      });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="paper max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share MineGuard Liberia</DialogTitle>
          <DialogDescription>
            Send the app link to coworkers, friends or your community. Only the public
            address is shared — never the page you are on or any of your data.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-sm border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {SHARE_MESSAGE}
        </p>

        {nativeAvailable && (
          <Button type="button" className="w-full" onClick={() => void handleNative()}>
            <Share2 className="size-4" /> Share using your device
          </Button>
        )}

        <ul className="grid grid-cols-2 gap-2" aria-label="Share to">
          {targets.map((t) => {
            const Icon = TARGET_ICON[t.id];
            return (
              <li key={t.id}>
                <a
                  href={t.href}
                  {...(t.opensInNewTab
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                  onClick={() => {
                    if (t.opensInNewTab) onOpenChange(false);
                  }}
                  className="flex min-h-11 items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Share on ${t.label}`}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{t.label}</span>
                </a>
              </li>
            );
          })}
        </ul>

        <div className="space-y-1.5">
          <label htmlFor="share-link" className="text-xs font-medium text-muted-foreground">
            Or copy the link
          </label>
          <div className="flex gap-2">
            <Input
              id="share-link"
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleCopy()}
              aria-label="Copy link"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A "Share app" button that opens the share dialog. `onOpen` lets a drawer close itself first. */
export function ShareAppButton({
  variant = "outline",
  size = "sm",
  className,
  label = "Share app",
  iconOnlyOnMobile = false,
  onOpen,
}: {
  variant?: "outline" | "ghost" | "default";
  size?: "sm" | "default";
  className?: string;
  label?: string;
  iconOnlyOnMobile?: boolean;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        aria-label={iconOnlyOnMobile ? label : undefined}
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      >
        <Share2 className="size-3.5" />
        <span className={iconOnlyOnMobile ? "hidden sm:inline" : undefined}>{label}</span>
      </Button>
      <ShareAppDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
