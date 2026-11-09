// ---------------------------------------------------------------------------
// Public User programme — Phase C (migration 0049): report ownership (opt-in), personal tracking,
// feedback and inquiries, and anonymization on account deletion.
// Real Postgres (PGlite) with the production migrations; every session rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let f: Awaited<ReturnType<typeof getFixture>>;
beforeAll(async () => {
  f = await getFixture();
  // Other files re-apply older migrations on the shared DB: assert the real end state.
  const db = await getDb();
  for (const m of ["0047_close_admin_bootstrap.sql", "0048_public_user_identity.sql", "0049_public_reports_feedback.sql", "0050_public_content.sql"]) {
    await db.exec(read(`supabase/migrations/${m}`));
  }
}, 120000);

const PUB = "dddd0049-0000-4000-8000-000000000001"; // verified public user
const PUB2 = "dddd0049-0000-4000-8000-000000000002"; // another verified public user
const UNV = "dddd0049-0000-4000-8000-000000000003"; // e-mail not confirmed
const ANON = "dddd0049-0000-4000-8000-000000000004"; // anonymous guest
const RST = "dddd0049-0000-4000-8000-000000000005"; // restricted public account
const MEM = "dddd0049-0000-4000-8000-000000000006"; // active company member

async function denied(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

async function world(run: Runner) {
  await run(`insert into auth.users (id, email, email_confirmed_at) values
    ('${PUB}', 'pub@example.org', now()), ('${PUB2}', 'pub2@example.org', now()),
    ('${UNV}', 'unv@example.org', null), ('${ANON}', null, null),
    ('${RST}', 'rst@example.org', now()), ('${MEM}', 'mem@example.org', now())`);
  const org = (await run("select id from public.organizations order by name limit 1"))[0].id;
  await run(`insert into public.organization_members (organization_id, user_id, org_role, status)
             values ('${org}', '${MEM}', 'worker', 'active')`);
  await run(`update public.profiles set restricted_at = now() where id = '${RST}'`);
}
const as = (run: Runner, uid: string, anonymous = false) =>
  run("set local role authenticated").then(() =>
    run(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: "authenticated", is_anonymous: anonymous })}', true)`),
  );
const back = (run: Runner) => run("reset role");
const q = (s: string) => s.replace(/'/g, "''");

const mine = (run: Runner, desc: string, category = "safety_concern", county = "Bomi") =>
  run(`select public.submit_my_community_report('${category}', '${q(desc)}', '${county}') as r`).then((r) => r[0].r as { id: string; trackingCode: string });
const anonymous = (run: Runner, desc: string, category = "safety_concern", county = "Bomi") =>
  run(`select public.submit_community_report(null, '${category}', '${q(desc)}', '${county}') as r`).then((r) => r[0].r as { id: string; trackingCode: string });
const feedback = (run: Runner, subject: string, message: string, kind = "feedback") =>
  run(`select public.submit_public_feedback('${kind}', '${q(subject)}', '${q(message)}') as r`).then((r) => r[0].r as { id: string });

const LONG = "The washing plant upstream is discharging brown water into the creek every evening.";

describe("0049: anonymous reporting is unchanged", () => {
  test("no session (anon role) and anonymous guests can still report; no owner is recorded; the code is server-minted", async () => {
    await withRole("anon", null, async (run) => {
      const r = await anonymous(run, LONG + " (anon role)");
      expect(r.trackingCode).toMatch(/^CR-([0-9A-F]{4}-){4}[0-9A-F]{4}$/);
    });
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, ANON, true);
      const r = await anonymous(run, LONG + " (guest)", "other");
      await back(run);
      const row = (await run(`select submitter_id, category::text as category from public.community_reports where id = '${r.id}'`))[0];
      expect(row).toEqual({ submitter_id: null, category: "other" });
    });
  });

  test("a verified user who does NOT tick 'link to my account' reports anonymously: no owner, nothing in My reports", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const r = await anonymous(run, LONG + " (verified user, unlinked)");
      await back(run);
      expect((await run(`select submitter_id from public.community_reports where id = '${r.id}'`))[0].submitter_id).toBeNull();
      await as(run, PUB);
      expect((await run("select * from public.mg_my_community_reports()")).length).toBe(0);
    });
  });

  test("tracking codes are unpredictable and unique, and the public lookup still works and follows triage", async () => {
    await withRole("postgres", null, async (run) => {
      const codes = new Set<string>();
      for (let i = 0; i < 25; i++) {
        const r = await anonymous(run, `${LONG} number ${i}`);
        expect(r.trackingCode).toMatch(/^CR-([0-9A-F]{4}-){4}[0-9A-F]{4}$/);
        codes.add(r.trackingCode);
      }
      expect(codes.size).toBe(25);
      const code = [...codes][0];
      await run("set local role anon");
      expect((await run(`select public.track_community_report('${code}') as t`))[0].t).toMatchObject({ status: "submitted" });
      expect((await run(`select public.track_community_report('CR-0000-0000-0000-0000-0000') as t`))[0].t).toBeNull();
    });
  });
});

