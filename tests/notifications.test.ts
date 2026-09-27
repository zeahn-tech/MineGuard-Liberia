// ---------------------------------------------------------------------------
// NOTIFICATIONS (§1) — minimal in-app v1, derived not stored.
//
// The service (api.records.listNotifications) is COMPUTED at request time
// from records the caller can already see: no notifications table, no
// delivery infrastructure. Tests verify the four properties that matter:
//
// 1. DEADLINES: only open corrective actions inside the due-soon window
//    (≤3 days) or overdue ones become notifications; severity tracks the
//    threshold (warning vs urgent); far-future CAs stay silent.
// 2. DECISIONS: an operator sees the reviewer's decision (verified/closed/
    // escalated) on CAs they opened; escalated is urgent.
// 3. REPORT STATUS: staff see triaged community reports from the last 7
//    days; untouched (submitted) ones are not news.
// 4. SCOPING / NO-LEAK: every notification derives from a record the
//    caller can access — cross-tenant CAs produce nothing for an operator;
//    role-less callers get an empty list; links point into the caller's
//    OWN section (/operate vs /portal).
//
// Delivery channels: in-app is the only channel. Push/email/SMS imply new
// infrastructure and cost — REQUIRES GOVERNMENT/OWNER CONFIRMATION
// (docs/01); their absence is asserted as a source-contract so the v1
// scope cannot silently grow a channel.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

let currentUid: string | null = null;
function setIdentity(uid: string | null) {
  currentUid = uid;
  __testSetAuthUserId(uid);
  edgeIdentity.set(uid);
}

function first<T>(q: { subscribe: (cb: (v: T) => void) => () => void }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const unsub = q.subscribe((v) => {
      unsub();
      resolve(v);
    });
  });
}

const DAY = 86_400_000;

/** Seed a corrective action directly (admin context) and return its id.
 *  Restores the caller's identity afterwards — the seed must not leak the
 *  admin session into the identity the test subscribes with. */
async function seedCA(opts: {
  findingId?: string;
  siteId?: string;
  dueAt: Date;
  status?: "open" | "in_progress" | "submitted" | "verified" | "closed" | "escalated";
  openedBy?: string;
}): Promise<string> {
  const prior = currentUid;
  setIdentity(f.admin);
  const rows = await adminSql(
    `insert into public.corrective_actions (finding_id, site_id, description, due_at, opened_by_id${opts.status ? ", status" : ""})
     values ('${opts.findingId ?? f.findingA}', '${opts.siteId ?? f.siteA}', 'Notification probe CA', '${opts.dueAt.toISOString()}', '${opts.openedBy ?? f.admin}'${opts.status ? `, '${opts.status}'` : ""})
     returning id`,
  );
  setIdentity(prior);
  return String(rows[0].id);
}

async function deleteCA(id: string) {
  setIdentity(f.admin);
  await adminSql(`delete from public.corrective_actions where id = '${id}'`);
}

describe("notification: corrective-action deadlines", () => {
  test("overdue open CA → urgent notification; due-in-2-days → warning; due-in-30-days → silent", async () => {
    setIdentity(f.opA); // AgriLib operator — own-tenant scope

    const overdue = await seedCA({ dueAt: new Date(Date.now() - 1 * DAY) });
    const soon = await seedCA({ dueAt: new Date(Date.now() + 2 * DAY) });
    const far = await seedCA({ dueAt: new Date(Date.now() + 30 * DAY) });

    const notifs = (await first(api.records.listNotifications()))!;
    const ids = new Set(notifs.map((n) => n.id));

    expect(ids.has(`ca-${overdue}`)).toBe(true);
    expect(notifs.find((n) => n.id === `ca-${overdue}`)?.severity).toBe("urgent");
    expect(notifs.find((n) => n.id === `ca-${overdue}`)?.title).toContain("Overdue");

    expect(ids.has(`ca-${soon}`)).toBe(true);
    expect(notifs.find((n) => n.id === `ca-${soon}`)?.severity).toBe("warning");

    expect(ids.has(`ca-${far}`)).toBe(false); // far-future: silent

    await deleteCA(overdue);
    await deleteCA(soon);
    await deleteCA(far);
  });

  test("decided (closed) CAs no longer produce deadline notifications", async () => {
    setIdentity(f.opA);
    const closed = await seedCA({ dueAt: new Date(Date.now() - 5 * DAY), status: "closed" });
    const notifs = (await first(api.records.listNotifications()))!;
    expect(notifs.some((n) => n.id === `ca-${closed}`)).toBe(false);
    await deleteCA(closed);
  });
});

describe("notification: reviewer decisions for operators", () => {
  test("operator sees verified/escalated decisions on CAs they opened; escalated is urgent", async () => {
    // opA opens (responds to) a CA — opened_by_id must be opA for the
    // decision notification to address them.
    setIdentity(f.opA);
    const decided = await seedCA({
      dueAt: new Date(Date.now() + 10 * DAY), // far future: no deadline noise
      status: "verified",
      openedBy: f.opA,
    });
    const escalated = await seedCA({
      dueAt: new Date(Date.now() + 10 * DAY),
      status: "escalated",
      openedBy: f.opA,
    });

    const notifs = (await first(api.records.listNotifications()))!;
    const verified = notifs.find((n) => n.id === `cad-${decided}`);
    expect(verified).toBeTruthy();
    expect(verified!.kind).toBe("ca_decision");
    expect(verified!.severity).toBe("info");
    expect(verified!.title).toContain("verified");
    expect(verified!.linkTo).toBe("/operate/corrective-actions"); // operator section link

    const esc = notifs.find((n) => n.id === `cad-${escalated}`);
    expect(esc!.severity).toBe("urgent");
    expect(esc!.title).toContain("ESCALATED");

    await deleteCA(decided);
    await deleteCA(escalated);
  });

  test("a decision on a CA the operator did NOT open is not addressed to them", async () => {
    setIdentity(f.opA);
    const notMine = await seedCA({
      dueAt: new Date(Date.now() + 10 * DAY),
      status: "verified",
      openedBy: f.admin,
    });
    const notifs = (await first(api.records.listNotifications()))!;
    expect(notifs.some((n) => n.id === `cad-${notMine}`)).toBe(false);
    await deleteCA(notMine);
  });
});

