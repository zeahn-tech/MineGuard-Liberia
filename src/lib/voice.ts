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
//
// TWO SEPARATE CHANNELS (company: migration 0046; Ministry: migration 0050). The person picks one
// per report. Company reports go to the company's own administrators; Ministry reports go to
// Ministry reviewers only and are never visible to the company. Same privacy modes, same device
// queue, same anonymity rules; different tables, different follow-up-code prefix (WV- / MV-).
// ---------------------------------------------------------------------------
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase";

export type VoiceMode = "named" | "confidential" | "anonymous";
/** Who receives the report. "company" = the company's administrators (0046). "ministry" = Ministry reviewers (0050). */
export type VoiceChannel = "company" | "ministry";

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

/** What a worker can flag to the Ministry about a company: labour practices, unsafe work practices, bad work habits. */
export const MINISTRY_CATEGORIES = [
  { value: "wages_or_benefits", label: "Unpaid, late or withheld wages or benefits", group: "labour" },
  { value: "working_hours", label: "Excessive hours, forced overtime or no rest", group: "labour" },
  { value: "harassment_or_discrimination", label: "Harassment, abuse or discrimination", group: "labour" },
  { value: "retaliation", label: "Retaliation for raising a concern", group: "labour" },
  { value: "child_or_forced_labour", label: "Child labour or forced labour", group: "labour" },
  { value: "contract_or_dismissal", label: "No contract, or unfair dismissal", group: "labour" },
  { value: "unsafe_practice", label: "Unsafe work practice", group: "safety" },
  { value: "missing_ppe_or_training", label: "No protective equipment or safety training", group: "safety" },
  { value: "hazard_ignored", label: "A known hazard the company has not fixed", group: "safety" },
  { value: "falsified_records", label: "Falsified safety or inspection records", group: "safety" },
  { value: "bad_work_habit", label: "Bad work habit (shortcuts, negligence, misconduct on site)", group: "conduct" },
  { value: "other", label: "Other concern about the company", group: "other" },
] as const;
export type MinistryCategory = (typeof MINISTRY_CATEGORIES)[number]["value"];
export const MINISTRY_GROUP_LABEL: Record<string, string> = { labour: "Labour practices", safety: "Unsafe work practices", conduct: "Work habits and conduct", other: "Other" };

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
    who: "The people who review this report can see who sent it: the company administrator, and the site manager and safety officers assigned to the site.",
    limits: ["You are signed in, so MineGuard's server records show that your account sent a report."],
  },
  confidential: {
    title: "Confidential report",
    summary: "We keep your identity, but it is hidden from ordinary users and from the site's managers and safety officers.",
    who: "Only a company administrator can open your identity, and only by stating a purpose. Every opening is recorded, and you can see how many times it was opened. The report itself is read by its reviewers.",
    limits: [
      "You are signed in to send it, so MineGuard's server records show that your account sent a report.",
      "Your identity is protected by access rules, not by being absent: a company administrator can open it.",
      "The report is shown to reviewers with an hourly time, not an exact one.",
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
      "No one has independently certified this design.",
    ],
  },
};

/** The Ministry channel: same three modes, but the audience and the custodian of an identity are different. */
export const MINISTRY_MODE_INFO: Record<VoiceMode, { title: string; summary: string; who: string; limits: string[] }> = {
  named: {
    title: "Named report to the Ministry",
    summary: "Your name is attached so Ministry reviewers can contact you.",
    who: "Ministry reviewers can see who sent it. Your company's administrators, managers and safety officers cannot see this report in MineGuard.",
    limits: ["You are signed in, so MineGuard's server records show that your account sent a report."],
  },
  confidential: {
    title: "Confidential report to the Ministry",
    summary: "We keep your identity, but it is hidden from ordinary users, from your company and from most Ministry reviewers.",
    who: "Only a Ministry administrator can open your identity, and only by stating a purpose. Every opening is recorded, and you can see how many times it was opened. Your company cannot open it.",
    limits: [
      "You are signed in to send it, so MineGuard's server records show that your account sent a report.",
      "Your identity is protected by access rules, not by being absent: a Ministry administrator can open it.",
      "The report is shown to reviewers with an hourly time, not an exact one.",
      "What you describe may let your company guess who you are, especially on a small crew.",
    ],
  },
  anonymous: {
    title: "Anonymous report to the Ministry",
    summary: "No name or account is attached. It is sent without using your sign-in.",
    who: "Nobody at MineGuard holds your identity for this report, because none is collected. The report does name your site and company, because the Ministry needs to know which one it is about.",
    limits: [
      "Anonymous does not mean untraceable. What you write, or the details you give, can point to you, especially on a small crew or a small site.",
      "Your phone, your network and the internet connection can show that a request was made. Those logs are outside MineGuard's report records and we cannot promise they are never kept.",
      "MineGuard does not store your address, device or browser with the report. A scrambled network key is used briefly to stop spam; it is never linked to a report.",
      "If you save it on this phone before sending, the text is on this phone until it is sent or you delete it.",
      "No one has independently certified this design.",
    ],
  },
};
export const MINISTRY_ROUTING_NOTICE =
  "This report goes to Ministry reviewers in MineGuard. Your company's administrators and managers cannot see it in MineGuard. Sending it does not start an investigation by itself, and the Ministry may not be able to tell you what it decides.";
