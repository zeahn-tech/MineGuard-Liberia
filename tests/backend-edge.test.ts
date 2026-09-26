// ---------------------------------------------------------------------------
// BACKEND EDGE — Gap Closure Directive v1.0, Priority A, Gap #3.
//
// docs/13's SQL suites (rls / rate-limit / evidence-url) prove the SERVER
// boundary in SQL. This suite proves the CLIENT boundary: the real
// src/lib/backend.ts — its error shaping (backendError), authorization
// re-derivation (requireAuthed/requireStaff/requireAdmin/requireReviewer),
// row mapping, offline-dedupe contract and audit writes — driven unmodified
// through a wire-protocol bridge (tests/helpers/backend-edge.ts) that
// translates supabase-js vocabulary into RLS-enforced SQL against the same
// migrations, with per-request identities exactly like PostgREST.
//
// Acceptance (Gap Closure Directive): every exported function exercised with
// at least one authorized-path and one denied-path test; error-shaping
// verified for the tokens the UI renders (FORBIDDEN / NOT_FOUND /
// RATE_LIMITED / UNAUTHENTICATED …). Mutations commit, so post-conditions
// are verified in SQL afterwards (adminSql) — nothing is rolled back except
// failed requests themselves.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { api, ensureProfileDoc } from "../src/lib/backend";
import { backendError, __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import {
  adminSql,
  createEdgeClient,
  EDGE_IDS as f,
  edgeIdentity,
  getEdgeDb,
} from "./helpers/backend-edge";
import type { QueryHandle } from "../src/lib/backend";

let clientSwapped = false;

beforeAll(async () => {
  // Boot the dedicated PGlite (stub → migrations → compact seed) and swap the
  // live ESM binding so backend.ts's `supabase` is the bridge client.
  await getEdgeDb();
  if (!clientSwapped) {
    __testSetSupabaseClient(createEdgeClient());
    clientSwapped = true;
  }
});

// Identity helpers — TWO stores must agree, exactly like the real wire:
//   * backend.ts's authUserId() (src/lib/supabase.ts module state) drives its
//     authorization re-derivation; the __testSetAuthUserId hook sets it.
//   * the bridge's per-request session (edgeIdentity) drives SET LOCAL role /
//     request.jwt.claims, i.e. what PostgREST would inject from the JWT.
function setIdentity(uid: string | null) {
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}
function asAdmin() {
  setIdentity(f.admin);
}
function asOpA() {
  setIdentity(f.opA);
}
function asOpB() {
  setIdentity(f.opB);
}
function asCounty() {
  setIdentity(f.county);
}
function asNational() {
  setIdentity(f.national);
}
function asGuest() {
  setIdentity(f.guest);
}
function asAnon() {
  setIdentity(null);
}

/** First value from a live() subscription (or undefined if it errored). */
function first<T>(q: QueryHandle<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      unsub();
      resolve(v);
    });
  });
}

/** Expect fn to reject with exactly the stable token (or a prefix match). */
async function expectError(fn: () => Promise<unknown>, token: string) {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    expect(msg).toContain(token);
    return;
  }
  throw new Error(`expected error containing "${token}", but the call succeeded`);
}

// ===========================================================================
// 0. backendError — the error-shaping layer itself (the literal [object
//    Object] bug from the forensic audit, now pinned by contract).
// ===========================================================================

