// ---------------------------------------------------------------------------
// MINEGUARD LIBERIA — EMERGENCY COMMAND & RESPONSE (client side)
//
// A SUPPLEMENTARY coordination aid. It does not replace the site's sirens, radios or
// site-approved emergency procedures, and it is not certified for emergency use.
//
// Authority lives in the database (migration 0040): every function here only calls a
// self-authorizing RPC. Nothing in this file is a security boundary — hiding a button
// for a role is a courtesy, the server refuses an unauthorized call regardless.
// ---------------------------------------------------------------------------

import { authUserId, backendError, supabase } from "./supabase";

export const EMERGENCY_API_VERSION = 1;

export type Severity = "advisory" | "warning" | "critical";
export type AlertStatus = "draft" | "active" | "cancelled" | "resolved";
export type TargetGroup = "all" | "workers" | "safety_officers" | "site_managers";

export const TARGET_GROUP_LABEL: Record<TargetGroup, string> = {
  all: "Everyone at the site",
  workers: "Workers and supervisors",
  safety_officers: "Safety officers",
  site_managers: "Site managers and company administrators",
};
export const SEVERITY_LABEL: Record<Severity, string> = {
  advisory: "Advisory",
  warning: "Warning",
  critical: "Critical",
};

export interface AlertUpdateNote {
  type: "updated" | "cancelled" | "resolved";
  revision: number;
  at: string;
  note: string | null;
}

/** What a worker's device is told about an alert (mg_my_emergency_alerts). */
export interface MyAlert {
  id: string;
  site_id: string;
  site_name: string;
  site_code: string;
  zone_label: string | null;
  title: string;
  severity: Severity;
  instructions: string;
  assembly_point: string | null;
  procedure_ref: string | null;
  status: AlertStatus;
  revision: number;
  activated_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  initiated_by: string;
  source_org: string | null;
  my_ack_revision: number | null;
  updates: AlertUpdateNote[];
}

export interface ListedAlert {
  id: string;
  site_id: string;
  title: string;
  severity: Severity;
  status: AlertStatus;
  revision: number;
  target_group: TargetGroup;
  zone_label: string | null;
  created_at: string;
  activated_at: string | null;
  closed_at: string | null;
}

export interface DashboardCounts {
  audience: number;
  acknowledged_current: number;
  acknowledged_earlier_revision: number;
  displayed_reported_current: number;
  no_push_subscription: number;
  push_service_accepted: number;
  push_queued: number;
  push_failed_or_expired: number;
  push_not_configured: number;
}
export interface DashboardPerson {
  user_id: string;
  name: string;
  org_role: string | null;
  in_audience: boolean;
  ack_revision: number | null;
  ack_at: string | null;
  displayed_revision_reported: number | null;
  has_push_subscription: boolean;
  push_states: string[];
}
export interface Dashboard {
  alert: Record<string, unknown> & {
    id: string;
    status: AlertStatus;
    revision: number;
    title: string;
    severity: Severity;
    instructions: string;
    assembly_point: string | null;
    procedure_ref: string | null;
    zone_label: string | null;
    target_group: TargetGroup;
    site_id: string;
    close_reason: string | null;
  };
  site_name: string;
  can_manage: boolean;
  counts: DashboardCounts;
  people: DashboardPerson[];
  history: Array<{ type: string; revision: number; at: string; note: string | null; by: string | null; title: string }>;
  limits: string[];
}

// ---- Words the server checks -------------------------------------------------------------
export type EmergencyAction = "activate" | "update" | "cancel" | "resolve";
export const CONFIRM_WORD: Record<EmergencyAction, string> = {
  activate: "ACTIVATE",
  update: "UPDATE",
  cancel: "CANCEL",
  resolve: "RESOLVE",
};
export function confirmationMatches(action: EmergencyAction, typed: string): boolean {
  return typed.trim() === CONFIRM_WORD[action];
}

/** Friendly text for the server's refusal tokens. */
export function explainEmergencyError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err ?? "");
  if (/STALE_REVISION/.test(m)) return "This alert was changed by someone else. Reload it and review the latest version before trying again.";
  if (/ALREADY_ACTIVE/.test(m)) return "This alert is already active.";
  if (/DUPLICATE_ACTIVE/.test(m)) return "An identical alert is already active for this site.";
  if (/ALREADY_CLOSED|ALERT_CLOSED/.test(m)) return "This alert is already closed.";
  if (/CONFIRMATION_REQUIRED/.test(m)) return "Type the confirmation word exactly to continue.";
  if (/NOTE_REQUIRED/.test(m)) return "A short note or reason is required.";
  if (/FORBIDDEN/.test(m)) return "You are not authorized to do that for this site.";
  if (/UNAUTHENTICATED/.test(m)) return "Your session has expired. Sign in again.";
  return m || "Something went wrong.";
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw backendError(error);
  return data as T;
}

