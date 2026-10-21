// ---------------------------------------------------------------------------
// EVIDENCE SECTION (doc 07 — evidence/media architecture; §10 camera + batch)
//
// Reusable attach-photos/files UI for a parent record (inspection, incident,
// observation). Notes:
//  - CAMERA CAPTURE (§10): a real getUserMedia viewfinder (CameraCapture)
//    with shutter/retake/switch and a capture="environment" file-input
//    fallback where the API or permission is unavailable. Captured frames
//    join the batch exactly like picked files — same upload, same queue,
//    same guarantees.
//  - BATCH UPLOAD WITH PER-FILE BYTE PROGRESS (§10): every file uploads
//    through the XHR wire path (uploadWithProgress) whose progress events
//    drive a real per-file progress bar — no polling, no fake progress.
//    Files that must be queued (offline) show "saved on device" instead:
//    there is no progress to report for bytes resting on the phone, and
//    pretending otherwise would be a fabricated indicator.
//  - NEVER SILENTLY DROP: bytes must reach Storage before the metadata row
//    exists, so an upload that cannot complete while offline is queued
//    locally (IndexedDB via offline-evidence.ts) and replayed when
//    connectivity returns; a network-class failure mid-batch is queued the
//    same way. A device-local URI is never a permanent media reference.
//  - Authorization is server-enforced: the data layer lists only evidence in
//    the caller's scope and the upload path re-derives site visibility.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useLatest } from "@/lib/use-latest";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CameraCapture, {
  type CameraCaptureResult,
} from "@/components/CameraCapture";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Camera,
  CloudOff,
  ExternalLink,
  FileText,
  ImageIcon,
  Loader2,
  Paperclip,
  RefreshCw,
  Upload,
} from "lucide-react";
import type { Evidence } from "@/lib/types";
import {
  enqueuePendingEvidence,
  readPendingEvidenceForParent,
  syncEvidenceQueue,
  type PendingEvidence,
} from "@/lib/offline-evidence";
import { sha256Hex } from "@/lib/sha256";

const MAX_BYTES = 25 * 1024 * 1024; // mirrored in rules + data layer

/** Per-file progress row inside the attach dialog. `loaded/total` exist only
 *  while uploading (byte progress from the XHR wire path). */
type BatchStatus = "pending" | "uploading" | "done" | "queued" | "failed";
interface BatchItem {
  key: string;
  name: string;
  status: BatchStatus;
  note?: string;
  loaded?: number;
  total?: number;
}

const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  pending: "Waiting…",
  uploading: "Uploading…",
  done: "Uploaded",
  queued: "Saved on device",
  failed: "Failed",
};

/** True when a failure looks like a connectivity problem (retryable) rather
 *  than a policy denial (storage/unauthorized) — only the former is queued. */
