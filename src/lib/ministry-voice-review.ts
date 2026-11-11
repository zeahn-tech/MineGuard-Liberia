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
  reporter_update: string | null; created_at: string; small_site: boolean; legal_hold: boolean; closed_at: string | null;
}
export interface MinistrySummary {
  total: number; open: number; critical_open: number;
  by_group: Record<string, number>; by_category: Record<string, number>;
  by_company: { organization_id: string; name: string; total: number; open: number; serious_open: number }[];
}
export interface MyMinistryReport { id: string; received_on: string; mode: string; category: string; stage: string; reporter_update: string | null; reporter_update_on: string | null; identity_opened: number; can_reply: boolean }

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

export interface MinistryMessage { seq: number; from_reporter: boolean; body: string; at: string }
export async function listMinistryMessages(reportId: string): Promise<MinistryMessage[]> {
  const { data, error } = await supabase.from("ministry_voice_messages").select("seq, from_reporter, body, at").eq("report_id", reportId).order("seq", { ascending: true }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as MinistryMessage[];
}
export interface MinistryPhoto { id: string; bytes: number; sha256: string; data: string }
export const ministryPhotos = (reportId: string) => rpc<MinistryPhoto[]>("mg_mv_attachments", { p_report: reportId });
export const ministryPhotoCounts = () => rpc<{ report_id: string; n: number }[]>("mg_mv_attachment_counts");
export const ministrySetHold = (id: string, hold: boolean, reason?: string) => rpc("mg_mv_set_hold", { p_id: id, p_hold: hold, p_reason: reason ?? null });
export const ministryDispose = (dryRun: boolean, confirm?: string) => rpc<{ dryRun: boolean; eligible?: number; deleted?: number; retentionMonths: number }>("mg_mv_dispose", { p_dry_run: dryRun, p_confirm: confirm ?? null });
export const setRetention = (channel: "company" | "ministry", months: number) => rpc("mg_voice_set_retention", { p_channel: channel, p_months: months });
export const retentionPolicy = () => rpc<{ channel: string; retention_months: number }[]>("mg_voice_retention");

// the Ministry's OWN intake codes (Ministry administrators only)
export interface MinistryCodeSite { site_id: string; site_name: string; organization_name: string }
export interface MinistryCodeInfo { code: string; changedOn: string; enabled: boolean; today: number; week: number; unusual: boolean }
export const ministryCodeSites = (search: string) => rpc<MinistryCodeSite[]>("mg_mv_code_sites", { p_search: search });
export const ministryCodeInfo = (siteId: string) => rpc<MinistryCodeInfo>("mg_mv_code_info", { p_site: siteId });
export const ministryRotateCode = (siteId: string) => rpc<string>("mg_mv_rotate_code", { p_site: siteId });
export const ministrySetAnonymous = (siteId: string, enabled: boolean) => rpc("mg_mv_set_anonymous", { p_site: siteId, p_enabled: enabled });

// trends, attention list and ageing (reviewers)
export interface MinistryTrends {
  months: { month: string; total: number; safety: number; labour: number; conduct: number; other: number }[];
  attention: { organization_id: string; name: string; reports90: number; previous90: number; serious90: number; sites90: number; topCategory: string | null; why: string }[];
  ageing: { unacknowledged3d: number; open14d: number; open30d: number };
  notice: string; limits: string[];
}
export const ministryTrends = (months = 6) => rpc<MinistryTrends>("mg_mv_trends", { p_months: months });

// requests to a company (Ministry administrators send; company administrators answer)
export const REQUEST_TOPICS = [
  { value: "working_hours_and_rest", label: "Working hours and rest breaks" },
  { value: "wages_and_benefits_records", label: "Wages and benefits records" },
  { value: "safety_training_and_ppe", label: "Safety training and protective equipment" },
  { value: "hazard_controls_and_maintenance", label: "Hazard controls and maintenance records" },
  { value: "workplace_conduct_and_discrimination", label: "Workplace conduct and discrimination" },
  { value: "contracts_and_dismissals", label: "Contracts and dismissals" },
] as const;
export interface CompanyRequest { id: string; organization_id: string; organization_name: string; topic: string; note: string | null; created_on: string; status: "open" | "answered" | "closed"; responses: { from: "Ministry" | "Company"; text: string; on: string }[] }
export const listRequests = () => rpc<CompanyRequest[]>("mg_mr_list");
export const createRequest = (orgId: string, topic: string, note?: string) => rpc<string>("mg_mr_create", { p_org: orgId, p_topic: topic, p_note: note ?? null });
export const respondToRequest = (id: string, body: string) => rpc("mg_mr_respond", { p_id: id, p_body: body });
export const followUpRequest = (id: string, body: string, close: boolean) => rpc("mg_mr_followup", { p_id: id, p_body: body, p_close: close });
export function explainRequestError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/TOO_FEW/.test(m)) return "There are not enough reports on this topic to ask this company without risking identifying a reporter.";
  if (/CONFLICT: this company was already asked/.test(m)) return "This company was already asked about this topic in the last 30 days.";
  if (/closed/.test(m)) return "This request is closed.";
  if (/FORBIDDEN/.test(m)) return "You are not allowed to do that.";
  if (/INVALID/.test(m)) return m.replace(/^.*INVALID:\s*/, "");
  return "That could not be completed. Nothing was changed; try again.";
}