// ---- Manager actions (online only — never queued) ------------------------------------------
export interface AlertDraft {
  siteId: string;
  title: string;
  severity: Severity;
  instructions: string;
  targetGroup: TargetGroup;
  zoneLabel?: string;
  assemblyPoint?: string;
  procedureRef?: string;
}
export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export const createAlert = (d: AlertDraft, idempotencyKey: string) =>
  rpc<string>("mg_emergency_create", {
    p_site_id: d.siteId,
    p_title: d.title,
    p_severity: d.severity,
    p_instructions: d.instructions,
    p_idempotency_key: idempotencyKey,
    p_target_group: d.targetGroup,
    p_zone_label: d.zoneLabel ?? null,
    p_assembly_point: d.assemblyPoint ?? null,
    p_procedure_ref: d.procedureRef ?? null,
  });
export const activateAlert = (id: string, expectedRevision: number, confirm: string) =>
  rpc<{ push_queued: number }>("mg_emergency_activate", { p_id: id, p_confirm: confirm, p_expected_revision: expectedRevision });
export const updateAlert = (
  id: string,
  expectedRevision: number,
  confirm: string,
  note: string,
  fields: Partial<Pick<AlertDraft, "title" | "severity" | "instructions" | "assemblyPoint" | "zoneLabel" | "procedureRef">>,
) =>
  rpc<{ revision: number }>("mg_emergency_update", {
    p_id: id,
    p_expected_revision: expectedRevision,
    p_confirm: confirm,
    p_note: note,
    p_title: fields.title ?? null,
    p_severity: fields.severity ?? null,
    p_instructions: fields.instructions ?? null,
    p_assembly_point: fields.assemblyPoint ?? null,
    p_zone_label: fields.zoneLabel ?? null,
    p_procedure_ref: fields.procedureRef ?? null,
  });
export const closeAlert = (id: string, outcome: "cancelled" | "resolved", reason: string, confirm: string, expectedRevision: number) =>
  rpc<{ status: AlertStatus }>("mg_emergency_close", {
    p_id: id,
    p_outcome: outcome,
    p_reason: reason,
    p_confirm: confirm,
    p_expected_revision: expectedRevision,
  });

/** Sites this person may manage alerts for — the same predicate the write RPCs enforce. Display
 *  only: hiding controls is a courtesy, the database refuses anyone else regardless. */
export async function manageableSites(): Promise<Array<{ id: string; name: string; code: string }>> {
  return rpc("mg_emergency_manageable_sites", {});
}

export async function listAlerts(): Promise<ListedAlert[]> {
  const { data, error } = await supabase
    .from("emergency_alerts")
    .select("id, site_id, title, severity, status, revision, target_group, zone_label, created_at, activated_at, closed_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw backendError(error);
  return (data ?? []) as ListedAlert[];
}
export const fetchDashboard = (id: string) => rpc<Dashboard>("mg_emergency_dashboard", { p_id: id });

/** Ask the server-side dispatcher to hand queued push messages to the push service. The alert
 *  is ALREADY active in the database whether or not this succeeds — push is best-effort. */
export async function requestPushDispatch(alertId: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("emergency-dispatch", { body: { alertId } });
    if (error) return { ok: false, detail: String(error.message ?? error) };
    return { ok: Boolean((data as { ok?: boolean } | null)?.ok), detail: (data as { detail?: string } | null)?.detail };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "dispatcher unreachable" };
  }
}

// ---- Worker side ------------------------------------------------------------------------------
export interface MyAlertsResult {
  alerts: MyAlert[];
  checkedAt: number;
  apiVersion: number;
}
export async function fetchMyAlerts(): Promise<MyAlertsResult> {
  const r = await rpc<{ api_version: number; alerts: MyAlert[] }>("mg_my_emergency_alerts", {});
  return { alerts: r.alerts ?? [], checkedAt: Date.now(), apiVersion: r.api_version ?? 1 };
}
/** Sync-queue handler: the actor is the session, so no user id is ever sent. */
export const acknowledgeEmergency = (a: { alertId: string; revision: number; clientRef: string; seenAt: number }) =>
  rpc("mg_emergency_ack", {
    p_alert_id: a.alertId,
    p_revision: a.revision,
    p_client_ref: a.clientRef,
    p_seen_at: new Date(a.seenAt).toISOString(),
  });
export const reportDisplayed = (alertId: string, revision: number) =>
  rpc("mg_emergency_mark_displayed", { p_alert_id: alertId, p_revision: revision });

