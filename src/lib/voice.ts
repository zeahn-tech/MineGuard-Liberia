// ---------------------------------------------------------------------------
// WORKER VOICE — client side (Implementation Phase 4; migration 0046).
//
// ANONYMITY RULES THIS FILE ENFORCES
//   * An anonymous report is sent from `anonymousClient()`: a separate Supabase client that has NO
//     session, persists nothing and never reads the signed-in user's token. The request carries only
//     the public key. Nothing about the person is added to the payload.
//   * The follow-up code is generated HERE, on the device, from the browser's CSPRNG (96 bits). The
//     server stores only a hash of it. We never send it anywhere except in the submit and status calls.
//   * Nothing here logs, tracks or reports the content, the code or the mode.
// ---------------------------------------------------------------------------
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase";

export type VoiceMode = "named" | "confidential" | "anonymous";

export const VOICE_CATEGORIES = [
  { value: "unsafe_condition", label: "Unsafe working condition" },
  { value: "near_miss", label: "Near miss" },
  { value: "equipment_hazard", label: "Equipment or maintenance hazard" },
  { value: "unsafe_procedure", label: "Unsafe procedure" },
  { value: "repeated_concern", label: "Repeated safety concern" },
  { value: "unresolved_action", label: "Unresolved corrective action" },
  { value: "other", label: "Other safety concern" },
] as const;
export type VoiceCategory = (typeof VOICE_CATEGORIES)[number]["value"];

export const VOICE_URGENCIES = [
  { value: "low", label: "Low — can wait for routine follow-up" },
  { value: "medium", label: "Medium — should be looked at soon" },
  { value: "high", label: "High — could cause serious harm" },
  { value: "critical", label: "Critical — immediate danger" },
] as const;
export type VoiceUrgency = (typeof VOICE_URGENCIES)[number]["value"];

export const VOICE_PREVIOUS = [
  { value: "no", label: "No, this is the first report" },
  { value: "yes", label: "Yes, it has been reported before" },
  { value: "unsure", label: "I am not sure" },
] as const;

export const MAX_DESCRIPTION = 4000;
export const MIN_DESCRIPTION = 10;

/** What each mode means, in plain words. Shown BEFORE anything sensitive is typed. */
export const MODE_INFO: Record<VoiceMode, { title: string; summary: string; who: string; limits: string[] }> = {
  named: {
    title: "Named report",
    summary: "Your name is attached, like any other safety record.",
    who: "The people who review this report can see who sent it: your company's administrator, and the site manager and safety officers assigned to the site. Ministry staff for your area (administrators, supervisors and inspectors) can also read it and see your name.",
    limits: ["You are signed in, so MineGuard's server records show that your account sent a report."],
  },
  confidential: {
    title: "Confidential report",
    summary: "We keep your identity, but your company's own administrators, managers and safety officers cannot open it.",
    who: "Only Ministry staff for your area (administrators, supervisors and inspectors) can open your identity, and only by stating a purpose. Every opening is recorded, and you can see how many times it was opened. Your company's reviewers read the report itself, without your name.",
    limits: [
      "You are signed in to send it, so MineGuard's server records show that your account sent a report.",
      "Your identity is protected by access rules, not by being absent: Ministry staff for your area can open it.",
      "The report is shown to reviewers with an hourly time (a day at a small site), not an exact one.",
    ],
  },
  anonymous: {
    title: "Anonymous report",
    summary: "No name or account is attached. It is sent without using your sign-in.",
    who: "Nobody at MineGuard holds your identity for this report, because none is collected.",
    limits: [
      "Anonymous does not mean untraceable. What you write, or the details you give, can point to you, especially on a small crew or a small site.",
      "Your phone, your network and the internet connection can show that a request was made. Those logs are outside MineGuard's report records and we cannot promise they are never kept.",
      "MineGuard does not store your address, device or browser with the report. A scrambled network key is used briefly to stop spam; it is never linked to a report.",
      "If you save it on this phone before sending, the text is on this phone until it is sent or you delete it.",
      "Photos can identify you even with hidden data removed: faces, name tags, your own equipment or where you were standing.",
      "No one has independently certified this design.",
    ],
  },
};

