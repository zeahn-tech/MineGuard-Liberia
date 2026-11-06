// ---------------------------------------------------------------------------
// Migration 0040 — emergency alerts: authorization, confirmation, duplicates, stale
// updates, audience / cross-site limits, acknowledgment attribution, append-only history,
// push outbox and secret handling. Runs against a real Postgres (PGlite).
// ---------------------------------------------------------------------------
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const SM = "aaaaaaaa-0000-4000-8000-0000000000b1"; // AgriLib site manager (assigned to siteA)
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // AgriLib worker (assigned to siteA)
const WK2 = "aaaaaaaa-0000-4000-8000-0000000000c2"; // AgriLib worker, no assignment of their own
const OTH = "aaaaaaaa-0000-4000-8000-0000000000d1"; // another company's administrator

beforeAll(async () => {
  f = await getFixture();
});

// Other suites in the same process re-run older migrations (0002/0009/0011) to test their
// idempotency, which resets function grants. 0040 is idempotent: re-apply it so these tests
// observe its real end state regardless of file order.
beforeEach(async () => {
  const db = await getDb();
  await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", "0040_emergency_alerts.sql"), "utf8"));
});

const as = (run: Runner, uid: string) =>
  run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
async function fails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}
async function owner(run: Runner, sql: string, params: unknown[] = []) {
  const claims = String((await run("select coalesce(current_setting('request.jwt.claims', true), '') as c"))[0].c);
  await run("reset role");
  await run("select set_config('request.jwt.claims', '', true)");
  const rows = await run(sql, params);
  await run("select set_config('request.jwt.claims', $1, true)", [claims]);
  await run("set local role authenticated");
  return rows;
}

async function world<T>(fn: (run: Runner, c: { orgA: string; siteA: string; siteB: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email, raw_user_meta_data) values
      ('${XA}','xa@agrilib.test','{"name":"Xavier Admin"}'), ('${SM}','sm@agrilib.test','{"name":"Sia Manager"}'),
      ('${WK}','wk@agrilib.test','{"name":"Wale Worker"}'), ('${WK2}','wk2@agrilib.test','{"name":"Wanda Worker"}'),
      ('${OTH}','oth@ore.test','{"name":"Olu Other"}')`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0]?.id as string | undefined;
    await run(`update public.sites set organization_id = '${orgA}' where id = '${f.siteA}'`);
    if (orgB) await run(`update public.sites set organization_id = '${orgB}' where id = '${f.siteB}'`);
    await run("set local role authenticated");
    await as(run, f.admin);
    const accept = async (uid: string, org: string, email: string, role: string | null) => {
      await as(run, f.admin);
      const id = role
        ? (await run(`select public.mg_create_org_invitation('${org}', '${email}', '${role}') as id`))[0].id
        : (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${id}')`);
    };
    await accept(XA, orgA, "xa@agrilib.test", null);
    await accept(SM, orgA, "sm@agrilib.test", "site_manager");
    await accept(WK, orgA, "wk@agrilib.test", "worker");
    await accept(WK2, orgA, "wk2@agrilib.test", "worker");
    if (orgB) await accept(OTH, orgB, "oth@ore.test", null);
    await as(run, XA);
    for (const u of [SM, WK]) {
      const m = (await run(`select id from public.organization_members where user_id = '${u}'`))[0].id;
      await run(`select public.mg_assign_member_site('${m}', '${f.siteA}')`);
    }
    await as(run, f.admin);
    return fn(run, { orgA, siteA: f.siteA, siteB: f.siteB });
  });
}

const key = () => crypto.randomUUID();
const create = async (run: Runner, site: string, over: Record<string, string> = {}) =>
  (await run(
    `select public.mg_emergency_create($1, $2, $3, $4, $5, $6, $7, $8, $9) as id`,
    [site, over.title ?? "Pit wall instability", over.severity ?? "critical",
     over.instructions ?? "Move to the assembly point.", over.key ?? key(),
     over.group ?? "all", over.zone ?? "North pit", over.assembly ?? "Gate 2", over.proc ?? "SOP-7"],
  ))[0].id as string;
const activate = (run: Runner, id: string, rev = 1, confirm = "ACTIVATE") =>
  run("select public.mg_emergency_activate($1, $2, $3) as r", [id, confirm, rev]);

