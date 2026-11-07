import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { Button } from "@/components/ui/button";
import {
  NO_BOARD_FILTERS,
  PERIODS,
  STALE_AFTER_DAYS,
  STATUS_META,
  STATUS_ORDER,
  ageText,
  applyBoardFilters,
  computeSiteStatuses,
  orgKey,
  periodMsOf,
  sortByUrgency,
  summarize,
  type BoardFilters,
  type FreshnessFilter,
  type PeriodKey,
  type SiteStatusInputs,
  type SiteStatusKey,
  type SiteStatusRow,
} from "@/lib/site-status";
import { TriangleAlert, WifiOff } from "lucide-react";
import { PageLoading } from "@/components/PageLoading";
import { BarList, ChartCard, type BarTone } from "@/components/BarList";
import { countyLoad, incidentSeverityInPeriod, statusCounts, topIncidentSites, prettify } from "@/lib/admin-charts";

const PAGE = 25;

const STATUS_TONE: Record<SiteStatusKey, string> = {
  review_now: "border-destructive/60 bg-destructive/10 text-destructive",
  action_overdue: "border-amber-600/50 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  insufficient: "border-border bg-muted text-foreground",
  stale: "border-border bg-muted text-foreground",
  recent_information: "border-border bg-card text-foreground",
};

