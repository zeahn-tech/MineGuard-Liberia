// ---------------------------------------------------------------------------
// Migration 0050 — Worker Voice → Ministry (confidential reporting to government). Real Postgres (PGlite).
// Asserts the SEPARATION of the two channels (a company can never see a report made about it; the Ministry
// still has no access to the company channel) and the same anonymity properties as 0046.
// ---------------------------------------------------------------------------
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const XA2 = "aaaaaaaa-0000-4000-8000-0000000000a2"; // second AgriLib administrator
const SM = "aaaaaaaa-0000-4000-8000-0000000000b1"; // site manager (siteA)
const SO = "aaaaaaaa-0000-4000-8000-0000000000b2"; // safety officer (siteA)
const SO2 = "aaaaaaaa-0000-4000-8000-0000000000b3"; // safety officer, no site
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // worker (siteA)
const WK2 = "aaaaaaaa-0000-4000-8000-0000000000c2"; // worker (siteA)
const OTH = "aaaaaaaa-0000-4000-8000-0000000000d1"; // other company's administrator

beforeAll(async () => { f = await getFixture(); });
beforeEach(async () => {
  const db = await getDb();
  for (const m of ["0040_emergency_alerts", "0041_emergency_authority_corrections", "0043_jsa_with_human_review", "0044_role_assignment_and_emergency_contacts", "0047_worker_voice", "0051_ministry_voice", "0053_voice_hardening"]) {
    await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", `${m}.sql`), "utf8"));
  }
});

const as = (run: Runner, uid: string) => run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
const src = (run: Runner, ip: string) => run(`select set_config('request.headers', '{"x-forwarded-for":"${ip}"}', true)`);
async function fails(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return String((e as Error).message); }
  return "";
}
/** run a statement as the table owner, then restore the caller's role + claims */
async function owner(run: Runner, sql: string, params: unknown[] = []) {
  const claims = String((await run("select coalesce(current_setting('request.jwt.claims', true), '') as c"))[0].c);
  const role = String((await run("select current_user as r"))[0].r);
  await run("reset role");
  await run("select set_config('request.jwt.claims', '', true)");
  const rows = await run(sql, params);
  await run("select set_config('request.jwt.claims', $1, true)", [claims]);
  if (role !== "postgres") await run(`set local role ${role}`);
  return rows;
}
/** a client with NO session: the anon role, no claims */
async function asAnon(run: Runner) {
  await run("select set_config('request.jwt.claims', '', true)");
  await run("set local role anon");
}
const asAuthed = async (run: Runner, uid: string) => { await run("reset role"); await run("set local role authenticated"); await as(run, uid); };

let n = 0;
const newCode = () => { n++; return (`ABCDEF0123456789${n.toString(16).padStart(8, "0")}`.slice(0, 16) + (n.toString(16).padStart(8, "0"))).toUpperCase().slice(0, 24); };
const BASE = { category: "unsafe_condition", urgency: "medium", description: "The haul road edge berm near Pit 3 has collapsed and trucks pass within a metre.", previously: "no" };

