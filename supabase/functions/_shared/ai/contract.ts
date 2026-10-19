// ---------------------------------------------------------------------------
// AI ASSISTANCE — contract (Session 8, AI-1; docs/08_AI_GOVERNANCE.MD).
//
// Pure TypeScript: no Deno globals, no network, no npm imports. The Edge
// Function entry (supabase/functions/ai-assist/index.ts) is the only file that
// touches the runtime; everything here is unit-testable under bun and is
// exactly what runs in production.
// ---------------------------------------------------------------------------

/** The label every AI payload carries. It is part of the DATA, not a UI toggle. */
export const AI_LABEL = "AI assistance — not an official determination";

export const CAPABILITIES = [
  "nl_search",
  "site_summary",
  "trend_notes",
  "inspection_priorities",
  "executive_briefing",
  "document_analysis",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** 'deterministic' = no model was called. 'provider' = a model shaped the
 *  wording (never the facts, citations or numbers — see narrate()). */
export type AiMode = "deterministic" | "provider";
export type AiOutcome = "answered" | "abstained" | "refused" | "error";

/** One statement of fact + the record IDs (or document spans) it is grounded in. */
export interface Claim {
  text: string;
  /** Record UUIDs the statement is derived from, or `span:<start>-<end>` for document analysis. */
  citations: string[];
}

export interface AiEnvelope<T = unknown> {
  label: typeof AI_LABEL;
  capability: Capability;
  mode: AiMode;
  providerId: string | null;
  generatedAt: string;
  abstained: boolean;
  abstainReason: string | null;
  /** Every distinct citation across `claims`; a subset of what was retrieved. */
  citations: string[];
  claims: Claim[];
  data: T | null;
  notices: string[];
}

/** The slice of a supabase-js client this module uses. Always a client built
 *  from the CALLER's JWT, so every read runs under the caller's RLS. */
export interface ScopedDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>): any;
}

export interface Caller {
  id: string;
  role: string | null;
}

export class AiError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export function makeEnvelope<T>(args: {
  capability: Capability;
  mode?: AiMode;
  providerId?: string | null;
  claims?: Claim[];
  data?: T | null;
  abstainReason?: string | null;
  notices?: string[];
  now?: Date;
}): AiEnvelope<T> {
  const claims = args.claims ?? [];
  const abstained = args.abstainReason != null;
  return {
    label: AI_LABEL,
    capability: args.capability,
    mode: args.mode ?? "deterministic",
    providerId: args.providerId ?? null,
    generatedAt: (args.now ?? new Date()).toISOString(),
    abstained,
    abstainReason: args.abstainReason ?? null,
    citations: abstained ? [] : [...new Set(claims.flatMap((c) => c.citations))].sort(),
    claims: abstained ? [] : claims,
    data: abstained ? null : (args.data ?? null),
    notices: args.notices ?? [],
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
