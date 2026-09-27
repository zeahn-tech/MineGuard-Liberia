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
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import type { Severity } from "@/lib/types";
import { AlertTriangle, CheckCircle2, Loader2, Send } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

const DAY = 86_400_000;

function severityClasses(sev: Severity): string {
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
  const obligationsQ = useQuery(api.inspections.listMyCorrectiveActions);
  const respond = useMutation(api.inspections.respondCorrectiveAction);
  const [searchParams] = useSearchParams();
  const siteFilter = searchParams.get("siteId") ?? null;

  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const all = obligationsQ ?? [];
  const obligations = siteFilter ? all.filter((o) => o.siteId === siteFilter) : all;
  const open = obligations.filter((o) => o.status === "open" || o.status === "in_progress");
  const overdue = open.filter((o) => o.dueAt < Date.now());
  const submitted = obligations.filter((o) => o.status === "submitted");

  const submitResponse = async (caId: string) => {
    if (!note.trim()) {
      toast.error("Describe the action taken before submitting.");
      return;
    }
    setBusy(true);
    try {
      await respond({ caId, operatorNote: note.trim() });
      toast.success("Response submitted for verification.");
      setRespondingId(null);
      setNote("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      toast.error(
        msg.includes("NOT_FOUND")
          ? "That obligation is no longer visible to your account."
          : msg.includes("FORBIDDEN")
            ? "Only the site's operator can respond, and only while the action is open."
            : "Could not submit the response.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
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

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <Send className="size-5 text-primary" strokeWidth={1.5} />
            <div>
              <p className="display text-2xl leading-none">{open.length}</p>
              <p className="text-xs text-muted-foreground">open — response needed</p>
            </div>
          </CardContent>
        </Card>
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <AlertTriangle
              className={`size-5 ${overdue.length > 0 ? "text-destructive" : "text-muted-foreground"}`}
              strokeWidth={1.5}
            />
            <div>
              <p className="display text-2xl leading-none">{overdue.length}</p>
              <p className="text-xs text-muted-foreground">past deadline</p>
            </div>
          </CardContent>
        </Card>
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <CheckCircle2 className="size-5 text-muted-foreground" strokeWidth={1.5} />
            <div>
              <p className="display text-2xl leading-none">{submitted.length}</p>
              <p className="text-xs text-muted-foreground">awaiting verification</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {obligationsQ === undefined && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      )}
      {obligationsQ !== undefined && obligations.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No corrective actions on your sites. Keep it that way.
        </p>
      )}

      <div className="space-y-3">
        {obligations.map((o) => {
          const isOpen = o.status === "open" || o.status === "in_progress";
          const dueMs = o.dueAt - Date.now();
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
                    }}
                  >
                    <Send className="mr-1.5 size-3.5" strokeWidth={1.5} />
                    Respond
                  </Button>
                )}
                {isOpen && respondingId === o._id && (
                  <div className="mt-2 space-y-2">
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Describe the corrective action taken…"
                      disabled={busy}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy || !note.trim()} onClick={() => void submitResponse(o._id)}>
                        {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Send className="mr-1.5 size-3.5" strokeWidth={1.5} />}
                        Submit response
                      </Button>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setRespondingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
