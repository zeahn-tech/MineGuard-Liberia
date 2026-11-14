// ---------------------------------------------------------------------------
// Migration 0046 — Worker Voice (Phase 4). Real Postgres (PGlite), backend enforcement.
// Anonymity is asserted at the DATA level: no identity column, no audit link, no identity row,
// no auth.uid() dependence, no raw address stored, generic notifications, guess-resistant codes.
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

const submitMember = (run: Runner, mode: string, site: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...BASE, ...over } as typeof BASE & Record<string, unknown>;
  return run("select public.mg_wv_submit($1,$2,$3,$4,$5,$6,$7,$8,$9) as r", [mode, site, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, p.concerns ?? false, code]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
const submitAnon = (run: Runner, siteCode: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...BASE, ...over } as typeof BASE & Record<string, unknown>;
  return run("select public.mg_wv_submit_anonymous($1,$2,$3,$4,$5,$6,$7,$8) as r", [siteCode, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, p.concerns ?? false, code]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
const siteCodeFor = async (run: Runner, uid: string, site: string) => { await asAuthed(run, uid); return (await run("select public.mg_wv_site_code($1) as c", [site]))[0].c as string; };
const reportIds = async (run: Runner) => (await owner(run, "select id, mode from public.worker_voice_reports order by created_at, id"));

describe("anonymous submission", () => {
  test("works with no session at all, and the site code is the only routing input", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      expect(code).toMatch(/^[0-9A-F]{10}$/);
      await asAnon(run);
      const r = await submitAnon(run, code);
      expect(r.status).toBe("received");
      await asAuthed(run, XA);
      expect((await run("select mode, site_id from public.worker_voice_reports"))[0]).toEqual({ mode: "anonymous", site_id: c.siteA });
    });
  });

  test("NO identity linkage: the report has no identity column, no identity row, no audit entry, no actor in its history", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await submitAnon(run, code);
      const cols = (await owner(run, "select column_name from information_schema.columns where table_name = 'worker_voice_reports'")).map((r) => String(r.column_name));
      for (const bad of ["user_id", "reporter_id", "created_by", "updated_by", "email", "employee_number", "member_id", "profile_id", "ip", "user_agent", "device"]) expect(cols).not.toContain(bad);
      const id = (await reportIds(run))[0].id as string;
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_identity where report_id = $1", [id]))[0].n).toBe(0);
      expect((await owner(run, "select count(*)::int as n from public.audit_log where entity_type like 'worker_voice%'"))[0].n).toBe(0);
      const ev = await owner(run, "select event, actor_id from public.worker_voice_events where report_id = $1", [id]);
      expect(ev).toEqual([{ event: "submitted", actor_id: null }]);
    });
  });

  test("a session token that rides along is IGNORED: the function never depends on auth.uid()", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAuthed(run, WK); // WK's own session is present on the call
      expect((await submitAnon(run, code)).status).toBe("received");
      const id = (await reportIds(run))[0].id as string;
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_identity where report_id = $1", [id]))[0].n).toBe(0);
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_events where report_id = $1 and actor_id is not null", [id]))[0].n).toBe(0);
      const src = readFileSync(join(import.meta.dir, "..", "supabase", "migrations", "0047_worker_voice.sql"), "utf8");
      const body = src.slice(src.indexOf("function public.mg_wv_submit_anonymous"), src.indexOf("-- public status"));
      expect(body).not.toContain("auth.uid()");
    });
  });

  test("received time is rounded to the hour; nothing precise to correlate with a session", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await submitAnon(run, code);
      await asAuthed(run, WK);
      await submitMember(run, "confidential", c.siteA);
      await asAuthed(run, XA);
      const rows = await run("select mode, extract(minute from created_at)::int as m, extract(second from created_at)::int as s from public.worker_voice_reports");
      for (const r of rows) { expect(r.m).toBe(0); expect(r.s).toBe(0); }
    });
  });

  test("a wrong or missing site code is refused without revealing which sites exist; guessing is rate-limited per source", async () => {
    await world(async (run) => {
      await asAnon(run);
      await src(run, "198.51.100.7");
      for (let i = 0; i < 10; i++) expect((await submitAnon(run, "0000000000")).status).toBe("invalid_site_code");
      expect((await submitAnon(run, "0000000000")).status).toBe("rate_limited");
      await src(run, "198.51.100.8"); // another source is not affected
      expect((await submitAnon(run, "0000000000")).status).toBe("invalid_site_code");
    });
  });

  test("the rate limit stores a salted digest, never an address, and nothing links a bucket to a report", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await src(run, "203.0.113.55");
      await submitAnon(run, code);
      const rows = await owner(run, "select bucket from public.rate_limits where bucket like 'wv:%'");
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain("203.0.113.55");
      expect(JSON.stringify(rows)).not.toMatch(/(\d{1,3}\.){3}\d{1,3}/);
    });
  });

  test("per-source hourly cap, then per-site cap; serious reports are never rejected for being anonymous", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await src(run, "198.51.100.20");
      for (let i = 0; i < 10; i++) expect((await submitAnon(run, code, newCode(), { urgency: "critical" })).status).toBe("received");
      expect((await submitAnon(run, code, newCode(), { urgency: "critical" })).status).toBe("rate_limited");
      for (let i = 0; i < 50; i++) { await src(run, `198.51.100.${30 + (i % 200)}.${i}`.replace(/\.\d+$/, "")); }
      await asAuthed(run, XA);
      expect((await run("select count(*)::int as n from public.worker_voice_reports where urgency = 'critical' and mode = 'anonymous'"))[0].n).toBe(10);
    });
  });

  test("malformed and oversized submissions are refused with a reason; nothing is stored", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const bad: Record<string, unknown>[] = [
        { category: "bogus" }, { urgency: "extreme" }, { previously: "maybe" }, { description: "short" },
        { description: "x".repeat(4001) }, { occurred: "2999-01-01T00:00:00Z" },
      ];
      for (const b of bad) expect((await submitAnon(run, code, newCode(), b)).status).toBe("invalid");
      for (const weak of ["", "SHORT", "G".repeat(24), "AAAAAAAAAAAAAAAAAAAAAAAA", "abcdefabcdefabcdefabcdef"]) {
        expect((await submitAnon(run, code, weak)).status).toBe("invalid");
      }
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(0);
    });
  });

  test("replaying the same submission is a duplicate, not a second report", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const k = newCode();
      expect((await submitAnon(run, code, k)).status).toBe("received");
      expect((await submitAnon(run, code, k)).status).toBe("duplicate");
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(1);
    });
  });

  test("a near-identical report from another person is accepted and flagged for reviewers, not rejected", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      expect((await submitAnon(run, code)).status).toBe("received");
      const second = await submitAnon(run, code, newCode(), { description: "  " + BASE.description.toUpperCase() + "  " });
      expect(second.status).toBe("received");
      expect(second.possibleDuplicate).toBe(true);
    });
  });

  test("the anonymous role can reach nothing but the two public functions", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await submitAnon(run, code);
      for (const t of ["worker_voice_reports", "worker_voice_identity", "worker_voice_events", "worker_voice_site_codes"]) {
        expect(await fails(run(`select * from public.${t}`))).toContain("permission denied");
      }
      expect(await fails(run("select public.mg_wv_site_code($1)", [c.siteA]))).toContain("permission denied");
      expect(await fails(run("select public.mg_wv_insert('anonymous',$1,'other','low','a long enough description',null,'no',false,'0123456789ABCDEF01234567',null,null)", [c.siteA]))).toContain("permission denied");
    });
  });
});