describe("0049: opt-in ownership for verified public users", () => {
  test("a verified public user links a report; the owner is the session, never a browser value", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const r = await mine(run, LONG + " (linked)");
      await back(run);
      expect((await run(`select submitter_id from public.community_reports where id = '${r.id}'`))[0].submitter_id).toBe(PUB);
      // the function has no owner parameter at all
      const args = (await run(`select pg_get_function_arguments(p.oid) as a from pg_proc p where p.proname = 'submit_my_community_report'`))[0].a as string;
      expect(args).not.toMatch(/submitter|owner|user_id|p_uid/i);
    });
  });

  test("not available to: unverified accounts, guests, staff, company members, restricted accounts, or the anon role", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      for (const [uid, anon] of [[UNV, false], [ANON, true], [f.county, false], [f.admin, false], [MEM, false], [RST, false], [f.opA, false]] as const) {
        await back(run);
        await as(run, uid, anon);
        expect(await denied(mine(run, LONG + ` (${uid})`))).toContain("FORBIDDEN");
      }
      await back(run);
      expect((await run("select count(*)::int as n from public.community_reports where submitter_id is not null"))[0].n).toBe(0);
    });
    await withRole("anon", null, async (run) => {
      expect(await denied(mine(run, LONG))).toMatch(/permission denied/i);
    });
  });

  test("an identical report within 24 hours is refused; a different one is accepted", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      await mine(run, LONG);
      expect(await denied(mine(run, "  " + LONG.toUpperCase() + " "))).toContain("DUPLICATE");
      await mine(run, LONG + " A second, different observation at the same site.");
    });
  });

  test("the 11th linked report in an hour is rate limited", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      for (let i = 0; i < 10; i++) await mine(run, `${LONG} distinct report ${i}`);
      expect(await denied(mine(run, `${LONG} distinct report 11`))).toContain("RATE_LIMITED");
    });
  });

  test("input validation still applies and a rejected report leaves no row behind", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      expect(await denied(run(`select public.submit_my_community_report('safety_concern', '${LONG}', 'Atlantis')`))).toMatch(/unknown county/);
      expect(await denied(run(`select public.submit_my_community_report('not_a_category', '${LONG}', 'Bomi')`))).not.toBe("");
      expect(await denied(mine(run, ""))).toMatch(/INVALID_INPUT/);
      await back(run);
      expect((await run(`select count(*)::int as n from public.community_reports where submitter_id = '${PUB}'`))[0].n).toBe(0);
    });
  });

  test("category 'other' is accepted", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const r = await mine(run, LONG + " (something else entirely)", "other");
      await back(run);
      expect((await run(`select category::text as c from public.community_reports where id = '${r.id}'`))[0].c).toBe("other");
    });
  });
});

