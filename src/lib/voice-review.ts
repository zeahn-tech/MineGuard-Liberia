// Reviewer-side calls for Worker Voice. Every one is a self-authorizing RPC or a row-level-secured read:
// the page hiding a button is a courtesy, the database refusing the call is the control.
import { supabase } from "./supabase";

export type ReportStatus = "received" | "triage" | "investigating" | "action_assigned" | "follow_up" | "closed";
export interface VoiceReportRow {
  id: string; organization_id: string; site_id: string; mode: "named" | "confidential" | "anonymous"; category: string; urgency: string;
  description: string; occurred_at: string | null; previously_reported: string; route: "site" | "company_admin";
  status: ReportStatus; triage_severity: string | null; assigned_to: string | null; escalated_at: string | null;
  linked_incident_id: string | null; duplicate_of: string | null; closure_reason: string | null;
  reporter_update: string | null; created_at: string; small_site: boolean; legal_hold: boolean; legal_hold_reason: string | null; closed_at: string | null;
}
export interface MyReport { id: string; received_on: string; mode: string; category: string; stage: string; reporter_update: string | null; reporter_update_on: string | null; identity_opened: number; can_reply: boolean }

const rpc = async <T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
};

export async function listVoiceReports(): Promise<VoiceReportRow[]> {
  const { data, error } = await supabase.from("worker_voice_reports").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as VoiceReportRow[];
}
export const reviewerSites = () => rpc<{ id: string; name: string }[]>("mg_wv_reviewer_sites");
export const myVoiceReports = () => rpc<MyReport[]>("mg_wv_my_reports");
export const siteCode = (siteId: string) => rpc<string>("mg_wv_site_code", { p_site: siteId });
export const rotateSiteCode = (siteId: string) => rpc<string>("mg_wv_rotate_code", { p_site: siteId });
export const eligibleReviewers = (id: string) => rpc<{ user_id: string; name: string | null }[]>("mg_wv_reviewers", { p_id: id });
export const triage = (id: string, severity: string, assignee?: string) => rpc("mg_wv_triage", { p_id: id, p_severity: severity, p_assignee: assignee ?? null });
export const setStatus = (id: string, status: string, note?: string) => rpc("mg_wv_set_status", { p_id: id, p_status: status, p_note: note ?? null });
export const postUpdate = (id: string, text: string) => rpc("mg_wv_post_update", { p_id: id, p_text: text });
export const escalate = (id: string, reason: string) => rpc("mg_wv_escalate", { p_id: id, p_reason: reason });
export const createIncident = (id: string, type: string, description: string) => rpc<string>("mg_wv_create_incident", { p_id: id, p_type: type, p_description: description, p_occurred: null });
export const openIdentity = (id: string, purpose?: string) => rpc<{ available: boolean; name?: string | null; jobTitle?: string | null }>("mg_wv_identity", { p_id: id, p_purpose: purpose ?? null });

export function explainReviewError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/ALREADY_ESCALATED/.test(m)) return "This is already with the company administrators. For a concern about the company's administrators or management the reporter can use the Ministry channel.";
  if (/PURPOSE_REQUIRED/.test(m)) return "State why the identity is needed (at least 10 characters).";
  if (/only a company administrator can open/.test(m)) return "Only a company administrator can open a confidential identity.";
  if (/cannot review a report you sent/.test(m)) return "You sent this report, so you cannot review it.";
  if (/CLOSURE_REASON_REQUIRED/.test(m)) return "Say why the report is being closed (at least 10 characters).";
  if (/backwards/.test(m)) return "A report cannot move back to an earlier stage.";
  if (/IMMUTABLE/.test(m)) return "This report is closed and cannot be changed.";
  if (/not an authorized reviewer|cannot be assigned/.test(m)) return "That person cannot be assigned to this report.";
  if (/FORBIDDEN/.test(m)) return "You are not authorized to do that.";
  if (/INVALID/.test(m)) return m.replace(/^.*INVALID:\s*/, "");
  return "That could not be completed. Nothing was changed; try again.";
}

export interface VoiceMessage { seq: number; from_reporter: boolean; body: string; at: string }
export async function listMessages(reportId: string): Promise<VoiceMessage[]> {
  const { data, error } = await supabase.from("worker_voice_messages").select("seq, from_reporter, body, at").eq("report_id", reportId).order("seq", { ascending: true }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as VoiceMessage[];
}
export interface VoicePhoto { id: string; bytes: number; sha256: string; data: string }
export const listPhotos = (reportId: string) => rpc<VoicePhoto[]>("mg_wv_attachments", { p_report: reportId });
export const photoCounts = () => rpc<{ report_id: string; n: number }[]>("mg_wv_attachment_counts");
export interface CodeInfo { code: string; expiresOn: string; enabled: boolean; today: number; week: number; unusual: boolean }
export const codeInfo = (siteId: string) => rpc<CodeInfo>("mg_wv_code_info", { p_site: siteId });
export const setAnonymousEnabled = (siteId: string, enabled: boolean) => rpc("mg_wv_set_anonymous", { p_site: siteId, p_enabled: enabled });
export const setHold = (id: string, hold: boolean, reason?: string) => rpc("mg_wv_set_hold", { p_id: id, p_hold: hold, p_reason: reason ?? null });
export const disposeCompany = (orgId: string, dryRun: boolean, confirm?: string) => rpc<{ dryRun: boolean; eligible?: number; deleted?: number; retentionMonths: number }>("mg_wv_dispose", { p_org: orgId, p_dry_run: dryRun, p_confirm: confirm ?? null });
export const retentionPolicy = () => rpc<{ channel: string; retention_months: number }[]>("mg_voice_retention");