describe("named and confidential reports", () => {
  test("members can send; non-members, other companies and signed-out users cannot", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      expect((await submitMember(run, "named", c.siteA)).status).toBe("received");
      expect((await submitMember(run, "confidential", c.siteA)).status).toBe("received");
      await asAuthed(run, OTH);
      expect(await fails(submitMember(run, "named", c.siteA))).toContain("FORBIDDEN");
      await asAuthed(run, SO2); // a company-level member (no site assignment) is a member of the company too
      expect((await submitMember(run, "named", c.siteA)).status).toBe("received");
      await asAnon(run);
      expect(await fails(submitMember(run, "named", c.siteA))).toBeTruthy();
      await asAuthed(run, WK);
      expect(await fails(submitMember(run, "anonymous", c.siteA))).toContain("INVALID");
    });
  });

  test("identity is held in a separate closed table, and neither ordinary users nor reviewers can read it directly", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "confidential", c.siteA);
      for (const who of [WK, WK2, SM, SO, XA, f.admin]) {
        await asAuthed(run, who);
        expect(await fails(run("select * from public.worker_voice_identity"))).toContain("permission denied");
      }
    });
  });

  test("ordinary site users and managers do NOT gain a confidential identity; only a company administrator, with a purpose, and it is recorded", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "confidential", c.siteA);
      const id = (await reportIds(run))[0].id as string;
      for (const who of [SM, SO]) { // reviewers of the report, but not custodians
        await asAuthed(run, who);
        expect(await fails(run("select public.mg_wv_identity($1,'I need to know who this is')", [id]))).toContain("FORBIDDEN");
      }
      for (const who of [WK2, OTH, SO2, f.admin, f.national]) {
        await asAuthed(run, who);
        expect(await fails(run("select public.mg_wv_identity($1,'I need to know who this is')", [id]))).toContain("FORBIDDEN");
      }
      await asAuthed(run, XA);
      expect(await fails(run("select public.mg_wv_identity($1)", [id]))).toContain("PURPOSE_REQUIRED");
      const got = (await run("select public.mg_wv_identity($1,'Welfare check requested by the safety committee') as r", [id]))[0].r;
      expect(got).toEqual({ available: true, name: "Wale Worker", jobTitle: null });
      expect((await owner(run, "select actor_id, detail from public.worker_voice_events where report_id = $1 and event = 'identity_revealed'", [id]))[0]).toEqual({ actor_id: XA, detail: "Welfare check requested by the safety committee" });
      await asAuthed(run, WK); // the reporter can see how many times it was opened
      expect((await run("select identity_opened from public.mg_wv_my_reports()"))[0].identity_opened).toBe(1);
    });
  });

  test("named reports show the reporter to the report's reviewers (existing rules); anonymous reports have nothing to show", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "named", c.siteA);
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await submitAnon(run, code);
      const rows = await reportIds(run);
      const named = rows.find((r) => r.mode === "named")!.id as string;
      const anon = rows.find((r) => r.mode === "anonymous")!.id as string;
      await asAuthed(run, SM);
      expect((await run("select (public.mg_wv_identity($1)) ->> 'name' as n", [named]))[0].n).toBe("Wale Worker");
      expect(await fails(run("select public.mg_wv_identity($1,'looking for the reporter please')", [anon]))).toContain("NOT_AVAILABLE");
      await asAuthed(run, XA);
      expect(await fails(run("select public.mg_wv_identity($1,'looking for the reporter please')", [anon]))).toContain("NOT_AVAILABLE");
    });
  });

  test("the audit log never ties a person to a report", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "confidential", c.siteA);
      await submitMember(run, "named", c.siteA);
      expect((await owner(run, "select count(*)::int as n from public.audit_log where entity_type like 'worker_voice%'"))[0].n).toBe(0);
      const ev = await owner(run, "select actor_id from public.worker_voice_events where event = 'submitted'");
      expect(ev.every((e) => e.actor_id === null)).toBe(true);
    });
  });

  test("deleting the reporter's account erases the link; the report stays, de-identified", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "confidential", c.siteA);
      const id = (await reportIds(run))[0].id as string;
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_identity where report_id = $1", [id]))[0].n).toBe(1);
      await owner(run, "update public.profiles set name = 'Deleted user', deleted_at = now() where id = $1", [WK]); // what 0035's deletion does
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_identity where report_id = $1", [id]))[0].n).toBe(0);
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_reports where id = $1", [id]))[0].n).toBe(1);
      await asAuthed(run, XA);
      expect((await run("select public.mg_wv_identity($1,'trying to find who sent this') as r", [id]))[0].r).toEqual({ available: false });
    });
  });
});

