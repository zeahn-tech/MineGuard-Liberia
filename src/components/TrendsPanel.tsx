// ---------------------------------------------------------------------------
// COMMAND-CENTER TRENDS (§19, Session 9) — time-series and geographic trends.
//
// Every number comes from SQL (api.stats.trendSeries / trendGeo →
// mg_trend_series / mg_trend_geo, SECURITY INVOKER): the panel can only show
// what the signed-in account's RLS lets it read. The chart has a text
// equivalent (a table) so the same figures are available without sight.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { TREND_METRICS, trendMetricLabel, type TrendBucket, type TrendMetric } from "@/lib/reporting";

const BUCKETS: { key: TrendBucket; label: string }[] = [
  { key: "day", label: "Daily (30 days)" },
  { key: "week", label: "Weekly (12 weeks)" },
  { key: "month", label: "Monthly (12 months)" },
];

function bucketLabel(iso: string, bucket: TrendBucket): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return bucket === "month"
    ? d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

export default function TrendsPanel() {
  const [metric, setMetric] = useState<TrendMetric>("incidents");
  const [bucket, setBucket] = useState<TrendBucket>("month");

  const series = useQuery(api.stats.trendSeries, { metric, bucket });
  // The geographic view compares the SAME window with the one before it.
  const geo = useQuery(
    api.stats.trendGeo,
    series ? { metric, from: series.from, to: series.to } : "skip",
  );

  const label = trendMetricLabel(metric);
  const data = (series?.points ?? []).map((p) => ({ name: bucketLabel(p.bucket, bucket), value: p.value }));

  return (
    <section aria-labelledby="trends-heading" className="space-y-4 border border-border bg-card p-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
        <div>
          <p className="kicker">Trends</p>
          <h2 id="trends-heading" className="display text-xl">{label} over time</h2>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-muted-foreground">
            Measure
            <select
              className="ml-2 rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground"
              value={metric}
              onChange={(e) => setMetric(e.target.value as TrendMetric)}
            >
              {TREND_METRICS.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">
            Period
            <select
              className="ml-2 rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground"
              value={bucket}
              onChange={(e) => setBucket(e.target.value as TrendBucket)}
            >
              {BUCKETS.map((b) => (
                <option key={b.key} value={b.key}>{b.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {series === undefined ? (
        <p className="py-6 text-sm text-muted-foreground">Loading trend…</p>
      ) : series === null ? (
        <p className="py-6 text-sm text-muted-foreground">No trend data for this account.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {series.total.toLocaleString()} in total, {series.from} to {series.to} (UTC). Only records
            visible to your account are counted.
          </p>
          <div className="h-48 w-full" role="img" aria-label={`${label} per ${bucket}, ${series.from} to ${series.to}`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="value" name={label} fill="currentColor" className="text-primary" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Show as table</summary>
            <table className="mt-2 w-full">
              <caption className="sr-only">{label} per {bucket}</caption>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="py-1 pr-4 font-normal">Period starting</th>
                  <th scope="col" className="py-1 text-right font-normal">{label}</th>
                </tr>
              </thead>
              <tbody>
                {series.points.map((p) => (
                  <tr key={p.bucket} className="border-t border-border/60">
                    <td className="py-1 pr-4">{p.bucket}</td>
                    <td className="py-1 text-right tabular-nums">{p.value.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}

      <div>
        <h3 className="kicker mb-2">By county — latest window vs the one before</h3>
        {geo === undefined || geo === null ? (
          <p className="text-sm text-muted-foreground">{series === null ? "—" : "Loading…"}</p>
        ) : geo.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded in either window.</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">
              {label} by county, {geo.from} to {geo.to}, compared with {geo.previousFrom} to {geo.previousTo}
            </caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 font-normal">County</th>
                <th scope="col" className="py-1 text-right font-normal">Now</th>
                <th scope="col" className="py-1 text-right font-normal">Before</th>
                <th scope="col" className="py-1 text-right font-normal">Change</th>
              </tr>
            </thead>
            <tbody>
              {geo.rows.map((r) => {
                const Icon = r.delta > 0 ? ArrowUpRight : r.delta < 0 ? ArrowDownRight : Minus;
                return (
                  <tr key={r.county} className="border-t border-border/60">
                    <th scope="row" className="py-1.5 text-left font-normal">{r.county}</th>
                    <td className="py-1.5 text-right tabular-nums">{r.value.toLocaleString()}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{r.previous.toLocaleString()}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      <span className="inline-flex items-center justify-end gap-1">
                        <Icon className="size-3" aria-hidden="true" />
                        {r.delta > 0 ? "+" : ""}{r.delta.toLocaleString()}
                        {r.changePct !== null ? ` (${r.changePct > 0 ? "+" : ""}${r.changePct}%)` : " (new)"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
