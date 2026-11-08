import { describe, expect, test } from "bun:test";
import {
  byLocation,
  bySeverity,
  byWeekdayThisMonth,
  topReporters,
  type IncidentLite,
} from "../src/lib/operator-analytics";

const at = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTime();
const inc = (over: Partial<IncidentLite>): IncidentLite => ({
  severity: "low",
  siteName: "Bench 6",
  occurredAt: at(2026, 10, 4),
  reportedById: "u1",
  ...over,
});

describe("operator safety analytics", () => {
  test("severity always lists all four levels, critical first", () => {
    const r = bySeverity([inc({ severity: "medium" }), inc({ severity: "medium" })]);
    expect(r.map((x) => x.severity)).toEqual(["critical", "high", "medium", "low"]);
    expect(r.map((x) => x.count)).toEqual([0, 0, 2, 0]);
  });

  test("locations are grouped and sorted by count", () => {
    const r = byLocation([inc({ siteName: "Lower Gangra" }), inc({}), inc({})]);
    expect(r).toEqual([
      { location: "Bench 6", count: 2 },
      { location: "Lower Gangra", count: 1 },
    ]);
  });

  test("weekday chart counts only the current month", () => {
    const now = at(2026, 10, 7); // Sat 7 Nov 2026
    const r = byWeekdayThisMonth(
      [inc({ occurredAt: at(2026, 10, 4) }), inc({ occurredAt: at(2026, 9, 28) }), inc({ occurredAt: at(2026, 10, 7) })],
      now,
    );
    expect(r.map((x) => x.day)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(r[new Date(at(2026, 10, 4)).getDay()].count).toBe(1);
    expect(r.reduce((n, x) => n + x.count, 0)).toBe(2);
  });

  test("top reporters merge reports and JSAs, named from the team list", () => {
    const rows = topReporters(
      [inc({ reportedById: "a", occurredAt: 1000 }), inc({ reportedById: "a", occurredAt: 3000 })],
      [{ prepared_by: "b", created_at: new Date(2000).toISOString(), submitted_at: null }],
      [{ userId: "a", name: "Great Monarch" }, { userId: "b", name: null }],
    );
    expect(rows[0]).toMatchObject({ name: "Great Monarch", reports: 2, jsas: 0, lastActive: 3000 });
    expect(rows[1]).toMatchObject({ name: "Team member", reports: 0, jsas: 1, lastActive: 2000 });
  });
});