describe("who can see and act on reports", () => {
  test("the review queue is limited to the company administrator and the site's assigned manager / safety officer", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run); await submitAnon(run, code);
      const count = async (who: string) => { await asAuthed(run, who); return (await run("select count(*)::int as n from public.worker_voice_reports"))[0].n as number; };
      for (const who of [XA, XA2, SM, SO]) expect(await count(who)).toBe(1);
      for (const who of [WK, WK2, SO2, OTH, f.admin, f.national, f.county]) expect(await count(who)).toBe(0);
    });
  });

  test("a report marked as concerning the usual reviewers goes to company administrators only", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "named", c.siteA, newCode(), { concerns: true });
      const count = async (who: string) => { await asAuthed(run, who); return (await run("select count(*)::int as n from public.worker_voice_reports"))[0].n as number; };
      expect(await count(XA)).toBe(1);
      expect(await count(SM)).toBe(0);
      expect(await count(SO)).toBe(0);
    });
  });

  test("cross-organization: another company's administrator sees nothing and can do nothing", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "named", c.siteA);
      const id = (await reportIds(run))[0].id as string;
      await asAuthed(run, OTH);
      expect((await run("select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(0);
      expect((await run("select count(*)::int as n from public.worker_voice_events"))[0].n).toBe(0);
      for (const call of ["select public.mg_wv_triage($1,'high')", "select public.mg_wv_set_status($1,'investigating')", "select public.mg_wv_post_update($1,'hello')", "select public.mg_wv_escalate($1,'a long enough reason')", "select public.mg_wv_identity($1)"]) {
        expect(await fails(run(call, [id]))).toContain("FORBIDDEN");
      }
      expect(await fails(run("select public.mg_wv_site_code($1)", [c.siteA]))).toContain("FORBIDDEN");
      expect(await fails(run("select public.mg_wv_rotate_code($1)", [c.siteA]))).toContain("FORBIDDEN");
    });
  });

  test("triage, assignment (to an eligible reviewer only), status, update, closure with a reason", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run); await submitAnon(run, code);
      const id = (await reportIds(run))[0].id as string;
      await asAuthed(run, SM);
      await run("select public.mg_wv_triage($1,'high',$2)", [id, SO]);
      expect((await run("select status, triage_severity, assigned_to from public.worker_voice_reports where id = $1", [id]))[0]).toEqual({ status: "triage", triage_severity: "high", assigned_to: SO });
      expect(await fails(run("select public.mg_wv_triage($1,'high',$2)", [id, WK2]))).toContain("not an authorized reviewer");
      expect(await fails(run("select public.mg_wv_triage($1,'high',$2)", [id, SO2]))).toContain("not an authorized reviewer");
      await run("select public.mg_wv_set_status($1,'investigating')", [id]);
      await run("select public.mg_wv_set_status($1,'action_assigned')", [id]);
      expect(await fails(run("select public.mg_wv_set_status($1,'triage')", [id]))).toContain("backwards");
      expect(await fails(run("select public.mg_wv_set_status($1,'closed')", [id]))).toContain("CLOSURE_REASON_REQUIRED");
      expect(await fails(run("select public.mg_wv_set_status($1,'closed','short')", [id]))).toContain("CLOSURE_REASON_REQUIRED");
      await run("select public.mg_wv_set_status($1,'closed','Berm rebuilt and signed off by the site manager')", [id]);
      expect(await fails(run("select public.mg_wv_set_status($1,'follow_up')", [id]))).toContain("IMMUTABLE");
      expect(await fails(run("select public.mg_wv_post_update($1,'late')", [id]))).toContain("IMMUTABLE");
    });
  });

  test("escalation: site reviewers can raise it to company administrators; administrators have no higher route; workers cannot", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "named", c.siteA);
      const id = (await reportIds(run))[0].id as string;
      await asAuthed(run, WK2);
      expect(await fails(run("select public.mg_wv_escalate($1,'a long enough reason')", [id]))).toContain("FORBIDDEN");
      await asAuthed(run, SM);
      expect(await fails(run("select public.mg_wv_escalate($1,'short')", [id]))).toContain("INVALID");
      await run("select public.mg_wv_escalate($1,'Concerns the haulage supervisor')", [id]);
      expect((await run("select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(0); // no longer visible to the site manager
      await asAuthed(run, XA);
      expect(await fails(run("select public.mg_wv_escalate($1,'Cannot go higher in the app')", [id]))).toContain("ALREADY_ESCALATED");
      expect((await run("select route from public.worker_voice_reports where id = $1", [id]))[0].route).toBe("company_admin");
    });
  });

  test("a reporter can never review, assign or open their own report, even as a company administrator", async () => {
    await world(async (run, c) => {
      await asAuthed(run, XA2);
      await submitMember(run, "confidential", c.siteA);
      const id = (await reportIds(run))[0].id as string;
      expect(await fails(run("select public.mg_wv_set_status($1,'triage')", [id]))).toContain("you cannot review a report you sent");
      await asAuthed(run, XA);
      expect(await fails(run("select public.mg_wv_triage($1,'low',$2)", [id, XA2]))).toContain("cannot be assigned");
      expect((await run("select count(*)::int as n from public.mg_wv_reviewers($1) where user_id = $2", [id, XA2]))[0].n).toBe(0);
    });
  });

  test("promoting to an incident: reviewer-written text only, one incident, the reviewer (not the reporter) is the incident's reporter", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "confidential", c.siteA);
      const id = (await reportIds(run))[0].id as string;
      await asAuthed(run, SM);
      expect(await fails(run("select public.mg_wv_create_incident($1,'near_miss','too short',null)", [id]))).toContain("write the incident description yourself");
      const inc = (await run("select public.mg_wv_create_incident($1,'near_miss','Haul road edge berm failure reported at Pit 3; inspection arranged.',null) as i", [id]))[0].i as string;
      const row = (await owner(run, "select reported_by_id, report_source, description from public.incidents where id = $1", [inc]))[0];
      expect(row.reported_by_id).toBe(SM);
      expect(row.description).not.toContain(BASE.description);
      expect(await fails(run("select public.mg_wv_create_incident($1,'near_miss','Second attempt at creating an incident record.',null)", [id]))).toContain("already exists");
      await asAuthed(run, WK);
      expect(await fails(run("select public.mg_wv_create_incident($1,'near_miss','A worker cannot promote a report to an incident.',null)", [id]))).toContain("FORBIDDEN");
    });
  });

  test("site codes: members read, reviewers rotate, the old code stops working, others are refused", async () => {
    await world(async (run, c) => {
      const old = await siteCodeFor(run, WK, c.siteA);
      expect(await siteCodeFor(run, WK2, c.siteA)).toBe(old);
      await asAuthed(run, WK);
      expect(await fails(run("select public.mg_wv_rotate_code($1)", [c.siteA]))).toContain("FORBIDDEN");
      await asAuthed(run, SM);
      const fresh = (await run("select public.mg_wv_rotate_code($1) as c", [c.siteA]))[0].c as string;
      expect(fresh).not.toBe(old);
      await asAnon(run);
      expect((await submitAnon(run, old)).status).toBe("invalid_site_code");
      expect((await submitAnon(run, fresh)).status).toBe("received");
      await asAuthed(run, SO2);
      expect(await fails(run("select public.mg_wv_rotate_code($1)", [c.siteA]))).toContain("FORBIDDEN");
    });
  });
});

