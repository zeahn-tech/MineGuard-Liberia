// ---------------------------------------------------------------------------
// CORRECTIVE ACTIONS (company side) — one place for who may work them and how
// they are counted, so the Overview, the Corrective Actions page and the
// Findings page can never disagree. The database enforces the same role rule
// (migration 0046); this module only mirrors it so the screens can explain
// themselves instead of failing on submit.
// ---------------------------------------------------------------------------
import type { CorrectiveAction } from "./types";

/** Company roles that may see and answer corrective actions. */
export const CA_COMPANY_ROLES = ["site_manager", "safety_officer"] as const;

export interface MembershipLike {
  orgRole: string;
  memberStatus: string;
  companyStatus: string;
}

export function canWorkCorrectiveActions(m: MembershipLike | null | undefined): boolean {
  return (
    !!m &&
    m.memberStatus === "active" &&
    m.companyStatus === "approved" &&
    (CA_COMPANY_ROLES as readonly string[]).includes(m.orgRole)
  );
}

type Status = CorrectiveAction["status"];

/** The operator can answer these (the database allows open and in progress). */
export const isRespondable = (s: Status) => s === "open" || s === "in_progress";
/** Still owed: not yet verified or closed by the reviewing authority. */
export const isOutstanding = (s: Status) => isRespondable(s) || s === "escalated";

export interface CaCounts {
  /** Open or in progress — the operator's response is needed. */
  needsResponse: number;
  /** Escalated by the authority; outstanding but no longer answerable here. */
  escalated: number;
  /** Outstanding and past its deadline (escalated actions included). */
  overdue: number;
  /** Answered, waiting for the reviewing authority to verify. */
  awaitingVerification: number;
  /** Verified or closed. */
  closed: number;
}

export function caCounts(list: { status: Status; dueAt: number }[], now: number): CaCounts {
  const c: CaCounts = { needsResponse: 0, escalated: 0, overdue: 0, awaitingVerification: 0, closed: 0 };
  for (const a of list) {
    if (isRespondable(a.status)) c.needsResponse += 1;
    if (a.status === "escalated") c.escalated += 1;
    if (isOutstanding(a.status) && a.dueAt < now) c.overdue += 1;
    if (a.status === "submitted") c.awaitingVerification += 1;
    if (a.status === "verified" || a.status === "closed") c.closed += 1;
  }
  return c;
}

/** Findings still open or acknowledged that have no corrective action at all —
 *  the reviewing authority has not yet set a deadline for them. */
export function findingsAwaitingAction<F extends { _id: string; status: string }>(
  findings: F[],
  cas: { findingId: string }[],
): F[] {
  const withCa = new Set(cas.map((c) => c.findingId));
  return findings.filter((f) => (f.status === "open" || f.status === "acknowledged") && !withCa.has(f._id));
}