async function world<T>(fn: (run: Runner, c: { orgA: string; orgB: string; siteA: string; siteB: string; member: (u: string) => Promise<string> }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email, raw_user_meta_data) values
      ('${XA}','xa@agrilib.test','{"name":"Xavier Admin"}'), ('${XA2}','xa2@agrilib.test','{"name":"Xena Admin"}'),
      ('${SM}','sm@agrilib.test','{"name":"Sia Manager"}'), ('${SO}','so@agrilib.test','{"name":"Sam Safety"}'),
      ('${SO2}','so2@agrilib.test','{"name":"Sana Safety"}'), ('${WK}','wk@agrilib.test','{"name":"Wale Worker"}'),
      ('${WK2}','wk2@agrilib.test','{"name":"Wanda Worker"}'), ('${OTH}','oth@ore.test','{"name":"Olu Other"}')`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    await run(`update public.sites set organization_id = '${orgA}' where id = '${f.siteA}'`);
    await run(`update public.sites set organization_id = '${orgB}' where id = '${f.siteB}'`);
    await run("set local role authenticated");
    const accept = async (uid: string, org: string, email: string, role: string | null, by = XA) => {
      await as(run, role ? by : f.admin);
      const id = role
        ? (await run(`select public.mg_create_org_invitation('${org}', '${email}', '${role}') as id`))[0].id
        : (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${id}')`);
    };
    await accept(XA, orgA, "xa@agrilib.test", null);
    await accept(XA2, orgA, "xa2@agrilib.test", null);
    await accept(SM, orgA, "sm@agrilib.test", "site_manager");
    await accept(SO, orgA, "so@agrilib.test", "safety_officer");
    await accept(SO2, orgA, "so2@agrilib.test", "safety_officer");
    await accept(WK, orgA, "wk@agrilib.test", "worker");
    await accept(WK2, orgA, "wk2@agrilib.test", "worker");
    await accept(OTH, orgB, "oth@ore.test", null);
    await as(run, XA);
    const member = async (u: string) => (await owner(run, `select id from public.organization_members where user_id = '${u}'`))[0].id as string;
    for (const u of [SM, SO, WK, WK2]) await run(`select public.mg_assign_member_site('${await member(u)}', '${f.siteA}')`);
    await as(run, f.admin);
    return fn(run, { orgA, orgB, siteA: f.siteA, siteB: f.siteB, member });
  });
}


const MBASE = { category: "wages_or_benefits", urgency: "medium", description: "Workers at the crusher have not been paid for six weeks and are told to keep working.", previously: "no" };
const mSubmit = (run: Runner, mode: string, site: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...MBASE, ...over } as typeof MBASE & Record<string, unknown>;
  return run("select public.mg_mv_submit($1,$2,$3,$4,$5,$6,$7,$8) as r", [mode, site, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, code]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
const mAnon = (run: Runner, siteCode: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...MBASE, ...over } as typeof MBASE & Record<string, unknown>;
  return run("select public.mg_mv_submit_anonymous($1,$2,$3,$4,$5,$6,$7) as r", [siteCode, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, code]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
// F1 (0052): the Ministry has its OWN intake code; the company's code is a different thing.
const siteCodeFor = async (run: Runner, uid: string, site: string) => { await asAuthed(run, uid); return (await run("select public.mg_mv_site_code($1) as c", [site]))[0].c as string; };
const companyCodeFor = async (run: Runner, uid: string, site: string) => { await asAuthed(run, uid); return (await run("select public.mg_wv_site_code($1) as c", [site]))[0].c as string; };
const mIds = async (run: Runner) => (await owner(run, "select id, mode from public.ministry_voice_reports order by created_at, id"));
const mCount = async (run: Runner, who: string) => { await asAuthed(run, who); return (await run("select count(*)::int as n from public.ministry_voice_reports"))[0].n as number; };
const MINISTRY_REVIEWERS = () => [f.admin, f.national];

describe("sending to the Ministry", () => {
  test("members can send named and confidential; other companies' people, non-members and signed-out users cannot", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      expect((await mSubmit(run, "named", c.siteA)).status).toBe("received");
      expect((await mSubmit(run, "confidential", c.siteA)).status).toBe("received");
      await asAuthed(run, OTH);
      expect(await fails(mSubmit(run, "named", c.siteA))).toContain("FORBIDDEN");
      await asAnon(run);
      expect(await fails(mSubmit(run, "named", c.siteA))).toBeTruthy();
      await asAuthed(run, WK);
      expect(await fails(mSubmit(run, "anonymous", c.siteA))).toContain("INVALID");
    });
  });

  test("anonymous works with no session, routed by the site code, and says which company and site it is about", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      expect((await mAnon(run, code)).status).toBe("received");
      expect((await mAnon(run, "0000000000")).status).toBe("invalid_site_code");
      await asAuthed(run, f.admin);
      const r = (await run("select organization_name, site_name, mode from public.mg_mv_list()"))[0];
      expect(r).toMatchObject({ organization_name: "AgriLib Mining", mode: "anonymous" });
    });
  });

  test("every Ministry category is accepted and an unknown one is refused with nothing stored", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      for (const cat of ["wages_or_benefits", "working_hours", "harassment_or_discrimination", "retaliation", "child_or_forced_labour", "contract_or_dismissal", "unsafe_practice", "missing_ppe_or_training", "hazard_ignored", "falsified_records", "bad_work_habit", "other"]) {
        expect((await mAnon(run, code, newCode(), { category: cat, description: `${cat}: a described concern about the company` })).status).toBe("received");
      }
      for (const bad of [{ category: "unsafe_condition" }, { category: "bogus" }, { urgency: "extreme" }, { previously: "maybe" }, { description: "short" }, { description: "x".repeat(4001) }, { occurred: "2999-01-01T00:00:00Z" }]) {
        expect((await mAnon(run, code, newCode(), bad)).status).toBe("invalid");
      }
      expect((await owner(run, "select count(*)::int as n from public.ministry_voice_reports"))[0].n).toBe(12);
    });
  });

  test("replays are a duplicate; a near-identical report is accepted and flagged; guessing and flooding are rate-limited per source", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await src(run, "198.51.100.61");
      const k = newCode();
      expect((await mAnon(run, code, k)).status).toBe("received");
      expect((await mAnon(run, code, k)).status).toBe("duplicate");
      const second = await mAnon(run, code, newCode(), { description: "  " + MBASE.description.toUpperCase() + "  " });
      expect(second.possibleDuplicate).toBe(true);
      await src(run, "198.51.100.62");
      for (let i = 0; i < 10; i++) expect((await mAnon(run, "0000000000")).status).toBe("invalid_site_code");
      expect((await mAnon(run, "0000000000")).status).toBe("rate_limited");
      await src(run, "198.51.100.63");
      for (let i = 0; i < 10; i++) expect((await mAnon(run, code, newCode(), { urgency: "critical" })).status).toBe("received");
      expect((await mAnon(run, code, newCode(), { urgency: "critical" })).status).toBe("rate_limited");
    });
  });
});

