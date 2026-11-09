import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";

const fmtDate = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

/** The newest PUBLISHED statistics set. Figures are typed in and approved by Ministry staff — nothing
 *  here is computed live from internal records. Renders nothing when no set has been published. */
export function ApprovedStatistics({ compact = false }: { compact?: boolean }) {
  const sets = useQuery(api.publicContent.list, "statistics");
  if (!sets || sets.length === 0) return null;
  const latest = [...sets].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0];
  const items = latest.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div>
      <div className={`grid grid-cols-2 divide-x divide-border ${compact ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        {items.slice(0, compact ? 4 : 12).map((it) => (
          <div key={it.label} className="px-5 py-6">
            <div className="stat-figure text-3xl">{it.value.toLocaleString()}</div>
            <div className="kicker mt-1">{it.label}</div>
            <div className="mt-1 text-xs text-muted-foreground">as of {fmtDate(it.as_of)}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{latest.title} — figures approved by the Ministry for public release.</p>
    </div>
  );
}
