// ---------------------------------------------------------------------------
// account-delete — Supabase Edge Function (profile settings -> "Delete my account").
// Deploy with JWT verification ON (default):
//     supabase functions deploy account-delete --use-api
// Uses the same CORS origin secret as the invitation function (INVITE_ALLOWED_ORIGIN).
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are platform-provided.
// The service-role client only runs AFTER the caller-scoped database function accepted
// the request (see _shared/account/handler.ts).
// ---------------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleAccountDeletion } from "../_shared/account/handler.ts";

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
  const token = auth.slice(7);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const db = createClient(url, anonKey, { ...opts, global: { headers: { Authorization: auth } } });
  const { data: u, error: uerr } = await db.auth.getUser(token);
  if (uerr || !u?.user) return json(401, { error: "UNAUTHENTICATED", message: "Sign in required" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "BAD_REQUEST", message: "JSON body required" });
  }

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, opts);
  const verifier = createClient(url, anonKey, opts);

  const result = await handleAccountDeletion(
    {
      db,
      verifyPassword: async (email, password) => {
        const { error } = await verifier.auth.signInWithPassword({ email, password });
        return !error;
      },
      admin: {
        removeAvatar: async (path) => {
          await admin.storage.from("avatars").remove([path]);
        },
        deleteUser: async (id) => {
          const { error } = await admin.auth.admin.deleteUser(id);
          return { error: error ? { message: error.message } : null };
        },
        disableUser: async (id) => {
          const random = crypto.randomUUID() + crypto.randomUUID();
          const { error } = await admin.auth.admin.updateUserById(id, {
            email: `deleted-${id}@deleted.invalid`,
            password: random,
            ban_duration: "876000h",
            user_metadata: {},
            email_confirm: true,
          });
          return { error: error ? { message: error.message } : null };
        },
        endSessions: async () => {
          await admin.auth.admin.signOut(token, "global");
        },
      },
    },
    { id: u.user.id, email: u.user.email ?? null },
    body,
  );
  return json(result.status, result.body);
});