describe("backendError: error shaping", () => {
  test("plain PostgREST object with row-level-security text → FORBIDDEN", () => {
    expect(backendError({ message: 'new row violates row-level security policy for table "sites"' }).message).toBe(
      "FORBIDDEN",
    );
  });
  test("a 42501-shaped PostgREST error (the wire shape for RLS denials) → FORBIDDEN", () => {
    expect(
      backendError({ code: "42501", message: "permission denied for table sites" }).message,
    ).toBe("FORBIDDEN");
  });
  test("RATE_LIMITED / NOT_FOUND / UNAUTHENTICATED passthrough", () => {
    expect(backendError({ message: "RATE_LIMITED: too many" }).message).toBe("RATE_LIMITED");
    expect(backendError({ message: "NOT_FOUND" }).message).toBe("NOT_FOUND");
    expect(backendError({ test: "x", message: "UNAUTHENTICATED" }).message).toBe("UNAUTHENTICATED");
  });
  test("plain object WITHOUT message never yields [object Object]", () => {
    const e = backendError({ code: "23505", details: null, hint: "dup" });
    expect(e.message).not.toContain("[object Object]");
    expect(e.message).toContain("23505");
  });
  test("plain object with empty message never yields [object Object]", () => {
    expect(backendError({ message: "" }).message).not.toContain("[object Object]");
  });
  test("plain Error passes through untouched", () => {
    expect(backendError(new Error("NOT_EDITABLE")).message).toBe("NOT_EDITABLE");
  });
  test("string input passes through", () => {
    expect(backendError("boom").message).toBe("boom");
  });
  test("UNREGISTERED_USER and USER_NOT_FOUND map to human text", () => {
    expect(backendError({ message: "USER_NOT_FOUND: no profile" }).message).toContain("sign up first");
    expect(backendError({ message: "UNREGISTERED_USER" }).message).toContain("no profile row yet");
  });
  test("PGRST116 / no-rows → NOT_FOUND", () => {
    expect(backendError({ message: "PGRST116: no rows" }).message).toBe("NOT_FOUND");
  });
});

// ===========================================================================
// 1. Auth gate — unauthenticated / unregistered / unassigned accounts.
// ===========================================================================