describe("the two channels stay separate", () => {
  test("a company can NEVER see a report made about it: administrators, managers, officers and workers read nothing and are refused every Ministry function", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run); await mAnon(run, code);
      await asAuthed(run, WK); await mSubmit(run, "named", c.siteA);
      const id = (await mIds(run))[0].id as string;
      for (const who of [XA, XA2, SM, SO, SO2, WK, WK2, OTH, f.county]) {
        expect(await mCount(run, who)).toBe(0);
        for (const sql of ["select * from public.mg_mv_list()", "select public.mg_mv_summary()", "select * from public.mg_mv_reviewers()"]) {
          expect(await fails(run(sql))).toContain("FORBIDDEN");
        }
        for (const sql of ["select public.mg_mv_triage($1,'high',null)", "select public.mg_mv_set_status($1,'investigating',null)", "select public.mg_mv_post_update($1,'we are looking into it')", "select public.mg_mv_identity($1,'I need to know who this is')"]) {
          expect(await fails(run(sql, [id]))).toMatch(/FORBIDDEN/);
        }
        expect(await fails(run("select * from public.ministry_voice_events"))).toBe(""); // readable by policy, but empty
        expect((await run("select count(*)::int as n from public.ministry_voice_events"))[0].n).toBe(0);
        expect(await fails(run("select * from public.ministry_voice_identity"))).toContain("permission denied");
      }
    });
  });

  test("the company channel is unchanged: company administrators review it, and the Ministry still has NO access to it", async () => {
    await world(async (run, c) => {
      const code = await companyCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await run("select public.mg_wv_submit_anonymous($1,'unsafe_condition','medium',$2,null,'no',false,$3)", [code, BASE.description, newCode()]);
      const cnt = async (who: string) => { await asAuthed(run, who); return (await run("select count(*)::int as n from public.worker_voice_reports"))[0].n as number; };
      for (const who of [XA, XA2, SM, SO]) expect(await cnt(who)).toBe(1);
      for (const who of [...MINISTRY_REVIEWERS(), f.county]) expect(await cnt(who)).toBe(0);
      const wid = (await owner(run, "select id from public.worker_voice_reports"))[0].id as string;
      for (const who of MINISTRY_REVIEWERS()) {
        await asAuthed(run, who);
        for (const sql of ["select public.mg_wv_triage($1,'high',null)", "select public.mg_wv_post_update($1,'x update for reporter')", "select public.mg_wv_identity($1,'trying to find who sent this')"]) {
          expect(await fails(run(sql, [wid]))).toContain("FORBIDDEN");
        }
        expect(await fails(run("select public.mg_wv_site_code($1)", [c.siteA]))).toContain("FORBIDDEN");
      }
    });
  });

  test("each channel has its OWN code: the company's never works for the Ministry, and the Ministry's never works for the company", async () => {
    await world(async (run, c) => {
      const company = await companyCodeFor(run, WK, c.siteA);
      const ministry = await siteCodeFor(run, WK, c.siteA);
      expect(ministry).not.toBe(company);
      await asAnon(run);
      expect((await mAnon(run, company)).status).toBe("invalid_site_code");
      const w0 = (await run("select public.mg_wv_submit_anonymous($1,'unsafe_condition','medium',$2,null,'no',false,$3) as r", [ministry, BASE.description, newCode()]))[0].r as Record<string, unknown>;
      expect(w0.status).toBe("invalid_site_code");
      const m = await mAnon(run, ministry);
      const w = (await run("select public.mg_wv_submit_anonymous($1,'unsafe_condition','medium',$2,null,'no',false,$3) as r", [company, BASE.description, newCode()]))[0].r as Record<string, unknown>;
      expect([m.status, w.status]).toEqual(["received", "received"]);
      expect((await run("select public.mg_mv_status($1) as r", [m.code]))[0].r).toMatchObject({ found: true, stage: "Received" });
      expect((await run("select public.mg_wv_status($1) as r", [m.code]))[0].r).toEqual({ found: false });
    });
  });

  test("notifications: Ministry reviewers are told generically; no company person is", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run); await mAnon(run, code, newCode(), { urgency: "critical" });
      const rows = await owner(run, "select user_id, kind, severity, title, body, link_to from public.notifications where link_to = '/portal/voice-ministry'");
      const users = rows.map((r) => r.user_id as string).sort();
      expect(users).toEqual([f.admin, f.national].sort());
      for (const u of [XA, XA2, SM, SO, WK, WK2, OTH]) expect(users).not.toContain(u);
      for (const r of rows) {
        expect(r.kind).toBe("worker_voice"); expect(r.severity).toBe("urgent");
        const text = JSON.stringify(r).toLowerCase();
        for (const leak of ["agrilib", "bomi", "wages", "anonymous", "confidential", "named", "crusher"]) expect(text).not.toContain(leak);
      }
    });
  });
});

