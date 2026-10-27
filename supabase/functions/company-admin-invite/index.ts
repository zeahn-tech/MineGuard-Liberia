// ---------------------------------------------------------------------------
// company-admin-invite — Supabase Edge Function (Phase B).
//
// Sends the Supabase Auth invitation email for a company-administrator
// nomination. Deploy with JWT verification ON (default):
//     supabase functions deploy company-admin-invite
// Secrets (never in the repo or the browser):
//     INVITE_REDIRECT_URL   the SITE ROOT (the app uses a hash router, so the invite
//                           link cannot carry a path), e.g. https://<user>.github.io/<repo>/
//     INVITE_ALLOWED_ORIGIN exact site origin for CORS (unset = no browser origin)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are platform-provided.
// The service-role client is used ONLY for the mail call, and only after the
// caller-scoped RPCs (organizations.write required) have succeeded.
// ---------------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleInviteRequest } from "../_shared/invite/handler.ts";

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

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED", message: "POST only" });

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json(401, { error: "UNAUTHENTICATED", message: "Sign in required" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const db = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: uerr } = await db.auth.getUser(auth.slice(7));
  if (uerr || !u?.user) return json(401, { error: "UNAUTHENTICATED", message: "Sign in required" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "BAD_REQUEST", message: "JSON body required" });
  }

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await handleInviteRequest(
    {
      db,
      redirectTo: Deno.env.get("INVITE_REDIRECT_URL") ?? null,
      mail: {
        invite: async (email, redirectTo) => {
          const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
          return { error: error ? { message: error.message, status: error.status } : null };
        },
        magicLink: async (email, redirectTo) => {
          const { error } = await anon.auth.signInWithOtp({
            email,
            options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
          });
          return { error: error ? { message: error.message } : null };
        },
      },
    },
    body,
  );
  return json(result.status, result.body);
});