describe("0049: ownership and tracking code are immutable; triage still works", () => {
  test("nobody — owner, staff or administrator — can change or steal ownership or the code", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const r = await mine(run, LONG);
      await back(run);
      for (const [uid, set] of [
        [PUB, `submitter_id = '${PUB2}'`],
        [PUB2, `submitter_id = '${PUB2}'`],
        [f.admin, `submitter_id = '${PUB2}'`],
        [f.admin, "submitter_id = null"],
        [f.national, `submitter_id = '${PUB2}'`],
        [f.admin, "tracking_code = 'CR-FORGED'"],
      ] as const) {
        await as(run, uid);
        const msg = await denied(run(`update public.community_reports set ${set} where id = '${r.id}'`));
        await back(run);
        // either refused outright, or the row was never writable/visible to that caller
        const now = (await run(`select submitter_id, tracking_code from public.community_reports where id = '${r.id}'`))[0];
        expect(now).toEqual({ submitter_id: PUB, tracking_code: r.trackingCode });
        void msg;
      }
      await as(run, f.admin);
      expect(await denied(run(`update public.community_reports set submitter_id = '${PUB2}' where id = '${r.id}'`))).toContain("ownership cannot be changed");
    });
  });

  test("the trusted claim/clear modes cannot be misused: claim only for yourself, clear only to NULL, nothing else may change", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      const r = await anonymous(run, LONG + " (to be claimed)");
      await as(run, PUB2);
      await run("select set_config('mg.report_owner', 'claim', true)");
      expect(await denied(run(`update public.community_reports set submitter_id = '${PUB}' where id = '${r.id}'`))).toBeDefined();
      await back(run);
      expect((await run(`select submitter_id from public.community_reports where id = '${r.id}'`))[0].submitter_id).toBeNull();
      await run("select set_config('mg.report_owner', 'clear', true)");
      await run(`update public.community_reports set triage_note = 'x' where id = '${r.id}'`).then(
        () => { throw new Error("must be refused"); },
        (e) => expect(String(e.message)).toContain("only the owner link"),
      );
    });
  });

  test("staff triage is unchanged: a supervisor starts review, an administrator decides; the public lookup mirrors it", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const r = await mine(run, LONG);
      await back(run);
      await as(run, f.national); // supervisor: a reviewer (triage needs the reviewer role)
      await run(`select public.triage_community_report('${r.id}', 'under_review', 'looking at it')`);
      await back(run);
      await as(run, f.admin);
      await run(`select public.triage_community_report('${r.id}', 'verified', 'confirmed on site')`);
      await back(run);
      expect((await run(`select status::text as s from public.report_tracking where tracking_code = '${r.trackingCode}'`))[0].s).toBe("verified");
    });
  });
});

describe("0049: personal report tracking (My reports)", () => {
  test("returns only the caller's reports, newest first, with curated columns — never the reviewer's note or identity", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const a = await mine(run, LONG + " first");
      await mine(run, LONG + " second");
      await back(run);
      await as(run, PUB2);
      await mine(run, LONG + " belongs to someone else");
      await back(run);
      await as(run, f.national);
      await run(`select public.triage_community_report('${a.id}', 'under_review', 'INTERNAL: suspect is a known operator')`);
      await back(run);
      await as(run, PUB);
      const rows = await run("select * from public.mg_my_community_reports()");
      expect(rows.length).toBe(2);
      expect(rows.every((x) => x.description.startsWith(LONG))).toBe(true);
      expect(rows.some((x) => String(x.description).includes("someone else"))).toBe(false);
      expect(Object.keys(rows[0]).sort()).toEqual(
        ["category", "community", "county", "created_at", "description", "district", "id", "reviewed_at", "status", "tracking_code"],
      );
      expect(JSON.stringify(rows)).not.toContain("INTERNAL");
      expect(rows.find((x) => x.id === a.id)!.status).toBe("under_review");
      // the function takes no id parameter: nothing to tamper with
      await back(run);
      const args = (await run(`select pg_get_function_arguments(p.oid) as a from pg_proc p where p.proname = 'mg_my_community_reports'`))[0].a;
      expect(args).toBe("");
    });
  });

  test("owners get no direct table access; guests, the anon role and strangers see nothing", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      await mine(run, LONG);
      await back(run);
      for (const [uid, anon] of [[PUB, false], [PUB2, false], [ANON, true]] as const) {
        await as(run, uid, anon);
        expect((await run("select count(*)::int as n from public.community_reports"))[0].n).toBe(0);
        await back(run);
      }
      await as(run, PUB2);
      expect((await run("select * from public.mg_my_community_reports()")).length).toBe(0);
      await back(run);
      await as(run, ANON, true);
      expect((await run("select * from public.mg_my_community_reports()")).length).toBe(0);
    });
    await withRole("anon", null, async (run) => {
      expect(await denied(run("select * from public.mg_my_community_reports()"))).toMatch(/permission denied/i);
    });
  });

  test("direct writes to the table are refused for every public caller", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      expect(await denied(run(`insert into public.community_reports (tracking_code, category, description, county, submitter_id)
        values ('CR-DIRECT', 'pollution', 'direct insert', 'Bomi', '${PUB}')`))).toMatch(/permission denied|row-level security/i);
    });
  });

  test("staff scope reads are unchanged: an inspector sees only their county's reports, an administrator sees all", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await anonymous(run, LONG + " in Bomi", "pollution", "Bomi");
      await anonymous(run, LONG + " in Nimba", "pollution", "Nimba");
      await as(run, f.county);
      const rows = await run("select county from public.community_reports");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.county === "Bomi")).toBe(true);
      await back(run);
      await as(run, f.admin);
      const all = await run("select distinct county from public.community_reports");
      expect(all.map((r) => r.county)).toEqual(expect.arrayContaining(["Bomi", "Nimba"]));
    });
  });
});

