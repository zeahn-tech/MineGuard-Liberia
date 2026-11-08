// ---------------------------------------------------------------------------
// REQUEST HANDLER — everything the Edge Function does, minus the runtime.
//
// Order of operations (each step is asserted in tests/ai-assist.test.ts):
//   1. identity comes from the caller's verified JWT (index.ts), never the body;
//   2. an account with no role is refused (and the refusal is logged);
//   3. the capability runs on the caller's own RLS-bound client;
//   4. cite-or-abstain drops every statement not grounded in retrieved records;
//   5. (only if a provider is approved AND the input looked clean) a model may
//      reword the surviving statements — nothing else;
//   6. exactly one ai_request_log row is written; if that fails, the answer is
//      WITHHELD (no unlogged AI output);
//   7. the response carries the AI label.
// ---------------------------------------------------------------------------

import {
  AiError, CAPABILITIES, makeEnvelope, sha256Hex,
  type AiEnvelope, type AiMode, type AiOutcome, type Caller, type Capability, type Claim, type ScopedDb,
} from "./contract.ts";
import { enforceCiteOrAbstain } from "./cite.ts";
import { detectInjection } from "./injection.ts";
import { analyzeDocument, executiveBriefing, inspectionPriorities, siteSummary, trendNotes, type Draft } from "./capabilities.ts";
import { incidentTrendSummary, riskPatterns } from "./insights.ts";
import { isEmergencyQuery, safetyGuidance, type SiteContact } from "./guidance.ts";
import { jsaSuggestions } from "./jsa-assist.ts";
import { executeFilter, parseQuestion, validateFilter, type SearchFilter } from "./filters.ts";
import { narrate, translateWithProvider, type ProviderAdapter } from "./provider.ts";

export interface HandlerDeps {
  db: ScopedDb;
  caller: Caller;
  provider: ProviderAdapter | null;
  now?: () => Date;
  /** Max requests per user per rolling hour, counted from ai_request_log.
   *  Unset = no limit (unit tests); the Edge Function always sets it. */
  rateLimitPerHour?: number;
}
export interface HandlerResult {
  status: number;
  body: AiEnvelope | { error: string; message: string };
}

const MAX_QUERY = 500;
/** Largest request body the handler will look at (characters of JSON). */
export const MAX_BODY_CHARS = 32_000;
export const DEFAULT_RATE_LIMIT_PER_HOUR = 60;
const NARRATABLE: Capability[] = ["site_summary", "trend_notes", "inspection_priorities", "executive_briefing"];

async function nlSearch(deps: HandlerDeps, queryRaw: unknown, now: Date): Promise<Draft & { filter: SearchFilter | null; providerUsed: boolean }> {
  if (typeof queryRaw !== "string" || queryRaw.trim().length === 0) throw new AiError("BAD_REQUEST", "query must be a non-empty string");
  if (queryRaw.length > MAX_QUERY) throw new AiError("BAD_REQUEST", `query is limited to ${MAX_QUERY} characters`);
  const flagged = detectInjection(queryRaw).length > 0;
  const notices: string[] = [];
  if (flagged) notices.push("Instruction-like text in the question was ignored; only searchable criteria were used.");

  let filter: SearchFilter | null = null;
  let providerUsed = false;
  let interpretation: string[] = [];

  // A model may propose a filter ONLY when the question looks clean, and its
  // proposal passes the same allowlist validator as the built-in parser.
  if (deps.provider && !flagged) {
    const proposed = await translateWithProvider(deps.provider, queryRaw);
    const v = validateFilter(proposed);
    if (v.ok) {
      filter = v.filter;
      providerUsed = true;
      interpretation = ["Filter proposed by the AI provider and checked against the search allowlist."];
    }
  }
  if (!filter) {
    const parsed = parseQuestion(queryRaw, now);
    filter = parsed.filter;
    interpretation = parsed.interpretation;
    notices.push(...parsed.notes);
  }
  const retrieved = new Set<string>();
  if (!filter) {
    return { claims: [], data: null, retrieved, notices, abstainReason: "The question could not be translated into a supported search. Try naming what to look for, for example \"overdue corrective actions\" or \"critical incidents in Bomi in the last 90 days\".", filter: null, providerUsed, injectionFlagged: flagged };
  }
  const res = await executeFilter(deps.db, filter);
  for (const r of res.rows) retrieved.add(String(r.id));
  if (res.truncated) notices.push(`Showing the first ${filter.limit} matches; there are more.`);
  if (res.rows.length === 0) {
    return { claims: [], data: null, retrieved, notices, abstainReason: "No records matching the question were found within your access.", filter, providerUsed, injectionFlagged: flagged };
  }
  const label = filter.entity.replace(/_/g, " ");
  const claims: Claim[] = [{
    text: `${res.rows.length}${res.truncated ? "+" : ""} ${label} match the question (${interpretation.join("; ") || "no further criteria"}).`,
    citations: res.rows.slice(0, 25).map((r) => String(r.id)),
  }];
  return { claims, data: { entity: res.entity, filter, interpretation, rows: res.rows, truncated: res.truncated }, retrieved, notices, abstainReason: null, filter, providerUsed, injectionFlagged: flagged };
}