export const MINISTRY_EMERGENCY_NOTICE =
  "If someone is in danger right now, follow your site's emergency procedure first. This is not an alarm and the Ministry does not respond to it in real time.";

export const RETALIATION_NOTICE =
  "MineGuard cannot guarantee protection from retaliation. Protection under your company's procedures and the law must be pursued through the appropriate channels.";
export const ROUTING_NOTICE =
  "This report goes to your company's reviewers in MineGuard. It is not sent to the Ministry or to any regulator.";
export const PERSONAL_INFO_NOTICE =
  "Describe what is wrong, where, and when. Leave out names, phone numbers, health details and anything about other people that the safety concern does not need.";
export const PHOTO_NOTICE =
  "You can add up to 3 photos. Camera, time and location data is removed on your phone and checked again by MineGuard, which refuses a photo that still carries any. What the picture shows is not removed: avoid faces, name tags and anything that points to you. Photos are shown only to the reviewers of the channel you chose, never through a link. They are not scanned for viruses.";
export const SMALL_SITE_NOTICE =
  "This is a small site (fewer than 10 people are assigned). Details such as your shift, your equipment or who was present may point to you. Reviewers will see only the day, not the hour. Consider general wording.";
/** Shown when the concern is about a company administrator or the company's management: a company route cannot be neutral. */
export const ABOUT_MANAGEMENT_NOTICE =
  "A report about a company administrator or the company's management should not go to the company. Send it to the Ministry instead: your company cannot see the Ministry channel.";
/** Shown to a reporter whose company report is unresolved for two weeks, or closed. It makes no link between the reports. */
export const MINISTRY_OPTION_NOTICE =
  "If you are not satisfied with how your company has handled this, you can send a separate report to the Ministry. The two reports are not linked, and your company will not see the Ministry one.";

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
export const formatFollowUpCode = (c: string, channel: VoiceChannel = "company") =>
  `${channel === "ministry" ? "MV" : "WV"}-${c.match(/.{4}/g)?.join("-") ?? c}`;