describe("0049: feedback and inquiries", () => {
  test("a verified public user sends feedback; others cannot", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const r = await feedback(run, "Clearer safety notices", "Please publish the safety notices in Kpelle and Bassa as well.");
      expect(r.id).toBeDefined();
      for (const [uid, anon] of [[UNV, false], [ANON, true], [f.county, false], [MEM, false], [RST, false], [f.opA, false]] as const) {
        await back(run);
        await as(run, uid, anon);
        expect(await denied(feedback(run, "Subject here", "A perfectly reasonable message text."))).toContain("FORBIDDEN");
      }
    });
    await withRole("anon", null, async (run) => {
      expect(await denied(feedback(run, "Subject here", "A perfectly reasonable message text."))).toMatch(/permission denied/i);
    });
  });

  test("validation, link cap, duplicate, rate limit and open-message cap", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      expect(await denied(feedback(run, "ab", "A perfectly reasonable message text."))).toMatch(/subject/);
      expect(await denied(feedback(run, "Good subject", "too short"))).toMatch(/message/);
      expect(await denied(feedback(run, "Good subject", "x".repeat(2001)))).toMatch(/message/);
      expect(await denied(feedback(run, "Good subject", "A perfectly reasonable message text.", "complaint"))).toMatch(/kind/);
      expect(await denied(feedback(run, "Links", "see https://a.example https://b.example https://c.example for details"))).toMatch(/links/);
      await feedback(run, "First message", "This is the first perfectly reasonable message.");
      expect(await denied(feedback(run, " FIRST MESSAGE ", "this is the first perfectly reasonable message."))).toContain("DUPLICATE");
      for (let i = 2; i <= 5; i++) await feedback(run, `Message ${i}`, `This is perfectly reasonable message number ${i}.`);
      expect(await denied(feedback(run, "Message 6", "This is perfectly reasonable message number 6."))).toContain("RATE_LIMITED");
    });
    await withRole("postgres", null, async (run) => {
      await world(run);
      for (let i = 0; i < 20; i++) {
        await run(`insert into public.public_feedback (submitter_id, kind, subject, message, fingerprint)
          values ('${PUB2}', 'feedback', 'Open ${i}', 'Open message number ${i} awaiting an answer', 'fp${i}')`);
      }
      await as(run, PUB2);
      expect(await denied(feedback(run, "One more", "This message should be refused for the open cap."))).toContain("LIMIT");
    });
  });

  test("My feedback shows only the owner's messages and the staff answer — never the internal note or responder", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const a = await feedback(run, "Question about permits", "How can I find out which companies hold valid permits?", "inquiry");
      await back(run);
      await as(run, PUB2);
      await feedback(run, "Someone else", "This message belongs to another person entirely.");
      await back(run);
      await as(run, f.national);
      await run(`select public.mg_respond_feedback('${a.id}', 'answered', 'Permit holders are listed on the Ministry website.', 'INTERNAL: same person asked last week')`);
      await back(run);
      await as(run, PUB);
      const rows = await run("select * from public.mg_my_feedback()");
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ status: "answered", response: "Permit holders are listed on the Ministry website." });
      expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "id", "kind", "message", "responded_at", "response", "status", "subject"]);
      expect(JSON.stringify(rows)).not.toContain("INTERNAL");
      expect((await run("select count(*)::int as n from public.public_feedback"))[0].n).toBe(0); // no direct access
      await back(run);
      await as(run, ANON, true);
      expect((await run("select * from public.mg_my_feedback()")).length).toBe(0);
    });
  });

  test("only administrators and supervisors work the queue; everyone else is refused", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const a = await feedback(run, "A suggestion", "Please add a map of all licensed mining areas.");
      await back(run);
      for (const uid of [f.admin, f.national]) {
        await as(run, uid);
        const q1 = await run("select * from public.mg_feedback_queue()");
        expect(q1.some((x) => x.id === a.id)).toBe(true);
        await back(run);
      }
      for (const [uid, anon] of [[f.county, false], [f.opA, false], [PUB, false], [PUB2, false], [ANON, true]] as const) {
        await as(run, uid, anon);
        expect(await denied(run("select * from public.mg_feedback_queue()"))).toContain("FORBIDDEN");
        expect(await denied(run(`select public.mg_respond_feedback('${a.id}', 'closed')`))).toContain("FORBIDDEN");
        await back(run);
      }
    });
  });

  test("responding: an 'answered' status needs a real answer; the response and the audit trail are recorded", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const a = await feedback(run, "Reporting delays", "Reports in Bomi take a long time to get a first status.");
      await back(run);
      await as(run, f.admin);
      expect(await denied(run(`select public.mg_respond_feedback('${a.id}', 'answered', '')`))).toMatch(/answer/);
      expect(await denied(run(`select public.mg_respond_feedback('${a.id}', 'new', 'x')`))).toMatch(/status/);
      expect(await denied(run(`select public.mg_respond_feedback('${PUB}', 'closed')`))).toContain("NOT_FOUND");
      await run(`select public.mg_respond_feedback('${a.id}', 'in_review', null, 'checking Bomi backlog')`);
      await run(`select public.mg_respond_feedback('${a.id}', 'answered', 'We added staff in Bomi this month.')`);
      const row = (await run(`select status, response, responded_by, internal_note from public.public_feedback where id = '${a.id}'`))[0];
      expect(row).toEqual({ status: "answered", response: "We added staff in Bomi this month.", responded_by: f.admin, internal_note: "checking Bomi backlog" });
      expect((await run(`select count(*)::int as n from public.audit_log where entity_id = '${a.id}'`))[0].n).toBeGreaterThanOrEqual(3);
    });
  });
});