export const RETALIATION_NOTICE =
  "MineGuard cannot guarantee protection from retaliation. Protection under your company's procedures and the law must be pursued through the appropriate channels.";
export const ROUTING_NOTICE =
  "This report goes to your company's reviewers in MineGuard. Ministry staff for your area (administrators, supervisors and inspectors) can also read it. They are not notified and cannot act on it. It is not sent to any other regulator.";
export const PERSONAL_INFO_NOTICE =
  "Describe what is wrong, where, and when. Leave out names, phone numbers, health details and anything about other people that the safety concern does not need.";
export const PHOTO_NOTICE =
  "You can add up to 3 photos. Camera, time and location data is removed on your phone and checked again by MineGuard, which refuses a photo that still carries any. What the picture shows is not removed: avoid faces, name tags and anything that points to you. Photos are shown only to reviewers and Ministry staff for your area, never through a link. They are not scanned for viruses.";
export const SMALL_SITE_NOTICE =
  "This is a small site (fewer than 10 people are assigned). Details such as your shift, your equipment or who was present may point to you. Reviewers will see only the day, not the hour. Consider general wording.";

// ---- follow-up code -------------------------------------------------------------------------------
const HEX = /^[0-9A-F]{24}$/;

/** 96 random bits as 24 upper-case hex characters, with at least 8 distinct characters. */
export function newFollowUpCode(rand: (b: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  for (let i = 0; i < 8; i++) {
    const hex = Array.from(rand(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
    if (new Set(hex).size >= 8) return hex;
  }
  throw new Error("Could not make a safe follow-up code on this device");
}
export const formatFollowUpCode = (c: string) => `WV-${c.match(/.{4}/g)?.join("-") ?? c}`;
/** Accepts WV-1234-..., spaces, lower case. Returns the 24 hex characters or null. */
export function parseFollowUpCode(raw: string): string | null {
  const t = raw.toUpperCase().replace(/^\s*WV[-\s_]?/, "").replace(/[^0-9A-Z]/g, "");
  return HEX.test(t) ? t : null;
}
export const normalizeSiteCode = (raw: string) => raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
export const formatSiteCode = (c: string) => (c.length === 10 ? `${c.slice(0, 5)}-${c.slice(5)}` : c);

// ---- the anonymous client --------------------------------------------------------------------------
let anon: SupabaseClient | null = null;
/** A client with no session: used for every anonymous call. */
export function anonymousClient(): SupabaseClient {
  anon ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "wv-anonymous-no-session" },
  });
  return anon;
}
export function __setAnonymousClient(c: SupabaseClient | null) { anon = c; }

// ---- sending ------------------------------------------------------------------------------------------
export interface VoiceFields {
  category: VoiceCategory;
  urgency: VoiceUrgency;
  description: string;
  /** ISO string, approximate, optional */
  occurredAt: string | null;
  previouslyReported: "no" | "yes" | "unsure";
  /** true = the concern is about the people who would normally review it */
  concernsReviewer: boolean;
}

export const MAX_REPLY = 1000;
export interface QueuedReport {
  id: string;
  mode: VoiceMode;
  /** named / confidential: the site to send to */
  siteId?: string;
  /** anonymous: the code posted at the site */
  siteCode?: string;
  fields: VoiceFields;
  /** base64 JPEGs, already cleaned on the device */
  attachments?: string[];
  code: string;
  savedAt: string;
  state: "saved_on_device" | "sending" | "needs_attention";
  attention?: string;
  attempts: number;
}

export type SendOutcome =
  | { kind: "received" | "duplicate" }
  | { kind: "rate_limited" | "invalid_site_code" | "anonymous_paused" | "network" | "signed_out" | "forbidden" }
  | { kind: "invalid"; message: string };