describe("who may create / activate / update / cancel", () => {
  test("company administrator and assigned site manager can; worker, other company and anonymous cannot", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      expect(await create(run, c.siteA)).toBeTruthy();
      await as(run, SM);
      expect(await create(run, c.siteA)).toBeTruthy();
      await as(run, WK);
      expect(await fails(create(run, c.siteA))).toMatch(/FORBIDDEN/);
      await as(run, OTH);
      expect(await fails(create(run, c.siteA))).toMatch(/FORBIDDEN/); // cross-company
      await run("select set_config('request.jwt.claims', '', true)");
      expect(await fails(create(run, c.siteA))).toMatch(/UNAUTHENTICATED|FORBIDDEN/);
    });
  });

  test("a site manager has no authority over a site they are not assigned to", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const m = (await run(`select id from public.organization_members where user_id = '${SM}'`))[0].id;
      await run(`select public.mg_unassign_member_site('${m}', '${c.siteA}')`);
      await as(run, SM);
      expect(await fails(create(run, c.siteA))).toMatch(/FORBIDDEN/);
    });
  });

  test("an unauthorized user cannot activate, update or cancel someone else's alert", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      for (const who of [WK, OTH]) {
        await as(run, who);
        expect(await fails(activate(run, id))).toMatch(/FORBIDDEN/);
        expect(await fails(run("select public.mg_emergency_update($1, 1, 'UPDATE', 'x', 'New title here')", [id]))).toMatch(/FORBIDDEN/);
        expect(await fails(run("select public.mg_emergency_close($1, 'cancelled', 'why', 'CANCEL', 1)", [id]))).toMatch(/FORBIDDEN/);
      }
    });
  });

  test("revoking the membership or assignment takes effect on the very next call", async () => {
    await world(async (run, c) => {
      await as(run, SM);
      const id = await create(run, c.siteA);
      await as(run, XA);
      const m = (await run(`select id from public.organization_members where user_id = '${SM}'`))[0].id;
      await run(`select public.mg_revoke_member('${m}')`);
      await as(run, SM);
      expect(await fails(activate(run, id))).toMatch(/FORBIDDEN/);
    });
  });

  test("Ministry administrator holds emergency.manage; supervisors and inspectors are read-only", async () => {
    await world(async (run, c) => {
      await as(run, f.admin);
      expect(await create(run, c.siteA)).toBeTruthy();
      await as(run, f.national);
      expect(await fails(create(run, c.siteA))).toMatch(/FORBIDDEN/);
    });
  });
});

describe("high-impact actions", () => {
  test("activation needs the confirmation word; a stale revision and a replay are refused", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      expect(await fails(activate(run, id, 1, "yes"))).toMatch(/CONFIRMATION_REQUIRED/);
      expect(await fails(activate(run, id, 7))).toMatch(/STALE_REVISION/);
      await activate(run, id);
      expect(await fails(activate(run, id))).toMatch(/ALREADY_ACTIVE/); // replay
    });
  });

  test("a repeated create request (same idempotency key) returns the same alert", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const k = key();
      const a = await create(run, c.siteA, { key: k });
      const b = await create(run, c.siteA, { key: k });
      expect(b).toBe(a);
      expect(Number((await owner(run, "select count(*)::int as n from public.emergency_alerts"))[0].n)).toBe(1);
    });
  });

  test("an identical second alert for the same site cannot be activated while the first is active", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const a = await create(run, c.siteA);
      const b = await create(run, c.siteA);
      await activate(run, a);
      expect(await fails(activate(run, b))).toMatch(/DUPLICATE_ACTIVE/);
    });
  });

  test("updating an active alert needs confirmation, a note and the current revision; replays are stale", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      const upd = (rev: number, confirm: string, note: string) =>
        run("select public.mg_emergency_update($1, $2, $3, $4, null, null, $5) as r", [id, rev, confirm, note, "Evacuate via the east road."]);
      expect(await fails(upd(1, "no", "road blocked"))).toMatch(/CONFIRMATION_REQUIRED/);
      expect(await fails(upd(1, "UPDATE", " "))).toMatch(/NOTE_REQUIRED/);
      await upd(1, "UPDATE", "West road blocked");
      expect(await fails(upd(1, "UPDATE", "West road blocked"))).toMatch(/STALE_REVISION/);
      expect(Number((await run("select revision from public.emergency_alerts where id = $1", [id]))[0].revision)).toBe(2);
    });
  });

  test("two managers racing: the second, working from an old revision, is refused rather than overwriting", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      await run("select public.mg_emergency_update($1, 1, 'UPDATE', 'first', null, null, 'Text from manager one')", [id]);
      await as(run, SM);
      expect(await fails(run("select public.mg_emergency_update($1, 1, 'UPDATE', 'second', null, null, 'Text from manager two')", [id]))).toMatch(/STALE_REVISION/);
    });
  });

  test("cancel/resolve need the matching word and a reason; a closed alert cannot be reopened or updated", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      const close = (o: string, reason: string, confirm: string) =>
        run("select public.mg_emergency_close($1, $2, $3, $4, 1) as r", [id, o, reason, confirm]);
      expect(await fails(close("cancelled", "false alarm", "RESOLVE"))).toMatch(/CONFIRMATION_REQUIRED/);
      expect(await fails(close("cancelled", "", "CANCEL"))).toMatch(/NOTE_REQUIRED/);
      await close("cancelled", "False alarm", "CANCEL");
      expect(await fails(close("cancelled", "again", "CANCEL"))).toMatch(/ALREADY_CLOSED/);
      expect(await fails(activate(run, id))).toMatch(/ALERT_CLOSED/);
      expect(await fails(run("select public.mg_emergency_update($1, 1, 'UPDATE', 'x', 'Some new title')", [id]))).toMatch(/ALERT_CLOSED/);
    });
  });

  test("the audience of an active alert cannot be widened by an update", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA, { group: "site_managers" });
      await activate(run, id);
      expect(await fails(run("select public.mg_emergency_update($1, 1, 'UPDATE', 'n', null, null, null, null, null, null, 'all')", [id]))).toMatch(/INVALID/);
    });
  });
});

