// ---------------------------------------------------------------------------
// EVIDENCE SECTION (doc 07 — evidence/media architecture)
//
// Reusable attach-photos/files UI for a parent record (inspection, incident,
// observation). Notes:
//  - Upload is ONLINE-ONLY by contract (doc 05): evidence bytes must reach
//    Storage before the metadata doc exists; a local blob: URL is never a
//    permanent media reference. Offline capture is queued at the record level
//    instead (offline-queue.ts).
//  - Authorization is server-enforced (firestore.rules / storage.rules):
//    the data layer lists only evidence in the caller's scope and the
//    upload mutation re-derives site visibility before writing.
// ---------------------------------------------------------------------------

import { useRef, useState } from "react";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { FileText, ImageIcon, Paperclip, Upload } from "lucide-react";
import type { Evidence } from "@/lib/types";

const MAX_BYTES = 25 * 1024 * 1024; // mirrored in rules + data layer

export default function EvidenceSection({
  parentType,
  parentId,
  siteId,
}: {
  parentType: Evidence["parentType"];
  parentId: string;
  siteId: string;
}) {
  const { user } = useAuth();
  const evidence = useQuery(api.evidence.listForParent, { parentType, parentId });
  const upload = useMutation(api.evidence.upload);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [caption, setCaption] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // Upload is available to any assigned account (staff or operator on their
  // own site); the backend + rules re-derive scope. Guests never have a role.
  const canUpload = !!user?.role;

  const onUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Choose a file first.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("File exceeds the 25MB limit.");
      return;
    }
    setSaving(true);
    try {
      await upload({
        file,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        parentType,
        parentId,
        siteId,
        caption: caption || undefined,
        capturedAt: Date.now(),
      });
      toast.success("Evidence attached");
      setOpen(false);
      setCaption("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="flex items-baseline justify-between border-b border-border pb-2">
        <h2 className="display flex items-center gap-2 text-lg">
          <Paperclip className="size-4" /> Evidence
        </h2>
        {canUpload && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Upload className="size-3.5" /> Attach file
          </Button>
        )}
      </div>

      {evidence === undefined ? (
        <p className="py-4 text-sm text-muted-foreground">Loading…</p>
      ) : evidence.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          No evidence attached yet.
          {canUpload ? " Photos, video, audio or documents (max 25MB)." : ""}
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {evidence.map((ev) => (
            <EvidenceCard key={ev._id} ev={ev} />
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="paper">
          <DialogHeader>
            <DialogTitle>Attach evidence</DialogTitle>
            <DialogDescription>
              Files upload immediately — attach evidence while online. Stored
              with your identity, the site, and a timestamp.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>File (max 25MB)</Label>
              <Input ref={fileRef} type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx" />
            </div>
            <div className="space-y-1.5">
              <Label>Caption (optional)</Label>
              <Input
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="What does this show?"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={onUpload} disabled={saving}>
              {saving ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function EvidenceCard({ ev }: { ev: Evidence }) {
  const getUrl = useMutation(api.evidence.getUrl);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (loading || url) return;
    setLoading(true);
    try {
      const u = await getUrl(ev._id);
      if (u) {
        setUrl(u);
        window.open(u, "_blank", "noopener");
      } else {
        toast.error("File unavailable (access denied or missing).");
      }
    } finally {
      setLoading(false);
    }
  };

  const isImage = ev.mimeType.startsWith("image/");
  return (
    <li className="border border-border p-3">
      <button
        type="button"
        onClick={load}
        className="group flex w-full items-start gap-3 text-left"
        title="Open evidence file"
      >
        {isImage && url ? (
          <img
            src={url}
            alt={ev.caption ?? ev.fileName}
            className="size-12 shrink-0 border border-border object-cover"
          />
        ) : (
          <span className="flex size-12 shrink-0 items-center justify-center border border-border bg-muted/40">
            {isImage ? (
              <ImageIcon className="size-5 text-muted-foreground" />
            ) : (
              <FileText className="size-5 text-muted-foreground" />
            )}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium group-hover:underline">
            {ev.fileName}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {ev.kind} · {(ev.sizeBytes / 1024).toFixed(0)} KB ·{" "}
            {new Date(ev.capturedAt ?? ev.createdAt).toLocaleString()}
          </span>
          {ev.caption && (
            <span className="mt-1 block text-xs text-muted-foreground italic">
              {ev.caption}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