function useOnline(): boolean {
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

const chip = (on: boolean) =>
  `rounded-full border px-2.5 py-0.5 text-xs ${
    on ? "bg-accent border-ring" : "border-border opacity-70 hover:opacity-100"
  }`;

function fmtDate(ts: number | null): string {
  return ts === null ? "—" : new Date(ts).toLocaleDateString();
}

/** Container: fetches the RLS-scoped feed and tracks load/online state; all
 *  rendering lives in SiteStatusBoardView so every state is testable. The
 *  rules live in src/lib/site-status.ts; there is no "safe" state. */
export default function SiteStatusBoard() {
  const [loadKey, setLoadKey] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const feed = useQuery(
    api.stats.siteStatusFeed,
    loadKey === 0 ? undefined : { retry: loadKey },
  );
  const online = useOnline();

  useEffect(() => {
    if (feed) return;
    const t = setTimeout(() => setTimedOut(true), 10_000);
    return () => {
      clearTimeout(t);
      setTimedOut(false);
    };
  }, [feed, loadKey]);

  return (
    <SiteStatusBoardView
      feed={feed}
      timedOut={timedOut}
      online={online}
      onRetry={() => {
        setTimedOut(false);
        setLoadKey((k) => k + 1);
      }}
    />
  );
}

export function SiteStatusBoardView({
  feed,
  timedOut,
  online,
  onRetry,
}: {
  feed: SiteStatusInputs | undefined;
  timedOut: boolean;
  online: boolean;
  onRetry: () => void;
}) {
  const [period, setPeriod] = useState<PeriodKey>("90d");
  const [filters, setFilters] = useState<BoardFilters>(NO_BOARD_FILTERS);
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(
    () =>
      feed
        ? computeSiteStatuses(feed, {
            now: feed.loadedAt,
            periodMs: periodMsOf(period),
          })
        : [],
    [feed, period],
  );

  const counties = useMemo(
    () => [...new Set(rows.map((r) => r.site.county))].filter(Boolean).sort(),
    [rows],
  );
  const orgs = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(orgKey(r.site), r.site.operatorName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(
    () => sortByUrgency(applyBoardFilters(rows, filters)),
    [rows, filters],
  );
  const summary = useMemo(() => summarize(filtered), [filtered]);

  const toggle = <K extends "counties" | "organizations" | "statuses">(
    key: K,
    value: BoardFilters[K][number],
  ) =>
    setFilters((f) => {
      const cur = f[key] as string[];
      const next = cur.includes(value as string)
        ? cur.filter((x) => x !== value)
        : [...cur, value as string];
      return { ...f, [key]: next } as BoardFilters;
    });

  const filtersActive =
    filters.counties.length > 0 ||
    filters.organizations.length > 0 ||
    filters.statuses.length > 0 ||
    filters.freshness !== "any" ||
    filters.criticalOnly ||
    filters.text.trim() !== "";

  if (!feed) {
    if (!timedOut) {
      return (
        <PageLoading shape="table" label="site status" compact />
      );
    }
    return (
      <section role="alert" className="border border-border bg-card p-4">
        <p className="display text-base">Site status could not load</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {online
            ? "This is usually a slow or unstable connection, not a problem with your account. Try again in a moment."
            : "You appear to be offline. The board will load as soon as you reconnect — or try again once you have signal."}
        </p>
        <Button
          className="mt-3"
          size="sm"
          onClick={onRetry}
        >
          Try again
        </Button>
      </section>
    );
  }

  const now = feed.loadedAt;
  const periodLabel = PERIODS.find((p) => p.key === period)?.label ?? "";
  const visible = filtered.slice(0, shown);

  return (
    <section aria-labelledby="site-status-h" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border pb-2">
        <h2 id="site-status-h" className="display min-w-0 text-lg break-words">
          Site status board
        </h2>
        <span className="text-xs text-muted-foreground">
          Data read {new Date(now).toLocaleString()} on this device
        </span>
      </div>

      {!online && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-sm border border-border bg-muted px-3 py-2 text-xs"
        >
          <WifiOff className="mt-0.5 size-3.5 shrink-0" />
          <p>
            You are offline. Figures are from the last successful read and may be
            out of date.
          </p>
        </div>
      )}

      {/* Summary: counts the dashboard can actually support. */}
      <dl className="grid min-w-0 grid-cols-2 gap-px overflow-hidden rounded-sm border border-border bg-border md:grid-cols-4">
        <Cell label="Sites in view" value={summary.sites} sub={`${summary.withPosition} with a valid map position`} />
        <Cell
          label="Open critical findings"
          value={summary.openCriticalFindings}
          sub={`${summary.sitesWithOpenCritical} site(s)`}
          emphasize={summary.openCriticalFindings > 0}
        />
        <Cell
          label="Overdue corrective actions"
          value={summary.overdueActions}
          sub={`${summary.sitesWithOverdueActions} site(s)`}
          emphasize={summary.overdueActions > 0}
        />
        <Cell label={`Incidents (${periodLabel.toLowerCase()})`} value={summary.incidentsInPeriod} sub="reported, not independently verified" />
        <Cell
          label="Recent approved inspection"
          value={summary.recentApproved}
          sub={`within ${STALE_AFTER_DAYS} days`}
        />
        <Cell label="Approved inspection older" value={summary.stale} sub={`over ${STALE_AFTER_DAYS} days`} />
        <Cell
          label="No approved inspection"
          value={summary.noApprovedInspection}
          sub="information insufficient"
        />
        <Cell label="Staleness window" value={STALE_AFTER_DAYS} sub="days (approved policy)" />
      </dl>

      {/* Filters */}
      <div className="space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Period</span>
            <select
              className="rounded-sm border border-border bg-background px-2 py-1"
              value={period}
              onChange={(e) => setPeriod(e.target.value as PeriodKey)}
            >
              {PERIODS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Verified data</span>
            <select
              className="rounded-sm border border-border bg-background px-2 py-1"
              value={filters.freshness}
              onChange={(e) =>
                setFilters((f) => ({ ...f, freshness: e.target.value as FreshnessFilter }))
              }
            >
              <option value="any">Any</option>
              <option value="fresh">Recent (≤ {STALE_AFTER_DAYS} days)</option>
              <option value="stale">Stale (&gt; {STALE_AFTER_DAYS} days)</option>
              <option value="none">None on record</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Search</span>
            <input
              type="search"
              className="w-40 rounded-sm border border-border bg-background px-2 py-1"
              value={filters.text}
              placeholder="Site, code or company"
              onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={filters.criticalOnly}
              onChange={(e) => setFilters((f) => ({ ...f, criticalOnly: e.target.checked }))}
            />
            <span>Open critical findings only</span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Status filter">
          <span className="text-muted-foreground">Status:</span>
          {STATUS_ORDER.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={filters.statuses.includes(k)}
              onClick={() => toggle("statuses", k)}
              className={chip(filters.statuses.includes(k))}
            >
              {STATUS_META[k].glyph} {STATUS_META[k].label}
            </button>
          ))}
        </div>

        {counties.length > 1 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="County filter">
            <span className="text-muted-foreground">County:</span>
            {counties.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={filters.counties.includes(c)}
                onClick={() => toggle("counties", c)}
                className={chip(filters.counties.includes(c))}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {orgs.length > 1 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Company filter">
            <span className="text-muted-foreground">Company:</span>
            {orgs.map(([key, name]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filters.organizations.includes(key)}
                onClick={() => toggle("organizations", key)}
                className={chip(filters.organizations.includes(key))}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        {filtersActive && (
          <button
            type="button"
            className="underline"
            onClick={() => {
              setFilters(NO_BOARD_FILTERS);
              setShown(PAGE);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Charts — drawn from exactly the sites the filters leave in view. */}
      {filtered.length > 0 && (
        <BoardCharts
          rows={filtered}
          summary={summary}
          incidents={feed.incidents}
          now={now}
          periodMs={periodMsOf(period)}
          periodLabel={periodLabel.toLowerCase()}
        />
      )}

      {/* List */}
      {rows.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          No registered sites are visible to your account. Sites appear here once
          a company is registered and its sites are added; nothing is shown for
          sites you are not authorized to see.
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          No sites match these filters.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" role="status">
            Showing {visible.length} of {filtered.length} site(s), most urgent first.
          </p>
          <ul className="divide-y divide-border border-y border-border">
            {visible.map((r) => (
              <Row key={r.site.id} r={r} now={now} />
            ))}
          </ul>
          {filtered.length > shown && (
            <Button variant="outline" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              Show more
            </Button>
          )}
        </>
      )}

      <details className="border border-border bg-card p-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer text-foreground">How statuses are determined</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {STATUS_ORDER.map((k) => (
            <li key={k}>
              <strong className="text-foreground">{STATUS_META[k].label}.</strong>{" "}
              {STATUS_META[k].description}
            </li>
          ))}
          <li>
            Statuses are decision support, not a compliance verdict, and there is
            no "safe" status: a site with no reports is shown as having
            insufficient information, never as safe. Open critical findings and
            overdue actions are always listed, whatever the status.
          </li>
          <li>
            "Verified" means an approved inspection. Incident and submission
            times are company-submitted and may not be reviewed.
          </li>
        </ul>
      </details>
    </section>
  );
}

function Cell({
  label,
  value,
  sub,
  emphasize,
}: {
  label: string;
  value: number;
  sub?: string;
  emphasize?: boolean;
}) {
  return (
    <div className="min-w-0 bg-card p-3">
      <dt className="kicker break-words">{label}</dt>
      <dd className={`stat-figure mt-1 text-2xl break-words ${emphasize ? "text-destructive" : ""}`}>
        {value.toLocaleString()}
      </dd>
      {sub && <p className="mt-0.5 text-xs break-words text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Row({ r, now }: { r: SiteStatusRow; now: number }) {
  const meta = STATUS_META[r.status];
  return (
    <li className="min-w-0 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <Link
            to={`/portal/sites/${r.site.id}`}
            className="text-sm font-medium break-words hover:underline"
          >
            {r.site.name}
          </Link>
          <p className="text-xs break-words text-muted-foreground">
            <span className="font-mono">{r.site.code}</span> · {r.site.operatorName} ·{" "}
            {r.site.county}
            {r.site.registryStatus !== "active" && ` · registry: ${r.site.registryStatus.replace(/_/g, " ")}`}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs ${STATUS_TONE[r.status]}`}
          title={meta.description}
        >
          <span aria-hidden="true">{meta.glyph}</span>
          {meta.label}
        </span>
      </div>

      {(r.openCriticalFindings > 0 || r.overdueActions > 0 || r.openSeriousIncidents > 0) && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          {r.openCriticalFindings > 0 && (
            <span>{r.openCriticalFindings} open critical finding(s)</span>
          )}
          {r.overdueActions > 0 && <span>{r.overdueActions} overdue action(s)</span>}
          {r.openSeriousIncidents > 0 && (
            <span>{r.openSeriousIncidents} open serious incident(s)</span>
          )}
        </p>
      )}

      <p className="mt-1 text-xs break-words text-muted-foreground">
        Verified: last approved inspection{" "}
        {r.lastApprovedInspectionAt === null
          ? "none on record"
          : `${fmtDate(r.lastApprovedInspectionAt)} (${ageText(r.lastApprovedInspectionAt, now)})`}
        {" · "}Company-submitted: last submission{" "}
        {r.lastSubmissionAt === null ? "none" : ageText(r.lastSubmissionAt, now)}
        {" · "}
        {r.openActions} outstanding action(s) · {r.incidentsInPeriod} incident(s) in period
        {!r.hasPosition && " · no valid map position on record"}
      </p>
    </li>
  );
}

const STATUS_BAR_TONE: Record<SiteStatusKey, BarTone> = {
  review_now: "critical",
  action_overdue: "warn",
  insufficient: "muted",
  stale: "muted",
  recent_information: "primary",
};

function BoardCharts({
  rows,
  summary,
  incidents,
  now,
  periodMs,
  periodLabel,
}: {
  rows: SiteStatusRow[];
  summary: ReturnType<typeof summarize>;
  incidents: SiteStatusInputs["incidents"];
  now: number;
  periodMs: number | null;
  periodLabel: string;
}) {
  const statuses = statusCounts(rows);
  const counties = countyLoad(rows);
  const topSites = topIncidentSites(rows);
  const sev = incidentSeverityInPeriod(incidents, new Set(rows.map((r) => r.site.id)), now, periodMs);
  const SEV_TONE: Record<string, BarTone> = { critical: "critical", high: "warn", medium: "primary", low: "ok" };
  const none = <p className="text-xs text-muted-foreground">Nothing to show for the sites in view.</p>;

  return (
    <div className="grid min-w-0 gap-3 md:grid-cols-2" aria-label="Site status charts">
      <ChartCard title="Sites by status" note="One primary status per site, most urgent first. Not a safety verdict.">
        <BarList
          items={statuses.map((s) => ({
            label: `${STATUS_META[s.status].glyph} ${STATUS_META[s.status].label}`,
            value: s.count,
            tone: STATUS_BAR_TONE[s.status],
          }))}
          max={Math.max(1, summary.sites)}
        />
      </ChartCard>

      <ChartCard title="Age of verified information" note={`Latest approved inspection; policy window ${STALE_AFTER_DAYS} days.`}>
        <BarList
          items={[
            { label: `Within ${STALE_AFTER_DAYS} days`, value: summary.recentApproved, tone: "primary" },
            { label: `Older than ${STALE_AFTER_DAYS} days`, value: summary.stale, tone: "muted" },
            { label: "No approved inspection", value: summary.noApprovedInspection, tone: "warn" },
          ]}
          max={Math.max(1, summary.sites)}
        />
      </ChartCard>

      <ChartCard title={`Incidents by severity (${periodLabel})`} note="Reported by companies; not independently verified.">
        <BarList
          items={sev.map((s) => ({ label: prettify(s.severity), value: s.count, tone: SEV_TONE[s.severity] }))}
        />
      </ChartCard>

      <ChartCard title={`Sites with most incidents (${periodLabel})`}>
        {topSites.length === 0 ? none : <BarList items={topSites} tone="primary" />}
      </ChartCard>

      <div className="md:col-span-2">
        <ChartCard title="Open critical findings, overdue actions and incidents by county" note="Counties with at least one of these; top six.">
          {counties.length === 0 ? (
            none
          ) : (
            <div className="grid min-w-0 gap-6 sm:grid-cols-3">
              <div>
                <p className="mb-2 text-xs font-medium">Open critical findings</p>
                <BarList items={counties.map((c) => ({ label: c.county, value: c.openCritical }))} tone="critical" />
              </div>
              <div>
                <p className="mb-2 text-xs font-medium">Overdue corrective actions</p>
                <BarList items={counties.map((c) => ({ label: c.county, value: c.overdue }))} tone="warn" />
              </div>
              <div>
                <p className="mb-2 text-xs font-medium">Incidents ({periodLabel})</p>
                <BarList items={counties.map((c) => ({ label: c.county, value: c.incidents }))} tone="primary" />
              </div>
            </div>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