describe("audience, visibility and acknowledgment", () => {
  test("only the addressed audience sees an active alert; drafts and other companies never do", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await as(run, WK);
      expect((await run("select public.mg_my_emergency_alerts() as r"))[0].r.alerts).toHaveLength(0); // draft
      await as(run, XA);
      await activate(run, id);
      await as(run, WK);
      const mine = (await run("select public.mg_my_emergency_alerts() as r"))[0].r.alerts;
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ title: "Pit wall instability", severity: "critical", status: "active", source_org: "AgriLib Mining" });
      expect(Object.keys(mine[0])).not.toContain("idempotency_key");
      await as(run, OTH);
      expect((await run("select public.mg_my_emergency_alerts() as r"))[0].r.alerts).toHaveLength(0);
      expect(await run("select id from public.emergency_alerts")).toHaveLength(0); // RLS
    });
  });

  test("target group narrows the audience", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA, { group: "site_managers" });
      await activate(run, id);
      await as(run, WK);
      expect((await run("select public.mg_my_emergency_alerts() as r"))[0].r.alerts).toHaveLength(0);
      await as(run, SM);
      expect((await run("select public.mg_my_emergency_alerts() as r"))[0].r.alerts).toHaveLength(1);
    });
  });

  test("acknowledgment is attributed to the session user, is idempotent and cannot be forged for someone else", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      await as(run, WK);
      const a1 = (await run("select public.mg_emergency_ack($1, 1, 'ref-1', now() - interval '2 minutes') as r", [id]))[0].r;
      const a2 = (await run("select public.mg_emergency_ack($1, 1, 'ref-2', now()) as r", [id]))[0].r;
      expect(a2.acked_at).toBe(a1.acked_at); // replay does not move the time
      const rows = await owner(run, "select user_id, client_ref from public.emergency_alert_acks where alert_id = $1", [id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(WK);
      // no function accepts a user id: signature check
      const sig = await owner(run, "select pg_get_function_identity_arguments('public.mg_emergency_ack(uuid,integer,text,timestamptz)'::regprocedure) as s");
      expect(String(sig[0].s)).not.toMatch(/user/);
      // not addressed to others
      await as(run, OTH);
      expect(await fails(run("select public.mg_emergency_ack($1, 1)", [id]))).toMatch(/FORBIDDEN/);
      await as(run, f.admin);
      expect(await fails(run("select public.mg_emergency_ack($1, 1)", [id]))).toMatch(/FORBIDDEN/);
    });
  });

  test("after an update the earlier acknowledgment is kept but the new revision is not acknowledged", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      await as(run, WK);
      await run("select public.mg_emergency_ack($1, 1)", [id]);
      await as(run, XA);
      await run("select public.mg_emergency_update($1, 1, 'UPDATE', 'Road changed', null, null, 'Use the east road.')", [id]);
      const d = (await run("select public.mg_emergency_dashboard($1) as r", [id]))[0].r;
      expect(d.counts).toMatchObject({ acknowledged_current: 0, acknowledged_earlier_revision: 1 });
      await as(run, WK);
      const mine = (await run("select public.mg_my_emergency_alerts() as r"))[0].r.alerts[0];
      expect(mine.revision).toBe(2);
      expect(mine.my_ack_revision).toBe(1);
      expect(mine.updates[0]).toMatchObject({ type: "updated", note: "Road changed" });
    });
  });

  test("a late acknowledgment of a cancelled alert is recorded as late, not lost and not an error", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      await run("select public.mg_emergency_close($1, 'cancelled', 'Drill ended', 'CANCEL', 1)", [id]);
      await as(run, WK);
      const r = (await run("select public.mg_emergency_ack($1, 1) as r", [id]))[0].r;
      expect(r).toMatchObject({ alert_status: "cancelled", acknowledged_after_close: true });
    });
  });

  test("an offline device still learns of a cancellation (closed alerts stay visible for a day)", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      await run("select public.mg_emergency_close($1, 'resolved', 'All clear', 'RESOLVE', 1)", [id]);
      await as(run, WK);
      const mine = (await run("select public.mg_my_emergency_alerts() as r"))[0].r.alerts;
      expect(mine[0]).toMatchObject({ status: "resolved", close_reason: "All clear" });
    });
  });

  test("a person removed from the company no longer receives the alert", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      const m = (await run(`select id from public.organization_members where user_id = '${WK}'`))[0].id;
      await run(`select public.mg_revoke_member('${m}')`);
      await as(run, WK);
      expect((await run("select public.mg_my_emergency_alerts() as r"))[0].r.alerts).toHaveLength(0);
      expect(await fails(run("select public.mg_emergency_ack($1, 1)", [id]))).toMatch(/FORBIDDEN/);
    });
  });
});