/** Fails CLOSED: if the log cannot be read, the request is refused. */
async function enforceRateLimit(deps: HandlerDeps, now: Date): Promise<void> {
  const limit = deps.rateLimitPerHour;
  if (limit === undefined) return;
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  let rows: unknown[] = [];
  try {
    const { data, error } = await deps.db.from("ai_request_log").select("id").eq("user_id", deps.caller.id).gte("created_at", since).limit(limit);
    if (error) throw error;
    rows = Array.isArray(data) ? data : [];
  } catch {
    throw new AiError("RATE_LIMIT_UNAVAILABLE", "Usage limits could not be checked, so the request was not run.");
  }
  if (rows.length >= limit) throw new AiError("RATE_LIMITED", `Request limit reached (${limit} per hour). Try again later.`);
}

/** The caller's own emergency contacts, read under THEIR row-level security (so another
 *  company's contacts can never appear). Fetched only for emergency questions; any failure
 *  means "no contacts", never a guess. */
async function loadContacts(db: ScopedDb): Promise<SiteContact[]> {
  try {
    const { data, error } = await db.from("emergency_contacts").select("id, name, phone, role_label, site_id, sort_order")
      .eq("active", true).order("sort_order", { ascending: true }).limit(20);
    if (error || !Array.isArray(data)) return [];
    return (data as Record<string, unknown>[]).filter((r) => typeof r.id === "string" && typeof r.name === "string" && typeof r.phone === "string")
      .map((r) => ({ id: r.id as string, name: r.name as string, phone: r.phone as string, role_label: typeof r.role_label === "string" ? r.role_label : null }));
  } catch {
    return [];
  }
}