describe("follow-up by reference code", () => {
  test("the reporter sees a coarse stage and reviewer-written updates only", async () => {
    await world(async (run, c) => {
      const site = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const r = await submitAnon(run, site, newCode(), { category: "equipment_hazard", urgency: "critical" });
      let s = (await run("select public.mg_wv_status($1) as r", [r.code]))[0].r;
      expect(s.found).toBe(true); expect(s.stage).toBe("Received"); expect(s.update).toBeNull();
      const id = (await reportIds(run))[0].id as string;
      await asAuthed(run, SM);
      await run("select public.mg_wv_triage($1,'critical',$2)", [id, SO]);
      await run("select public.mg_wv_set_status($1,'investigating')", [id]);
      await run("select public.mg_wv_post_update($1,'We have inspected the area and barricaded it.')", [id]);
      await asAnon(run);
      s = (await run("select public.mg_wv_status($1) as r", [r.code]))[0].r;
      expect(s.stage).toBe("Under investigation");
      expect(s.update).toBe("We have inspected the area and barricaded it.");
      expect(Object.keys(s).sort()).toEqual(["canReply", "closed", "found", "lastChange", "messages", "ministryOption", "stage", "update", "updateOn"]);
      const dump = JSON.stringify(s);
      for (const secret of ["critical", "equipment_hazard", SO, SM, "triage", "Pit 3", "severity", "assigned"]) expect(dump).not.toContain(secret);
    });
  });

  test("wrong, malformed, truncated and another report's codes all look identical to 'not found'", async () => {
    await world(async (run, c) => {
      const site = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const r = await submitAnon(run, site);
      const probes = ["", "WV-0000", r.code.slice(0, 23), r.code + "0", r.code.toLowerCase().replace(/[0-9A-F]/g, "g"), "ABCDEF012345678901234567", "'; drop table x; --"];
      for (const p of probes) expect((await run("select public.mg_wv_status($1) as r", [p]))[0].r).toEqual({ found: false });
    });
  });

  test("guessing is rate-limited per source; the stored value is a hash, not the code", async () => {
    await world(async (run, c) => {
      const site = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const r = await submitAnon(run, site);
      await src(run, "198.51.100.77");
      let limited = 0;
      for (let i = 0; i < 14; i++) {
        const out = (await run("select public.mg_wv_status($1) as r", [`${i.toString(16).padStart(2, "0")}ABCDEF0123456789ABCDEF`.toUpperCase()]))[0].r;
        if (out.status === "rate_limited") limited++;
      }
      expect(limited).toBeGreaterThanOrEqual(3);
      const stored = (await owner(run, "select code_hash from public.worker_voice_reports"))[0].code_hash as string;
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      expect(stored).not.toContain(r.code.toLowerCase());
      expect(JSON.stringify(await owner(run, "select * from public.worker_voice_reports"))).not.toContain(r.code);
    });
  });

  test("a code from one report cannot be reused to read or alter another", async () => {
    await world(async (run, c) => {
      const site = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const a = await submitAnon(run, site);
      const b = await submitAnon(run, site, newCode(), { description: "A completely different concern about the crusher guard being removed." });
      const sa = (await run("select public.mg_wv_status($1) as r", [a.code]))[0].r;
      const sb = (await run("select public.mg_wv_status($1) as r", [b.code]))[0].r;
      expect(sa.found && sb.found).toBe(true);
      expect(await fails(run("update public.worker_voice_reports set status = 'closed'"))).toContain("permission denied");
    });
  });

  test("named and confidential reporters can follow up without ever revealing themselves", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      const r = await submitMember(run, "confidential", c.siteA);
      await asAnon(run);
      expect((await run("select public.mg_wv_status($1) ->> 'stage' as s", [r.code]))[0].s).toBe("Received");
      await asAuthed(run, WK);
      const mine = await run("select mode, stage from public.mg_wv_my_reports()");
      expect(mine).toEqual([{ mode: "confidential", stage: "Received" }]);
      await asAuthed(run, WK2);
      expect((await run("select count(*)::int as n from public.mg_wv_my_reports()"))[0].n).toBe(0);
    });
  });
});