describe("dashboard honesty", () => {
  test("separates audience, acknowledged, reported-displayed and push states, and states what cannot be verified", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      await run("select public.mg_register_push_subscription('https://push.example.test/abc', 'k1', 'a1', 'UA')");
      await as(run, XA);
      const id = await create(run, c.siteA);
      const act = (await activate(run, id))[0].r;
      expect(act.push_queued).toBe(1);
      await as(run, WK);
      await run("select public.mg_emergency_mark_displayed($1, 1)", [id]);
      await as(run, XA);
      const d = (await run("select public.mg_emergency_dashboard($1) as r", [id]))[0].r;
      expect(d.counts.audience).toBeGreaterThanOrEqual(3);
      expect(d.counts).toMatchObject({ acknowledged_current: 0, displayed_reported_current: 1, push_queued: 1, push_service_accepted: 0 });
      expect(d.counts.no_push_subscription).toBe(d.counts.audience - 1);
      expect(d.limits.join(" ")).toMatch(/does not mean the device received it/);
      expect(d.limits.join(" ")).toMatch(/No acknowledgment does not mean/);
      const person = d.people.find((p: { user_id: string }) => p.user_id === WK);
      expect(person.ack_revision).toBeNull();
      expect(JSON.stringify(d)).not.toMatch(/push\.example\.test|"k1"|"a1"|@agrilib/); // no secrets, no emails
    });
  });

  test("a worker cannot open the manager dashboard", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      await as(run, WK);
      expect(await fails(run("select public.mg_emergency_dashboard($1)", [id]))).toMatch(/FORBIDDEN/);
    });
  });
});

