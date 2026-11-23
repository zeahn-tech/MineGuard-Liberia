// In-app "Share MineGuard Liberia": a button that opens a dialog with the
// device's native share sheet (when available), one-tap links for the common
// social and messaging apps, and a copy-link fallback that works everywhere.
import { useState, type ReactNode } from "react";
import { Check, Copy, Facebook, Linkedin, Mail, MessageCircle, MessageSquare, Send, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { appShareUrl, SHARE_CHANNELS, SHARE_TEXT, SHARE_TITLE, type ShareChannelId } from "@/lib/share";

// Brand colours are intentional (recognisable app badges), not theme colours.
const BADGE: Record<ShareChannelId, { bg: string; icon: ReactNode }> = {
  whatsapp: { bg: "#25D366", icon: <MessageCircle className="size-6" /> },
  facebook: { bg: "#1877F2", icon: <Facebook className="size-6" /> },
  x: { bg: "#000000", icon: <span className="text-xl font-bold leading-none">X</span> },
  telegram: { bg: "#229ED9", icon: <Send className="size-6" /> },
  linkedin: { bg: "#0A66C2", icon: <Linkedin className="size-6" /> },
  sms: { bg: "#34A853", icon: <MessageSquare className="size-6" /> },
  email: { bg: "#6B7280", icon: <Mail className="size-6" /> },
};

export function ShareAppButton({ className = "w-full justify-start text-muted-foreground" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" className={className} onClick={() => setOpen(true)}>
        <Share2 className="size-3.5" /> Share app
      </Button>
      <ShareAppDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ShareAppDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const url = appShareUrl();
  const [copied, setCopied] = useState(false);
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function nativeShare() {
    try {
      await navigator.share({ title: SHARE_TITLE, text: SHARE_TEXT, url });
      onOpenChange(false);
    } catch (e) {
      // Closing the share sheet is not an error.
      if (!(e instanceof DOMException && e.name === "AbortError")) toast.error("Could not open the share menu. Use one of the apps below or copy the link.");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy automatically. Select the link and copy it.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Share MineGuard Liberia</DialogTitle>
          <DialogDescription>Send the app link to coworkers, friends or your community. Nothing is shared until you choose an app.</DialogDescription>
        </DialogHeader>

        {canNativeShare && (
          <Button onClick={nativeShare} className="w-full">
            <Share2 className="size-4" /> Share using your phone
          </Button>
        )}

        <ul className="grid grid-cols-4 gap-3" aria-label="Share through">
          {SHARE_CHANNELS.map((c) => (
            <li key={c.id}>
              <a
                href={c.href(url)}
                {...(c.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="flex flex-col items-center gap-1.5 rounded-md p-1 text-center text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <span className="flex size-12 items-center justify-center rounded-full text-white" style={{ backgroundColor: BADGE[c.id].bg }} aria-hidden="true">
                  {BADGE[c.id].icon}
                </span>
                {c.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex gap-2">
          <Input readOnly value={url} aria-label="App link" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" onClick={copyLink} aria-label="Copy link">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
