// ---------------------------------------------------------------------------
// BarList — a small accessible bar chart, vertical (columns) or horizontal.
// Every bar carries its number as text next to it (colour is never the only
// cue) and the list is a real <ul>, so a screen reader gets the same figures
// a sighted reader sees. Sizes are relative to `max` (default: the largest
// value shown). Many vertical columns scroll sideways inside the card instead
// of squeezing the labels. Use `alternate(position)` to alternate orientation.
// Palette follows the bar-chart infographic: navy, teal and green, with red and
// amber kept for critical / warning so the colour still carries meaning.
// ---------------------------------------------------------------------------
import type { ReactNode } from "react";
import type { BarOrientation } from "@/lib/chart-orientation";

export type BarTone = "primary" | "critical" | "warn" | "ok" | "muted" | "accent";

const TONE: Record<BarTone, string> = {
  primary: "bg-[#013f72] dark:bg-[#5b9bd5]",
  critical: "bg-destructive",
  warn: "bg-amber-600",
  ok: "bg-[#00949a] dark:bg-teal-500",
  accent: "bg-[#80d95a] dark:bg-[#80d95a]",
  muted: "bg-muted-foreground/60",
};

/** Height of the tallest bar in a vertical chart, in px. */
const PLOT_PX = 96;
/** Room kept above the tallest bar for its value label, in px. */
const VALUE_PX = 24;

export interface BarItem {
  label: string;
  value: number;
  tone?: BarTone;
  /** Optional unit/suffix shown after the number, e.g. "%". */
  suffix?: string;
}

export function BarList({ items, max, tone = "primary", empty, orientation = "vertical" }: {
  items: BarItem[];
  max?: number;
  tone?: BarTone;
  empty?: ReactNode;
  orientation?: BarOrientation;
}) {
  if (items.length === 0) return <>{empty ?? null}</>;
  const top = Math.max(1, max ?? Math.max(...items.map((i) => i.value)));
  const text = (i: BarItem) => `${i.value.toLocaleString()}${i.suffix ?? ""}`;

  if (orientation === "horizontal") {
    return (
      <ul className="space-y-2">
        {items.map((i) => (
          <li
            key={i.label}
            className="grid min-w-0 grid-cols-[minmax(0,7rem)_1fr] items-center gap-3 text-sm sm:grid-cols-[minmax(0,10rem)_1fr]"
          >
            <span className="break-words text-xs text-muted-foreground">{i.label}</span>
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-4 shrink-0 rounded-sm ${TONE[i.tone ?? tone]}`}
                style={{ width: i.value <= 0 ? "3px" : `${Math.max(3, Math.min(100, (i.value / top) * 100)) * 0.85}%` }}
              />
              <span className="tabular-nums">{text(i)}</span>
            </span>
          </li>
        ))}
      </ul>
    );
  }

  // Vertical: each column stacks [value][bar] bottom-aligned, so the number
  // sits directly on top of its bar, then the label under a shared baseline.
  return (
    <div className="max-w-full overflow-x-auto">
      <ul
        className="grid"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(3.5rem, 1fr))` }}
      >
        {items.map((i) => {
          const barPx = i.value <= 0 ? 3 : Math.max(3, Math.min(1, i.value / top) * PLOT_PX);
          return (
            <li key={i.label} className="flex min-w-0 flex-col">
              <div
                className="flex flex-col items-center justify-end px-1"
                style={{ height: PLOT_PX + VALUE_PX }}
              >
                <span className="mb-1 text-sm leading-none tabular-nums">{text(i)}</span>
                <span
                  aria-hidden="true"
                  className={`w-full max-w-[1.25rem] rounded-t-sm ${TONE[i.tone ?? tone]}`}
                  style={{ height: barPx }}
                />
              </div>
              <span className="border-t border-border px-1 pt-1.5 text-center text-[11px] leading-tight break-words text-muted-foreground">
                {i.label}
              </span>
            </li>
          );
        })}
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