function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    return true;
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
  /** Omitted for site-less community_report attachments (migration 0013). */
  siteId?: string;
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
  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Upload is available to any assigned account (staff or operator on their
  // own site); the backend + rules re-derive scope. Guests never have a role.
  const canUpload = !!user?.role;

  const refreshPending = useCallback(
    () => readPendingEvidenceForParent(parentType, parentId).then(setPending),
    [parentType, parentId],
  );

  // Keep the latest upload mutation without making the sync effect depend on a
  // freshly-created function each render (which would re-run the effect).
  const uploadRef = useLatest(upload);

  // Replay the queue on mount and whenever connectivity returns. The routine
  // lives inside the effect so a late result after unmount is dropped
  // instead of updating an unmounted component.
  useEffect(() => {
    let cancelled = false;
    const runSync = async () => {
      try {
        const { synced } = await syncEvidenceQueue((a) => uploadRef.current(a));
        if (synced > 0 && !cancelled) {
          toast.success(
            `Uploaded ${synced} queued evidence file${synced > 1 ? "s" : ""}`,
          );
          setNonce((n) => n + 1);
        }
      } catch {
        /* sync is best-effort; items remain queued */
      }
      if (!cancelled) await refreshPending();
    };
    void runSync();
    const onOnline = () => void runSync();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
  }, [refreshPending, uploadRef]);

  const resetDialog = useCallback(() => {
    setOpen(false);
    setShowCamera(false);
    setBatch([]);
    setCaption("");
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  /** A camera frame joins the batch exactly like a picked file. */
  const onCameraCaptured = (result: CameraCaptureResult) => {
    const asFile = new File([result.blob], result.fileName, {
      type: result.mimeType,
    });
    setBatch((prev) => [
      ...prev,
      {
        key: `cam-${Date.now()}-${result.fileName}`,
        name: result.fileName,
        status: asFile.size > MAX_BYTES ? "failed" : "pending",
        note: asFile.size > MAX_BYTES ? "Exceeds 25MB" : undefined,
      },
    ]);
    pendingFilesRef.current.push(asFile);
    toast.success("Photo captured — added to the batch.");
  };

  // Files waiting to upload: picked files (read once at Upload time) plus
  // camera captures accumulated since the dialog opened.
  const pendingFilesRef = useRef<File[]>([]);

  const onUpload = async () => {
    if (saving) return;
    const files: File[] = [
      ...Array.from(fileRef.current?.files ?? []),
      ...pendingFilesRef.current,
    ];
    if (files.length === 0) {
      toast.error("Choose at least one file first.");
      return;
    }
    // Build the progress rows up front so oversized files show their failure
    // inline instead of aborting the whole batch.
    const items: BatchItem[] = files.map((f, i) => ({
      key: `${i}-${f.name}-${f.size}`,
      name: f.name,
      status: f.size > MAX_BYTES ? "failed" : "pending",
      note: f.size > MAX_BYTES ? "Exceeds 25MB" : undefined,
    }));
    setBatch(items);
    setSaving(true);

    const setStatus = (key: string, status: BatchStatus, note?: string) =>
      setBatch((prev) =>
        prev.map((b) => (b.key === key ? { ...b, status, note } : b)),
      );
    const setProgress = (key: string, loaded: number, total: number) =>
      setBatch((prev) =>
        prev.map((b) => (b.key === key ? { ...b, loaded, total } : b)),
      );

    const capturedAt = Date.now();
    let uploaded = 0;
    let queued = 0;
    let failed = items.filter((i) => i.status === "failed").length;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const item = items[i];
      if (item.status === "failed") continue; // oversized — already marked
      setStatus(item.key, "uploading");
      const meta = {
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        parentType,
        parentId,
        siteId,
        caption: caption || undefined,
        capturedAt,
      };
      try {
        // EVD-1: hash before send — the queue records the digest, the data
        // layer re-hashes and refuses a mismatch.
        const digest = await sha256Hex(file);
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          // The upload mutation takes `file`; the queue stores bytes as `blob`.
          await enqueuePendingEvidence({
            ...meta,
            blob: file,
            sha256: digest ?? undefined,
          });
          setStatus(item.key, "queued");
          queued++;
        } else {
          await upload({
            ...meta,
            sha256: digest ?? undefined,
            file,
            onProgress: (p: { loaded: number; total: number }) =>
              setProgress(item.key, p.loaded, p.total),
          });
          setStatus(item.key, "done");
          uploaded++;
        }
      } catch (e) {
        if (isNetworkError(e)) {
          // Never lose the bytes on a connectivity failure — queue and retry.
          // If the QUEUE itself cannot persist (quota), this rejects too and
          // the file is marked failed — never reported as saved (OFF-2).
          try {
            const digest = await sha256Hex(file);
            await enqueuePendingEvidence({
              ...meta,
              blob: file,
              sha256: digest ?? undefined,
            });
            setStatus(item.key, "queued");
            queued++;
          } catch (qErr) {
            setStatus(
              item.key,
              "failed",
              qErr instanceof Error ? qErr.message : "Not saved on this device",
            );
            failed++;
          }
        } else {
          setStatus(
            item.key,
            "failed",
            e instanceof Error ? e.message : "Upload failed",
          );
          failed++;
        }
      }
    }

    if (uploaded > 0) setNonce((n) => n + 1);
    await refreshPending();

    if (uploaded > 0 && queued === 0 && failed === 0) {
      toast.success(`${uploaded} file${uploaded > 1 ? "s" : ""} attached`);
    } else if (uploaded > 0 || queued > 0) {
      toast.info(
        `${uploaded} uploaded, ${queued} saved on device` +
          (failed > 0 ? `, ${failed} failed` : ""),
      );
    } else {
      toast.error("Upload failed — see the per-file errors above.");
    }

    // Clear the inputs so a follow-up selection starts fresh; the progress
    // rows stay visible until the dialog is closed.
    if (fileRef.current) fileRef.current.value = "";
    pendingFilesRef.current = [];
    setSaving(false);
  };

  const batchRunning =
    saving ||
    batch.some((b) => b.status === "pending" || b.status === "uploading");
  const batchFinished = batch.length > 0 && !batchRunning;

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
        <ListLoading onRetry={() => setNonce((n) => n + 1)} />
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

      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) resetDialog();
          else setOpen(true);
        }}
      >
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
              <Label>Files (max 25MB each)</Label>
              <Input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,video/*,audio/*,.pdf,.doc,.docx"
                disabled={batchRunning}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Camera</Label>
              {showCamera ? (
                <CameraCapture
                  onCaptured={onCameraCaptured}
                  onClose={() => setShowCamera(false)}
                />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={batchRunning}
                  onClick={() => setShowCamera(true)}
                >
                  <Camera className="mr-1.5 size-4" strokeWidth={1.5} />
                  Take a photo
                </Button>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Caption (optional — applies to every selected file)</Label>
              <Input
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="What does this show?"
                disabled={batchRunning}
              />
            </div>
            {batch.length > 0 && (
              <ul className="max-h-44 divide-y divide-border overflow-y-auto border border-border">
                {batch.map((b) => (
                  <li
                    key={b.key}
                    className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs"
                  >
                    <span className="min-w-0 truncate">{b.name}</span>
                    <span
                      className={
                        b.status === "done"
                          ? "shrink-0 text-emerald-600 dark:text-emerald-400"
                          : b.status === "failed"
                            ? "shrink-0 text-destructive"
                            : b.status === "queued"
                              ? "shrink-0 text-amber-600 dark:text-amber-400"
                              : "shrink-0 text-muted-foreground"
                      }
                      title={b.note}
                    >
                      {b.note ?? BATCH_STATUS_LABEL[b.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {/* Per-file BYTE progress bars (§10) — each bar tracks exactly one
                file's real XHR progress events; queued/failed files carry no
                bar because there are no bytes in flight for them. */}
            {batch.some((b) => b.status === "uploading" && b.total) && (
              <div className="space-y-1.5">
                {batch
                  .filter((b) => b.status === "uploading" && b.total)
                  .map((b) => {
                    const pct = Math.min(
                      100,
                      Math.round(((b.loaded ?? 0) / (b.total ?? 1)) * 100),
                    );
                    return (
                      <div key={`p-${b.key}`}>
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span className="truncate">{b.name}</span>
                          <span>
                            {pct}% · {((b.loaded ?? 0) / 1024).toFixed(0)}/
                            {((b.total ?? 0) / 1024).toFixed(0)} KB
                          </span>
                        </div>
                        <div className="h-1 overflow-hidden rounded bg-muted">
                          <div
                            className="h-full bg-primary transition-[width] duration-150"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
          <DialogFooter>
            {/* While a batch is in flight neither button is actionable: closing
                mid-upload would orphan the progress rows, and a second Upload
                click would double-send the same files. */}
            <Button
              variant="outline"
              onClick={resetDialog}
              disabled={batchRunning}
            >
              {batchFinished ? "Close" : "Cancel"}
            </Button>
            <Button
              onClick={batchFinished ? resetDialog : onUpload}
              disabled={batchRunning}
            >
              {batchFinished
                ? "Done"
                : saving
                  ? `Uploading…${batch.length > 1 ? ` (${batch.filter((b) => b.status === "done").length}/${batch.length})` : ""}`
                  : "Upload"}
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
          <span className="block truncate text-sm font-medium">
            {item.fileName}
          </span>
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

/** "Loading…" that cannot spin forever: after STALL_MS it says so and offers
 *  a retry (a fresh scoped read) instead of leaving the person guessing. */
const STALL_MS = 15_000;
function ListLoading({ onRetry }: { onRetry: () => void }) {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setStalled(true), STALL_MS);
    return () => window.clearTimeout(t);
  }, []);
  if (!stalled)
    return (
      <p
        className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );
  return (
    <div className="py-4 text-sm text-muted-foreground" role="alert">
      <p>Evidence is taking too long to load. Check your connection.</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={onRetry}
      >
        <RefreshCw className="size-3.5" /> Try again
      </Button>
    </div>
  );
}

const URL_TTL_MS = 100_000; // signed links live 120 s server-side; refresh before that
const MINT_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error("TIMEOUT")), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** At most MAX_MINTS link requests in flight at once: a screen with many
 *  attachments used to fire them all together and starve the connection. */
const MAX_MINTS = 3;
let activeMints = 0;
const mintQueue: Array<() => void> = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (activeMints >= MAX_MINTS)
    await new Promise<void>((go) => mintQueue.push(go));
  activeMints++;
  try {
    return await work();
  } finally {
    activeMints--;
    mintQueue.shift()?.();
  }
}

function friendlyReason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === "TIMEOUT") return "The server did not respond in time.";
  if (m.includes("NOT_FOUND"))
    return "This file was not found, or your account cannot open it.";
  if (m.includes("UNAUTHENTICATED"))
    return "You are signed out. Sign in again.";
  return m.replace(/^Error:\s*/, "").slice(0, 200);
}