export async function handleAiRequest(deps: HandlerDeps, body: unknown): Promise<HandlerResult> {
  const started = Date.now();
  const now = (deps.now ?? (() => new Date()))();
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const capability = b.capability as Capability;

  let outcome: AiOutcome = "error";
  let mode: AiMode = "deterministic";
  let providerId: string | null = null;
  let errorCode: string | null = null;
  let injectionFlagged = false;
  let retrievedCount = 0;
  let citationCount = 0;
  let droppedCount = 0;
  let filterLog: unknown = null;
  let queryText: string | null = null;
  let envelope: AiEnvelope | null = null;
  let status = 200;
  let errBody: { error: string; message: string } | null = null;

  try {
    if (!(CAPABILITIES as readonly string[]).includes(capability)) throw new AiError("BAD_REQUEST", "unknown capability");
    if (!deps.caller.role) throw new AiError("FORBIDDEN", "AI assistance is available to accounts with an assigned role");
    if (JSON.stringify(b).length > MAX_BODY_CHARS) throw new AiError("BAD_REQUEST", `request is limited to ${MAX_BODY_CHARS} characters`);
    await enforceRateLimit(deps, now);

    let draft: Draft;
    switch (capability) {
      case "nl_search": {
        const r = await nlSearch(deps, b.query, now);
        draft = r;
        filterLog = r.filter;
        queryText = b.query as string;
        if (r.providerUsed) mode = "provider";
        break;
      }
      case "site_summary":
        draft = await siteSummary(deps.db, b.siteId, now);
        filterLog = { siteId: b.siteId };
        break;
      case "trend_notes":
        draft = await trendNotes(deps.db, { siteId: b.siteId, months: b.months }, now);
        filterLog = { siteId: b.siteId ?? null, months: b.months ?? null };
        break;
      case "inspection_priorities":
        draft = await inspectionPriorities(deps.db, b.limit, now);
        break;
      case "executive_briefing":
        draft = await executiveBriefing(deps.db, now);
        break;
      case "incident_trend_summary":
        draft = await incidentTrendSummary(deps.db, { siteId: b.siteId, days: b.days }, now);
        filterLog = { siteId: b.siteId ?? null, days: b.days ?? null };
        break;
      case "risk_patterns":
        draft = await riskPatterns(deps.db, { siteId: b.siteId, months: b.months }, now);
        filterLog = { siteId: b.siteId ?? null, months: b.months ?? null };
        break;
      case "safety_guidance":
        draft = safetyGuidance(b.query, isEmergencyQuery(b.query) ? await loadContacts(deps.db) : []);
        queryText = typeof b.query === "string" ? b.query : null; // logged as hash + length only
        break;
      case "jsa_suggestions":
        draft = jsaSuggestions({ task: b.task, location: b.location });
        queryText = typeof b.task === "string" ? b.task : null; // logged as hash + length only
        break;
      case "document_analysis":
        draft = analyzeDocument(b.text);
        queryText = typeof b.text === "string" ? b.text : null;
        break;
    }
    injectionFlagged = draft.injectionFlagged === true;
    retrievedCount = draft.retrieved.size;

    const first = enforceCiteOrAbstain(draft.claims, draft.retrieved);
    let kept = first.kept;
    droppedCount = first.dropped;
    let abstainReason = draft.abstainReason;
    if (!abstainReason && kept.length === 0) abstainReason = "No statement could be grounded in records available to you.";

    // Optional wording pass: never for flagged input, never for search/document output.
    if (!abstainReason && deps.provider && !injectionFlagged && NARRATABLE.includes(capability)) {
      const n = await narrate(deps.provider, kept);
      if (n.reworded > 0) {
        const again = enforceCiteOrAbstain(n.claims, draft.retrieved);
        kept = again.kept;
        droppedCount += again.dropped;
        mode = "provider";
        providerId = deps.provider.id;
      }
    }
    if (mode === "provider" && !providerId) providerId = deps.provider?.id ?? null;

    envelope = makeEnvelope({ capability, mode, providerId, claims: kept, data: draft.data, abstainReason, notices: draft.notices, now });
    citationCount = envelope.citations.length;
    outcome = envelope.abstained ? "abstained" : "answered";
  } catch (e) {
    if (e instanceof AiError) {
      errorCode = e.code;
      outcome = e.code === "FORBIDDEN" || e.code === "BAD_REQUEST" || e.code === "RATE_LIMITED" ? "refused" : "error";
      status = e.code === "FORBIDDEN" ? 403 : e.code === "BAD_REQUEST" ? 400 : e.code === "RATE_LIMITED" ? 429 : e.code === "RATE_LIMIT_UNAVAILABLE" ? 503 : 502;
      errBody = { error: e.code, message: e.message };
    } else {
      errorCode = "INTERNAL";
      status = 500;
      errBody = { error: "INTERNAL", message: "The AI assistant could not complete this request." };
    }
  }

  // Exactly one log row per request. No log, no answer.
  const capForLog = (CAPABILITIES as readonly string[]).includes(capability) ? capability : null;
  if (capForLog) {
    const row = {
      user_id: deps.caller.id,
      capability: capForLog,
      mode,
      provider_id: providerId,
      outcome,
      query_sha256: queryText !== null ? await sha256Hex(queryText) : null,
      query_length: queryText !== null ? queryText.length : null,
      filters: filterLog ?? null,
      record_count: retrievedCount,
      citation_count: citationCount,
      dropped_citations: droppedCount,
      injection_flagged: injectionFlagged,
      error_code: errorCode,
      latency_ms: Date.now() - started,
    };
    let logError: unknown = null;
    try {
      const res = await deps.db.from("ai_request_log").insert(row);
      logError = res?.error ?? null;
    } catch (e) {
      logError = e;
    }
    if (logError) {
      return { status: 503, body: { error: "LOG_UNAVAILABLE", message: "The request could not be recorded, so no AI output is returned." } };
    }
  }

  if (errBody) return { status, body: errBody };
  return { status: 200, body: envelope! };
}
