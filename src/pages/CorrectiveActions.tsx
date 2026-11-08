// ---------------------------------------------------------------------------
// MINISTRY CORRECTIVE ACTIONS — every corrective action in the signed-in
// staff member's scope (RLS decides the scope; national staff see all, county
// inspectors their county). Supervisors and administrators verify, close and
// escalate what companies have answered; inspectors follow progress read-only
// (they open actions from the inspection itself).
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, ClipboardCheck, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageLoading } from "@/components/PageLoading";
import { api } from "@/lib/backend";
import { useMutation, useQuery } from "@/lib/backend-react";
import { useAuth } from "@/hooks/use-auth";
import { useNow } from "@/hooks/use-now";
import { toastError, toastSuccess } from "@/lib/feedback";
import { caCounts, isOutstanding } from "@/lib/corrective-actions";
import type { CorrectiveAction } from "@/lib/types";

type Status = CorrectiveAction["status"];
type Filter = "active" | "awaiting" | "overdue" | "escalated" | "done" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "active", label: "Needs attention" },
  { key: "awaiting", label: "Awaiting verification" },
  { key: "overdue", label: "Overdue" },
  { key: "escalated", label: "Escalated" },
  { key: "done", label: "Verified or closed" },
  { key: "all", label: "All" },
];

const STATUS_LABEL: Record<Status, string> = {
  open: "Open",
  in_progress: "In progress",
  submitted: "Answered — awaiting verification",
  verified: "Verified",
  closed: "Closed",
  escalated: "Escalated",
};

function sevClass(sev: string) {
  if (sev === "critical" || sev === "high") return "bg-destructive/10 text-destructive border-destructive/25";
  if (sev === "medium") return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30";
  return "bg-muted text-muted-foreground border-border";
}

const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function CorrectiveActions() {
  const now = useNow();
  const { user } = useAuth();
  const canDecide = user?.role === "admin" || user?.role === "supervisor";
  const listQ = useQuery(api.inspections.listMyCorrectiveActions);
  const decide = useMutation(api.inspections.decideCorrectiveAction);
  const [filter, setFilter] = useState<Filter>("active");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const all = useMemo(() => listQ ?? [], [listQ]);
  const counts = caCounts(all, now);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((a) => {
        switch (filter) {
          case "active":
            return a.status !== "verified" && a.status !== "closed";
          case "awaiting":
            return a.status === "submitted";
          case "overdue":
            return isOutstanding(a.status) && a.dueAt < now;
          case "escalated":
            return a.status === "escalated";
          case "done":
            return a.status === "verified" || a.status === "closed";
          default:
            return true;
        }
      })
      .filter(
        (a) =>
          !needle ||
          [a.siteName, a.siteCode, a.county, a.findingTitle, a.description].some((s) => s?.toLowerCase().includes(needle)),
      )
      // answered first (they wait on the reviewer), then oldest deadline first
      .sort((a, b) => Number(b.status === "submitted") - Number(a.status === "submitted") || a.dueAt - b.dueAt);
  }, [all, filter, q, now]);

  async function act(a: CorrectiveAction, decision: Status, done: string) {
    setBusy(a._id);
    try {
      await decide({ caId: a._id, decision });
      toastSuccess({ title: done, reassure: "The decision is recorded in the audit log and the company is notified." });
    } catch (err) {
      toastError(err, { action: "update this corrective action" });
    } finally {
      setBusy(null);
    }
  }

  if (listQ === undefined) return <PageLoading shape="list" label="corrective actions" />;

  const stat = (n: number, label: string, tone = "") => (
    <Card className="paper rounded-none border-border shadow-none">
      <CardContent className="pt-4">
        <p className={`display text-2xl leading-none ${tone}`}>{n}</p>
        <p className="mt-1 text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );

  return (
    <div className="min-w-0 space-y-4">
      <header>
        <p className="kicker">Compliance</p>
        <h1 className="display text-2xl">Corrective actions</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          What companies owe after an inspection finding, and what they have answered.{" "}
          {canDecide
            ? "Verify or close answered actions; escalate overdue ones."
            : "Verification and closure are done by supervisors and administrators."}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stat(counts.needsResponse, "waiting on the company")}
        {stat(counts.awaitingVerification, "awaiting verification", counts.awaitingVerification > 0 ? "text-primary" : "")}
        {stat(counts.overdue, "overdue", counts.overdue > 0 ? "text-destructive" : "")}
        {stat(counts.escalated, "escalated")}
        {stat(counts.closed, "verified or closed")}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? "default" : "outline"}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" strokeWidth={1.5} />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Site, county or finding"
            aria-label="Search corrective actions"
            className="pl-8"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={all.length === 0 ? "No corrective actions in your scope" : "Nothing matches this view"}
          why={
            all.length === 0
              ? "Corrective actions appear here when an inspector opens one for a finding, and again when the company answers it."
              : "Try another filter or clear the search."
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((a) => {
            const overdue = isOutstanding(a.status) && a.dueAt < now;
            return (
              <li key={a._id}>
                <Card className="paper rounded-none border-border shadow-none">
                  <CardContent className="space-y-2 pt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${sevClass(a.findingSeverity)}`}>
                        {a.findingSeverity}
                      </span>
                      <span className="min-w-0 flex-1 break-words text-sm font-medium">{a.findingTitle}</span>
                      <span className="text-xs text-muted-foreground">{STATUS_LABEL[a.status]}</span>
                    </div>
                    <p className="text-sm break-words">{a.description}</p>
                    <p className="text-xs text-muted-foreground">
                      <Link to={`/portal/sites/${a.siteId}`} className="text-primary underline-offset-4 hover:underline">
                        {a.siteCode} · {a.siteName}
                      </Link>{" "}
                      · {a.county} · due {fmt(a.dueAt)}
                      {overdue && <span className="font-medium text-destructive"> · overdue</span>}
                    </p>
                    {a.operatorNote && (
                      <div className="border-l-2 border-border pl-3">
                        <p className="text-xs text-muted-foreground">Company's response</p>
                        <p className="text-sm break-words">{a.operatorNote}</p>
                      </div>
                    )}
                    {canDecide && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {a.status === "submitted" && (
                          <>
                            <Button size="sm" disabled={busy === a._id} onClick={() => act(a, "verified", "Corrective action verified.")}>
                              {busy === a._id ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" strokeWidth={1.5} />}
                              Verify
                            </Button>
                            <Button size="sm" variant="outline" disabled={busy === a._id} onClick={() => act(a, "closed", "Corrective action closed.")}>
                              Verify and close
                            </Button>
                          </>
                        )}
                        {a.status === "verified" && (
                          <Button size="sm" variant="outline" disabled={busy === a._id} onClick={() => act(a, "closed", "Corrective action closed.")}>
                            Close
                          </Button>
                        )}
                        {overdue && (a.status === "open" || a.status === "in_progress") && (
                          <Button size="sm" variant="outline" disabled={busy === a._id} onClick={() => act(a, "escalated", "Corrective action escalated.")}>
                            Escalate
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
