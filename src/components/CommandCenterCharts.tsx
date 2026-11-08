// ---------------------------------------------------------------------------
// COMMAND-CENTER CHARTS — a visual companion to the stat row. Every figure is
// one the dashboard already loaded (command-center stats, risk indicators,
// community reports); the numbers stay on screen as text beside each bar.
// ---------------------------------------------------------------------------
import { BarList, ChartCard } from "@/components/BarList";
import { PageLoading } from "@/components/PageLoading";
import type { CommandCenterStats } from "@/lib/backend";
import type { CommunityReport } from "@/lib/types";
import { communityBy, coverageSplit, recordBars } from "@/lib/admin-charts";

const none = <p className="text-xs text-muted-foreground">Nothing recorded in your scope yet.</p>;

export default function CommandCenterCharts({
  stats,
  reports,
  priority,
}: {
  stats: CommandCenterStats;
  reports: CommunityReport[] | undefined;
  priority: { label: string; value: number }[];
}) {
  const cov = coverageSplit(stats.inspectionCoveragePct);
  const onTime = Math.max(0, stats.correctiveActionsOpen - stats.correctiveActionsOverdue);
  const counties = recordBars(stats.countyCounts);
  const types = recordBars(stats.incidentTypes);
  const env = recordBars(stats.envByCategory);

  return (
    <section aria-label="Command center charts" className="grid min-w-0 gap-3 md:grid-cols-2">
      <ChartCard title="Corrective actions" note="Outstanding actions: overdue versus still within their deadline.">
        <BarList
          items={[
            { label: "Overdue", value: stats.correctiveActionsOverdue, tone: "critical" },
            { label: "Open, within deadline", value: onTime, tone: "primary" },
          ]}
        />
      </ChartCard>

      <ChartCard title="Inspection coverage" note="Share of sites with an approved inspection.">
        <BarList
          items={[
            { label: "With approved inspection", value: cov.covered, suffix: "%", tone: "primary" },
            { label: "Without", value: cov.notCovered, suffix: "%", tone: "warn" },
          ]}
          max={100}
        />
      </ChartCard>

      <ChartCard title="Incidents by type" note={`${stats.incidentsTotal.toLocaleString()} reported; not independently verified.`}>
        {types.length === 0 ? none : <BarList items={types} tone="primary" />}
      </ChartCard>

      <ChartCard title="Records by county" note="Records across your scope, top eight counties.">
        {counties.length === 0 ? none : <BarList items={counties} tone="primary" />}
      </ChartCard>

      <ChartCard title="Community reports by status">
        {reports === undefined ? (
          <PageLoading shape="list" label="community reports" rows={2} compact />
        ) : reports.length === 0 ? (
          none
        ) : (
          <BarList items={communityBy(reports, "status")} tone="primary" />
        )}
      </ChartCard>

      <ChartCard title="Community reports by category">
        {reports === undefined ? (
          <PageLoading shape="list" label="community reports" rows={2} compact />
        ) : reports.length === 0 ? (
          none
        ) : (
          <BarList items={communityBy(reports, "category")} tone="warn" />
        )}
      </ChartCard>

      {env.length > 0 && (
        <ChartCard title="Environmental alerts by category" note="Measured or verified only.">
          <BarList items={env} tone="critical" />
        </ChartCard>
      )}

      {priority.length > 0 && (
        <ChartCard title="Highest risk indicators" note="Decision support only — not a verdict on any site.">
          <BarList items={priority} tone="warn" />
        </ChartCard>
      )}
    </section>
  );
}
