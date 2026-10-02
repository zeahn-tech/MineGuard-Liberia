// ---------------------------------------------------------------------------
// OPERATOR PORTAL — Gap Closure Directive, Priority B item 5 (spec §20).
//
// The dedicated operator surface: own sites, compliance obligations
// (corrective actions with finding + site join), and the respond flow.
// Driven through the REAL src/lib/backend.ts via the wire bridge, exactly
// like tests/backend-edge.test.ts — RLS + guard triggers decide, the client
// mirror is verified to agree.
//
// What is asserted: an operator's obligation feed contains ONLY their own
// tenant's rows (cross-tenant CAs are invisible, not merely filtered in the
// UI); staff see the same feed over their own scope; the respond flow works
// for the owning operator while open, is existence-masked (NOT_FOUND) for
// another tenant, and FORBIDDEN for staff; every authorized response lands
// in audit_log.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { api } from "../src/lib/backend";
import { __testSetSupabaseClient, __testSetAuthUserId } from "../src/lib/supabase";
import {
  adminSql,
  createEdgeClient,
  edgeIdentity,
  EDGE_IDS as f,
  getEdgeDb,
} from "./helpers/backend-edge";

let clientSwapped = false;

beforeAll(async () => {
  await getEdgeDb();
  if (!clientSwapped) {
    __testSetSupabaseClient(createEdgeClient());
    clientSwapped = true;
  }
});

function setIdentity(uid: string | null) {
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}

/** First value from a live() subscription (or undefined if it errored). */
function first<T>(q: { subscribe: (cb: (v: T) => void) => () => void }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      unsub();
      resolve(v);
    });
  });
}

describe("operator portal: obligation feed", () => {
  test("operator sees ONLY their own tenant's corrective actions, joined with finding + site", async () => {
    setIdentity(f.opA); // AgriLib Mining (siteA)
    const feed = await first(api.inspections.listMyCorrectiveActions());
    expect(feed!.length).toBeGreaterThanOrEqual(1);
    expect(feed!.every((o) => o.siteId === f.siteA)).toBe(true);
    expect(feed!.every((o) => o.siteCode.startsWith("LB-BOM"))).toBe(true);
    // The join worked: finding title and site identity are present.
    expect(feed![0].findingTitle).toBeTruthy();
    expect(feed![0].county).toBe("Bomi");
  });

  test("cross-tenant obligations are invisible to the feed (RLS, not UI filtering)", async () => {
    // Seed a CA on siteB (OreCo tenant) as admin, then re-check opA's feed.
    setIdentity(f.admin);
    const siteBFinding = await adminSql(
      `insert into public.findings (inspection_id, site_id, title, severity, created_by_id)
       values ('${f.inspection}', '${f.siteB}', 'Edge opB finding', 'medium', '${f.admin}')
       returning id`,
    );
    await adminSql(
      `insert into public.corrective_actions (finding_id, site_id, description, due_at, opened_by_id)
       values ('${siteBFinding[0].id}', '${f.siteB}', 'Edge opB obligation', now() + interval '5 days', '${f.admin}')
       returning id`,
    );

    setIdentity(f.opA);
    const feedA = await first(api.inspections.listMyCorrectiveActions());
    expect(feedA!.some((o) => o.siteId === f.siteB)).toBe(false);

    setIdentity(f.opB);
    const feedB = await first(api.inspections.listMyCorrectiveActions());
    expect(feedB!.every((o) => o.siteId === f.siteB)).toBe(true);
    expect(feedB!.some((o) => o.siteId === f.siteA)).toBe(false);

    setIdentity(f.admin);
    await adminSql(
      `delete from public.corrective_actions where finding_id = '${siteBFinding[0].id}'`,
    );
    await adminSql(`delete from public.findings where id = '${siteBFinding[0].id}'`);
  });

  test("staff see the same feed over their own scope (national = all)", async () => {
    setIdentity(f.national);
    const feed = await first(api.inspections.listMyCorrectiveActions());
    expect(feed!.length).toBeGreaterThanOrEqual(1);
    // National staff can access all sites, so both tenants may appear —
    // but every row must carry a joined site identity.
    expect(feed!.every((o) => o.siteCode && o.county)).toBe(true);
  });

  test("unassigned callers get an empty feed, not an error", async () => {
    setIdentity(f.guest);
    const feed = await first(api.inspections.listMyCorrectiveActions());
    expect(feed).toEqual([]);
  });
});

describe("operator portal: respond flow", () => {
  test("owning operator responds to an OPEN action; response lands in audit_log", async () => {
    // Fresh open CA on opA's site (admin opens it, as staff do).
    setIdentity(f.admin);
    const caId = await api.inspections.openCorrectiveAction({
      findingId: f.findingA,
      description: "Operator portal respond probe",
      dueAt: Date.now() + 3 * 86_400_000,
    });

    setIdentity(f.opA);
    await api.inspections.respondCorrectiveAction({ caId, operatorNote: "Guard installed on the jaw crusher" });

    const row = await adminSql(
      `select operator_note, status from public.corrective_actions where id = '${caId}'`,
    );
    expect(row[0].status).toBe("submitted");
    // SEC-1 (0009): the response's audit row comes from the server-side
    // mg_audit_row trigger (one UPDATE ⇒ exactly one row).
    const audit = await adminSql(
      `select 1 from public.audit_log where action = 'corrective_actions.update' and entity_id = '${caId}'`,
    );
    expect(audit.length).toBe(1);
  });

  test("responding again (already submitted) is FORBIDDEN — one response per action", async () => {
    setIdentity(f.opA);
    const feed = await first(api.inspections.listMyCorrectiveActions());
    const submitted = feed!.find((o) => o.status === "submitted");
    expect(submitted).toBeTruthy();
    let msg = "";
    try {
      await api.inspections.respondCorrectiveAction({ caId: submitted!._id, operatorNote: "second try" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("FORBIDDEN");
  });

  test("another tenant's action is existence-masked (NOT_FOUND), staff gets FORBIDDEN", async () => {
    setIdentity(f.admin);
    const feed = await first(api.inspections.listMyCorrectiveActions());
    const openOne = feed!.find((o) => o.status === "open");
    expect(openOne).toBeTruthy();

    // opB cannot even see siteA's rows → NOT_FOUND (existence masking).
    setIdentity(f.opB);
    let msg = "";
    try {
      await api.inspections.respondCorrectiveAction({ caId: openOne!._id, operatorNote: "not mine" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("NOT_FOUND");

    // Staff are not operators → FORBIDDEN by the client guard.
    setIdentity(f.national);
    msg = "";
    try {
      await api.inspections.respondCorrectiveAction({ caId: openOne!._id, operatorNote: "staff note" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("FORBIDDEN");
  });
});
