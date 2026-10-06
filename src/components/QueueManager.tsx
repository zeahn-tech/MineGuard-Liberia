// ---------------------------------------------------------------------------
// QUEUE MANAGER (OFF-4/OFF-5) — the human surface for everything the queues
// are holding on the device.
//
//  * INSPECT: field submissions and queued evidence files with their status
//    (pending / retrying / conflict / parked), attempt counts, errors and the
//    next automatic retry time — plus the durable-store backend (a "memory"
//    backend means nothing survives a reload and says so).
//  * RETRY: manual "retry now" that ignores backoff windows (parked
//    conflict/dead items only move through the explicit actions below).
//  * EXPORT: the full queue + drafts + local parent refs as JSON for support
//    and debugging — evidence byte payloads are described (name/size/sha256),
//    not embedded.
//  * DISCARD: per item or everything, always behind an AlertDialog
//    confirmation — dropping field data is never one accidental click.
//  * CONFLICT RESOLUTION (OFF-4): a 409 item opens a screen showing the
//    queued local response beside the server's current row; the human picks
//    "keep server" (drop mine) or "apply mine" (re-arms the row_version to
//    the server's current version and retries). Nothing auto-resolves.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  AlertTriangle,
  CloudOff,
  Download,
  FileText,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  buildQueueExport,
  discardQueueItem,
  ensureOfflineReady,
  readQueue,
  readDrafts,
  resolveConflictKeepMine,
  resolveConflictKeepServer,
  retryQueueItem,
  subscribeQueue,
  type QueueItem,
  type QueueKind,
} from "@/lib/offline-queue";
import {
  readPendingEvidence,
  removePendingEvidence,
  syncEvidenceQueue,
  type PendingEvidence,
} from "@/lib/offline-evidence";
import { storeBackend, subscribeStore, type StoreBackend } from "@/lib/offline-store";
import { syncQueue } from "@/lib/offline-queue";
import { CONFLICT_PREFIX } from "@/lib/offline-retry";

const KIND_LABEL: Record<QueueKind, string> = {
  inspectionDraft: "Inspection draft",
  inspectionSubmit: "Inspection submission",
  incidentReport: "Incident report",
  observationReport: "Observation",
  caResponse: "CA response",
};

function statusChip(item: QueueItem): { label: string; cls: string } {
  switch (item.status) {
    case "conflict":
      return { label: "conflict", cls: "border-destructive/40 text-destructive" };
    case "dead":
      return {
        label: item.failureKind === "permanent" ? "rejected" : "parked",
        cls: "border-destructive/40 text-destructive",
      };
    case "failed":
      return { label: "retrying", cls: "border-amber-500/40 text-amber-700 dark:text-amber-400" };
    case "syncing":
      return { label: "syncing", cls: "border-border text-muted-foreground" };
    default:
      return { label: "queued", cls: "border-border text-muted-foreground" };
  }
}

function payloadSummary(item: QueueItem): string {
  if (item.kind === "caResponse") return item.ca?.operatorNote ?? "";
  if (item.payload?.description) return item.payload.description;
  if (item.answers) return `${Object.keys(item.answers).length} answer(s)`;
  return "";
}

/** Parse the CONFLICT:{json} server snapshot back into display fields. */
function serverFields(item: QueueItem): Record<string, unknown> {
  return (item.serverSnapshot as Record<string, unknown> | undefined) ?? {};
}

interface ConfirmState {
  kind: "submission" | "evidence" | "all";
  id?: string;
}