describe("push subscriptions and delivery outbox", () => {
  test("subscriptions are not readable by any client; only https endpoints are accepted", async () => {
    await world(async (run) => {
      await as(run, WK);
      await run("select public.mg_register_push_subscription('https://push.example.test/abc', 'k1', 'a1')");
      expect(await fails(run("select * from public.push_subscriptions"))).toMatch(/permission denied/);
      expect(await fails(run("select public.mg_register_push_subscription('http://insecure.test/x', 'k', 'a')"))).toMatch(/check|violates/i);
      expect((await run("select public.mg_my_push_status() as r"))[0].r.active_subscriptions).toBe(1);
      await run("select public.mg_unregister_push_subscription('https://push.example.test/abc')");
      expect((await run("select public.mg_my_push_status() as r"))[0].r.active_subscriptions).toBe(0);
    });
  });

  test("dispatcher functions are service-role only; outcomes are recorded without implying receipt", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      await run("select public.mg_register_push_subscription('https://push.example.test/abc', 'k1', 'a1')");
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      expect(await fails(run("select * from public.mg_emergency_claim_push($1)", [id]))).toMatch(/permission denied/);
      expect((await run("select public.mg_emergency_dispatch_allowed($1) as ok", [id]))[0].ok).toBe(true);
      await as(run, WK);
      expect((await run("select public.mg_emergency_dispatch_allowed($1) as ok", [id]))[0].ok).toBe(false);

      await run("reset role");
      await run("set local role service_role");
      const claimed = await run("select * from public.mg_emergency_claim_push($1)", [id]);
      expect(claimed).toHaveLength(1);
      expect(Object.keys(claimed[0])).not.toContain("instructions"); // lock-screen payload carries no instructions
      expect(await run("select * from public.mg_emergency_claim_push($1)", [id])).toHaveLength(0); // not claimed twice
      await run("select public.mg_emergency_record_push($1, 'expired', 'HTTP 410')", [claimed[0].delivery_id]);
      await run("reset role");
      await run("set local role authenticated");
      await as(run, XA);
      const d = (await run("select public.mg_emergency_dashboard($1) as r", [id]))[0].r;
      expect(d.counts.push_failed_or_expired).toBe(1);
      expect(d.counts.push_service_accepted).toBe(0);
      const sub = await owner(run, "select expired_at from public.push_subscriptions");
      expect(sub[0].expired_at).not.toBeNull();
    });
  });
});

describe("audit trail and tamper resistance", () => {
  test("creation, activation, update and cancellation are audited with the responsible actor", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      await run("select public.mg_emergency_update($1, 1, 'UPDATE', 'n', null, null, 'Changed instructions here')", [id]);
      await run("select public.mg_emergency_close($1, 'resolved', 'Done', 'RESOLVE', 2)", [id]);
      const hist = await owner(run, "select change_type, changed_by from public.emergency_alert_revisions where alert_id = $1 order by seq", [id]);
      expect(hist.map((h) => h.change_type)).toEqual(["created", "activated", "updated", "resolved"]);
      expect(hist.every((h) => h.changed_by === XA)).toBe(true);
      const audit = await owner(run, "select actor_id, action from public.audit_log where entity_type = 'emergency_alerts' and entity_id = $1", [id]);
      expect(audit.length).toBeGreaterThanOrEqual(4);
      expect(audit.every((a) => a.actor_id === XA)).toBe(true);
    });
  });

  test("ordinary users cannot write or alter alerts, history, acknowledgments, deliveries or the audit log directly", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      for (const sql of [
        `update public.emergency_alerts set status = 'resolved' where id = '${id}'`,
        `insert into public.emergency_alerts (site_id,title,severity,instructions,idempotency_key,created_by) values ('${c.siteA}','Fake alert','critical','x','abcdefgh12','${XA}')`,
        `delete from public.emergency_alert_revisions`,
        `update public.emergency_alert_revisions set note = 'edited'`,
        `insert into public.emergency_alert_acks (alert_id,user_id,revision,alert_status_at_ack) values ('${id}','${WK}',1,'active')`,
        `update public.emergency_alert_deliveries set state = 'service_accepted'`,
        `delete from public.audit_log where entity_type = 'emergency_alerts'`,
        `update public.audit_log set summary = 'x' where entity_type = 'emergency_alerts'`,
      ]) {
        expect(await fails(run(sql))).toMatch(/permission denied|row-level security|IMMUTABLE/i);
      }
    });
  });

  test("even the owner cannot edit or delete history rows (append-only trigger)", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      await as(run, WK);
      await run("select public.mg_emergency_ack($1, 1)", [id]);
      await run("reset role");
      expect(await fails(run("update public.emergency_alert_revisions set note = 'x'"))).toMatch(/IMMUTABLE/);
      expect(await fails(run("delete from public.emergency_alert_acks"))).toMatch(/IMMUTABLE/);
      await run("set local role authenticated");
    });
  });

  test("push endpoints and keys never reach the audit log", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      await run("select public.mg_register_push_subscription('https://push.example.test/secret-endpoint', 'p256-secret', 'auth-secret')");
      await as(run, XA);
      const id = await create(run, c.siteA);
      await activate(run, id);
      const rows = await owner(run, "select details::text as d from public.audit_log where details is not null");
      expect(rows.some((r) => /secret-endpoint|p256-secret|auth-secret/.test(String(r.d)))).toBe(false);
    });
  });
});
