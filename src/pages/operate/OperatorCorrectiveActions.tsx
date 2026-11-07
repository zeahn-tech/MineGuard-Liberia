// ---------------------------------------------------------------------------
// OPERATOR CORRECTIVE ACTIONS — the operator's compliance obligations and the
// respond flow. One response per action (open → submitted, guard-enforced);
// the reviewing authority verifies and closes. The respond mutation
// re-derives operator + tenant server-side and writes the audit row.
// ---------------------------------------------------------------------------

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import type { Severity } from "@/lib/types";
import { AlertTriangle, CheckCircle2, Download, FileCheck2, Loader2, Send, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  COMPLIANCE_EXPORT_COLUMNS,
  downloadFile,
  streamCsvFile,
} from "@/lib/export-csv";
import EvidenceSection from "@/components/EvidenceSection";
import {
  enqueueCaResponse,
  newClientRef,
} from "@/lib/offline-queue";
import { useNow } from "@/hooks/use-now";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { useCaAccess } from "@/hooks/use-ca-access";
import { caCounts, findingsAwaitingAction, isRespondable } from "@/lib/corrective-actions";
import { Link } from "react-router";
import { FieldError } from "@/components/ui/field";
import { toastSuccess } from "@/lib/feedback";
import { focusField } from "@/lib/validation";

const DAY = 86_400_000;