describe("who reviews, and who may open a confidential identity", () => {
  test("Ministry administrators and national supervisors review; an inspector does not", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK); await mSubmit(run, "confidential", c.siteA);
      for (const who of MINISTRY_REVIEWERS()) expect(await mCount(run, who)).toBe(1);
      expect(await mCount(run, f.county)).toBe(0);
      await asAuthed(run, f.county);
      expect(await fails(run("select * from public.mg_mv_list()"))).toContain("FORBIDDEN");
    });
  });

  test("confidential: a supervisor is refused; the administrator needs a purpose; it is recorded and the reporter sees a count", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK); await mSubmit(run, "confidential", c.siteA);
      const id = (await mIds(run))[0].id as string;
      await asAuthed(run, f.national);
      expect(await fails(run("select public.mg_mv_identity($1,'I need to know who this is')", [id]))).toContain("FORBIDDEN");
      await asAuthed(run, f.admin);
      expect(await fails(run("select public.mg_mv_identity($1)", [id]))).toContain("PURPOSE_REQUIRED");
      expect((await run("select public.mg_mv_identity($1,'Welfare check on a reported pay dispute') as r", [id]))[0].r).toEqual({ available: true, name: "Wale Worker", jobTitle: null });
      expect((await owner(run, "select actor_id, detail from public.ministry_voice_events where report_id = $1 and event = 'identity_revealed'", [id]))[0]).toEqual({ actor_id: f.admin, detail: "Welfare check on a reported pay dispute" });
      await asAuthed(run, WK);
      expect((await run("select identity_opened, stage from public.mg_mv_my_reports()"))[0]).toMatchObject({ identity_opened: 1, stage: "Received" });
    });
  });

  test("named: Ministry reviewers can see the reporter; anonymous has nothing to reveal", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK); await mSubmit(run, "named", c.siteA);
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run); await mAnon(run, code);
      const rows = await mIds(run);
      const named = rows.find((r) => r.mode === "named")!.id as string;
      const anon = rows.find((r) => r.mode === "anonymous")!.id as string;
      await asAuthed(run, f.national);
      expect((await run("select (public.mg_mv_identity($1)) ->> 'name' as n", [named]))[0].n).toBe("Wale Worker");
      await asAuthed(run, f.admin);
      expect(await fails(run("select public.mg_mv_identity($1,'looking for the reporter please')", [anon]))).toContain("NOT_AVAILABLE");
    });
  });

  test("triage, assignment, status, closure rules and the reporter-facing update", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run); const sent = await mAnon(run, code);
      const id = (await mIds(run))[0].id as string;
      await asAuthed(run, f.admin);
      await run("select public.mg_mv_triage($1,'high',$2)", [id, f.national]);
      expect(await fails(run("select public.mg_mv_triage($1,'high',$2)", [id, XA]))).toContain("not an authorized reviewer");
      await run("select public.mg_mv_post_update($1,'The Ministry has received this and is reviewing it.')", [id]);
      await run("select public.mg_mv_set_status($1,'investigating',null)", [id]);
      const listed = (await run("select status, triage_severity, assigned_name from public.mg_mv_list()"))[0];
      expect(listed).toMatchObject({ status: "investigating", triage_severity: "high", assigned_name: "Erin Supervisor" });
      expect(await fails(run("select public.mg_mv_set_status($1,'triage',null)", [id]))).toContain("backwards");
      expect(await fails(run("select public.mg_mv_set_status($1,'closed','short')", [id]))).toContain("CLOSURE_REASON_REQUIRED");
      // the reporter sees a stage and the update, and nothing else
      await asAnon(run);
      const st = (await run("select public.mg_mv_status($1) as r", [sent.code]))[0].r as Record<string, unknown>;
      expect(Object.keys(st).sort()).toEqual(["canReply", "closed", "found", "lastChange", "messages", "stage", "update", "updateOn"]);
      expect(st).toMatchObject({ found: true, stage: "Under review by the Ministry", update: "The Ministry has received this and is reviewing it." });
      await asAuthed(run, f.admin);
      await run("select public.mg_mv_set_status($1,'closed','Referred to the labour inspectorate; the company has been directed to pay.')", [id]);
      expect(await fails(run("select public.mg_mv_post_update($1,'a later update')", [id]))).toContain("IMMUTABLE");
    });
  });

  test("the summary counts reports by group, category and company, with no text and no identity", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await mAnon(run, code, newCode(), { category: "wages_or_benefits", description: "Wages have not been paid for six weeks at the crusher." });
      await mAnon(run, code, newCode(), { category: "unsafe_practice", urgency: "critical", description: "Blasting is done with workers still inside the exclusion zone." });
      await mAnon(run, code, newCode(), { category: "bad_work_habit", description: "Supervisors skip the pre-shift check and sign it anyway." });
      await asAuthed(run, f.national);
      const s = (await run("select public.mg_mv_summary() as s"))[0].s as { total: number; by_company: unknown[] };
      expect(s).toMatchObject({ total: 3, open: 3, critical_open: 1, by_group: { labour: 1, safety: 1, conduct: 1 } });
      expect(s.by_company).toEqual([expect.objectContaining({ name: "AgriLib Mining", total: 3, open: 3, serious_open: 1 })]);
      expect(JSON.stringify(s)).not.toMatch(/Wale|crusher|Blasting/);
    });
  });
});