// ---- Last-known cache (so a device that lost signal still shows what it last knew) ---------------
const CACHE_KEY = "mg.emergency.last.v1";
interface CacheShape { userId: string; checkedAt: number; alerts: MyAlert[] }
export function saveLastKnown(r: MyAlertsResult): void {
  try {
    const uid = authUserId();
    if (!uid) return;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ userId: uid, checkedAt: r.checkedAt, alerts: r.alerts } satisfies CacheShape));
  } catch { /* storage may be full or blocked — the live view still works */ }
}
export function loadLastKnown(): MyAlertsResult | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CacheShape;
    if (!c || c.userId !== authUserId() || !Array.isArray(c.alerts)) return null; // never show another person's alerts
    return { alerts: c.alerts, checkedAt: c.checkedAt, apiVersion: EMERGENCY_API_VERSION };
  } catch { return null; }
}
export function clearLastKnown(): void {
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}

// ---- Pure presentation rules (unit-tested) ----------------------------------------------------------
/** How trustworthy is what is on screen? Offline or old data must say so. */
export type Freshness = { level: "live" | "stale" | "unknown"; message: string };
export const STALE_AFTER_MS = 2 * 60_000;
export function describeFreshness(checkedAt: number | null, now: number, online: boolean, lastError: boolean): Freshness {
  if (checkedAt == null) return { level: "unknown", message: "Not checked yet. If you are in danger, follow your site's emergency procedure now." };
  const mins = Math.max(0, Math.round((now - checkedAt) / 60_000));
  const ago = mins < 1 ? "less than a minute ago" : `${mins} min ago`;
  if (!online || lastError)
    return { level: "stale", message: `No connection to MineGuard — showing what this device last received (${ago}). It may be out of date or incomplete. Rely on radio, sirens and your site's procedure.` };
  if (now - checkedAt > STALE_AFTER_MS) return { level: "stale", message: `Last checked ${ago}. Updating…` };
  return { level: "live", message: `Checked ${ago}.` };
}

export type AckView =
  | { state: "needed" }
  | { state: "saved_on_device" }
  | { state: "acknowledged"; revision: number }
  | { state: "needed_after_update"; earlierRevision: number };
export function ackView(alert: Pick<MyAlert, "revision" | "my_ack_revision" | "status">, queuedRevision: number | null): AckView {
  if (alert.my_ack_revision === alert.revision) return { state: "acknowledged", revision: alert.revision };
  if (queuedRevision === alert.revision) return { state: "saved_on_device" };
  if (alert.my_ack_revision != null) return { state: "needed_after_update", earlierRevision: alert.my_ack_revision };
  return { state: "needed" };
}

export function deliveryStateLabel(state: string): string {
  switch (state) {
    case "queued": return "Waiting to be handed to the push service";
    case "sending": return "Being handed to the push service";
    case "service_accepted": return "Push service accepted it (not proof it reached the device)";
    case "service_rejected": return "Push service refused or failed";
    case "subscription_expired": return "Device registration expired";
    case "not_configured": return "Push is not configured on the server";
    default: return state;
  }
}

/** The server may be newer than this cached copy of the app. */
export function clientNeedsReload(serverApiVersion: number): boolean {
  return serverApiVersion > EMERGENCY_API_VERSION;
}

// ---- Web Push (browser side) ------------------------------------------------------------------------------
export type PushSupport =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "not_configured" | "insecure" };
export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return { ok: false, reason: "unsupported" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return { ok: false, reason: "unsupported" };
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };
  if (!import.meta.env.VITE_VAPID_PUBLIC_KEY) return { ok: false, reason: "not_configured" };
  return { ok: true };
}
export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
export type PushState = "unsupported" | "not_configured" | "insecure" | "denied" | "off" | "on";
export async function currentPushState(): Promise<PushState> {
  const s = pushSupport();
  if (!s.ok) return s.reason;
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub && Notification.permission === "granted" ? "on" : "off";
  } catch { return "off"; }
}
export async function enablePush(): Promise<PushState> {
  const s = pushSupport();
  if (!s.ok) return s.reason;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const reg = await navigator.serviceWorker.ready;
  const key = urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY as string);
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as unknown as BufferSource }));
  await registerSubscription(sub);
  return "on";
}
export async function registerSubscription(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error("Incomplete push subscription");
  await rpc("mg_register_push_subscription", {
    p_endpoint: j.endpoint,
    p_p256dh: j.keys.p256dh,
    p_auth: j.keys.auth,
    p_user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
  });
}
export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await rpc("mg_unregister_push_subscription", { p_endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}
/** Re-register on every app start while permission is granted: covers a browser-rotated or
 *  expired subscription and a device that changed hands. Failures are silent by design. */
export async function refreshPushRegistration(): Promise<void> {
  try {
    if (!pushSupport().ok || Notification.permission !== "granted" || !authUserId()) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await registerSubscription(sub);
  } catch { /* ignore */ }
}
