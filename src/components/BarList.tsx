// ---------------------------------------------------------------------------
// BarList — a small accessible horizontal bar chart. Every bar carries its
// number as text (colour is never the only cue) and the list is a real <ul>,
// so a screen reader gets the same figures a sighted reader sees. Widths are
// relative to `max` (default: the largest value shown).
// ---------------------------------------------------------------------------
import type { ReactNode } from "react";

export type BarTone = "primary" | "critical" | "warn" | "ok" | "muted";

const TONE: Record<BarTone, string> = {
  primary: "bg-primary",
  critical: "bg-destructive",
  warn: "bg-amber-600",
  ok: "bg-teal-700",
  muted: "bg-muted-foreground/60",
};

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
            <span className="tabular-nums">
              {i.value.toLocaleString()}
              {i.suffix ?? ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
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