describe("anonymity is a data property, as in the company channel", () => {
  test("no identity column, no identity row for anonymous, no audit entry, no actor on 'submitted', time rounded to the hour", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run); await mAnon(run, code);
      await asAuthed(run, WK); await mSubmit(run, "confidential", c.siteA);
      const cols = (await owner(run, "select column_name from information_schema.columns where table_name = 'ministry_voice_reports'")).map((r) => String(r.column_name));
      for (const bad of ["user_id", "reporter_id", "created_by", "updated_by", "email", "employee_number", "member_id", "profile_id", "ip", "user_agent", "device"]) expect(cols).not.toContain(bad);
      for (const t of ["file", "attachment", "url", "image"]) expect(cols.filter((x) => x.includes(t))).toEqual([]);
      const anon = (await mIds(run)).find((r) => r.mode === "anonymous")!.id as string;
      expect((await owner(run, "select count(*)::int as n from public.ministry_voice_identity where report_id = $1", [anon]))[0].n).toBe(0);
      expect((await owner(run, "select count(*)::int as n from public.audit_log where entity_type like 'ministry_voice%'"))[0].n).toBe(0);
      expect((await owner(run, "select count(*)::int as n from public.ministry_voice_events where event = 'submitted' and actor_id is not null"))[0].n).toBe(0);
      const t = await owner(run, "select extract(minute from created_at)::int as m, extract(second from created_at)::int as s from public.ministry_voice_reports");
      for (const r of t) { expect(r.m).toBe(0); expect(r.s).toBe(0); }
    });
  });

  test("the anonymous function never depends on auth.uid(); a session that rides along is ignored", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAuthed(run, WK);
      expect((await mAnon(run, code)).status).toBe("received");
      const id = (await mIds(run))[0].id as string;
      expect((await owner(run, "select count(*)::int as n from public.ministry_voice_identity where report_id = $1", [id]))[0].n).toBe(0);
      const sql = readFileSync(join(import.meta.dir, "..", "supabase", "migrations", "0051_ministry_voice.sql"), "utf8");
      const body = sql.slice(sql.indexOf("function public.mg_mv_submit_anonymous"), sql.indexOf("-- public status"));
      expect(body).not.toContain("auth.uid()");
    });
  });

  test("the anonymous role reaches nothing but the two public functions; the rate-limit key is a digest, never an address", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await src(run, "203.0.113.77");
      await mAnon(run, code);
      for (const t of ["ministry_voice_reports", "ministry_voice_identity", "ministry_voice_events"]) expect(await fails(run(`select * from public.${t}`))).toContain("permission denied");
      for (const sql of ["select * from public.mg_mv_list()", "select public.mg_mv_summary()"]) expect(await fails(run(sql))).toContain("permission denied");
      expect(await fails(run("select public.mg_mv_insert('anonymous',$1,'other','low','a long enough description',null,'no','0123456789ABCDEF01234567',null,null)", [c.siteA]))).toContain("permission denied");
      const rows = await owner(run, "select bucket from public.rate_limits where bucket like 'mv:%'");
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toMatch(/(\d{1,3}\.){3}\d{1,3}/);
    });
  });

  test("deleting the reporter's account erases the link; the report stays, de-identified", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK); await mSubmit(run, "confidential", c.siteA);
      const id = (await mIds(run))[0].id as string;
      await owner(run, "update public.profiles set name = 'Deleted user', deleted_at = now() where id = $1", [WK]);
      expect((await owner(run, "select count(*)::int as n from public.ministry_voice_identity where report_id = $1", [id]))[0].n).toBe(0);
      expect((await owner(run, "select count(*)::int as n from public.ministry_voice_reports where id = $1", [id]))[0].n).toBe(1);
      await asAuthed(run, f.admin);
      expect((await run("select public.mg_mv_identity($1,'trying to find who sent this') as r", [id]))[0].r).toEqual({ available: false });
    });
  });

  test("reports are never deleted and their content is never edited", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK); await mSubmit(run, "named", c.siteA);
      expect(await fails(owner(run, "delete from public.ministry_voice_reports"))).toContain("IMMUTABLE");
      expect(await fails(owner(run, "update public.ministry_voice_reports set description = 'something else entirely'"))).toContain("IMMUTABLE");
    });
  });
});
