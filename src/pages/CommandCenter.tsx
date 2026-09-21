import { Link, useNavigate } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { readQueue } from "@/lib/offline-queue";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { ArrowRight, ShieldAlert, TriangleAlert } from "lucide-react";

function useSeedOnce() {
  const seed = useMutation(api.seed.seedIfEmpty);
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (attempted) return;
    setAttempted(true);
    seed({}).catch(() => {
      /* seed is opportunistic; failures are surfaced elsewhere */
    });
  }, [attempted, seed]);
}

export default function CommandCenter() {
  useSeedOnce();
  const { user } = useAuth();
  const navigate = useNavigate();
  const stats = useQuery(api.stats.commandCenter);
  const risk = useQuery(api.sites.riskScores);
  const sites = useQuery(api.sites.list);
  const communityReports = useQuery(api.records.listCommunityReports);
  const [queueCount, setQueueCount] = useState(0);

  useEffect(() => {
    setQueueCount(readQueue().filter((q) => q.status !== "done").length);
    const i = setInterval(
      () => setQueueCount(readQueue().filter((q) => q.status !== "done").length),
      2000,
    );
    return () => clearInterval(i);
  }, []);

  if (!stats) {
    return <div className="py-20 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  const riskEntries = Object.entries(risk ?? {})
    .map(([siteId, r]) => ({ siteId, ...r }))
    .sort((a, b) => b.score - a.score);

  const siteById = new Map((sites ?? []).map((s) => [s._id, s]));
  const priority = riskEntries.slice(0, 5).filter((r) => r.score > 0);

  const pendingReports = (communityReports ?? []).filter(
    (r) => r.status === "submitted" || r.status === "under_review",
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-1">
        <p className="kicker">National command center — {stats.scope} scope</p>
        <h1 className="display text-3xl">Oversight at a glance</h1>
        <p className="text-sm text-muted-foreground">
          All figures computed from live platform data. {user?.name ? `Welcome, ${user.name}.` : ""}
        </p>
      </header>

      {queueCount > 0 && (
        <div className="flex items-center gap-2 rounded-sm border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="size-4" />
          {queueCount} field submission(s) queued offline — they will sync automatically
          when connectivity returns.
        </div>
      )}

      {/* Stat row */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-border bg-border md:grid-cols-4">
        <StatCell label="Mining sites" value={stats.sites} sub={`${stats.activeSites} active`} />
        <StatCell label="Inspections" value={stats.inspectionsTotal} sub={`${stats.inspectionsUnderReview} under review`} />
        <StatCell label="Open findings" value={stats.findingsTotal} sub={`${stats.findingsCriticalOpen} critical open`} />
        <StatCell label="Corrective actions" value={stats.correctiveActionsOpen} sub={`${stats.correctiveActionsOverdue} overdue`} />
        <StatCell label="Incidents" value={stats.incidentsTotal} sub={`${stats.fatalities} fatalities recorded`} />
        <StatCell label="Environmental alerts" value={stats.envAlerts} sub="measured or verified" />
        <StatCell label="Community reports" value={stats.communityReports} sub={`${stats.communityReportsPending} awaiting triage`} />
        <StatCell label="Inspection coverage" value={stats.inspectionCoveragePct} suffix="%" sub="sites with an approved inspection" />
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* Priority sites */}
        <section>
          <div className="flex items-baseline justify-between border-b border-border pb-2">
            <h2 className="display text-lg">Priority sites (risk indicator)</h2>
            <span className="text-xs text-muted-foreground">Explainable · configurable · not a verdict</span>
          </div>
          {priority.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No elevated-risk sites in your scope.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {priority.map((r) => {
                const site = siteById.get(r.siteId as string);
                return (
                  <li key={r.siteId} className="py-3">
                    <button
                      className="group w-full text-left"
                      onClick={() => navigate(`/portal/sites/${r.siteId}`)}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium group-hover:underline">
                          {site ? site.name : "Site"}
                        </span>
                        <span className="stat-figure text-lg">{r.score}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        <span className="font-mono">{site?.code}</span>
                        {r.factors.slice(0, 2).map((f) => (
                          <span key={f.label}>· {f.label}</span>
                        ))}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Attention queues */}
        <section className="space-y-6">
          <div>
            <div className="flex items-baseline justify-between border-b border-border pb-2">
              <h2 className="display text-lg">Under review</h2>
              <Link to="/portal/inspections" className="text-xs text-muted-foreground hover:text-foreground">
                All inspections →
              </Link>
            </div>
            <p className="py-3 text-sm text-muted-foreground">
              {stats.inspectionsUnderReview} inspection(s) awaiting supervisor decision.
            </p>
          </div>

          <div>
            <div className="flex items-baseline justify-between border-b border-border pb-2">
              <h2 className="display text-lg">Community reports awaiting triage</h2>
              <Link to="/portal/community" className="text-xs text-muted-foreground hover:text-foreground">
                Triage queue →
              </Link>
            </div>
            {pendingReports.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No pending reports.</p>
            ) : (
              <ul className="divide-y divide-border">
                {pendingReports.slice(0, 4).map((r) => (
                  <li key={r._id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm">{r.description}</p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">{r.trackingCode}</span> · {r.county} ·{" "}
                        {r.category.replace(/_/g, " ")}
                      </p>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <Link to="/portal/community">
                        Review <ArrowRight className="size-3" />
                      </Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border border-border bg-card p-4">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 size-4 text-muted-foreground" strokeWidth={1.5} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Risk indicators are decision-support only. They summarize recorded
                findings, overdue actions, incidents, and verified environmental alerts
                using configurable weights. A risk score never determines guilt or
                triggers enforcement by itself.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCell({
  label,
  value,
  sub,
  suffix,
}: {
  label: string;
  value: number;
  sub?: string;
  suffix?: string;
}) {
  return (
    <div className="bg-card p-4">
      <p className="kicker">{label}</p>
      <p className="stat-figure mt-1 text-3xl">
        {value.toLocaleString()}
        {suffix ?? ""}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
