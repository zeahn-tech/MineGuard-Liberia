// ---------------------------------------------------------------------------
// AI ASSIST CLIENT (Session 8, AI-1) — a thin caller of the `ai-assist` Edge
// Function. Deliberately NOT part of the `api.ai` section in backend.ts, whose
// source contract (tests/ai-risk-explanation.test.ts) keeps the risk explainer
// free of any network call.
//
// The browser sends only a capability name and its parameters. Identity is the
// signed-in session's JWT, attached by supabase-js; the function derives the
// user and role from it. No provider setting or secret exists on this side.
// Every response carries `label` ("AI assistance — not an official
// determination") — render it wherever the output is shown.
// ---------------------------------------------------------------------------

import { supabase } from "./supabase";

export type AiCapability =
  | "nl_search"
  | "site_summary"
  | "trend_notes"
  | "inspection_priorities"
  | "executive_briefing"
  | "document_analysis";

export interface AiClaim {
  text: string;
  /** Record UUIDs (or `span:<start>-<end>` for document analysis). */
  citations: string[];
}

export interface AiAssistResponse<T = unknown> {
  label: string;
  capability: AiCapability;
  mode: "deterministic" | "provider";
  providerId: string | null;
  generatedAt: string;
  abstained: boolean;
  abstainReason: string | null;
  citations: string[];
  claims: AiClaim[];
  data: T | null;
  notices: string[];
}

export type AiAssistRequest =
  | { capability: "nl_search"; query: string }
  | { capability: "site_summary"; siteId: string }
  | { capability: "trend_notes"; siteId?: string; months?: number }
  | { capability: "inspection_priorities"; limit?: number }
  | { capability: "executive_briefing" }
  | { capability: "document_analysis"; text: string };

export async function askAiAssistant<T = unknown>(req: AiAssistRequest): Promise<AiAssistResponse<T>> {
  const { data, error } = await supabase.functions.invoke("ai-assist", { body: req });
  if (error) throw new Error(`AI_ASSIST_FAILED: ${error.message ?? "request failed"}`);
  return data as AiAssistResponse<T>;
}
