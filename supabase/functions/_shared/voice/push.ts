// ---------------------------------------------------------------------------
// Worker Voice push dispatcher logic (pure; the Edge Function wires the real sender).
// The payload is one of THREE FIXED values chosen by the outbox row's kind. It never carries a report id, mode,
// category or text. The outbox only says WHO to wake and which of the three generic messages to show.
// ---------------------------------------------------------------------------
import { classifyPushStatus, endpointAllowed } from "../emergency/dispatch.ts";

export const VOICE_PUSH_PAYLOADS: Record<string, string> = {
  company: JSON.stringify({ v: 1, t: "wv" }),
  ministry: JSON.stringify({ v: 1, t: "mv" }),
  request: JSON.stringify({ v: 1, t: "mr" }),
};

export interface VoiceClaimed { outbox_id: string; subscription_id: string; kind: string; endpoint: string; p256dh: string; auth: string }
export interface VoicePushDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: { rpc(fn: string, args?: Record<string, unknown>): any };
  sender: ((sub: { endpoint: string; p256dh: string; auth: string }, payload: string) => Promise<{ status: number }>) | null;
}
export interface VoicePushResult { status: number; body: Record<string, unknown> }

export async function handleVoicePushSweep(deps: VoicePushDeps): Promise<VoicePushResult> {
  // reminders and automatic escalation ride on the same scheduler tick; a failure there never blocks delivery
  const ageing = await deps.service.rpc("mg_voice_ageing_sweep");
  const claimed = await deps.service.rpc("mg_voice_push_claim", { p_limit: 100 });
  if (claimed.error) return { status: 500, body: { ok: false, error: "CLAIM_FAILED" } };
  const rows = (claimed.data ?? []) as VoiceClaimed[];
  const out = { sent: 0, expired: 0, retry: 0, failed: 0, not_configured: 0 };
  const record = (r: VoiceClaimed, state: string, detail: string, dead?: boolean) =>
    deps.service.rpc("mg_voice_push_record", { p_outbox: r.outbox_id, p_state: state, p_detail: detail, p_dead_subscription: dead ? r.subscription_id : null });

  for (const r of rows) {
    const payload = VOICE_PUSH_PAYLOADS[r.kind];
    if (!payload) { await record(r, "failed", "unknown kind"); out.failed++; continue; }
    if (!deps.sender) { await record(r, "queued", "push is not configured on the server"); out.not_configured++; continue; }
    if (!endpointAllowed(r.endpoint)) { await record(r, "failed", "endpoint rejected"); out.failed++; continue; }
    let status = 0;
    try { status = (await deps.sender({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, payload)).status; } catch { status = 0; }
    const c = classifyPushStatus(status);
    if (c === "accepted") { await record(r, "sent", `accepted ${status}`); out.sent++; }
    else if (c === "expired") { await record(r, "expired", `subscription gone ${status}`, true); out.expired++; }
    else if (c === "retry") { await record(r, "queued", `retry later (${status})`); out.retry++; }
    else { await record(r, "failed", `rejected ${status}`); out.failed++; }
  }
  return { status: 200, body: { ok: true, claimed: rows.length, ageing: ageing?.data ?? null, ...out } };
}
