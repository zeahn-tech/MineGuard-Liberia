// ---------------------------------------------------------------------------
// Emergency push dispatcher (migration 0040). Pure logic over injected dependencies so it is
// testable without a Deno runtime or a push service.
//
// What "delivered" means here — and does not:
//   * The database decides who may dispatch (mg_emergency_dispatch_allowed) BEFORE any
//     privileged action; the caller's own session is what is checked.
//   * We record what the push SERVICE answered. HTTP 201 means the browser vendor's service
//     accepted the message — NOT that the device received it or that anyone saw it.
//   * 404/410 = subscription gone (recorded as expired); 429/5xx/network = retry later;
//     other 4xx = refused. Without VAPID keys nothing is sent and the rows say so.
//   * The push payload carries NO instructions (title + severity + alert id only).
// ---------------------------------------------------------------------------

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}
export interface Claimed {
  delivery_id: string;
  alert_id: string;
  event: string;
  revision: number;
  title: string;
  severity: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface DispatchDeps {
  /** Client scoped to the CALLER's JWT. */
  caller: { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult> };
  /** Service-role client: only reached after the caller was authorized for this alert. */
  service: { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult> };
  /** null when VAPID is not configured. */
  sender: null | ((sub: { endpoint: string; p256dh: string; auth: string }, payload: string) => Promise<{ status: number }>);
}
export interface DispatchResult {
  status: number;
  body: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Push endpoints must be public https hosts; never loopback/private/link-local literals. */
export function endpointAllowed(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  if (h.includes(":")) return false; // IPv6 literal
  return true;
}

export function classifyPushStatus(status: number): "accepted" | "expired" | "retry" | "rejected" {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 404 || status === 410) return "expired";
  if (status === 429 || status >= 500 || status === 0) return "retry";
  return "rejected";
}

export function buildPayload(c: Pick<Claimed, "alert_id" | "event" | "revision" | "title" | "severity">): string {
  return JSON.stringify({
    v: 1,
    id: c.alert_id,
    event: c.event,
    revision: c.revision,
    severity: c.severity,
    title: String(c.title ?? "").slice(0, 120),
  });
}

export async function handleDispatch(deps: DispatchDeps, body: unknown): Promise<DispatchResult> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const alertId = typeof b.alertId === "string" ? b.alertId : "";
  if (!UUID.test(alertId)) return { status: 400, body: { ok: false, error: "BAD_REQUEST", detail: "alertId required" } };

  // 1. who is asking — decided by the database, as the caller
  const allowed = await deps.caller.rpc("mg_emergency_dispatch_allowed", { p_alert: alertId });
  if (allowed.error || allowed.data !== true) {
    return { status: 403, body: { ok: false, error: "FORBIDDEN", detail: "Not authorized for this alert." } };
  }

  // 2. claim queued deliveries for THIS alert only
  const claimed = await deps.service.rpc("mg_emergency_claim_push", { p_alert: alertId, p_limit: 200 });
  if (claimed.error) return { status: 500, body: { ok: false, error: "CLAIM_FAILED", detail: "Could not read the delivery queue." } };
  const rows = (claimed.data ?? []) as Claimed[];

  const tally = { accepted: 0, expired: 0, retry: 0, rejected: 0, not_configured: 0 };
  for (const c of rows) {
    let outcome: keyof typeof tally;
    let detail: string | null = null;
    if (!deps.sender) {
      outcome = "not_configured";
      detail = "VAPID keys not configured";
    } else if (!endpointAllowed(c.endpoint)) {
      outcome = "rejected";
      detail = "endpoint not allowed";
    } else {
      try {
        const r = await deps.sender({ endpoint: c.endpoint, p256dh: c.p256dh, auth: c.auth }, buildPayload(c));
        outcome = classifyPushStatus(r.status);
        detail = `HTTP ${r.status}`;
      } catch {
        outcome = "retry";
        detail = "network error";
      }
    }
    tally[outcome]++;
    await deps.service.rpc("mg_emergency_record_push", { p_delivery: c.delivery_id, p_outcome: outcome, p_detail: detail });
  }

  return {
    status: 200,
    body: {
      ok: tally.rejected + tally.expired + tally.retry + tally.not_configured === 0,
      attempted: rows.length,
      ...tally,
      // honest wording for the UI — acceptance is not receipt
      detail: !deps.sender
        ? "Push is not configured on the server; no push messages were sent."
        : "Counts reflect what the push service answered. They do not confirm any device received or showed the alert.",
    },
  };
}
