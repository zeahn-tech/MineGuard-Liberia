// ---------------------------------------------------------------------------
// OPERATOR SAFETY ANALYTICS (every active member of an approved company): incidents by severity,
// by location, by weekday this month, and the company's most active reporters.
// Built only from records the account can already read (server RLS); the
// charts are bars with visible counts, so they read the same without colour.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { BarChart3, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageLoading } from "@/components/PageLoading";
import { EmptyState } from "@/components/EmptyState";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import { listJsas, type Jsa } from "@/lib/jsa";
import { useNow } from "@/hooks/use-now";
import {
  byLocation,
  bySeverity,
  byWeekdayThisMonth,
  topReporters,
} from "@/lib/operator-analytics";

const SEV_COLOR: Record<string, string> = {
  critical: "bg-red-600",
  high: "bg-orange-600",
  medium: "bg-amber-500",
  low: "bg-teal-600",
};

function BarRow({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  return (
    <li className="grid grid-cols-[6.5rem_1fr] items-center gap-3 text-sm sm:grid-cols-[9rem_1fr]">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`h-5 rounded-sm ${color}`}
          style={{ width: count === 0 ? "4px" : `${Math.max(4, (count / max) * 100)}%` }}
          aria-hidden="true"
        />
        <span className="tabular-nums">{count}</span>
      </span>
    </li>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="paper min-w-0 rounded-none border-border shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="display text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default function OperatorAnalytics() {
  const now = useNow();
  const me = useQuery(api.workforce.myMembership);
  const isMember = me?.memberStatus === "active" && me.companyStatus === "approved";
  const incidentsQ = useQuery(api.records.listIncidents);
  const namesQ = useQuery(api.workforce.memberNames, isMember && me ? { organizationId: me.organizationId } : "skip");
  const [jsas, setJsas] = useState<Jsa[] | undefined>();
  const [jsaFailed, setJsaFailed] = useState(false);

  useEffect(() => {
    if (!isMember) return;
    let live = true;
    listJsas().then((j) => live && setJsas(j)).catch(() => {
      if (live) {
        setJsas([]);
        setJsaFailed(true);
      }
    });
    return () => {
      live = false;
    };
  }, [isMember]);

  if (me === undefined) return <div className="p-4 md:p-6"><PageLoading shape="list" label="analytics" /></div>;
  if (!isMember) {
    return (
      <div className="p-4 md:p-6">
        <div className="paper flex items-start gap-3 p-6">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-sm">Safety analytics are available to active members of an approved company.</p>
        </div>
      </div>
    );
  }
  if (incidentsQ === undefined || jsas === undefined || namesQ === undefined) {
    return <div className="p-4 md:p-6"><PageLoading shape="list" label="analytics" /></div>;
  }

  const incidents = incidentsQ ?? [];
  const sev = bySeverity(incidents);
  const loc = byLocation(incidents);
  const days = byWeekdayThisMonth(incidents, now);
  const reporters = topReporters(incidents, jsas, namesQ ?? []);
  const month = new Date(now).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="min-w-0 space-y-4 p-4 md:p-6">
      <header>
        <p className="kicker">{me.organizationName}</p>
        <h1 className="display text-2xl">Safety analytics</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Built from the incident reports and job safety analyses your account can see.
        </p>
      </header>

      {incidents.length === 0 && jsas.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No safety records yet"
          why="Charts appear once your company has reported an incident or filed a job safety analysis."
        />
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <Panel title="Incidents by severity">
            <ul className="space-y-2">
              {sev.map((s) => (
                <BarRow
                  key={s.severity}
                  label={s.severity[0].toUpperCase() + s.severity.slice(1)}
                  count={s.count}
                  max={Math.max(1, ...sev.map((x) => x.count))}
                  color={SEV_COLOR[s.severity]}
                />
              ))}
            </ul>
          </Panel>

          <Panel title="Incidents by location">
            {loc.length === 0 ? (
              <p className="text-sm text-muted-foreground">No incidents recorded.</p>
            ) : (
              <ul className="space-y-2">
                {loc.map((l) => (
                  <BarRow key={l.location} label={l.location} count={l.count} max={loc[0].count} color="bg-indigo-600" />
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={`Incidents this month (by day) — ${month}`}>
            <ul className="space-y-2">
              {days.map((d) => (
                <BarRow
                  key={d.day}
                  label={d.day}
                  count={d.count}
                  max={Math.max(1, ...days.map((x) => x.count))}
                  color="bg-purple-700"
                />
              ))}
            </ul>
          </Panel>

          <Panel title="Top reporters (most active workers)">
            {jsaFailed && (
              <p className="mb-2 text-xs text-muted-foreground">
                Job safety analyses could not be loaded, so JSA counts may be incomplete.
              </p>
            )}
            {reporters.length === 0 ? (
              <p className="text-sm text-muted-foreground">No reports or JSAs yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Most active reporters</caption>
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th scope="col" className="py-1 pr-2 font-normal">#</th>
                      <th scope="col" className="py-1 pr-2 font-normal">Worker name</th>
                      <th scope="col" className="py-1 pr-2 text-right font-normal">Reports submitted</th>
                      <th scope="col" className="py-1 pr-2 text-right font-normal">JSAs filed</th>
                      <th scope="col" className="py-1 text-right font-normal">Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reporters.map((r, i) => (
                      <tr key={r.userId} className="border-t border-border/60">
                        <td className="py-1.5 pr-2 tabular-nums">{i + 1}</td>
                        <th scope="row" className="py-1.5 pr-2 text-left font-normal">{r.name}</th>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{r.reports}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{r.jsas}</td>
                        <td className="py-1.5 text-right text-xs text-muted-foreground">
                          {r.lastActive ? new Date(r.lastActive).toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
