// ---------------------------------------------------------------------------
// worker-voice-push — Supabase Edge Function (Worker Voice, migration 0052).
// Wakes reviewers' devices with one of three FIXED generic payloads, and runs the ageing sweep (reminders and the
// automatic escalation of reports nobody has acknowledged). Called only by a scheduler holding a shared
// secret (supabase/cron/voice-sweep.sql); there is no user-facing entry point and no JWT.
//     supabase functions deploy worker-voice-push --no-verify-jwt --use-api
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (the same ones emergency-dispatch uses),
//          WORKER_VOICE_PUSH_SECRET (long random string). SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are platform-provided.
// Without the VAPID secrets nothing is sent and rows stay queued (in-app notifications still work).
// Delivery is best effort and depends on the device and the browser vendor's push service. Rows older
// than 6 hours are closed out as "not sent", never pushed late.
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { describeVapidProblem, resolveVapidConfig } from "../_shared/push/vapid.ts";
import { secretsMatch } from "../_shared/emergency/dispatch.ts";
import { handleVoicePushSweep } from "../_shared/voice/push.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// Keys are normalised and validated (decoded length, pair match) before the library sees them. A bad secret
// disables push delivery with a safe log line instead of crashing the function at boot.
const vapid = resolveVapidConfig({
  subject: Deno.env.get("VAPID_SUBJECT"),
  publicKey: Deno.env.get("VAPID_PUBLIC_KEY"),
  privateKey: Deno.env.get("VAPID_PRIVATE_KEY"),
});
const configured = vapid.ok;
if (vapid.ok) {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  console.log("[worker-voice-push] VAPID configured: private key 32 bytes, public key 65 bytes, key pair verified.");
} else {
  console.error(describeVapidProblem("worker-voice-push", vapid.diagnostics));
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json(405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  if (!secretsMatch(req.headers.get("x-sweep-secret") ?? "", Deno.env.get("WORKER_VOICE_PUSH_SECRET") ?? "")) {
    return json(401, { ok: false, error: "UNAUTHENTICATED" });
  }
  const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const sender = configured
    ? async (sub: { endpoint: string; p256dh: string; auth: string }, payload: string) => {
        try {
          const r = await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 3600, urgency: "high", timeout: 8000 });
          return { status: r.statusCode };
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (typeof status === "number") return { status };
          throw e;
        }
      }
    : null;
  const r = await handleVoicePushSweep({ service, sender });
  return json(r.status, r.body);
});