export default function QueueManager({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const reportIncident = useMutation(api.records.reportIncident);
  const reportObservation = useMutation(api.records.reportObservation);
  const respondCa = useMutation(api.inspections.respondCorrectiveAction);
  const upload = useMutation(api.evidence.upload);

  const [items, setItems] = useState<QueueItem[]>([]);
  const [evidence, setEvidence] = useState<PendingEvidence[]>([]);
  const [draftCount, setDraftCount] = useState(0);
  const [backend, setBackend] = useState<StoreBackend | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [conflictItem, setConflictItem] = useState<QueueItem | null>(null);

  const refresh = useCallback(async () => {
    await ensureOfflineReady();
    setItems(readQueue());
    setDraftCount(readDrafts().length);
    setEvidence(await readPendingEvidence());
    setBackend(await storeBackend());
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const offQ = subscribeQueue(() => void refresh());
    const offS = subscribeStore(() => void refresh());
    return () => {
      offQ();
      offS();
    };
  }, [open, refresh]);

  const syncApi = {
    reportIncident,
    reportObservation,
    respondCorrectiveAction: respondCa,
  };

  const retryAll = async () => {
    setBusy(true);
    try {
      const q = await syncQueue(syncApi, { force: true });
      const e = await syncEvidenceQueue(upload, { force: true });
      const moved = q.synced + e.synced;
      const parked = q.conflicts + q.dead + e.dead;
      if (moved > 0) toast.success(`Synced ${moved} item(s)`);
      else if (parked > 0) toast.info("Nothing synced — some items need review");
      else toast.info("Nothing to sync right now");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const doDiscard = async () => {
    if (!confirm) return;
    try {
      if (confirm.kind === "submission" && confirm.id) {
        await discardQueueItem(confirm.id);
        toast.info("Submission discarded");
      } else if (confirm.kind === "evidence" && confirm.id) {
        await removePendingEvidence(confirm.id);
        toast.info("File discarded");
      } else if (confirm.kind === "all") {
        for (const it of readQueue()) await discardQueueItem(it.id);
        for (const ev of await readPendingEvidence()) await removePendingEvidence(ev.id);
        toast.info("Queue cleared");
      }
      setConflictItem(null);
    } catch (err) {
      // NotSavedError — the discard did not persist; say so instead of
      // pretending the item is gone.
      toast.error(err instanceof Error ? err.message : "Could not discard");
    } finally {
      setConfirm(null);
      await refresh();
    }
  };

  const exportJson = async () => {
    try {
      const data = await buildQueueExport();
      const blob = new Blob(
        [
          JSON.stringify(
            {
              ...data,
              evidence: evidence.map((e) => ({
                id: e.id,
                parentType: e.parentType,
                parentId: e.parentId,
                parentRef: e.parentRef,
                fileName: e.fileName,
                mimeType: e.mimeType,
                sizeBytes: e.blob?.size ?? 0,
                sha256: e.sha256,
                attempts: e.attempts,
                status: e.status,
                lastError: e.lastError,
                createdAt: new Date(e.createdAt).toISOString(),
              })),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mineguard-queue-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Queue exported as JSON");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  };

  const active = items.filter((q) => q.status !== "done");
  const conflicts = active.filter((q) => q.status === "conflict");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="paper max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Offline queue</DialogTitle>
            <DialogDescription>
              Everything saved on this device, its sync state, and what happens
              next. Nothing here is dropped automatically.
            </DialogDescription>
          </DialogHeader>

          {backend === "memory" && (
            <p className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              Persistent storage is unavailable in this browser session — queued
              items will be LOST when the tab closes. Export before closing.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void retryAll()} disabled={busy}>
              <RefreshCw className={`mr-1.5 size-3.5 ${busy ? "animate-spin" : ""}`} />
              Sync now
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportJson()}>
              <Download className="mr-1.5 size-3.5" /> Export JSON
            </Button>
            {active.length + evidence.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => setConfirm({ kind: "all" })}
              >
                <Trash2 className="mr-1.5 size-3.5" /> Discard all
              </Button>
            )}
          </div>

          <section>
            <h3 className="kicker mb-2">
              Field submissions ({active.length})
              {draftCount > 0 ? ` · drafts (${draftCount})` : ""}
            </h3>
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing waiting — all submissions are synced.
              </p>
            ) : (
              <ul className="divide-y divide-border border border-border">
                {active.map((item) => {
                  const chip = statusChip(item);
                  return (
                    <li key={item.id} className="space-y-1.5 p-2.5 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm">
                          {KIND_LABEL[item.kind] ?? item.kind}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {item.siteCode}
                        </span>
                        <span className={`stamp border px-1.5 py-0.5 text-[10px] ${chip.cls}`}>
                          {chip.label}
                        </span>
                        <span className="ml-auto flex items-center gap-1.5">
                          {item.status === "conflict" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => setConflictItem(item)}
                            >
                              Resolve…
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px]"
                              disabled={busy}
                              onClick={() =>
                                void (async () => {
                                  await retryQueueItem(item.id);
                                  await retryAll();
                                })()
                              }
                            >
                              Retry
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px] text-destructive"
                            onClick={() => setConfirm({ kind: "submission", id: item.id })}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </span>
                      </div>
                      {payloadSummary(item) && (
                        <p className="line-clamp-2 text-muted-foreground">
                          {payloadSummary(item)}
                        </p>
                      )}
                      <p className="text-muted-foreground">
                        attempt {item.attempts}
                        {item.nextRetryAt && item.status !== "conflict" && item.status !== "dead"
                          ? ` · next automatic retry ${new Date(item.nextRetryAt).toLocaleTimeString()}`
                          : ""}
                        {item.status === "dead"
                          ? item.failureKind === "permanent"
                            ? " · the server rejected this — it will not be retried automatically"
                            : " · parked after repeated failures — retry manually or discard"
                          : ""}
                      </p>
                      {item.lastError && (
                        <p className="break-all text-destructive">{item.lastError}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="kicker mb-2">Evidence files ({evidence.length})</h3>
            {evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">No files waiting to upload.</p>
            ) : (
              <ul className="divide-y divide-border border border-border">
                {evidence.map((ev) => (
                  <li key={ev.id} className="flex items-start gap-2 p-2.5 text-xs">
                    <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{ev.fileName}</p>
                      <p className="text-muted-foreground">
                        {ev.parentType}
                        {ev.parentRef && !ev.parentId ? " (waiting for its parent to sync)" : ""} ·{" "}
                        {ev.attempts} attempt(s)
                        {ev.nextRetryAt
                          ? ` · next retry ${new Date(ev.nextRetryAt).toLocaleTimeString()}`
                          : ""}
                      </p>
                      {ev.sha256 && (
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          sha256 {ev.sha256.slice(0, 16)}…
                        </p>
                      )}
                      {ev.lastError && <p className="text-destructive">{ev.lastError}</p>}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px] text-destructive"
                      onClick={() => setConfirm({ kind: "evidence", id: ev.id })}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {evidence.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      const r = await syncEvidenceQueue(upload, { force: true });
                      if (r.synced > 0) toast.success(`Uploaded ${r.synced} file(s)`);
                      else toast.info("No files uploaded");
                    } finally {
                      setBusy(false);
                      await refresh();
                    }
                  })()
                }
              >
                <CloudOff className="mr-1.5 size-3.5" /> Upload files now
              </Button>
            )}
          </section>
        </DialogContent>
      </Dialog>

      {/* HUMAN CONFLICT RESOLUTION (OFF-4): local attempt beside the server's
          current row — keep server, or apply mine over the version shown. */}
      <Dialog
        open={conflictItem !== null}
        onOpenChange={(v) => {
          if (!v) setConflictItem(null);
        }}
      >
        <DialogContent className="paper">
          <DialogHeader>
            <DialogTitle>Resolve sync conflict</DialogTitle>
            <DialogDescription>
              Someone changed this record on the server after you started your
              response. Your version was NOT sent. Choose which one should
              stand — nothing is overwritten until you pick.
            </DialogDescription>
          </DialogHeader>
          {conflictItem && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border border-border p-3">
                <p className="kicker mb-1">Your queued response</p>
                <p className="whitespace-pre-wrap text-sm">
                  {conflictItem.ca?.operatorNote ?? payloadSummary(conflictItem)}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  prepared {new Date(conflictItem.createdAt).toLocaleString()} ·{" "}
                  {conflictItem.attempts} attempt(s)
                </p>
              </div>
              <div className="border border-destructive/40 p-3">
                <p className="kicker mb-1 text-destructive">Server has now</p>
                <dl className="space-y-1 text-sm">
                  {Object.entries(serverFields(conflictItem)).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="truncate text-right">
                        {v === null || v === "" ? "—" : String(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          )}
          <DialogHeader>
            <DialogTitle className="text-base">What should happen?</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              onClick={() =>
                void (async () => {
                  if (!conflictItem) return;
                  await resolveConflictKeepServer(conflictItem.id);
                  toast.info("Kept the server version — your local response was discarded.");
                  setConflictItem(null);
                  await refresh();
                })()
              }
            >
              Keep server version
            </Button>
            <Button
              onClick={() =>
                void (async () => {
                  if (!conflictItem) return;
                  await resolveConflictKeepMine(conflictItem.id);
                  toast.success("Will re-apply your response over the version shown.");
                  setConflictItem(null);
                  await refresh();
                })()
              }
            >
              Apply my version
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(v) => {
          if (!v) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "all" ? "Discard everything queued?" : "Discard this item?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "all"
                ? "All queued submissions, drafts and evidence bytes on this device will be deleted. This cannot be undone."
                : "The queued data on this device will be deleted. If it has not synced yet, it will never reach the server. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doDiscard()}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Small header button both portals embed (staff + operator parity, OFF-5). */
export function QueueManagerButton({
  label,
  onOpened,
}: {
  label?: string;
  onOpened?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        onClick={() => {
          setOpen(true);
          onOpened?.();
        }}
      >
        {label ?? "Queue"}
      </Button>
      <QueueManager open={open} onOpenChange={setOpen} />
    </>
  );
}

// CONFLICT_PREFIX is re-exported so consumers can detect a conflict message
// without importing the retry module directly.
export { CONFLICT_PREFIX };
