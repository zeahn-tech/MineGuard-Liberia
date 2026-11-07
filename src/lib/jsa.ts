// ---------------------------------------------------------------------------
// JOB SAFETY ANALYSIS — client side. Authority lives in the database (migration 0043):
// every function here calls a self-authorizing RPC or a row-level-secured read. Hiding a
// button is a courtesy; the server refuses an unauthorized call regardless. AI is not a
// principal anywhere: suggestions are inputs a person chooses to keep, and approval is a
// separate act by a DIFFERENT authorised person.
// ---------------------------------------------------------------------------
import { supabase } from "./supabase";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type JsaStatus = "draft" | "submitted" | "approved" | "rejected";
export const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high", "critical"];

export interface JsaHazard {
  hazard: string;
  consequence?: string;
  risk_level: RiskLevel;
  control: string;
  source: "person" | "ai_suggested";
}
export interface Jsa {
  id: string;
  site_id: string;
  prepared_by: string;
  task_description: string;
  location_area: string | null;
  job_date: string;
  hazards: JsaHazard[];
  ppe: string[];
  ai_assisted: boolean;
  status: JsaStatus;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}
export interface JsaSite { id: string; name: string; code: string }

export function newKey(): string {
  return `jsa-${crypto.randomUUID()}`;
}

/** Plain-language version of a database refusal. */
export function explainJsaError(e: unknown): string {
  const m = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
  if (/FORBIDDEN.*prepared/i.test(m)) return "You prepared this JSA, so someone else must review it.";
  if (/FORBIDDEN/i.test(m)) return "You are not authorised to do that for this site.";
  if (/CONFIRMATION_REQUIRED/i.test(m)) return "Type the confirmation word exactly to continue.";
  if (/NOTE_REQUIRED/i.test(m)) return "Say what must change so the preparer can fix it.";
  if (/at least one hazard/i.test(m)) return "Add at least one hazard with a control measure before submitting.";
  if (/INVALID/i.test(m)) return "Each hazard needs a description, a risk level and a control measure.";
  if (/CONFLICT/i.test(m)) return "This JSA has changed or is no longer editable. Reload and check its status.";
  if (/UNAUTHENTICATED/i.test(m)) return "Please sign in again.";
  return "That could not be completed. Nothing was changed; try again.";
}

export async function jsaSites(): Promise<JsaSite[]> {
  const { data, error } = await supabase.rpc("mg_jsa_sites");
  if (error) throw new Error(error.message);
  return (data ?? []) as JsaSite[];
}

export async function listJsas(): Promise<Jsa[]> {
  const { data, error } = await supabase.from("job_safety_analyses").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as Jsa[];
}

export async function canReview(siteId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("mg_can_review_jsa", { p_site_id: siteId });
  return !error && data === true;
}

export interface JsaDraftInput {
  siteId: string; task: string; location?: string; jobDate: string; hazards: JsaHazard[]; ppe: string[];
}
export async function saveJsa(input: JsaDraftInput, key: string, id?: string): Promise<string> {
  const { data, error } = await supabase.rpc("mg_jsa_save", {
    p_site_id: input.siteId, p_task: input.task, p_job_date: input.jobDate,
    p_hazards: input.hazards, p_ppe: input.ppe, p_idempotency_key: key,
    p_location: input.location || null, p_id: id ?? null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}
export async function submitJsa(id: string): Promise<void> {
  const { error } = await supabase.rpc("mg_jsa_submit", { p_id: id });
  if (error) throw new Error(error.message);
}
export async function reviewJsa(id: string, decision: "approve" | "reject", confirm: string, note?: string): Promise<void> {
  const { error } = await supabase.rpc("mg_jsa_review", { p_id: id, p_decision: decision, p_confirm: confirm, p_note: note || null });
  if (error) throw new Error(error.message);
}
