// Reviewer-side calls for Worker Voice. Every one is a self-authorizing RPC or a row-level-secured read:
// the page hiding a button is a courtesy, the database refusing the call is the control.
import { supabase } from "./supabase";

export type ReportStatus = "received" | "triage" | "investigating" | "action_assigned" | "follow_up" | "closed";
export interface VoiceReportRow {
  id: string; site_id: string; mode: "named" | "confidential" | "anonymous"; category: string; urgency: string;
  description: string; occurred_at: string | null; previously_reported: string; route: "site" | "company_admin";
  status: ReportStatus; triage_severity: string | null; assigned_to: string | null; escalated_at: string | null;
  linked_incident_id: string | null; duplicate_of: string | null; closure_reason: string | null;
  reporter_update: string | null; created_at: string;
}
export interface MyReport { id: string; received_on: string; mode: string; category: string; stage: string; reporter_update: string | null; reporter_update_on: string | null; identity_opened: number }

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
  if (/ALREADY_ESCALATED/.test(m)) return "This report is already with the company administrators. MineGuard has no higher route; use your company procedure or legal channels.";
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
