// Ministry-side calls for Worker Voice (migration 0050). Every one is a self-authorizing RPC: the page
// hiding a button is a courtesy, the database refusing the call is the control. Company accounts hold
// no grant on any of these, so a company administrator cannot read a report made about their company.
import { supabase } from "./supabase";

export type MinistryStatus = "received" | "triage" | "investigating" | "action_taken" | "closed";
export interface MinistryReportRow {
  id: string; organization_id: string; organization_name: string; site_id: string; site_name: string;
  mode: "named" | "confidential" | "anonymous"; category: string; urgency: string; description: string;
  occurred_at: string | null; previously_reported: string; status: MinistryStatus; triage_severity: string | null;
  assigned_to: string | null; assigned_name: string | null; duplicate_of: string | null; closure_reason: string | null;
  reporter_update: string | null; created_at: string;
}
export interface MinistrySummary {
  total: number; open: number; critical_open: number;
  by_group: Record<string, number>; by_category: Record<string, number>;
  by_company: { organization_id: string; name: string; total: number; open: number; serious_open: number }[];
}
export interface MyMinistryReport { id: string; received_on: string; mode: string; category: string; stage: string; reporter_update: string | null; reporter_update_on: string | null; identity_opened: number }

const rpc = async <T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
};

export const listMinistryReports = () => rpc<MinistryReportRow[]>("mg_mv_list", { p_limit: 300 });
export const ministrySummary = () => rpc<MinistrySummary>("mg_mv_summary");
export const myMinistryReports = () => rpc<MyMinistryReport[]>("mg_mv_my_reports");
export const ministryReviewers = () => rpc<{ user_id: string; name: string | null }[]>("mg_mv_reviewers");
export const ministryTriage = (id: string, severity: string, assignee?: string) => rpc("mg_mv_triage", { p_id: id, p_severity: severity, p_assignee: assignee ?? null });
export const ministrySetStatus = (id: string, status: string, note?: string) => rpc("mg_mv_set_status", { p_id: id, p_status: status, p_note: note ?? null });
export const ministryPostUpdate = (id: string, text: string) => rpc("mg_mv_post_update", { p_id: id, p_text: text });
export const ministryOpenIdentity = (id: string, purpose?: string) => rpc<{ available: boolean; name?: string | null; jobTitle?: string | null }>("mg_mv_identity", { p_id: id, p_purpose: purpose ?? null });

export function explainMinistryError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/PURPOSE_REQUIRED/.test(m)) return "State why the identity is needed (at least 10 characters).";
  if (/only a Ministry administrator can open/.test(m)) return "Only a Ministry administrator can open a confidential identity.";
  if (/cannot review a report you sent/.test(m)) return "You sent this report, so you cannot review it.";
  if (/CLOSURE_REASON_REQUIRED/.test(m)) return "Say why the report is being closed (at least 10 characters).";
  if (/backwards/.test(m)) return "A report cannot move back to an earlier stage.";
  if (/IMMUTABLE/.test(m)) return "This report is closed and cannot be changed.";
  if (/not an authorized reviewer/.test(m)) return "That person cannot be assigned to this report.";
  if (/FORBIDDEN/.test(m)) return "You are not authorized to do that.";
  if (/INVALID/.test(m)) return m.replace(/^.*INVALID:\s*/, "");
  return "That could not be completed. Nothing was changed; try again.";
}
