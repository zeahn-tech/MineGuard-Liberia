// ---------------------------------------------------------------------------
// BarList — a small accessible vertical bar (column) chart. Every bar carries
// its number as text above it (colour is never the only cue) and the list is a
// real <ul>, so a screen reader gets the same figures a sighted reader sees.
// Heights are relative to `max` (default: the largest value shown). Many
// columns scroll sideways inside the card instead of squeezing the labels.
// Palette follows the bar-chart infographic: navy, teal and green, with red and
// amber kept for critical / warning so the colour still carries meaning.
// ---------------------------------------------------------------------------
import type { ReactNode } from "react";

export type BarTone = "primary" | "critical" | "warn" | "ok" | "muted" | "accent";

const TONE: Record<BarTone, string> = {
  primary: "bg-[#013f72] dark:bg-[#5b9bd5]",
  critical: "bg-destructive",
  warn: "bg-amber-600",
  ok: "bg-[#00949a] dark:bg-teal-500",
  accent: "bg-[#80d95a] dark:bg-[#80d95a]",
  muted: "bg-muted-foreground/60",
};

/** Height of the plotting area, in px. */
const PLOT_PX = 144;

export interface BarItem {
  label: string;
  value: number;
  tone?: BarTone;
  /** Optional unit/suffix shown after the number, e.g. "%". */
  suffix?: string;
}

export function BarList({ items, max, tone = "primary", empty }: {
  items: BarItem[];
  max?: number;
  tone?: BarTone;
  empty?: ReactNode;
}) {
  if (items.length === 0) return <>{empty ?? null}</>;
  const top = Math.max(1, max ?? Math.max(...items.map((i) => i.value)));
  return (
    <div className="max-w-full overflow-x-auto pb-1">
      <ul
        className="flex min-w-full items-end gap-2 border-b border-border"
        style={{ width: items.length > 4 ? `${items.length * 4.5}rem` : undefined }}
      >
        {items.map((i) => {
          const pct = i.value <= 0 ? 0 : Math.max(3, Math.min(100, (i.value / top) * 100));
          return (
            <li key={i.label} className="flex min-w-0 flex-1 flex-col items-center justify-end" title={`${i.label}: ${i.value.toLocaleString()}${i.suffix ?? ""}`}>
              <span className="mb-1 text-sm tabular-nums">
                {i.value.toLocaleString()}
                {i.suffix ?? ""}
              </span>
              <span className="flex w-full items-end justify-center" style={{ height: PLOT_PX }}>
                <span
                  aria-hidden="true"
                  className={`w-full max-w-[3.5rem] rounded-t-sm ${TONE[i.tone ?? tone]}`}
                  style={{ height: i.value <= 0 ? "3px" : `${(pct / 100) * PLOT_PX}px` }}
                />
              </span>
            </li>
          );
        })}
      </ul>
      {/* Labels sit under the baseline in the same column grid. */}
      <ul
        aria-hidden="true"
        className="flex min-w-full gap-2 pt-1.5"
        style={{ width: items.length > 4 ? `${items.length * 4.5}rem` : undefined }}
      >
        {items.map((i) => (
          <li key={i.label} className="min-w-0 flex-1 text-center text-[11px] leading-tight break-words text-muted-foreground">
            {i.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A titled chart card used by the admin dashboards. */
export function ChartCard({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="min-w-0 border border-border bg-card p-4">
      <h3 className="kicker break-words">{title}</h3>
      {note && <p className="mt-0.5 text-xs break-words text-muted-foreground">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
