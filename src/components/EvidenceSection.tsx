// ---------------------------------------------------------------------------
// EVIDENCE SECTION (doc 07 — evidence/media architecture)
//
// Reusable attach-photos/files UI for a parent record (inspection, incident,
// observation). Notes:
//  - Bytes must reach Storage before the metadata doc exists, so an upload while
//    offline is queued locally (IndexedDB via offline-evidence.ts) and replayed
//    when connectivity returns. A device-local URI is never a permanent media
//    reference — the queue holds bytes only until the real upload succeeds.
//  - Authorization is server-enforced (firestore.rules / storage.rules): the
//    data layer lists only evidence in the caller's scope and the upload
//    mutation re-derives site visibility before writing.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
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
import { CloudOff, FileText, ImageIcon, Paperclip, Upload } from "lucide-react";
import type { Evidence } from "@/lib/types";
import {
  enqueuePendingEvidence,
  readPendingEvidenceForParent,
  syncEvidenceQueue,
  type PendingEvidence,
} from "@/lib/offline-evidence";

const MAX_BYTES = 25 * 1024 * 1024; // mirrored in rules + data layer

/** True when a failure looks like a connectivity problem (retryable) rather
 *  than a policy denial (storage/unauthorized) — only the former is queued. */
function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  // Deliberately narrow: only clearly-connectivity signals are considered
  // retryable. A policy denial (storage/unauthorized) or a missing bucket must
  // surface as an error, not silently accumulate in the offline queue.
  return (
    msg.includes("network") ||
    msg.includes("failed to fetch") ||
    msg.includes("unavailable") ||
    msg.includes("offline")
  );
}

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
  // `refresh` is a nonce: the generic live() watcher cannot watch /evidence
  // safely (its list rule is parent-joined), so a completed upload/sync bumps
  // the nonce to force a fresh scoped read.
  const [nonce, setNonce] = useState(0);
  const evidence = useQuery(api.evidence.listForParent, {
    parentType,
    parentId,
    refresh: nonce,
  });
  const upload = useMutation(api.evidence.upload);
  const [pending, setPending] = useState<PendingEvidence[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [caption, setCaption] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // Upload is available to any assigned account (staff or operator on their
  // own site); the backend + rules re-derive scope. Guests never have a role.
  const canUpload = !!user?.role;

  const refreshPending = useCallback(async () => {
    setPending(await readPendingEvidenceForParent(parentType, parentId));
  }, [parentType, parentId]);

  // Keep the latest upload mutation without making the sync effect depend on a
  // freshly-created function each render (which would re-run the effect).
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  const runSync = useCallback(async () => {
    try {
      const { synced } = await syncEvidenceQueue((a) => uploadRef.current(a));
      if (synced > 0) {
        toast.success(
          `Uploaded ${synced} queued evidence file${synced > 1 ? "s" : ""}`,
        );
        setNonce((n) => n + 1);
      }
    } catch {
      /* sync is best-effort; items remain queued */
    }
    await refreshPending();
  }, [refreshPending]);

  // Replay the queue on mount and whenever connectivity returns.
  useEffect(() => {
    void runSync();
    const onOnline = () => void runSync();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [runSync]);

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
    const meta = {
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      parentType,
      parentId,
      siteId,
      caption: caption || undefined,
      capturedAt: Date.now(),
    };
    // The upload mutation takes `file`; the local queue stores the same bytes
    // under `blob`.
    const reset = () => {
      setOpen(false);
      setCaption("");
      if (fileRef.current) fileRef.current.value = "";
    };
    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await enqueuePendingEvidence({ ...meta, blob: file });
        toast.info("Saved on device — will upload when back online.");
        reset();
      } else {
        await upload({ ...meta, file });
        toast.success("Evidence attached");
        setNonce((n) => n + 1);
        reset();
      }
      await refreshPending();
    } catch (e) {
      if (isNetworkError(e)) {
        // Never lose the bytes on a connectivity failure — queue and retry.
        await enqueuePendingEvidence({ ...meta, blob: file });
        toast.info("Network unavailable — saved on device, will upload automatically.");
        reset();
        await refreshPending();
      } else {
        toast.error(e instanceof Error ? e.message : "Upload failed");
      }
    } finally {
      setSaving(false);
    }
  };

  const total = (evidence?.length ?? 0) + pending.length;

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

      {pending.length > 0 && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <CloudOff className="size-3.5" />
          {pending.length} file{pending.length > 1 ? "s" : ""} saved on this
          device and waiting to upload.
        </p>
      )}

      {evidence === undefined ? (
        <p className="py-4 text-sm text-muted-foreground">Loading…</p>
      ) : total === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          No evidence attached yet.
          {canUpload ? " Photos, video, audio or documents (max 25MB)." : ""}
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pending.map((p) => (
            <PendingCard key={p.id} item={p} />
          ))}
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
              Files upload immediately when online. Offline, they are saved on
              this device and uploaded automatically once you reconnect. Either
              way they are stored with your identity, the site, and a timestamp.
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

function PendingCard({ item }: { item: PendingEvidence }) {
  const isImage = item.mimeType.startsWith("image/");
  return (
    <li className="border border-dashed border-border p-3">
      <div className="flex items-start gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center border border-border bg-muted/40">
          {isImage ? (
            <ImageIcon className="size-5 text-muted-foreground" />
          ) : (
            <FileText className="size-5 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{item.fileName}</span>
          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <CloudOff className="size-3" /> Queued for upload
          </span>
          {item.lastError && (
            <span className="mt-1 block text-xs text-destructive">
              {item.lastError}
            </span>
          )}
        </span>
      </div>
    </li>
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
