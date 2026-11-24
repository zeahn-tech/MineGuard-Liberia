// Charts on a screen alternate between vertical and horizontal bars: the first
// is vertical, the next horizontal, and so on in display order.
export type BarOrientation = "vertical" | "horizontal";

/** Orientation for the chart at `position` (0-based, in display order). */
export function alternate(position: number): BarOrientation {
  return position % 2 === 0 ? "vertical" : "horizontal";
}