describe("notifications and abuse limits", () => {
  test("reviewers get a generic notification: no reporter, content, mode, category or site", async () => {
    await world(async (run, c) => {
      const site = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await submitAnon(run, site, newCode(), { description: "Foreman Kollie shouted and threatened the night shift about the gas alarm.", category: "unsafe_procedure", urgency: "critical" });
      const rows = await owner(run, "select user_id, kind, severity, title, body, link_to from public.notifications where kind = 'worker_voice'");
      expect(rows.length).toBeGreaterThan(0);
      const users = rows.map((r) => r.user_id as string);
      for (const u of [XA, XA2, SM, SO]) expect(users).toContain(u);
      for (const u of [WK, WK2, SO2, OTH]) expect(users).not.toContain(u);
      for (const r of rows) {
        expect(r.title).toBe("A safety report requires review");
        expect(r.body).toBe("MineGuard: A safety report requires review. Sign in with your authorized account to access it.");
        expect(r.link_to).toBe("/operate/voice-review");
      }
      const dump = JSON.stringify(rows);
      for (const leak of ["Kollie", "gas alarm", "anonymous", "confidential", "unsafe_procedure", "Pit 3", "critical"]) expect(dump).not.toContain(leak);
    });
  });

  test("a named reporter who is also a reviewer is not notified about their own report", async () => {
    await world(async (run, c) => {
      await asAuthed(run, SM);
      await submitMember(run, "confidential", c.siteA);
      const users = (await owner(run, "select user_id from public.notifications where kind = 'worker_voice'")).map((r) => r.user_id);
      expect(users).not.toContain(SM);
      expect(users).toContain(XA);
    });
  });

  test("signed-in senders are limited per person per hour, keyed by a digest", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      for (let i = 0; i < 10; i++) expect((await submitMember(run, "named", c.siteA, newCode(), { description: `Concern number ${i} about something different at the north pit.` })).status).toBe("received");
      expect((await submitMember(run, "named", c.siteA, newCode(), { description: "One more concern about a different thing entirely." })).status).toBe("rate_limited");
      const buckets = JSON.stringify(await owner(run, "select bucket from public.rate_limits where bucket like 'wv:u:%'"));
      expect(buckets).not.toContain(WK);
    });
  });

  test("submitted content is frozen: no edits, no deletion, no moving between sites or modes", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "named", c.siteA);
      const id = (await reportIds(run))[0].id as string;
      await run("reset role");
      expect(await fails(run("update public.worker_voice_reports set description = 'rewritten after the fact by someone' where id = $1", [id]))).toContain("IMMUTABLE");
      expect(await fails(run("update public.worker_voice_reports set mode = 'anonymous' where id = $1", [id]))).toContain("IMMUTABLE");
      expect(await fails(run("update public.worker_voice_reports set site_id = $2 where id = $1", [id, c.siteB]))).toContain("IMMUTABLE");
      expect(await fails(run("delete from public.worker_voice_reports where id = $1", [id]))).toContain("never deleted");
    });
  });

  test("photo and message tables are closed to every client role", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "named", c.siteA);
      for (const who of [WK, XA, f.admin]) {
        await asAuthed(run, who);
        expect(await fails(run("select * from public.worker_voice_attachments"))).toContain("permission denied");
        expect(await fails(run("select * from public.voice_push_outbox"))).toContain("permission denied");
        expect(await fails(run("select * from public.worker_voice_code_usage"))).toContain("permission denied");
      }
      await asAnon(run);
      expect(await fails(run("select * from public.worker_voice_messages"))).toContain("permission denied");
    });
  });
});
