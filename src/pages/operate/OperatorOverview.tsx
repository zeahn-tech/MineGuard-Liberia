// ---------------------------------------------------------------------------
// OPERATOR OVERVIEW — landing page of the /operate section.
// Own compliance position at a glance: obligations (corrective actions),
// findings on own sites, own sites registry. Everything server-scoped to the
// operator's tenant; nothing here exists for any other tenant.
// ---------------------------------------------------------------------------

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  Loader2,
} from "lucide-react";
import { Link } from "react-router";

const DAY = 86_400_000;

export default function OperatorOverview() {
  const { user } = useAuth();
  const sitesQ = useQuery(api.sites.list);
  const obligationsQ = useQuery(api.inspections.listMyCorrectiveActions);
  const findingsQ = useQuery(api.inspections.listMyFindings);

  const obligations = obligationsQ ?? [];
  const findings = findingsQ ?? [];
  const openCAs = obligations.filter(
    (o) => o.status === "open" || o.status === "in_progress",
  );
  const overdue = openCAs.filter((o) => o.dueAt < Date.now());
  const awaiting = obligations.filter((o) => o.status === "submitted");
  const openFindings = findings.filter(
    (f) => f.status === "open" || f.status === "acknowledged",
  );

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <p className="kicker">Operator portal</p>
        <h1 className="display text-2xl">
          {user?.operatorName ?? "Your company"} — compliance overview
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Your company's sites and compliance obligations. You see your own
          records only — isolation is enforced by the server, not by this page.
        </p>
      </div>

      {/* Counters */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <ClipboardList className="size-5 text-primary" strokeWidth={1.5} />
            <div>
              <p className="display text-2xl leading-none">{openCAs.length}</p>
              <p className="text-xs text-muted-foreground">open corrective actions</p>
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
              <p className="display text-2xl leading-none">{awaiting.length}</p>
              <p className="text-xs text-muted-foreground">awaiting verification</p>
            </div>
          </CardContent>
        </Card>
        <Card className="paper rounded-none border-border shadow-none">
          <CardContent className="flex items-center gap-3 pt-4">
            <FileCheck2 className="size-5 text-muted-foreground" strokeWidth={1.5} />
            <div>
              <p className="display text-2xl leading-none">{openFindings.length}</p>
              <p className="text-xs text-muted-foreground">open findings</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Most urgent obligations — the operator's actionable list */}
      <Card className="paper rounded-none border-border shadow-none">
        <CardHeader className="pb-2">
          <p className="kicker">Do next</p>
          <CardTitle className="display text-lg">Obligations needing your response</CardTitle>
          <CardDescription>
            Open corrective actions on your sites, soonest deadline first.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {obligationsQ === undefined && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          )}
          {obligationsQ !== undefined && openCAs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing open — no action needed right now.
            </p>
          )}
          {openCAs.slice(0, 5).map((o) => {
            const dueMs = o.dueAt - Date.now();
            const isOverdue = dueMs < 0;
            return (
              <Link
                key={o._id}
                to="/operate/corrective-actions"
                className="block rounded border border-border bg-muted/30 p-3 transition-colors hover:bg-muted/60"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{o.findingTitle}</span>
                  <span className="text-xs text-muted-foreground">
                    · {o.siteCode} {o.siteName}
                  </span>
                  <span
                    className={`ml-auto text-xs ${isOverdue ? "font-medium text-destructive" : "text-muted-foreground"}`}
                  >
                    {isOverdue
                      ? `Overdue ${Math.ceil(-dueMs / DAY)} day(s)`
                      : `Due in ${Math.ceil(dueMs / DAY)} day(s)`}
                  </span>
                </div>
                <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{o.description}</p>
              </Link>
            );
          })}
          {openCAs.length > 5 && (
            <Link
              to="/operate/corrective-actions"
              className="block pt-1 text-sm text-primary underline-offset-4 hover:underline"
            >
              All open corrective actions →
            </Link>
          )}
        </CardContent>
      </Card>

      {/* Own sites quick glance */}
      <Card className="paper rounded-none border-border shadow-none">
        <CardHeader className="pb-2">
          <p className="kicker">Site registry</p>
          <CardTitle className="display text-lg">Your licensed sites</CardTitle>
        </CardHeader>
        <CardContent>
          {sitesQ === undefined && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          )}
          {sitesQ !== undefined && (sitesQ ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No sites are registered to your company yet.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {(sitesQ ?? []).map((s) => (
              <Link key={s._id} to={`/operate/sites/${s._id}`} className="block">
                <div className="flex h-full items-center gap-3 rounded border border-border bg-muted/30 p-3 transition-colors hover:bg-muted/60">
                  <Building2 className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{s.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.code} · {s.county} · {s.status.replace("_", " ")}
                    </p>
                  </div>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {(s.openActions ?? 0) === 0
                      ? "no open actions"
                      : `${s.openActions} open action(s)`}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