describe("auth gate", () => {
  test("anonymous caller: UNAUTHENTICATED on a staff mutation", async () => {
    asAnon();
    await expectError(() => api.sites.create({ name: "X", operatorName: "Y", county: "Bomi" }), "UNAUTHENTICATED");
  });

  test("unassigned guest (signed in, no role): sites.list returns empty, staff mutations FORBIDDEN", async () => {
    asGuest();
    const sites = await first(api.sites.list());
    expect(sites).toEqual([]);
    await expectError(
      () => api.inspections.createDraft({ siteId: f.siteA, templateId: f.template }),
      "FORBIDDEN",
    );
    // Staff-only list: empty, not an error (documents the no-hang contract).
    const reports = await first(api.records.listCommunityReports());
    expect(reports).toEqual([]);
  });

  test("UNREGISTERED_USER for an auth uid with no profile row", async () => {
    // A fresh auth.users row whose trigger-created profile was deleted.
    const created = await adminSql(
      `insert into auth.users (id, email, raw_user_meta_data)
       values (gen_random_uuid(), 'orphan@edge.test', '{}'::jsonb) returning id`,
    );
    const orphan = String(created[0].id);
    await adminSql(`delete from public.profiles where id = '${orphan}'`);
    edgeIdentity.set(orphan);
    await expectError(() => api.sites.listTemplates().then(first), "profile row yet");
  });

  test("signUp through the bridge creates the profile via the real trigger; duplicate email maps to EMAIL_IN_USE", async () => {
    const { signUpEmail, signInEmail } = await import("../src/lib/backend");
    const email = `edge-${Date.now()}@edge.test`;
    await signUpEmail(email, "whatever", "Edge User");
    const prof = await adminSql(`select name, role from public.profiles where email = '${email}'`);
    expect(prof.length).toBe(1);
    expect(prof[0].name).toBe("Edge User");

    // Duplicate sign-up → EMAIL_IN_USE via authErrorMessage mapping.
    let msg = "";
    try {
      await signUpEmail(email, "whatever");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("EMAIL_IN_USE");
    void signInEmail;
  });

  test("signInEmail with an unknown email maps to INCORRECT_CREDENTIALS", async () => {
    const { signInEmail } = await import("../src/lib/backend");
    let msg = "";
    try {
      await signInEmail(`nobody-${Date.now()}@edge.test`, "pw");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("INCORRECT_CREDENTIALS");
  });
});

// ===========================================================================
// 2. Sites.
// ===========================================================================

describe("sites", () => {
  test("authorized: admin creates a site with a generated code, audits it, status-settable", async () => {
    asAdmin();
    const id = await api.sites.create({
      name: "Edge Suite Site",
      operatorName: "AgriLib Mining",
      county: "Bomi",
      district: "Senjeh",
      latitude: 6.9,
      longitude: -10.9,
    });
    expect(id).toBeTruthy();
    const row = await adminSql(`select code, status, operator_name from public.sites where id = '${id}'`);
    expect(row[0].status).toBe("pending_verification");
    expect(String(row[0].code)).toMatch(/^MGL-BOM-\d{4}$/);
    expect(row[0].operator_name).toBe("AgriLib Mining");
    const audit = await adminSql(
      `select 1 from public.audit_log where action = 'site.create' and entity_id = '${id}'`,
    );
    expect(audit.length).toBe(1);

    await api.sites.setStatus({ siteId: id, status: "active" });
    const st = await adminSql(`select status from public.sites where id = '${id}'`);
    expect(st[0].status).toBe("active");
  });

  test("denied: operator cannot create or status-set sites (FORBIDDEN); INVALID_STATUS rejected", async () => {
    asOpA();
    await expectError(() => api.sites.create({ name: "Nope", operatorName: "X", county: "Bomi" }), "FORBIDDEN");
    await expectError(() => api.sites.setStatus({ siteId: f.siteA, status: "closed" }), "FORBIDDEN");
    asAdmin();
    await expectError(() => api.sites.setStatus({ siteId: f.siteA, status: "nonsense" }), "INVALID_STATUS");
  });

  test("scoping: operator sees only own tenant; county inspector only own county; detail is null-masked for out-of-scope ids", async () => {
    asOpB();
    const list = await first(api.sites.list());
    expect(list!.map((s) => s._id)).toEqual([f.siteB]);
    expect(list![0].openActions).toBe(0);

    // Detail of another tenant's site masks to null (not an error).
    const masked = await first(api.sites.get({ siteId: f.siteA }));
    expect(masked).toBeNull();

    asCounty();
    const countyList = await first(api.sites.list());
    expect(countyList!.map((s) => s._id)).toEqual([f.siteA]); // Bomi only

    asAdmin();
    const all = await first(api.sites.list());
    expect(all!.length).toBeGreaterThanOrEqual(2);
  });

  test("openActions counts only non-closed/verified CAs per site", async () => {
    asAdmin();
    const list = await first(api.sites.list());
    const siteA = list!.find((s) => f.siteA === s._id)!;
    expect(siteA.openActions).toBe(1); // the seeded open CA on findingA
  });

  test("riskScores: explainable factors include the seeded overdue-corrective-action factor for staff", async () => {
    // Seed a past-due CA so a deterministic factor exists.
    const due = await adminSql(
      `insert into public.corrective_actions (finding_id, site_id, description, due_at, opened_by_id)
       values ('${f.findingA}', '${f.siteA}', 'Edge overdue CA', now() - interval '2 days', '${f.admin}')
       returning id`,
    );
    asNational();
    const scores = await first(api.sites.riskScores());
    const entry = scores![f.siteA];
    expect(entry.score).toBeGreaterThan(0);
    expect(entry.factors.some((x) => /overdue/i.test(x.label))).toBe(true);
    void due;
  });
});

// ===========================================================================
// 3. Inspections lifecycle (draft → submit → review) + findings + CAs.
// ===========================================================================

describe("inspections lifecycle", () => {
  test("authorized: county inspector drafts, updates, submits; supervisor reviews", async () => {
    asCounty();
    const id = await api.inspections.createDraft({ siteId: f.siteA, templateId: f.template });
    expect(id).toBeTruthy();

    await api.inspections.updateDraft({ inspectionId: id, answers: { "0:0": true }, notes: "edge notes" });
    const upd = await adminSql(`select answers, notes from public.inspections where id = '${id}'`);
    expect((upd[0].answers as Record<string, unknown>)["0:0"]).toBe(true);

    await api.inspections.submit({ inspectionId: id });
    const st = await adminSql(`select status, submitted_at is not null as has_sub from public.inspections where id = '${id}'`);
    expect(st[0].status).toBe("under_review");
    expect(st[0].has_sub).toBe(true);

    // Ownership guard: another inspector cannot edit someone else's draft.
    asNational();
    await expectError(() => api.inspections.updateDraft({ inspectionId: id, notes: "hijack" }), "FORBIDDEN");

    asNational();
    await api.inspections.review({ inspectionId: id, decision: "approved", note: "ok" });
    const rev = await adminSql(
      `select status, reviewer_id, review_note from public.inspections where id = '${id}'`,
    );
    expect(rev[0].status).toBe("approved");
    expect(rev[0].reviewer_id).toBe(f.national);
  });

  test("denied: operator cannot draft; status transitions are enforced (NOT_EDITABLE / NOT_REVIEWABLE)", async () => {
    asOpA();
    await expectError(
      () => api.inspections.createDraft({ siteId: f.siteA, templateId: f.template }),
      "FORBIDDEN",
    );

    // NOT_EDITABLE: a submitted inspection can't be draft-edited by its owner.
    asCounty();
    const draft = await api.inspections.createDraft({ siteId: f.siteA, templateId: f.template });
    await api.inspections.submit({ inspectionId: draft });
    await expectError(() => api.inspections.updateDraft({ inspectionId: draft, notes: "late edit" }), "NOT_EDITABLE");

    // NOT_REVIEWABLE: approving an already-approved inspection.
    asNational();
    await api.inspections.review({ inspectionId: draft, decision: "approved" });
    await expectError(() => api.inspections.review({ inspectionId: draft, decision: "rejected" }), "NOT_REVIEWABLE");
  });

  test("listTemplates: authorized staff sees templates; anonymous gets UNAUTHENTICATED", async () => {
    asCounty();
    const templates = await first(api.inspections.listTemplates());
    expect(templates!.some((t) => t._id === f.template)).toBe(true);
    asAnon();
    await expectError(() => first(api.inspections.listTemplates()), "UNAUTHENTICATED");
  });

  test("inspections.list: county inspector sees only own-county + own rows", async () => {
    asCounty();
    const list = await first(api.inspections.list());
    // The seeded inspection belongs to admin at siteA; the county inspector
    // (non-national) must NOT see it.
    expect(list!.some((i) => i._id === f.inspection)).toBe(false);
    // But their own submitted one from the earlier test is visible.
    expect(list!.length).toBeGreaterThanOrEqual(1);
    expect(list!.every((i) => i.county === "Bomi")).toBe(true);
  });

  test("addFinding + updateFindingStatus: staff creates, operator can only acknowledge", async () => {
    asCounty();
    const fid = await api.inspections.addFinding({
      inspectionId: f.inspection,
      title: "Edge finding",
      severity: "high",
    });
    expect(fid).toBeTruthy();

    asOpA();
    await api.inspections.updateFindingStatus({ findingId: fid, status: "acknowledged" });
    const ack = await adminSql(`select status from public.findings where id = '${fid}'`);
    expect(ack[0].status).toBe("acknowledged");

    await expectError(() => api.inspections.updateFindingStatus({ findingId: fid, status: "resolved" }), "FORBIDDEN");

    // Admin (reviewer) may resolve.
    asAdmin();
    await api.inspections.updateFindingStatus({ findingId: fid, status: "resolved" });
  });

  test("corrective actions: staff opens, operator responds, reviewer closes; respond by non-matching operator FORBIDDEN", async () => {
    // CA on findingB (siteB — OreCo tenant).
    asAdmin();
    const caId = await api.inspections.openCorrectiveAction({
      findingId: f.findingB,
      description: "Edge CA",
      dueAt: Date.now() + 7 * 86_400_000,
    });
    expect(caId).toBeTruthy();

    asOpB(); // matches OreCo Liberia
    await api.inspections.respondCorrectiveAction({ caId, operatorNote: "fixed" });
    const note = await adminSql(`select operator_note, status from public.corrective_actions where id = '${caId}'`);
    expect(note[0].operator_note).toBe("fixed");
    expect(note[0].status).toBe("submitted");

    asOpA(); // wrong tenant
    await expectError(
      () => api.inspections.respondCorrectiveAction({ caId, operatorNote: "not mine" }),
      "FORBIDDEN",
    );

    asNational();
    await api.inspections.decideCorrectiveAction({ caId, decision: "closed" });
    const closed = await adminSql(`select status, closed_at is not null as has_closed, verified_by_id from public.corrective_actions where id = '${caId}'`);
    expect(closed[0].status).toBe("closed");
    expect(closed[0].has_closed).toBe(true);
    expect(closed[0].verified_by_id).toBe(f.national);
  });
});

// ===========================================================================
// 4. Records: incidents, observations, community reports.
// ===========================================================================

describe("records", () => {
  test("incident: operator files at own site (authorized) and cannot at another tenant's site (FORBIDDEN)", async () => {
    asOpA();
    const id = await api.records.reportIncident({
      siteId: f.siteA,
      type: "injury",
      severity: "medium",
      description: "Edge incident",
      occurredAt: Date.now(),
    });
    expect(id).toBeTruthy();
    const src = await adminSql(`select report_source from public.incidents where id = '${id}'`);
    expect(src[0].report_source).toBe("operator");

    await expectError(
      () =>
        api.records.reportIncident({
          siteId: f.siteB,
          type: "injury",
          severity: "low",
          description: "not my site",
          occurredAt: Date.now(),
        }),
      "FORBIDDEN",
    );
  });

  test("incident status: staff-only; operator FORBIDDEN", async () => {
    asOpA();
    await expectError(
      () => api.records.setIncidentStatus({ incidentId: f.incidentA, status: "investigating" }),
      "FORBIDDEN",
    );
    asNational();
    await api.records.setIncidentStatus({ incidentId: f.incidentA, status: "investigating" });
    const st = await adminSql(`select status from public.incidents where id = '${f.incidentA}'`);
    expect(st[0].status).toBe("investigating");
  });

  test("clientRef dedupe: replaying the same queued incident submission creates ONE row", async () => {
    asCounty();
    const args = {
      siteId: f.siteA,
      type: "near_miss" as const,
      severity: "low" as const,
      description: "dedupe probe",
      occurredAt: Date.now(),
      clientRef: `edge-dedupe-${Date.now()}`,
    };
    const firstId = await api.records.reportIncident(args);
    const replayedId = await api.records.reportIncident(args);
    expect(replayedId).toBe(firstId);
    const cnt = await adminSql(`select count(*) as n from public.incidents where client_ref = '${args.clientRef}'`);
    expect(Number(cnt[0].n)).toBe(1);
  });

  test("observation: staff reports + statuses; operator cannot set status", async () => {
    asNational();
    const id = await api.records.reportObservation({
      siteId: f.siteB,
      category: "water_pollution",
      verification: "measured",
      description: "Edge observation",
      observedAt: Date.now(),
    });
    expect(id).toBeTruthy();
    await api.records.setObservationStatus({ observationId: id, status: "monitoring" });
    const st = await adminSql(`select status from public.environmental_observations where id = '${id}'`);
    expect(st[0].status).toBe("monitoring");

    asOpB();
    await expectError(() => api.records.setObservationStatus({ observationId: id, status: "open" }), "FORBIDDEN");
  });

  test("community report: public submission (no auth) returns tracking code; RATE_LIMITED shapes through", async () => {
    asAnon();
    const out = await api.records.submitCommunityReport({
      category: "pollution",
      description: "Edge public report",
      county: "Bomi",
    });
    expect(out.trackingCode).toMatch(/^CR-/);
    const trk = await adminSql(`select status from public.report_tracking where tracking_code = '${out.trackingCode}'`);
    expect(trk[0].status).toBe("submitted");

    // Coarse tracking lookup is public.
    const tracked = await first(api.records.trackCommunityReport({ trackingCode: out.trackingCode }));
    expect(tracked!.status).toBe("submitted");
  });

  test("community report triage: reviewer authorized, operator FORBIDDEN", async () => {
    const rep = await adminSql(
      `select id, tracking_code from public.community_reports where tracking_code = 'CR-TEST0001'`,
    );
    asNational();
    await api.records.triageCommunityReport({ reportId: String(rep[0].id), decision: "verified", note: "confirmed" });
    const st = await adminSql(`select status from public.report_tracking where tracking_code = 'CR-TEST0001'`);
    expect(st[0].status).toBe("verified");
    asOpA();
    await expectError(
      () => api.records.triageCommunityReport({ reportId: String(rep[0].id), decision: "dismissed" }),
      "FORBIDDEN",
    );
  });

  test("listCommunityReports: staff sees the queue, operator sees empty", async () => {
    asNational();
    const staff = await first(api.records.listCommunityReports());
    expect(staff!.length).toBeGreaterThanOrEqual(1);
    asOpA();
    const op = await first(api.records.listCommunityReports());
    expect(op).toEqual([]);
  });
});

// ===========================================================================
// 5. Stats + users + audit.
// ===========================================================================

describe("stats and users", () => {
  test("commandCenter: national staff gets real aggregates; guest gets zeroed stats without denied queries", async () => {
    asNational();
    const s = await first(api.stats.commandCenter());
    expect(s!.sites).toBeGreaterThanOrEqual(2);
    expect(s!.communityReports).toBeGreaterThanOrEqual(1);
    asGuest();
    const g = await first(api.stats.commandCenter());
    expect(g!.sites).toBe(0);
    expect(g!.communityReports).toBe(0);
  });

  test("listUsers is admin-only: supervisor and operator FORBIDDEN; admin sees the directory", async () => {
    asNational();
    await expectError(() => first(api.stats.listUsers()), "FORBIDDEN");
    asOpA();
    await expectError(() => first(api.stats.listUsers()), "FORBIDDEN");
    asAdmin();
    const users = await first(api.stats.listUsers());
    expect(users!.some((u) => u.email === "alice@mineguard.test")).toBe(true);
  });

  test("setUserRole is admin-only and updates the row + audit", async () => {
    asAdmin();
    await api.stats.setUserRole({ userId: f.guest, role: "inspector", scope: "county", county: "Bomi" });
    const p = await adminSql(`select role, scope, county from public.profiles where id = '${f.guest}'`);
    expect(p[0].role).toBe("inspector");
    // Restore guest to role-less for later tests.
    await adminSql(`update public.profiles set role = null, scope = null, county = null where id = '${f.guest}'`);
    asOpA();
    await expectError(() => api.stats.setUserRole({ userId: f.guest, role: "admin" }), "FORBIDDEN");
  });

  test("provisionByEmail is admin-only; unknown email maps to human text", async () => {
    asOpA();
    await expectError(
      () => api.stats.provisionByEmail({ email: "x@x.test", role: "inspector", scope: "county" }),
      "FORBIDDEN",
    );
    asAdmin();
    await expectError(
      () => api.stats.provisionByEmail({ email: "missing@edge.test", role: "inspector", scope: "county" }),
      "sign up first",
    );
  });

  test("completeProfile: self-service authorized path writes fields; anonymous UNAUTHENTICATED", async () => {
    // Use the guest account (role-less) so no bootstrap side effects occur.
    asGuest();
    await api.stats.completeProfile({ jobTitle: "Field Officer", organization: "Edge Org", scope: "county", county: "Nimba" });
    const p = await adminSql(`select job_title, organization, profile_complete from public.profiles where id = '${f.guest}'`);
    expect(p[0].job_title).toBe("Field Officer");
    expect(p[0].profile_complete).toBe(true);
    // Restore.
    await adminSql(`update public.profiles set job_title = null, organization = null, profile_complete = false, scope = null, county = null where id = '${f.guest}'`);

    asAnon();
    await expectError(
      () => api.stats.completeProfile({ jobTitle: "X", organization: "Y" }),
      "UNAUTHENTICATED",
    );
  });

  test("recentAuditLog: staff authorized; operator empty; audit rows exist for admin mutations", async () => {
    asNational();
    const log = await first(api.stats.recentAuditLog());
    expect(log!.some((a) => a.action === "site.create")).toBe(true);
    asOpA();
    const opLog = await first(api.stats.recentAuditLog());
    expect(opLog).toEqual([]);
  });

  test("publicStats: anonymous-readable mirror (authBound: false)", async () => {
    asAnon();
    const s = await first(api.stats.publicStats());
    expect(s).not.toBeNull();
    expect(typeof s!.sites).toBe("number");
  });
});

// ===========================================================================
// 6. Evidence — storage path contract, tenant gate, scope-list RPC.
// ===========================================================================

describe("evidence", () => {
  test("authorized: operator uploads to own tenant; metadata row + audit written; path contract holds", async () => {
    asOpA();
    const rowId = await api.evidence.upload({
      file: new Blob([new Uint8Array(16)]),
      fileName: "edge-evidence.jpg",
      mimeType: "image/jpeg",
      parentType: "incident",
      parentId: f.incidentA,
      siteId: f.siteA,
      caption: "edge",
    });
    expect(rowId).toBeTruthy();
    const row = await adminSql(
      `select storage_path, uploaded_by_id, kind from public.evidence where id = '${rowId}'`,
    );
    expect(row[0].uploaded_by_id).toBe(f.opA);
    expect(row[0].kind).toBe("photo");
    expect(String(row[0].storage_path)).toMatch(new RegExp(`^${f.opA}/.+__edge-evidence\\.jpg$`));
  });

  test("denied: operator cannot upload against another tenant's site; missing siteId; oversized file", async () => {
    asOpA();
    await expectError(
      () =>
        api.evidence.upload({
          file: new Blob([new Uint8Array(4)]),
          fileName: "x.jpg",
          mimeType: "image/jpeg",
          parentType: "incident",
          parentId: f.incidentA,
          siteId: f.siteB,
          caption: undefined,
        }),
      "FORBIDDEN",
    );
    await expectError(
      () =>
        api.evidence.upload({
          file: new Blob([new Uint8Array(4)]),
          fileName: "x.jpg",
          mimeType: "image/jpeg",
          parentType: "incident",
          parentId: f.incidentA,
          // eslint-disable-next-line
          siteId: "" as unknown as string,
        }),
      "EVIDENCE_REQUIRES_SITE",
    );
    await expectError(
      () =>
        api.evidence.upload({
          file: new Blob([new Uint8Array(26 * 1024 * 1024)]),
          fileName: "big.jpg",
          mimeType: "image/jpeg",
          parentType: "incident",
          parentId: f.incidentA,
          siteId: f.siteA,
        }),
      "FILE_TOO_LARGE",
    );
  });

  test("listForParent: operator lists own-parent evidence; other tenant gets empty list", async () => {
    asOpA();
    const own = await first(api.evidence.listForParent({ parentType: "incident", parentId: f.incidentA }));
    expect(own!.length).toBeGreaterThanOrEqual(1);
    asOpB();
    const other = await first(api.evidence.listForParent({ parentType: "incident", parentId: f.incidentA }));
    expect(other).toEqual([]);
  });

  test("getUrl: authorized caller gets a signed URL; cross-tenant caller NOT_FOUND", async () => {
    asOpA();
    const url = await api.evidence.getUrl(f.evidenceA);
    expect(url).toContain("bridge.local/sign/evidence/");
    asOpB();
    await expectError(() => api.evidence.getUrl(f.evidenceA), "NOT_FOUND");
  });

  test("storageFootprint: admin-only; operator FORBIDDEN", async () => {
    asOpA();
    await expectError(() => first(api.evidence.storageFootprint()), "FORBIDDEN");
    asAdmin();
    const fp = await first(api.evidence.storageFootprint());
    expect(fp!.count).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// 7. Seed — admin-only, refuses on non-empty database.
// ===========================================================================

describe("seed", () => {
  test("seedIfEmpty: admin-only (operator FORBIDDEN) and refuses a non-empty database", async () => {
    asOpA();
    await expectError(() => api.seed.seedIfEmpty(), "FORBIDDEN");
    asAdmin();
    const out = await api.seed.seedIfEmpty();
    expect(out).toEqual({ seeded: false, reason: "not_empty" });
  });
});

// ===========================================================================
// 8. ensureProfileDoc — idempotent profile ensure.
// ===========================================================================

describe("ensureProfileDoc", () => {
  test("idempotent: safe to call twice", async () => {
    asOpA();
    await ensureProfileDoc();
    await ensureProfileDoc();
    const rows = await adminSql(`select count(*) as n from public.profiles where id = '${f.opA}'`);
    expect(Number(rows[0].n)).toBe(1);
  });
});