type Minted = { url: string; at: number };

function EvidenceCard({ ev }: { ev: Evidence }) {
  const getUrl = useMutation(api.evidence.getUrl);
  const getUrlRef = useLatest(getUrl);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [mediaFailed, setMediaFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reason, setReason] = useState<string | null>(null);

  const isImage = ev.mimeType.startsWith("image/");
  const isVideo = ev.mimeType.startsWith("video/");
  const isAudio = ev.mimeType.startsWith("audio/");
  const previewable = isImage || isVideo || isAudio;
  const retry = () => {
    setState("loading");
    setMediaFailed(false);
    setAttempt((n) => n + 1);
  };

  // Returns the link, or the reason there is none (state is set by the callers,
  // inside promise callbacks).
  const mint = useCallback(async (): Promise<{
    url: string | null;
    why: string | null;
  }> => {
    try {
      const u = await limited(() =>
        withTimeout(getUrlRef.current(ev._id), MINT_TIMEOUT_MS),
      );
      if (!u)
        return { url: null, why: "The server returned no link for this file." };
      setMinted({ url: u, at: Date.now() });
      return { url: u, why: null };
    } catch (e) {
      return { url: null, why: friendlyReason(e) };
    }
  }, [ev._id, getUrlRef]);

  // Mint a signed link as soon as the card appears so the preview shows
  // without a tap. Always ends in "ready" or "error" — never an endless spinner.
  useEffect(() => {
    let cancelled = false;
    // A retry that fails instantly looks like a dead button; hold the busy
    // state briefly so the person SEES it try again.
    const minBusy =
      attempt > 0 ? new Promise((r) => setTimeout(r, 700)) : Promise.resolve();
    void Promise.all([mint(), minBusy]).then(([r]) => {
      if (cancelled) return;
      setReason(r.why);
      setState(r.url ? "ready" : "error");
    });
    return () => {
      cancelled = true;
    };
  }, [mint, attempt]);

  // Links expire after ~2 minutes: re-mint on demand rather than reuse a dead one.
  const openFile = async () => {
    let url = minted && Date.now() - minted.at < URL_TTL_MS ? minted.url : null;
    if (!url) {
      setState("loading");
      const r = await mint();
      url = r.url;
      setReason(r.why);
      setState(url ? "ready" : "error");
    }
    if (!url) {
      toast.error("File unavailable (access denied, missing or offline).");
      return;
    }
    // Same-tab navigation target via a real anchor click: unlike window.open
    // after an await, mobile browsers do not treat this as a blocked popup.
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const url = minted?.url ?? null;
  const caption = ev.caption ?? ev.fileName;
  return (
    <li className="border border-border p-3">
      {previewable && (
        <div className="mb-3 overflow-hidden border border-border bg-muted/40">
          {state === "loading" && (
            <div
              className="flex h-32 items-center justify-center text-xs text-muted-foreground"
              role="status"
            >
              <Loader2 className="mr-2 size-4 animate-spin" /> Loading preview…
            </div>
          )}
          {state === "error" && (
            <div
              className="flex h-32 flex-col items-center justify-center gap-2 text-xs text-muted-foreground"
              role="alert"
            >
              <span className="px-3 text-center">
                Couldn&apos;t load this file.
                {reason && (
                  <span className="mt-1 block break-words font-mono text-[11px]">
                    {reason}
                  </span>
                )}
                {attempt > 0 && (
                  <span className="mt-1 block">Tried {attempt + 1} times.</span>
                )}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => retry()}
              >
                <RefreshCw className="size-3.5" /> Try again
              </Button>
            </div>
          )}
          {state === "ready" && url && !mediaFailed && isImage && (
            <img
              src={url}
              alt={caption}
              loading="lazy"
              onError={() => setMediaFailed(true)}
              className="max-h-72 w-full object-contain"
            />
          )}
          {state === "ready" && url && !mediaFailed && isVideo && (
            <video
              src={url}
              controls
              playsInline
              preload="metadata"
              onError={() => setMediaFailed(true)}
              className="max-h-72 w-full"
            />
          )}
          {state === "ready" && url && !mediaFailed && isAudio && (
            <audio
              src={url}
              controls
              preload="metadata"
              onError={() => setMediaFailed(true)}
              className="w-full"
            />
          )}
          {state === "ready" && mediaFailed && (
            <div
              className="flex h-24 flex-col items-center justify-center gap-2 text-xs text-muted-foreground"
              role="alert"
            >
              <span>This file can&apos;t be previewed here.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => retry()}
              >
                <RefreshCw className="size-3.5" /> Reload
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="flex items-start gap-3">
        {!previewable && (
          <span className="flex size-12 shrink-0 items-center justify-center border border-border bg-muted/40">
            {isImage ? (
              <ImageIcon className="size-5 text-muted-foreground" />
            ) : (
              <FileText className="size-5 text-muted-foreground" />
            )}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void openFile()}
          title="Open evidence file"
        >
          <ExternalLink className="size-3.5" /> Open
        </Button>
      </div>
    </li>
  );
}
