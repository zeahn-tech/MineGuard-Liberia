// Stubbed Supabase for the browser smoke tests. Every request to *.supabase.co
// is fulfilled here; the realtime socket is refused. Nothing leaves the box.
import type { Page, Route } from "@playwright/test";

export const AUTH_STORAGE_KEY = "mg.supabase.auth.v1";
const USER_ID = "00000000-0000-4000-8000-000000000001";

export type StubRole = "admin" | "operator";

export type Recorded = { method: string; path: string; body?: string };

function b64url(o: object) {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

/** A structurally valid (unsigned) JWT — the client only decodes claims. */
export function fakeSession(role: StubRole) {
  const exp = Math.floor(Date.now() / 1000) + 3600 * 6;
  const claims = { sub: USER_ID, aud: "authenticated", role: "authenticated", aal: "aal1", amr: [], exp, email: `${role}@example.test` };
  const access_token = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.sig`;
  return {
    access_token,
    refresh_token: "stub-refresh",
    token_type: "bearer",
    expires_in: 3600 * 6,
    expires_at: exp,
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: `${role}@example.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}

const NOW = new Date().toISOString();
const SITE = {
  id: "11111111-1111-4111-8111-111111111111", code: "LB-BOM-001", name: "Bomi Ridge Gold Concession", operator_name: "AgriLib Mining",
  county: "Bomi", district: "Klay", mineral: "gold", site_type: "industrial", status: "active", latitude: 6.75, longitude: -10.85,
  geo_verified: false, geo_source: "typed", geo_accuracy_m: null, created_at: NOW, updated_at: NOW, organization_id: "22222222-2222-4222-8222-222222222222",
};

const TEMPLATE = {
  id: "33333333-3333-4333-8333-333333333333", name: "Standard site inspection", description: "Routine compliance visit", active: true,
  sections: [{ title: "Safety", questions: [{ id: "q1", text: "PPE worn on site?", type: "yesno" }] }], created_by: USER_ID, created_at: NOW,
};

function profileRow(role: StubRole) {
  return role === "admin"
    ? { id: USER_ID, email: "admin@example.test", name: "Test Administrator", role: "admin", scope: "national", job_title: "Oversight lead", organization: "Test Agency", profile_complete: true, created_at: NOW }
    : { id: USER_ID, email: "operator@example.test", name: "Test Operator", role: "operator", operator_name: "AgriLib Mining", organization_id: SITE.organization_id, profile_complete: true, created_at: NOW };
}

export async function installStub(page: Page, opts: { role?: StubRole | null; failSubmit?: boolean } = {}) {
  const log: Recorded[] = [];
  const role = opts.role ?? null;

  await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());

  if (role) {
    const session = fakeSession(role);
    await page.addInitScript(([k, v]) => localStorage.setItem(k as string, v as string), [AUTH_STORAGE_KEY, JSON.stringify(session)]);
  }

  await page.route(/supabase\.co/, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    log.push({ method: req.method(), path: p + (url.search ? "?" + url.search.slice(1, 80) : ""), body: req.postData() ?? undefined });
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", "content-range": "0-0/*", ...headers }, body: JSON.stringify(body) });

    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });

    if (p.startsWith("/auth/v1/user")) return json(role ? fakeSession(role).user : { message: "no session" }, role ? 200 : 401);
    if (p.startsWith("/auth/v1/token")) return role ? json(fakeSession(role)) : json({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);
    if (p.startsWith("/auth/v1/factors") || p.includes("/mfa")) return json([]);
    if (p.startsWith("/auth/v1")) return json({});

    if (p.startsWith("/rest/v1/rpc/")) {
      const fn = p.split("/").pop()!;
      if (/submit_community_report/.test(fn)) {
        if (opts.failSubmit) return json({ message: "RATE_LIMITED" }, 429);
        return json({ tracking_code: "MG-TEST-0001", trackingCode: "MG-TEST-0001" });
      }
      return json([]);
    }

    if (p.startsWith("/rest/v1/")) {
      const table = p.split("/")[3];
      const wantsObject = /pgrst\.object/.test(req.headers()["accept"] ?? "");
      let rows: unknown[] = [];
      if (table === "profiles" && role) rows = [profileRow(role)];
      if (table === "sites" && role) rows = [SITE];
      if (table === "inspection_templates" && role) rows = [TEMPLATE];
      if (table === "meta") rows = [{ key: "public_stats", value: { sites: 1, inspections: 0, incidents: 0, communityReports: 0 } }];
      if (wantsObject) return rows.length ? json(rows[0]) : json({ message: "not found", code: "PGRST116" }, 406);
      return json(rows, 200, { "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
    }
    return json({});
  });

  return log;
}
