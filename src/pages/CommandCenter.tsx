import { Link, useNavigate } from "react-router";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  ensureOfflineReady,
  readQueue,
  subscribeQueue,
} from "@/lib/offline-queue";
import { useEffect, useState } from "react";
import TrendsPanel from "@/components/TrendsPanel";
import { ArrowRight, ShieldAlert, TriangleAlert } from "lucide-react";

// NOTE: the demo-data seed is an explicit admin action ("Load demo data"
// button in the sidebar). It must NOT auto-run on page mount — an implicit
// write per navigation adds rules round-trips and latency to every visit.

export default function CommandCenter() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // BOUNDED LOADING (the reported "loads forever" failure): if the stats
  // fetch keeps failing, show an honest retry instead of an endless
  // "Loading…". Bumping the key opens a fresh subscription for the same
  // (args-less) query; the query layer retries with backoff underneath.
  const [loadKey, setLoadKey] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const stats = useQuery(
    api.stats.commandCenter,
    loadKey === 0 ? undefined : { retry: loadKey },
  );
  const risk = useQuery(api.sites.riskScores);
  const sites = useQuery(api.sites.list);
  const communityReports = useQuery(api.records.listCommunityReports);
  const [queueCount, setQueueCount] = useState(0);

  useEffect(() => {
    const refresh = () =>
      setQueueCount(readQueue().filter((q) => q.status !== "done").length);
    // The banner mirrors the durable (IndexedDB) queue: load it, follow
    // mutations, keep the slow interval as a cross-tab backstop.
    void ensureOfflineReady().then(refresh);
    const off = subscribeQueue(refresh);
    refresh();
    const i = setInterval(refresh, 2000);
    return () => {
      off();
      clearInterval(i);
    };
  }, []);

  // 8s without data → surface the failure instead of loading forever.
  useEffect(() => {
    if (stats) return;
    const t = setTimeout(() => setTimedOut(true), 8_000);
    return () => {
      clearTimeout(t);
      // Data arrived (or a retry started): the next wait begins un-timed-out.
      setTimedOut(false);
    };
  }, [stats, loadKey]);

  if (!stats) {
    if (!timedOut) {
      return (
        <div className="py-20 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      );
    }
    return (
      <div className="py-20 text-center">
        <p className="display text-lg">The dashboard could not load</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          The request failed — check your connection and try again. The exact
          error is logged in the browser console.
        </p>
        <Button
          className="mt-4"
          onClick={() => {
            setTimedOut(false);
            setLoadKey((k) => k + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const riskEntries = Object.entries(risk ?? {})
    .map(([siteId, r]) => ({ siteId: String(siteId), score: Number(r.score), factors: r.factors ?? [] }))
    .sort((a, b) => b.score - a.score);

  const siteById = new Map((sites ?? []).map((s) => [s._id as string, s]));
  const priority = riskEntries.slice(0, 5).filter((r) => r.score > 0);

  const pendingReports = (communityReports ?? []).filter(
    (r) => r.status === "submitted" || r.status === "under_review",
  );

  return (
    <div className="min-w-0 space-y-8">
      <header className="flex min-w-0 flex-col gap-1">
        <p className="kicker break-words">National command center — {stats.scope} scope</p>
        <h1 className="display text-2xl break-words sm:text-3xl">Oversight at a glance</h1>
        <p className="text-sm break-words text-muted-foreground">
          All figures computed from live platform data. {user?.name ? `Welcome, ${user.name}.` : ""}
        </p>
      </header>

      {queueCount > 0 && (
        <div className="flex min-w-0 items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 flex-1 break-words">
            {queueCount} field submission(s) queued offline — they will sync automatically
            when connectivity returns.
          </p>
        </div>
      )}

      <TrendsPanel />

      {/* Stat row */}
      <div className="grid min-w-0 grid-cols-2 gap-px overflow-hidden rounded-sm border border-border bg-border md:grid-cols-4">
        <StatCell label="Mining sites" value={stats.sites} sub={`${stats.activeSites} active`} />
        <StatCell label="Inspections" value={stats.inspectionsTotal} sub={`${stats.inspectionsUnderReview} under review`} />
        <StatCell label="Open findings" value={stats.findingsTotal} sub={`${stats.findingsCriticalOpen} critical open`} />
        <StatCell label="Corrective actions" value={stats.correctiveActionsOpen} sub={`${stats.correctiveActionsOverdue} overdue`} />
        <StatCell label="Incidents" value={stats.incidentsTotal} sub={`${stats.fatalities} fatalities recorded`} />
        <StatCell label="Environmental alerts" value={stats.envAlerts} sub="measured or verified" />
        <StatCell label="Community reports" value={stats.communityReports} sub={`${stats.communityReportsPending} awaiting triage`} />
        <StatCell label="Inspection coverage" value={stats.inspectionCoveragePct} suffix="%" sub="sites with an approved inspection" />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-2">
        {/* Priority sites */}
        <section className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-2">
            <h2 className="display min-w-0 text-lg break-words">Priority sites (risk indicator)</h2>
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
                      className="group block w-full min-w-0 text-left"
                      onClick={() => navigate(`/portal/sites/${r.siteId}`)}
                    >
                      <div className="flex min-w-0 items-baseline justify-between gap-3">
                        <span className="min-w-0 text-sm font-medium break-words group-hover:underline">
                          {site ? site.name : "Site"}
                        </span>
                        <span className="stat-figure shrink-0 text-lg">{r.score}</span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                        <span className="font-mono break-all">{site?.code}</span>
                        {r.factors.slice(0, 2).map((f) => (
                          <span key={f.label} className="min-w-0 break-words">· {f.label}</span>
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
        <section className="min-w-0 space-y-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-2">
              <h2 className="display min-w-0 text-lg break-words">Under review</h2>
              <Link to="/portal/inspections" className="ml-auto inline-flex min-h-6 shrink-0 items-center text-xs text-muted-foreground hover:text-foreground">
                All inspections →
              </Link>
            </div>
            <p className="py-3 text-sm break-words text-muted-foreground">
              {stats.inspectionsUnderReview} inspection(s) awaiting supervisor decision.
            </p>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-2">
              <h2 className="display min-w-0 text-lg break-words">Community reports awaiting triage</h2>
              <Link to="/portal/community" className="ml-auto inline-flex min-h-6 shrink-0 items-center text-xs text-muted-foreground hover:text-foreground">
                Triage queue →
              </Link>
            </div>
            {pendingReports.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">No pending reports.</p>
            ) : (
              <ul className="divide-y divide-border">
                {pendingReports.slice(0, 4).map((r) => (
                  <li key={r._id} className="flex min-w-0 items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{r.description}</p>
                      <p className="text-xs break-words text-muted-foreground">
                        <span className="font-mono">{r.trackingCode}</span> · {r.county} ·{" "}
                        {r.category.replace(/_/g, " ")}
                      </p>
                    </div>
                    <Button asChild variant="outline" size="sm" className="shrink-0">
                      <Link to="/portal/community">
                        Review <ArrowRight className="size-3" />
                      </Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="min-w-0 border border-border bg-card p-4">
            <div className="flex min-w-0 items-start gap-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
              <p className="min-w-0 flex-1 text-xs leading-relaxed break-words text-muted-foreground">
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
    <div className="min-w-0 bg-card p-3 sm:p-4">
      <p className="kicker break-words">{label}</p>
      <p className="stat-figure mt-1 text-2xl break-words sm:text-3xl">
        {value.toLocaleString()}
        {suffix ?? ""}
      </p>
      {sub && <p className="mt-0.5 text-xs break-words text-muted-foreground">{sub}</p>}
    </div>
  );
}
