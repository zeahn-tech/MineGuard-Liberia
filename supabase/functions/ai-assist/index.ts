// ---------------------------------------------------------------------------
// ai-assist — Supabase Edge Function (Session 8, AI-1).
//
// SERVER-SIDE ONLY. This is the only file that touches the runtime:
//   * identity: the caller's JWT is verified with auth.getUser(); the user id
//     and role used downstream come from that and from the caller's own
//     `profiles` row — never from the request body;
//   * data access: a client built with the CALLER's Authorization header and
//     the public anon key. There is no service-role key in this function, so
//     there is no code path that can read outside the caller's RLS scope;
//   * secrets: provider settings come from Edge Function secrets (Deno.env).
//     They are not in the repository and never reach the browser. With no
//     approved provider (the current state) none are read at all;
//   * deploy with JWT verification ON (the default): supabase functions deploy ai-assist
// ---------------------------------------------------------------------------

import { createClient } from "npm:@supabase/supabase-js@2";
import { handleAiRequest } from "../_shared/ai/handler.ts";
import { resolveProvider } from "../_shared/ai/provider.ts";

const CORS = {
  // Fail closed: with AI_ALLOWED_ORIGIN unset no browser origin is allowed
  // (set it to your exact site origin, e.g. https://example.org).
  "Access-Control-Allow-Origin": Deno.env.get("AI_ALLOWED_ORIGIN") ?? "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED", message: "POST only" });

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json(401, { error: "UNAUTHENTICATED", message: "Sign in required" });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: u, error: uerr } = await db.auth.getUser(auth.slice(7));
  if (uerr || !u?.user) return json(401, { error: "UNAUTHENTICATED", message: "Sign in required" });

  const { data: profile } = await db.from("profiles").select("role").eq("id", u.user.id).maybeSingle();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "BAD_REQUEST", message: "JSON body required" });
  }

  const result = await handleAiRequest(
    { db, caller: { id: u.user.id, role: (profile?.role as string | null) ?? null }, provider: resolveProvider(Deno.env) },
    body,
  );
  return json(result.status, result.body);
});
