// ---------------------------------------------------------------------------
// emergency-dispatch — Supabase Edge Function (emergency alerts, migration 0040).
// Deploy with JWT verification ON (default):
//     supabase functions deploy emergency-dispatch --use-api
// Secrets (supabase secrets set ...):
//     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https: contact)
//     INVITE_ALLOWED_ORIGIN (same CORS origin secret the other functions use)
//     EMERGENCY_SWEEP_SECRET (long random string; enables the scheduled retry sweep, see below)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are platform-provided.
// Without the VAPID secrets the function sends nothing and records "not_configured".
// The same public key must be set at build time as VITE_VAPID_PUBLIC_KEY.
// Generate a pair once with:  npx web-push generate-vapid-keys
// Scheduled retries: a scheduler POSTs {"sweep": true} with header x-sweep-secret. See
// supabase/cron/emergency-dispatch-sweep.sql (NOT applied by migrations: it needs your project
// URL and secret). Without a schedule, queued rows are retried only when a manager presses
// "Retry push delivery" or acts on the alert again. Rows older than 6 hours are closed out as
// "not sent", never pushed late.
// ---------------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { handleDispatch, handleSweep, secretsMatch } from "../_shared/emergency/dispatch.ts";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("INVITE_ALLOWED_ORIGIN") ?? "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const pub = Deno.env.get("VAPID_PUBLIC_KEY");
const priv = Deno.env.get("VAPID_PRIVATE_KEY");
const subject = Deno.env.get("VAPID_SUBJECT");
const configured = Boolean(pub && priv && subject);
if (configured) webpush.setVapidDetails(subject!, pub!, priv!);

function makeSender() {
  return async (sub: { endpoint: string; p256dh: string; auth: string }, payload: string) => {
    try {
      const r = await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 3600, urgency: "high", timeout: 8000 },
      );
      return { status: r.statusCode };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (typeof status === "number") return { status };
      throw e;
    }
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });

  // Scheduled sweep: shared secret, no user session. Sends nothing unless the secret matches.
  const sweepSecret = Deno.env.get("EMERGENCY_SWEEP_SECRET") ?? "";
  const presented = req.headers.get("x-sweep-secret");
  if (presented !== null) {
    if (!secretsMatch(presented, sweepSecret)) return json(401, { ok: false, error: "UNAUTHENTICATED" });
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
    const swept = await handleSweep({ service: svc, sender: configured ? makeSender() : null });
    return json(swept.status, swept.body);
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json(401, { ok: false, error: "UNAUTHENTICATED" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { ...opts, global: { headers: { Authorization: auth } } });
  const { data: u, error } = await caller.auth.getUser(auth.slice(7));
  if (error || !u?.user) return json(401, { ok: false, error: "UNAUTHENTICATED" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "BAD_REQUEST" });
  }

  const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, opts);
  const result = await handleDispatch(
    {
      caller,
      service,
      sender: configured ? makeSender() : null,
    },
    body,
  );
  return json(result.status, result.body);
});
