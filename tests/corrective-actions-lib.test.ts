import { describe, expect, test } from "bun:test";
import { canWorkCorrectiveActions, caCounts, findingsAwaitingAction } from "../src/lib/corrective-actions";

const NOW = Date.UTC(2026, 10, 7);
const DAY = 86_400_000;
const m = (orgRole: string, memberStatus = "active", companyStatus = "approved") => ({ orgRole, memberStatus, companyStatus });

describe("corrective action access", () => {
  test("only active site managers and safety officers of an approved company", () => {
    expect(canWorkCorrectiveActions(m("site_manager"))).toBe(true);
    expect(canWorkCorrectiveActions(m("safety_officer"))).toBe(true);
    for (const r of ["company_admin", "worker", "onboarding_officer"]) expect(canWorkCorrectiveActions(m(r))).toBe(false);
    expect(canWorkCorrectiveActions(m("site_manager", "pending"))).toBe(false);
    expect(canWorkCorrectiveActions(m("site_manager", "active", "suspended"))).toBe(false);
    expect(canWorkCorrectiveActions(null)).toBe(false);
  });
});

describe("corrective action counts", () => {
  const list = [
    { status: "open" as const, dueAt: NOW + DAY },
    { status: "open" as const, dueAt: NOW - DAY }, // overdue
    { status: "in_progress" as const, dueAt: NOW - 2 * DAY }, // overdue
    { status: "escalated" as const, dueAt: NOW - 5 * DAY }, // overdue, not answerable
    { status: "submitted" as const, dueAt: NOW - DAY }, // answered: never overdue
    { status: "verified" as const, dueAt: NOW - DAY },
    { status: "closed" as const, dueAt: NOW - DAY },
  ];
  test("counts each state once and keeps escalated actions in the overdue figure", () => {
    expect(caCounts(list, NOW)).toEqual({ needsResponse: 3, escalated: 1, overdue: 3, awaitingVerification: 1, closed: 2 });
  });
  test("empty list is all zeros", () => {
    expect(caCounts([], NOW)).toEqual({ needsResponse: 0, escalated: 0, overdue: 0, awaitingVerification: 0, closed: 0 });
  });
});

describe("findings with no corrective action", () => {
  test("lists open/acknowledged findings that no action points at", () => {
    const findings = [
      { _id: "a", status: "open" },
      { _id: "b", status: "acknowledged" },
      { _id: "c", status: "open" },
      { _id: "d", status: "resolved" },
    ];
    expect(findingsAwaitingAction(findings, [{ findingId: "c" }]).map((f) => f._id)).toEqual(["a", "b"]);
  });
});