/** Accepts WV-1234-..., spaces, lower case. Returns the 24 hex characters or null. */
export function parseFollowUpCode(raw: string): string | null {
  const t = raw.toUpperCase().replace(/^\s*WV[-\s_]?/, "").replace(/[^0-9A-Z]/g, "");
  return HEX.test(t) ? t : null;
}
/** Which channel a typed code belongs to: "MV-" = Ministry, "WV-" = company, no prefix = unknown (try both). */
export function parseAnyFollowUpCode(raw: string): { code: string; channel: VoiceChannel | null } | null {
  const lead = raw.trim().toUpperCase().match(/^(WV|MV)[-\s_]?/);
  const channel: VoiceChannel | null = lead ? (lead[1] === "MV" ? "ministry" : "company") : null;
  const t = raw.toUpperCase().replace(/^\s*(WV|MV)[-\s_]?/, "").replace(/[^0-9A-Z]/g, "");
  return HEX.test(t) ? { code: t, channel } : null;
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
  category: VoiceCategory | MinistryCategory;
  urgency: VoiceUrgency;
  description: string;
  /** ISO string, approximate, optional */
  occurredAt: string | null;
  previouslyReported: "no" | "yes" | "unsure";
  /** true = the concern is about the people who would normally review it (company channel only) */
  concernsReviewer: boolean;
}
export interface QueuedReport {
  id: string;
  /** Absent on items saved before the Ministry channel existed: those are company reports. */
  channel?: VoiceChannel;
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
  if (item.channel === "ministry") return sendMinistryReport(item);
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

/** The Ministry channel: same shape and same anonymity rules as above, to the mg_mv_* functions (0050). */
async function sendMinistryReport(item: QueuedReport): Promise<SendOutcome> {
  const f = item.fields;
  try {
    if (item.mode !== "anonymous") {
      const { data, error } = await supabase.rpc("mg_mv_submit", {
        p_mode: item.mode, p_site: item.siteId, p_category: f.category, p_urgency: f.urgency,
        p_description: f.description, p_occurred: f.occurredAt, p_previously: f.previouslyReported, p_code: item.code, p_attachments: item.attachments?.length ? item.attachments : null,
      });
      return fromRpc(error, data);
    }
    // anonymous: the session-less client only, exactly as for the company channel
    const { data, error } = await anonymousClient().rpc("mg_mv_submit_anonymous", {
      p_site_code: normalizeSiteCode(item.siteCode ?? ""), p_category: f.category, p_urgency: f.urgency,
      p_description: f.description, p_occurred: f.occurredAt, p_previously: f.previouslyReported, p_code: item.code, p_attachments: item.attachments?.length ? item.attachments : null,
    });
    return fromRpc(error, data);
  } catch {
    return { kind: "network" };
  }
}

export interface ThreadMessage { from: "you" | "reviewers"; text: string; on: string }
export interface FollowUpStatus { found: boolean; status?: string; stage?: string; closed?: boolean; lastChange?: string; update?: string | null; updateOn?: string | null; messages?: ThreadMessage[]; canReply?: boolean; ministryOption?: boolean; channel?: VoiceChannel }
export async function lookupFollowUp(rawCode: string): Promise<FollowUpStatus> {
  const parsed = parseAnyFollowUpCode(rawCode);
  if (!parsed) return { found: false };
  const ask = async (fn: "mg_wv_status" | "mg_mv_status") => {
    const { data, error } = await anonymousClient().rpc(fn, { p_code: parsed.code });
    if (error) throw new Error("lookup failed");
    return { ...(data as FollowUpStatus), channel: fn === "mg_mv_status" ? ("ministry" as const) : ("company" as const) };
  };
  // a prefix names the channel; without one, try the company channel first and then the Ministry's
  if (parsed.channel === "ministry") return ask("mg_mv_status");
  const first = await ask("mg_wv_status");
  if (first.found || parsed.channel === "company" || first.status === "rate_limited") return first;
  return ask("mg_mv_status");
}

export const MAX_REPLY = 1000;
export type ReplyOutcome = "received" | "rate_limited" | "invalid" | "not_found" | "closed" | "network";
/** Reply with the follow-up code alone, from the session-less client: nothing identifies the sender. */
export async function replyWithCode(rawCode: string, text: string, channel: VoiceChannel): Promise<ReplyOutcome> {
  const parsed = parseAnyFollowUpCode(rawCode);
  if (!parsed) return "not_found";
  try {
    const { data, error } = await anonymousClient().rpc(channel === "ministry" ? "mg_mv_reply" : "mg_wv_reply", { p_code: parsed.code, p_text: text });
    if (error) return "network";
    const st = (data as { status?: string } | null)?.status;
    return st === "received" || st === "rate_limited" || st === "invalid" || st === "not_found" || st === "closed" ? st : "network";
  } catch { return "network"; }
}
export async function replyMine(reportId: string, text: string, channel: VoiceChannel): Promise<void> {
  const { error } = await supabase.rpc(channel === "ministry" ? "mg_mv_reply_mine" : "mg_wv_reply_mine", { p_id: reportId, p_text: text });
  if (error) throw new Error(error.message);
}

export interface SiteInfo { valid: boolean; smallSite?: boolean; paused?: boolean; status?: string }
/** What to tell a person about a site before they send, from the posted code. A wrong code counts as a guess. */
export async function siteInfoByCode(rawCode: string, channel: VoiceChannel): Promise<SiteInfo> {
  try {
    const { data, error } = await anonymousClient().rpc(channel === "ministry" ? "mg_mv_site_info" : "mg_wv_site_info", { p_site_code: normalizeSiteCode(rawCode) });
    return error ? { valid: false } : (data as SiteInfo);
  } catch { return { valid: false }; }
}
export async function siteIsSmall(siteId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("mg_wv_site_small", { p_site: siteId });
  return !error && data === true;
}
/** A member's app reads the CHANNEL's own code (the company's and the Ministry's are different) to send anonymously without typing it. */
export async function memberSiteCode(channel: VoiceChannel, siteId: string): Promise<string> {
  const { data, error } = await supabase.rpc(channel === "ministry" ? "mg_mv_site_code" : "mg_wv_site_code", { p_site: siteId });
  if (error) throw new Error(error.message);
  return data as string;
}