function fromRpc(error: { message?: string; code?: string } | null, data: unknown): SendOutcome {
  if (error) {
    const m = error.message ?? "";
    if (/UNAUTHENTICATED|JWT/i.test(m)) return { kind: "signed_out" };
    if (/FORBIDDEN/i.test(m)) return { kind: "forbidden" };
    if (/INVALID/i.test(m)) return { kind: "invalid", message: m.replace(/^.*INVALID:\s*/, "") };
    return { kind: "network" };
  }
  const r = (data ?? {}) as { status?: string; message?: string };
  switch (r.status) {
    case "received": case "duplicate": case "rate_limited": case "invalid_site_code": case "anonymous_paused": return { kind: r.status };
    case "invalid": return { kind: "invalid", message: r.message ?? "The report could not be accepted." };
    default: return { kind: "network" };
  }
}

export async function sendReport(item: QueuedReport): Promise<SendOutcome> {
  const f = item.fields;
  try {
    if (item.mode === "anonymous") {
      const { data, error } = await anonymousClient().rpc("mg_wv_submit_anonymous", {
        p_site_code: normalizeSiteCode(item.siteCode ?? ""), p_category: f.category, p_urgency: f.urgency,
        p_description: f.description, p_occurred: f.occurredAt, p_previously: f.previouslyReported,
        p_concerns: f.concernsReviewer, p_code: item.code, p_attachments: item.attachments?.length ? item.attachments : null,
      });
      return fromRpc(error, data);
    }
    const { data, error } = await supabase.rpc("mg_wv_submit", {
      p_mode: item.mode, p_site: item.siteId, p_category: f.category, p_urgency: f.urgency,
      p_description: f.description, p_occurred: f.occurredAt, p_previously: f.previouslyReported,
      p_concerns: f.concernsReviewer, p_code: item.code, p_attachments: item.attachments?.length ? item.attachments : null,
    });
    return fromRpc(error, data);
  } catch {
    return { kind: "network" };
  }
}

export interface ThreadMessage { from: "you" | "reviewers"; text: string; on: string }
export interface FollowUpStatus { found: boolean; status?: string; stage?: string; closed?: boolean; lastChange?: string; update?: string | null; updateOn?: string | null; messages?: ThreadMessage[]; canReply?: boolean }
export async function lookupFollowUp(rawCode: string): Promise<FollowUpStatus> {
  const code = parseFollowUpCode(rawCode);
  if (!code) return { found: false };
  const { data, error } = await anonymousClient().rpc("mg_wv_status", { p_code: code });
  if (error) throw new Error("lookup failed");
  return data as FollowUpStatus;
}

export type ReplyOutcome = "received" | "rate_limited" | "invalid" | "not_found" | "closed" | "network";
/** Reply with the follow-up code alone. Sent from the session-less client: nothing identifies the sender. */
export async function replyWithCode(rawCode: string, text: string): Promise<ReplyOutcome> {
  const code = parseFollowUpCode(rawCode);
  if (!code) return "not_found";
  try {
    const { data, error } = await anonymousClient().rpc("mg_wv_reply", { p_code: code, p_text: text });
    if (error) return "network";
    const st = (data as { status?: string } | null)?.status;
    return st === "received" || st === "rate_limited" || st === "invalid" || st === "not_found" || st === "closed" ? st : "network";
  } catch { return "network"; }
}
export async function replyMine(reportId: string, text: string): Promise<void> {
  const { error } = await supabase.rpc("mg_wv_reply_mine", { p_id: reportId, p_text: text });
  if (error) throw new Error(error.message);
}

export interface SiteInfo { valid: boolean; smallSite?: boolean; paused?: boolean; status?: string }
/** What to tell a person about a site before they send, from the posted code. A wrong code counts as a guess. */
export async function siteInfoByCode(rawCode: string): Promise<SiteInfo> {
  try {
    const { data, error } = await anonymousClient().rpc("mg_wv_site_info", { p_site_code: normalizeSiteCode(rawCode) });
    return error ? { valid: false } : (data as SiteInfo);
  } catch { return { valid: false }; }
}
export async function siteIsSmall(siteId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("mg_wv_site_small", { p_site: siteId });
  return !error && data === true;
}
