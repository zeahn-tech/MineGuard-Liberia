// ---------------------------------------------------------------------------
// SUMMARY REPORT (§1 reporting, Session 9) — printable / exportable
// government-style summary of what the signed-in account can see.
//
// NOT AN OFFICIAL DOCUMENT. The banner at the top and the footer are rendered
// on screen AND in print, and the CSV carries the same text as its last row.
// "Print / Save as PDF" uses the browser's print dialog — there is no server
// PDF generator, no signature, seal or reference number, by design.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { Download, Printer } from "lucide-react";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { downloadFile } from "@/lib/export-csv";
import {
  ACTIVITY_LABELS,
  POSITION_LABELS,
  REPORT_BANNER,
  REPORT_DISCLAIMER,
  reportFileName,
  reportToCsv,
} from "@/lib/reporting";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function Reports() {
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 89 * 86_400_000)));
  const [to, setTo] = useState(isoDay(today));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  const report = useQuery(api.stats.summaryReport, valid ? { from, to } : "skip");

  const exportCsv = () => {
    if (!report) return;
    downloadFile(
      new File([reportToCsv(report)], reportFileName(report), { type: "text/csv;charset=utf-8" }),
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div>
          <p className="kicker">Reports</p>
          <h1 className="display text-3xl">Summary report</h1>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted-foreground">
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
              className="ml-2 rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <label className="text-xs text-muted-foreground">
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
              className="ml-2 rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground" />
          </label>
          <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!report}>
            <Printer className="size-3.5" /> Print / Save as PDF
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!report}>
            <Download className="size-3.5" /> Export CSV
          </Button>
        </div>
      </div>

      {!valid && (
        <p role="alert" className="text-sm text-destructive print:hidden">
          Choose a start date that is on or before the end date.
        </p>
      )}

      {valid && report === undefined && <p className="text-sm text-muted-foreground">Preparing report…</p>}
      {valid && report === null && (
        <p className="text-sm text-muted-foreground">This account has no role, so there is nothing to report.</p>
      )}

      {report && (
        <article aria-label="Summary report" className="space-y-6 border border-border bg-card p-6 print:border-0 print:p-0">
          <p className="border-2 border-foreground px-3 py-1.5 text-center text-sm font-semibold tracking-widest">
            {REPORT_BANNER}
          </p>
          <header className="space-y-1">
            <h2 className="display text-2xl">MineGuard Liberia — mining oversight summary</h2>
            <p className="text-sm text-muted-foreground">
              Period {report.period.from} to {report.period.to} (UTC) · account scope: {report.scope} ·
              generated {new Date(report.generatedAt).toLocaleString()}
            </p>
          </header>

          <section aria-labelledby="rep-activity">
            <h3 id="rep-activity" className="kicker mb-2">Activity in the period</h3>
            <dl className="grid grid-cols-2 gap-px border border-border bg-border md:grid-cols-4">
              {Object.entries(report.activity).map(([k, v]) => (
                <div key={k} className="bg-card p-3">
                  <dt className="text-xs text-muted-foreground">{ACTIVITY_LABELS[k] ?? k}</dt>
                  <dd className="stat-figure text-2xl">{v.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="rep-position">
            <h3 id="rep-position" className="kicker mb-2">Position as of generation time</h3>
            <dl className="grid grid-cols-2 gap-px border border-border bg-border md:grid-cols-4">
              {Object.entries(report.position).map(([k, v]) => (
                <div key={k} className="bg-card p-3">
                  <dt className="text-xs text-muted-foreground">{POSITION_LABELS[k] ?? k}</dt>
                  <dd className="stat-figure text-2xl">{v.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="rep-county">
            <h3 id="rep-county" className="kicker mb-2">By county</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-1 font-normal">County</th>
                    <th scope="col" className="py-1 text-right font-normal">Sites</th>
                    <th scope="col" className="py-1 text-right font-normal">Incidents</th>
                    <th scope="col" className="py-1 text-right font-normal">Fatalities</th>
                    <th scope="col" className="py-1 text-right font-normal">Critical findings</th>
                    <th scope="col" className="py-1 text-right font-normal">Overdue actions</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byCounty.map((c) => (
                    <tr key={c.county} className="border-t border-border/60">
                      <th scope="row" className="py-1.5 text-left font-normal">{c.county}</th>
                      <td className="py-1.5 text-right tabular-nums">{c.sites}</td>
                      <td className="py-1.5 text-right tabular-nums">{c.incidents}</td>
                      <td className="py-1.5 text-right tabular-nums">{c.fatalities}</td>
                      <td className="py-1.5 text-right tabular-nums">{c.criticalFindings}</td>
                      <td className="py-1.5 text-right tabular-nums">{c.overdueCorrectiveActions}</td>
                    </tr>
                  ))}
                  {report.byCounty.length === 0 && (
                    <tr><td colSpan={6} className="py-2 text-muted-foreground">No sites in scope.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="rep-risk">
            <h3 id="rep-risk" className="kicker mb-2">Highest risk indicators</h3>
            <ol className="space-y-1 text-sm">
              {report.topRiskSites.map((s) => (
                <li key={s.siteId} className="flex justify-between gap-3 border-t border-border/60 py-1">
                  <span><span className="font-mono">{s.code}</span> {s.name} · {s.county}</span>
                  <span className="tabular-nums">{s.score}</span>
                </li>
              ))}
              {report.topRiskSites.length === 0 && <li className="text-muted-foreground">No scored sites.</li>}
            </ol>
            <p className="mt-2 text-xs text-muted-foreground">
              Risk indicators are decision-support only and never determine guilt or enforcement.
            </p>
          </section>

          <footer className="border-t-2 border-foreground pt-3 text-xs leading-relaxed" data-report-footer>
            {REPORT_DISCLAIMER}
          </footer>
        </article>
      )}
    </div>
  );
}
