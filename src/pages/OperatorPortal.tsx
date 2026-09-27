// ---------------------------------------------------------------------------
// OPERATOR PORTAL — Gap Closure Directive, Priority B item 5 (spec §20).
//
// A dedicated surface for the Operator role instead of the staff command
// center with a reduced nav (docs/02 "known limitations"). Scope follows the
// product spec exactly: the operator's OWN sites, their compliance
// obligations (corrective actions), and the respond flow — nothing more.
// Staff keep the full command center; this page never renders for them.
//
// Authorization: RLS + canAccessSite mirror (strict tenant isolation by
// operatorName) and the guard triggers decide what lands in these queries —
// the page only renders what the server already scoped, and the respond
// action goes through api.inspections.respondCorrectiveAction, which
// re-derives operator + tenant server-side and is audit logged.
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
import { useAuth } from "@/hooks/use-auth";
import type { Severity } from "@/lib/types";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  Loader2,
  Send,
} from "lucide-react";import { useState } from "react";
import { Link } from "react-router";
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

export default function OperatorPortal() {
  const { user } = useAuth();
  const sitesQ = useQuery(api.sites.list);
  const obligationsQ = useQuery(api.inspections.listMyCorrectiveActions);
  const respond = useMutation(api.inspections.respondCorrectiveAction);

  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const sites = sitesQ ?? [];
  const obligations = obligationsQ ?? [];
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
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="kicker">Mining operator portal</p>
          <h1 className="display text-2xl">
            {user?.operatorName ?? "Your company"} — compliance overview
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Your licensed sites and the corrective actions opened against them.
            Respond to an open action with what your crew did; the reviewing
            authority verifies and closes it. You see only your own company's
            records — this is enforced server-side.
          </p>
        </div>
      </div>

      {/* --- Obligation counters --- */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <ClipboardList className="size-5 text-primary" strokeWidth={1.5} />
            <div>
              <p className="display text-2xl leading-none">{open.length}</p>
              <p className="text-xs text-muted-foreground">open corrective actions</p>
            </div>
          </CardContent>
        </Card>
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <AlertTriangle className={`size-5 ${overdue.length > 0 ? "text-destructive" : "text-muted-foreground"}`} strokeWidth={1.5} />
            <div>
              <p className="display text-2xl leading-none">{overdue.length}</p>
              <p className="text-xs text-muted-foreground">past their deadline</p>
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

      {/* --- Compliance obligations --- */}
      <Card className="paper rounded-none border-border shadow-none">
        <CardHeader className="pb-2">
          <p className="kicker">Corrective actions</p>
          <CardTitle className="display text-lg">Your compliance obligations</CardTitle>
          <CardDescription>
            Opened by inspectors after findings on your sites. Deadlines are
            binding; overdue actions are visible to the oversight authority.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
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
          {obligations.map((o) => {
            const isOpen = o.status === "open" || o.status === "in_progress";
            const dueMs = o.dueAt - Date.now();
            const overdueNow = isOpen && dueMs < 0;
            return (
              <div key={o._id} className="rounded border border-border bg-muted/30 p-3">
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
                  <span className="ml-auto text-xs text-muted-foreground">
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
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* --- Own sites --- */}
      <Card className="paper rounded-none border-border shadow-none">
        <CardHeader className="pb-2">
          <p className="kicker">Site registry</p>
          <CardTitle className="display text-lg">Your licensed sites</CardTitle>
          <CardDescription>
            Registry records for your company only. Status changes are made by
            the administrator, not by operators.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {sitesQ === undefined && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          )}
          {sitesQ !== undefined && sites.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No sites are registered to your company yet.
            </p>
          )}
          {sites.map((s) => (
            <Link key={s._id} to={`/portal/sites/${s._id}`} className="block">
              <div className="h-full rounded border border-border bg-muted/30 p-3 transition-colors hover:bg-muted/60">
                <div className="flex items-center gap-2">
                  <Building2 className="size-4 text-muted-foreground" strokeWidth={1.5} />
                  <span className="text-sm font-medium">{s.name}</span>
                  <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {s.status.replace("_", " ")}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {s.code} · {s.county}
                  {s.mineralType ? ` · ${s.mineralType}` : ""}
                </p>
                <p className="mt-1 flex items-center gap-1 text-xs">
                  <FileCheck2 className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
                  {s.openActions ?? 0} open corrective action{(s.openActions ?? 0) === 1 ? "" : "s"}
                </p>
              </div>
            </Link>
          ))}
        </CardContent>
      </Card>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Operator accounts see exclusively their own company's records. Every
        response you submit is attributed in the audit trail. Decision-support
        figures shown to the oversight authority are computed from verified
        records, not from this view.
      </p>
    </div>
  );
}