describe("notification: community report status changes (staff)", () => {
  test("triaged reports surface for staff; untouched 'submitted' ones do not", async () => {
    // Seed two reports: one triaged to 'verified' (news), one untouched
    // 'submitted' (not news). Do NOT depend on other suites' mutations.
    setIdentity(f.admin);
    const triaged = await adminSql(
      `insert into public.community_reports (tracking_code, category, description, county, status, reviewed_at)
       values ('CR-NTF0002', 'pollution', 'Notification triage probe', 'Bomi', 'verified', now())
       returning id`,
    );
    await adminSql(
      `insert into public.community_reports (tracking_code, category, description, county, status)
       values ('CR-NTF0001', 'pollution', 'Notification silence probe', 'Bomi', 'submitted')`,
    );

    setIdentity(f.national);
    const notifs = (await first(api.records.listNotifications()))!;
    const rep = notifs.find((n) => n.id === `rep-${triaged[0].id}`);
    expect(rep).toBeTruthy();
    expect(rep!.kind).toBe("report_status");
    expect(rep!.title).toContain("CR-NTF0002");
    expect(rep!.title).toContain("verified");
    expect(rep!.linkTo).toBe("/portal/community");
    expect(notifs.some((n) => n.title.includes("CR-NTF0001"))).toBe(false);

    await adminSql(`delete from public.community_reports where id = '${triaged[0].id}'`);
    await adminSql(`delete from public.community_reports where tracking_code = 'CR-NTF0001'`);
  });

  test("operators (non-staff) receive no community-report notifications", async () => {
    setIdentity(f.opA);
    const notifs = (await first(api.records.listNotifications()))!;
    expect(notifs.some((n) => n.kind === "report_status")).toBe(false);
  });
});

describe("notification: scoping and no-leak", () => {
  test("cross-tenant CA produces nothing for the operator (isolation holds in notifications)", async () => {
    // An urgent CA on siteB (OreCo) — opA (AgriLib) must not see it.
    const otherTenant = await seedCA({
      findingId: undefined,
      siteId: f.siteB,
      dueAt: new Date(Date.now() - 2 * DAY),
    });
    // The seed above uses findingA (siteA) with site_id overridden to siteB —
    // normalize by deleting afterwards. opA's view:
    setIdentity(f.opA);
    const notifs = (await first(api.records.listNotifications()))!;
    expect(notifs.some((n) => n.id === `ca-${otherTenant}`)).toBe(false);
    // …while the OreCo operator DOES see it.
    setIdentity(f.opB);
    const notifsB = (await first(api.records.listNotifications()))!;
    expect(notifsB.some((n) => n.id === `ca-${otherTenant}`)).toBe(true);
    await deleteCA(otherTenant);
  });

  test("role-less callers get an empty list; anonymous get no data, never a thrown error", async () => {
    setIdentity(f.guest);
    const notifs = (await first(api.records.listNotifications()))!;
    expect(notifs).toEqual([]);
    // Anonymous: requireAuthed throws UNAUTHENTICATED inside the live()
    // fetcher, which resolves UNDEFINED (the documented live() contract —
    // a bad subscription never hangs or throws into the UI). Either way:
    // no data leaks, no error surfaces to the caller.
    setIdentity(null);
    const anon = await first(api.records.listNotifications());
    expect(anon === undefined || anon!.length === 0).toBe(true);
  });

  test("staff links point into /portal, operator links into /operate (each shell's own section)", async () => {
    setIdentity(f.national);
    const staffNotifs = (await first(api.records.listNotifications()))!;
    for (const n of staffNotifs) {
      expect(n.linkTo.startsWith("/portal")).toBe(true);
    }
    setIdentity(f.opA);
    const opNotifs = (await first(api.records.listNotifications()))!;
    for (const n of opNotifs) {
      expect(n.linkTo.startsWith("/operate")).toBe(true);
    }
  });
});

describe("delivery-channel classification (v1 scope guard)", () => {
  const backendSrc = readFileSync(join(import.meta.dir, "..", "src", "lib", "backend.ts"), "utf8");

  test("notifications are derived at request time — no notifications table exists", async () => {
    setIdentity(f.admin);
    const tables = await adminSql(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name ilike '%notif%'`,
    );
    expect(tables.length).toBe(0);
  });

  test("no push/email/SMS channel is wired into the product (REQUIRES CONFIRMATION gate)", () => {
    expect(backendSrc).toContain("listNotifications");
    expect(backendSrc).not.toMatch(/sendEmail|sendSms|pushNotification|web-push|fcm|sendgrid|twilio/i);
    // The classification is documented where the decision lives:
    expect(backendSrc).toContain("REQUIRES GOVERNMENT/OWNER CONFIRMATION");
  });

  test("the UI states the in-app-only scope to the user", () => {
    const bellSrc = readFileSync(join(import.meta.dir, "..", "src", "components", "NotificationBell.tsx"), "utf8");
    expect(bellSrc).toContain("In-app notifications only");
  });
});