function severityClasses(sev: string | Severity | undefined): string {
  switch (sev) {
    case "critical":
      return "bg-destructive/15 text-destructive border-destructive/30";
    case "high":
      return "bg-destructive/10 text-destructive border-destructive/25";
    case "medium":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

export default function OperatorCorrectiveActions() {
  const access = useCaAccess();
  if (access === "loading") return <div className="p-4 md:p-6"><PageLoading shape="list" label="corrective actions" /></div>;
  if (access === "denied") {
    return (
      <div className="p-4 md:p-6">
        <EmptyState
          icon={ShieldAlert}
          title="Corrective actions are for site managers and safety officers"
          why="Responding to a corrective action is a compliance act, so it is limited to the people who run safety on your sites. Ask your company administrator if you need that role."
        />
      </div>
    );
  }
  return <CorrectiveActionsBody />;
}

function CorrectiveActionsBody() {
  const now = useNow();
  const obligationsQ = useQuery(api.inspections.listMyCorrectiveActions);
  const findingsQ = useQuery(api.inspections.listMyFindings);
  const respond = useMutation(api.inspections.respondCorrectiveAction);
  const [searchParams] = useSearchParams();
  const siteFilter = searchParams.get("siteId") ?? null;

  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const all = obligationsQ ?? [];
  const obligations = siteFilter ? all.filter((o) => o.siteId === siteFilter) : all;
  const counts = caCounts(obligations, now);
  const siteFindings = (findingsQ ?? []).filter((f) => !siteFilter || f.siteId === siteFilter);
  const unanswered = findingsAwaitingAction(siteFindings, all);

  const submitResponse = async (caId: string) => {
    if (!note.trim()) {
      setNoteError("Describe what was done to address this action — for example, what was repaired or changed, and when.");
      focusField(`ca-note-${caId}`);
      return;
    }
    setNoteError(undefined);
    const obligation = obligations.find((o) => o._id === caId);
    setBusy(true);
    try {
      // row_version gate (OFF-4): the server refuses with CONFLICT if the
      // reviewing authority changed this action after we loaded it.
      await respond({
        caId,
        operatorNote: note.trim(),
        expectedRowVersion: obligation?.rowVersion,
      });
      toastSuccess({
        title: "Response submitted.",
        reassure: "It is now with the reviewing authority for verification — the status updates on this card.",
      });
      setRespondingId(null);
      setNote("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.startsWith("CONFLICT:")) {
        toast.error(
          "This action changed on the server after you opened it — your response was NOT sent. The card refreshed; re-read it and submit again if your response still applies.",
        );
        setRespondingId(null);
        setNote("");
      } else if (msg.includes("NOT_FOUND")) {
        toast.error("That obligation is no longer visible to your account.");
      } else if (msg.includes("FORBIDDEN_ROLE")) {
        toast.error("Only site managers and safety officers can respond to corrective actions.");
      } else if (msg.includes("FORBIDDEN")) {
        toast.error(
          "This action can no longer be answered by your company — it may have been escalated or already answered. Refresh to see its current state.",
        );
      } else if (!navigator.onLine || msg.includes("Failed to fetch")) {
        // OFFLINE PATH (operator parity): persist the response to the device
        // queue; the scheduler submits it on reconnect with the same
        // row_version, so a concurrent change still lands as a resolvable
        // conflict instead of a silent overwrite.
        try {
          await enqueueCaResponse({
            clientRef: newClientRef(),
            siteId: obligation?.siteId ?? "",
            siteCode: obligation?.siteCode ?? "",
            caId,
            operatorNote: note.trim(),
            expectedRowVersion: obligation?.rowVersion,
          });
        } catch (e) {
          toast.error(
            `NOT saved on this device — ${e instanceof Error ? e.message : "storage unavailable"}`,
          );
          return;
        }
        toast.info(
          "You appear to be offline — the response is saved on this device and will submit automatically.",
        );
        setRespondingId(null);
        setNote("");
      } else {
        toast.error("Could not submit the response.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-col gap-2">
        <div>
          <p className="kicker">Operator portal</p>
          <h1 className="display text-2xl">Corrective actions</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Opened by inspectors after findings on your sites. Respond with what
            your crew did — once per action; the reviewing authority verifies and
            closes it. Deadlines are binding; overdue actions are visible to the
            oversight authority.
          </p>
        </div>
        <div className="flex justify-start">
          <Button
            variant="outline"
            size="sm"
            disabled={obligationsQ === undefined || obligations.length === 0}
            onClick={() => {
              // Export STREAMS the caller-scoped compliance pages (§9 + SEC-4:
              // no unscoped path — the row source IS the caller's RLS
              // visibility — and no whole-table buffer). Byte-identical File
              // as before.
              toast.promise(
                (async () => {
                  const file = await streamCsvFile(
                    api.exports.streamCompliance(),
                    COMPLIANCE_EXPORT_COLUMNS,
                    "compliance",
                  );
                  downloadFile(file);
                  return file.name;
                })(),
                {
                  loading: "Exporting…",
                  success: (name) => `Exported ${String(name)}.`,
                  error: (e) => (e instanceof Error ? e.message : "Export failed"),
                },
              );
            }}
          >
            <Download className="size-4" /> Export CSV
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <Send className="size-5 text-primary" strokeWidth={1.5} />
            <div>
              <p className="display text-2xl leading-none">{counts.needsResponse}</p>
              <p className="text-xs text-muted-foreground">open — response needed</p>
            </div>
          </CardContent>
        </Card>
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <AlertTriangle
              className={`size-5 ${counts.overdue > 0 ? "text-destructive" : "text-muted-foreground"}`}
              strokeWidth={1.5}
            />
            <div>
              <p className="display text-2xl leading-none">{counts.overdue}</p>
              <p className="text-xs text-muted-foreground">past deadline{counts.escalated > 0 ? ` (${counts.escalated} escalated)` : ""}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <CheckCircle2 className="size-5 text-muted-foreground" strokeWidth={1.5} />
            <div>
              <p className="display text-2xl leading-none">{counts.awaitingVerification}</p>
              <p className="text-xs text-muted-foreground">awaiting verification</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {obligationsQ === undefined && (
        <PageLoading shape="list" label="corrective actions" />
      )}
      {obligationsQ !== undefined && obligations.length === 0 && unanswered.length === 0 && (
        <EmptyState
          icon={CheckCircle2}
          title="No corrective actions on your sites"
          why="Corrective actions appear here when the reviewing authority opens one for a finding on your sites."
        />
      )}

      {/* Findings the authority has not turned into a corrective action yet:
          without this the page looked empty while findings existed. */}
      {unanswered.length > 0 && (
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="space-y-2 pt-4">
            <div className="flex items-start gap-2">
              <FileCheck2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {unanswered.length} finding{unanswered.length === 1 ? "" : "s"} waiting for a corrective action
                </p>
                <p className="text-xs text-muted-foreground">
                  The reviewing authority has recorded these but has not opened a corrective action yet, so there is
                  nothing to respond to. A Respond button appears here as soon as one is opened.
                </p>
              </div>
            </div>
            <ul className="divide-y divide-border text-sm">
              {unanswered.map((f) => (
                <li key={f._id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${severityClasses(f.severity)}`}>
                    {f.severity}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{f.title}</span>
                  <span className="text-xs text-muted-foreground">{f.siteCode} {f.siteName}</span>
                </li>
              ))}
            </ul>
            <Link to="/operate/findings" className="inline-block text-xs text-primary underline-offset-4 hover:underline">
              View all findings →
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {obligations.map((o) => {
          const isOpen = isRespondable(o.status);
          const dueMs = o.dueAt - now;
          const overdueNow = isOpen && dueMs < 0;
          return (
            <Card key={o._id} className="paper rounded-none border-border shadow-none">
              <CardContent className="pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${severityClasses(o.findingSeverity)}`}
                  >
                    {o.findingSeverity}
                  </span>
                  <span className="text-sm font-medium">{o.findingTitle}</span>
                  <span className="text-xs text-muted-foreground">
                    · {o.siteCode} {o.siteName}, {o.county}
                  </span>
                  <span
                    className={`ml-auto text-xs ${overdueNow ? "font-medium text-destructive" : "text-muted-foreground"}`}
                  >
                    {o.status === "submitted"
                      ? "Submitted — awaiting verification"
                      : o.status === "verified" || o.status === "closed"
                        ? "Closed by reviewer"
                        : o.status === "escalated"
                          ? "Escalated"
                          : overdueNow
                            ? `Overdue by ${Math.ceil(-dueMs / DAY)} day(s)`
                            : `Due in ${Math.max(0, Math.ceil(dueMs / DAY))} day(s)`}
                  </span>
                </div>
                <p className="mt-1 text-sm">{o.description}</p>
                {o.operatorNote && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your response: “{o.operatorNote}”
                  </p>
                )}
                {isOpen && respondingId !== o._id && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={busy}
                    onClick={() => {
                      setRespondingId(o._id);
                      setNote("");
                      setNoteError(undefined);
                    }}
                  >
                    <Send className="mr-1.5 size-3.5" strokeWidth={1.5} />
                    Respond
                  </Button>
                )}
                {isOpen && respondingId === o._id && (
                  <div className="mt-2 space-y-2">
                    <Input
                      id={`ca-note-${o._id}`}
                      value={note}
                      onChange={(e) => {
                        setNote(e.target.value);
                        if (noteError) setNoteError(e.target.value.trim() ? undefined : noteError);
                      }}
                      placeholder="Describe the corrective action taken…"
                      aria-invalid={noteError ? true : undefined}
                      aria-describedby={noteError ? `ca-note-${o._id}-error` : undefined}
                      disabled={busy}
                    />
                    {noteError && <FieldError id={`ca-note-${o._id}-error`}>{noteError}</FieldError>}
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy} onClick={() => void submitResponse(o._id)}>
                        {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Send className="mr-1.5 size-3.5" strokeWidth={1.5} />}
                        Submit response
                      </Button>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setRespondingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {/* Operator document upload on the CA response (EVD-1):
                    supporting files attach to the corrective action itself —
                    queued bytes survive offline and replay with the same
                    guarantees as every other evidence capture. */}
                <div className="mt-3">
                  <EvidenceSection
                    parentType="corrective_action"
                    parentId={o._id}
                    siteId={o.siteId}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