describe("0049: account deletion anonymizes ownership", () => {
  test("reports and messages stay, lose the account link, and the account no longer 'owns records'", async () => {
    await withRole("postgres", null, async (run) => {
      await world(run);
      await as(run, PUB);
      const r = await mine(run, LONG + " (will outlive the account)");
      await feedback(run, "A parting note", "Thank you for the work on mining safety in Bomi county.");
      const out = (await run("select public.mg_prepare_account_deletion() as d"))[0].d as { hasRecords: boolean };
      expect(out.hasRecords).toBe(false);
      await back(run);
      expect((await run(`select submitter_id, description from public.community_reports where id = '${r.id}'`))[0]).toEqual({
        submitter_id: null,
        description: LONG + " (will outlive the account)",
      });
      expect((await run(`select count(*)::int as n from public.public_feedback where submitter_id is null`))[0].n).toBe(1);
      expect((await run(`select name, deleted_at is not null as del from public.profiles where id = '${PUB}'`))[0]).toEqual({ name: "Deleted user", del: true });
      // the public tracking code keeps working
      await run("set local role anon");
      expect((await run(`select public.track_community_report('${r.trackingCode}') as t`))[0].t).toMatchObject({ status: "submitted" });
    });
  });
});

describe("0049: source contracts", () => {
  test("the anonymous submit and track functions are NOT redefined by 0049", () => {
    const m = read("supabase/migrations/0049_public_reports_feedback.sql").replace(/--[^\n]*/g, "");
    expect(m).not.toMatch(/create or replace function public\.submit_community_report\(/);
    expect(m).not.toMatch(/create or replace function public\.track_community_report\(/);
  });
  test("the migration grants no table writes and no anon access", () => {
    const m = read("supabase/migrations/0049_public_reports_feedback.sql").replace(/--[^\n]*/g, "");
    expect(m).not.toMatch(/\bgrant\s+(insert|update|delete|all)\b/i);
    expect(m).not.toMatch(/\bto anon\b/i);
  });
  test("the client never sends an owner id; linking is an explicit choice", () => {
    const b = read("src/lib/backend.ts");
    const i = b.indexOf('rpc("submit_my_community_report"');
    expect(i).toBeGreaterThan(0);
    expect(b.slice(i, i + 500)).not.toMatch(/submitter|p_user|p_owner/);
    expect(read("src/pages/CommunitySubmit.tsx")).toContain("linkToAccount");
  });
});
