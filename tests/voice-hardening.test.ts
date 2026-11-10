/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed RPC results in assertions */
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
  for (const m of ["0040_emergency_alerts", "0041_emergency_authority_corrections", "0043_jsa_with_human_review", "0044_role_assignment_and_emergency_contacts", "0046_worker_voice", "0050_ministry_voice", "0052_voice_hardening"]) {
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


import { createHash } from "node:crypto";
const src2 = (run: Runner, ip: string) => run(`select set_config('request.headers', '{"x-forwarded-for":"${ip}"}', true)`);
const WBASE = { category: "unsafe_condition", urgency: "medium", description: "The haul road edge berm near Pit 3 has collapsed and trucks pass within a metre.", previously: "no" };
const wMember = (run: Runner, mode: string, site: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...WBASE, ...over } as typeof WBASE & Record<string, unknown>;
  return run("select public.mg_wv_submit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) as r", [mode, site, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, p.concerns ?? false, code, p.photos ? JSON.stringify(p.photos) : null]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
const wAnon = (run: Runner, siteCode: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...WBASE, ...over } as typeof WBASE & Record<string, unknown>;
  return run("select public.mg_wv_submit_anonymous($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as r", [siteCode, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, p.concerns ?? false, code, p.photos ? JSON.stringify(p.photos) : null]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
const mMember = (run: Runner, mode: string, site: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...MBASE, ...over } as typeof MBASE & Record<string, unknown>;
  return run("select public.mg_mv_submit($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as r", [mode, site, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, code, p.photos ? JSON.stringify(p.photos) : null]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
const mAnonP = (run: Runner, siteCode: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...MBASE, ...over } as typeof MBASE & Record<string, unknown>;
  return run("select public.mg_mv_submit_anonymous($1,$2,$3,$4,$5,$6,$7,$8::jsonb) as r", [siteCode, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, code, p.photos ? JSON.stringify(p.photos) : null]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
const wIds = async (run: Runner) => (await owner(run, "select id, mode from public.worker_voice_reports order by created_at, id"));
const pushSub = (run: Runner, uid: string, n: number) => owner(run, "insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'p256dh-key', 'auth-key')", [uid, `https://push.example.test/sub/${n}`]);

// ---- a tiny synthetic JPEG: right structure, no real pixels ----
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const seg = (marker: number, data: number[]) => [0xff, marker, ...u16(data.length + 2), ...data];
const JFIF = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
function jpeg(o: { before?: number[]; w?: number; entropy?: number; afterScan?: number[] } = {}): Buffer {
  const dqt = seg(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => 1 + (i % 7))]);
  const sof = seg(0xc0, [8, ...u16(480), ...u16(o.w ?? 640), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const dht = seg(0xc4, [0, ...Array.from({ length: 28 }, (_, i) => i % 5)]);
  const sos = seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  return Buffer.from([0xff, 0xd8, ...JFIF, ...(o.before ?? []), ...dqt, ...sof, ...dht, ...sos, ...Array.from({ length: o.entropy ?? 300 }, (_, i) => (i * 37 + 11) % 250), ...(o.afterScan ?? []), 0xff, 0xd9]);
}
const b64 = (b: Buffer) => b.toString("base64");
const EXIF = seg(0xe1, [...Buffer.from("Exif\0\0"), 1, 2, 3, 4, 5, 6, 7, 8]);

describe("F1 · the Ministry's intake code belongs to the Ministry", () => {
  test("the company can rotate its own code, and that never touches Ministry intake", async () => {
    await world(async (run, c) => {
      const ministry = await siteCodeFor(run, WK, c.siteA);
      const company = await companyCodeFor(run, WK, c.siteA);
      await asAuthed(run, SM);
      await run("select public.mg_wv_rotate_code($1)", [c.siteA]);
      await asAnon(run);
      expect((await mAnonP(run, ministry)).status).toBe("received"); // the Ministry's poster still works
      expect((await wAnon(run, company)).status).toBe("invalid_site_code"); // the company's old poster no longer does
    });
  });
  test("only a Ministry administrator can see the Ministry code list, rotate, pause or resume; company people, supervisors and inspectors cannot", async () => {
    await world(async (run, c) => {
      await siteCodeFor(run, WK, c.siteA);
      for (const who of [XA, SM, SO, WK, OTH, f.national, f.county]) {
        await asAuthed(run, who);
        for (const call of ["select * from public.mg_mv_code_sites('')", "select public.mg_mv_code_info($1)", "select public.mg_mv_rotate_code($1)", "select public.mg_mv_set_anonymous($1, false)"]) {
          expect(await fails(run(call, [c.siteA]))).toContain("FORBIDDEN");
        }
      }
      await asAuthed(run, f.admin);
      expect((await run("select site_name from public.mg_mv_code_sites('AgriLib')")).length).toBeGreaterThan(0);
      const old = (await run("select public.mg_mv_code_info($1) ->> 'code' as c", [c.siteA]))[0].c as string;
      const fresh = (await run("select public.mg_mv_rotate_code($1) as c", [c.siteA]))[0].c as string;
      expect(fresh).not.toBe(old);
      await asAnon(run);
      expect((await mAnonP(run, old)).status).toBe("invalid_site_code");
      expect((await mAnonP(run, fresh)).status).toBe("received");
    });
  });
  test("pausing stops anonymous Ministry intake with an honest answer; signed-in reports still work; resuming works", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAuthed(run, f.admin);
      await run("select public.mg_mv_set_anonymous($1,false)", [c.siteA]);
      await asAnon(run);
      expect((await mAnonP(run, code)).status).toBe("anonymous_paused");
      expect(((await run("select public.mg_mv_site_info($1) as r", [code]))[0].r as any).paused).toBe(true);
      await asAuthed(run, WK);
      expect((await mMember(run, "named", c.siteA)).status).toBe("received");
      await asAuthed(run, f.admin);
      await run("select public.mg_mv_set_anonymous($1,true)", [c.siteA]);
      await asAnon(run);
      expect((await mAnonP(run, code, newCode(), { description: "Anonymous intake is open again at this site now, so this is accepted." })).status).toBe("received");
    });
  });
  test("a member's app can read the Ministry code to send, but a stranger cannot; the Ministry code never expires on its own", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      expect(code).toMatch(/^[0-9A-F]{10}$/);
      expect(await siteCodeFor(run, WK2, c.siteA)).toBe(code);
      await asAuthed(run, OTH);
      expect(await fails(run("select public.mg_mv_site_code($1)", [c.siteA]))).toContain("FORBIDDEN");
      const cols = (await owner(run, "select column_name from information_schema.columns where table_name = 'ministry_voice_site_codes'")).map((r) => r.column_name);
      expect(cols).not.toContain("expires_at");
    });
  });
  test("company codes expire after 90 days and a member's next request issues a new one; the Ministry's is untouched", async () => {
    await world(async (run, c) => {
      const company = await companyCodeFor(run, WK, c.siteA);
      const ministry = await siteCodeFor(run, WK, c.siteA);
      await owner(run, "update public.worker_voice_site_codes set expires_at = now() - interval '1 day'");
      await asAnon(run);
      expect((await wAnon(run, company)).status).toBe("invalid_site_code");
      expect((await mAnonP(run, ministry)).status).toBe("received");
      const fresh = await companyCodeFor(run, WK2, c.siteA);
      expect(fresh).not.toBe(company);
      await asAnon(run);
      expect((await wAnon(run, fresh)).status).toBe("received");
    });
  });
  test("intake volume is counted per day, never per report, and a surge is flagged", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      for (let i = 0; i < 21; i++) { await src2(run, `198.51.100.${i + 1}`); await mAnonP(run, code, newCode(), { description: `Concern number ${i} about unpaid wages at the north pit workshop.` }); }
      await asAuthed(run, f.admin);
      const info = (await run("select public.mg_mv_code_info($1) as r", [c.siteA]))[0].r as any;
      expect(info).toMatchObject({ today: 21, week: 21, unusual: true, enabled: true });
      expect((await owner(run, "select column_name from information_schema.columns where table_name = 'ministry_voice_code_usage'")).map((r) => r.column_name).sort()).toEqual(["day", "n", "site_id"]);
    });
  });
  test("F2: the escalation dead end now points at the Ministry channel", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await wMember(run, "named", c.siteA, newCode(), { concerns: true });
      const id = (await wIds(run))[0].id as string;
      await asAuthed(run, XA);
      expect(await fails(run("select public.mg_wv_escalate($1,'Cannot go higher inside the company')", [id]))).toContain("Ministry channel");
    });
  });
});

describe("A1 · two-way messaging, both channels", () => {
  test("company: the reporter replies with the code alone; reviewers read it; hourly time; generic notification; thread order is true order", async () => {
    await world(async (run, c) => {
      const code = await companyCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const r = await wAnon(run, code);
      const id = (await wIds(run))[0].id as string;
      await asAuthed(run, SM);
      await run("select public.mg_wv_post_update($1,'Can you tell us which shift this was?')", [id]);
      await asAnon(run);
      await owner(run, "delete from public.notifications where kind = 'worker_voice'");
      expect((await run("select public.mg_wv_reply($1,'It was the night shift. The foreman Kollie was there.') ->> 'status' as s", [r.code]))[0].s).toBe("received");
      const st = (await run("select public.mg_wv_status($1) as r", [r.code]))[0].r as any;
      expect(st.messages.map((m: any) => m.from)).toEqual(["reviewers", "you"]);
      expect(st.canReply).toBe(true);
      expect(JSON.stringify(await owner(run, "select title, body from public.notifications where kind = 'worker_voice'"))).not.toContain("Kollie");
      expect((await owner(run, "select extract(minute from at)::int as m from public.worker_voice_messages where from_reporter"))[0].m).toBe(0);
      expect((await owner(run, "select count(*)::int as n from public.audit_log where entity_type like 'worker_voice%' or entity_type like 'ministry_voice%'"))[0].n).toBe(0);
      for (const who of [WK, OTH, SO2, f.admin, f.national]) { await asAuthed(run, who); expect((await run("select count(*)::int as n from public.worker_voice_messages"))[0].n).toBe(0); }
    });
  });
  test("Ministry: the same, on its own tables; company people and the other channel's reviewers cannot read it", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const r = await mAnonP(run, code);
      const id = (await mIds(run))[0].id as string;
      await asAuthed(run, f.admin);
      await run("select public.mg_mv_post_update($1,'Please tell us the date the wages were last paid.')", [id]);
      await asAnon(run);
      expect((await run("select public.mg_mv_reply($1,'The last payment was in September.') ->> 'status' as s", [r.code]))[0].s).toBe("received");
      const st = (await run("select public.mg_mv_status($1) as r", [r.code]))[0].r as any;
      expect(st.messages.map((m: any) => [m.from, m.text])).toEqual([["reviewers", "Please tell us the date the wages were last paid."], ["you", "The last payment was in September."]]);
      for (const who of [XA, SM, SO, WK, OTH, f.county]) { await asAuthed(run, who); expect((await run("select count(*)::int as n from public.ministry_voice_messages"))[0].n).toBe(0); }
      for (const who of [f.admin, f.national]) { await asAuthed(run, who); expect((await run("select count(*)::int as n from public.ministry_voice_messages"))[0].n).toBe(2); }
      expect((await run("select count(*)::int as n from public.worker_voice_messages"))[0].n).toBe(0);
    });
  });
  test("replies are validated and limited on both channels; closed reports take none; guessing is limited", async () => {
    await world(async (run, c) => {
      const wc = await companyCodeFor(run, WK, c.siteA); const mc = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const w = await wAnon(run, wc); const m = await mAnonP(run, mc);
      for (const [fn, code] of [["mg_wv_reply", w.code], ["mg_mv_reply", m.code]] as const) {
        const reply = async (t: string, k = code) => (await run(`select public.${fn}($1,$2) as r`, [k, t]))[0].r as any;
        expect((await reply("ok", newCode())).status).toBe("not_found");
        expect((await reply("   ")).status).toBe("invalid");
        expect((await reply("x".repeat(1001))).status).toBe("invalid");
        for (let i = 0; i < 10; i++) expect((await reply(`message ${i}`)).status).toBe("received");
        expect((await reply("one too many")).status).toBe("rate_limited");
      }
      await asAuthed(run, SM);
      const wid = (await wIds(run))[0].id as string;
      await run("select public.mg_wv_set_status($1,'closed','Resolved and verified on site by the manager')", [wid]);
      await asAnon(run);
      expect((await run("select public.mg_wv_reply($1,'after closing') ->> 'status' as s", [w.code]))[0].s).toBe("closed");
      await src2(run, "198.51.100.200");
      let limited = 0;
      for (let i = 0; i < 14; i++) if (((await run("select public.mg_mv_reply($1,'hello there') ->> 'status' as s", [`${i.toString(16).padStart(2, "0")}ABCDEF0123456789ABCDEF`.toUpperCase()]))[0].s) === "rate_limited") limited++;
      expect(limited).toBeGreaterThanOrEqual(3);
    });
  });
  test("signed-in reporters reply from their own list; nobody else can reply as them", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await wMember(run, "confidential", c.siteA); await mMember(run, "confidential", c.siteA, newCode(), { description: "Overtime is being demanded without any pay at the north pit." });
      const wid = (await wIds(run))[0].id as string; const mid = (await mIds(run))[0].id as string;
      await run("select public.mg_wv_reply_mine($1,'It happened again today.')", [wid]);
      await run("select public.mg_mv_reply_mine($1,'It happened again today.')", [mid]);
      for (const who of [WK2, XA, f.admin, OTH]) { await asAuthed(run, who); expect(await fails(run("select public.mg_wv_reply_mine($1,'pretending')", [wid]))).toContain("FORBIDDEN"); expect(await fails(run("select public.mg_mv_reply_mine($1,'pretending')", [mid]))).toContain("FORBIDDEN"); }
    });
  });
});

describe("A2 · ageing and escalation", () => {
  test("company: a report nobody touched for 7 days goes to the company administrators; reminders after 3 days are generic and once a day", async () => {
    await world(async (run, c) => {
      const code = await companyCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await wAnon(run, code, newCode(), { description: "The foreman Kollie ignores the gas alarm every night shift." });
      await owner(run, "update public.worker_voice_reports set created_at = now() - interval '4 days'");
      await owner(run, "delete from public.notifications where kind = 'worker_voice'");
      const first = (await owner(run, "select public.mg_voice_ageing_sweep() as r"))[0].r as any;
      expect(first).toMatchObject({ companyReminded: 1, autoEscalated: 0 });
      const n1 = await owner(run, "select user_id, title, body from public.notifications where kind = 'worker_voice'");
      expect(new Set(n1.map((x) => x.user_id))).toEqual(new Set([XA, XA2, SM, SO]));
      expect(JSON.stringify(n1)).not.toMatch(/Kollie|gas alarm/);
      expect(n1.every((x) => x.title === "A safety report is still waiting for review")).toBe(true);
      await owner(run, "select public.mg_voice_ageing_sweep()");
      expect((await owner(run, "select count(*)::int as n from public.notifications where kind = 'worker_voice'"))[0].n).toBe(n1.length); // once a day
      await owner(run, "update public.worker_voice_reports set created_at = now() - interval '8 days'");
      const second = (await owner(run, "select public.mg_voice_ageing_sweep() as r"))[0].r as any;
      expect(second.autoEscalated).toBe(1);
      expect((await owner(run, "select route from public.worker_voice_reports"))[0].route).toBe("company_admin");
      expect((await owner(run, "select event, actor_id, detail from public.worker_voice_events where event = 'auto_escalated'"))[0]).toEqual({ event: "auto_escalated", actor_id: null, detail: "unacknowledged for 7 days" });
      await asAuthed(run, SM);
      expect((await run("select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(0);
      await asAuthed(run, XA);
      expect((await run("select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(1);
    });
  });
  test("a report somebody has acknowledged is not chased or escalated", async () => {
    await world(async (run, c) => {
      const code = await companyCodeFor(run, WK, c.siteA);
      await asAnon(run); await wAnon(run, code);
      const id = (await wIds(run))[0].id as string;
      await asAuthed(run, SM); await run("select public.mg_wv_triage($1,'high')", [id]);
      await owner(run, "update public.worker_voice_reports set created_at = now() - interval '9 days'");
      expect(((await owner(run, "select public.mg_voice_ageing_sweep() as r"))[0].r as any)).toMatchObject({ companyReminded: 0, autoEscalated: 0 });
    });
  });
  test("Ministry: unacknowledged reports remind the Ministry reviewers, generically", async () => {
    await world(async (run, c) => {
      const code = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run); await mAnonP(run, code);
      await owner(run, "update public.ministry_voice_reports set created_at = now() - interval '4 days'");
      await owner(run, "delete from public.notifications where kind = 'worker_voice'");
      expect(((await owner(run, "select public.mg_voice_ageing_sweep() as r"))[0].r as any).ministryReminded).toBe(1);
      const rows = await owner(run, "select user_id, body, link_to from public.notifications where kind = 'worker_voice'");
      expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([f.admin, f.national]));
      expect(rows.every((r) => r.link_to === "/portal/voice-ministry" && /still waiting for review/.test(r.body as string))).toBe(true);
    });
  });
  test("the sweep is not callable by any client role", async () => {
    await world(async (run) => {
      for (const who of [XA, f.admin, WK]) { await asAuthed(run, who); expect(await fails(run("select public.mg_voice_ageing_sweep()"))).toContain("permission denied"); }
      await asAnon(run);
      expect(await fails(run("select public.mg_voice_ageing_sweep()"))).toContain("permission denied");
    });
  });
  test("a reporter whose company report is closed or two weeks old is told the Ministry channel exists; a fresh one is not", async () => {
    await world(async (run, c) => {
      const code = await companyCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const r = await wAnon(run, code);
      const opt = async () => ((await run("select public.mg_wv_status($1) as r", [r.code]))[0].r as any).ministryOption;
      expect(await opt()).toBe(false);
      await owner(run, "update public.worker_voice_reports set created_at = now() - interval '15 days'");
      expect(await opt()).toBe(true);
    });
  });
});

describe("A3 · reviewer push", () => {
  test("both channels queue one push per subscribed reviewer, with a kind and nothing else; reminders and requests too", async () => {
    await world(async (run, c) => {
      await pushSub(run, SM, 1); await pushSub(run, f.admin, 2); await pushSub(run, WK, 3);
      const wc = await companyCodeFor(run, WK, c.siteA); const mc = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      await wAnon(run, wc, newCode(), { description: "Foreman Kollie shouted at the night shift about the gas alarm." });
      await mAnonP(run, mc, newCode(), { description: "Foreman Kollie withholds wages from the crusher crew every month." });
      const rows = await owner(run, "select user_id, kind from public.voice_push_outbox order by kind");
      expect(rows).toEqual([{ user_id: SM, kind: "company" }, { user_id: f.admin, kind: "ministry" }]);
      expect((await owner(run, "select column_name from information_schema.columns where table_name = 'voice_push_outbox'")).map((x) => x.column_name).sort()).toEqual(["attempts", "created_at", "detail", "id", "kind", "state", "updated_at", "user_id"]);
      expect(JSON.stringify(await owner(run, "select * from public.voice_push_outbox"))).not.toMatch(/Kollie|wages|gas alarm/);
    });
  });
  test("the dispatcher claims once, records outcomes, expires stale rows and stops targeting dead subscriptions; clients cannot reach it", async () => {
    await world(async (run, c) => {
      await pushSub(run, SM, 1);
      const code = await companyCodeFor(run, WK, c.siteA);
      await asAnon(run); await wAnon(run, code);
      for (const who of [SM, XA, f.admin]) { await asAuthed(run, who); expect(await fails(run("select * from public.mg_voice_push_claim(10)"))).toContain("permission denied"); }
      await asAnon(run);
      expect(await fails(run("select * from public.mg_voice_push_claim(10)"))).toContain("permission denied");
      await run("reset role"); await run("set local role service_role");
      const first = await run("select outbox_id, subscription_id, kind, endpoint from public.mg_voice_push_claim(10)");
      expect(first.length).toBe(1);
      expect(first[0].kind).toBe("company");
      expect((await run("select count(*)::int as n from public.mg_voice_push_claim(10)"))[0].n).toBe(0);
      await run("select public.mg_voice_push_record($1,'expired','subscription gone 410',$2)", [first[0].outbox_id, first[0].subscription_id]);
      expect((await owner(run, "select expired_at is not null as dead from public.push_subscriptions"))[0].dead).toBe(true);
      await owner(run, "update public.voice_push_outbox set state = 'queued', created_at = now() - interval '7 hours'");
      expect((await run("select count(*)::int as n from public.mg_voice_push_claim(10)"))[0].n).toBe(0);
      expect((await owner(run, "select state from public.voice_push_outbox"))[0].state).toBe("expired");
    });
  });
});

describe("A4 · photos, both channels", () => {
  test("a clean JPEG is accepted in every mode on both channels, hashed by the server, and served only to that channel's reviewers", async () => {
    await world(async (run, c) => {
      const img = jpeg(); const wc = await companyCodeFor(run, WK, c.siteA); const mc = await siteCodeFor(run, WK, c.siteA);
      await asAuthed(run, WK);
      expect((await wMember(run, "named", c.siteA, newCode(), { photos: [b64(img)] })).status).toBe("received");
      expect((await mMember(run, "confidential", c.siteA, newCode(), { photos: [b64(img), b64(jpeg({ entropy: 400 }))] })).status).toBe("received");
      await asAnon(run);
      expect((await wAnon(run, wc, newCode(), { photos: [b64(img)], description: "A third concern about a leaking fuel hose at the depot." })).status).toBe("received");
      expect((await mAnonP(run, mc, newCode(), { photos: [b64(img)], description: "Payslips were altered after we signed them, see the photo." })).status).toBe("received");
      const wid = (await owner(run, "select id from public.worker_voice_reports where mode = 'named'"))[0].id as string;
      const mid = (await owner(run, "select id from public.ministry_voice_reports where mode = 'confidential'"))[0].id as string;
      await asAuthed(run, SM);
      const got = await run("select bytes, sha256, data from public.mg_wv_attachments($1)", [wid]);
      expect(got[0].sha256).toBe(createHash("sha256").update(img).digest("hex"));
      expect(Buffer.from(got[0].data as string, "base64").equals(img)).toBe(true);
      expect((await run("select count(*)::int as n from public.mg_wv_attachment_counts()"))[0].n).toBe(2);
      expect(await fails(run("select * from public.mg_mv_attachments($1)", [mid]))).toContain("FORBIDDEN");
      await asAuthed(run, f.national);
      expect((await run("select count(*)::int as n from public.mg_mv_attachments($1)", [mid]))[0].n).toBe(2);
      expect(await fails(run("select * from public.mg_wv_attachments($1)", [wid]))).toContain("FORBIDDEN"); // the Ministry has no access to company photos
      for (const who of [WK, OTH, SO2, f.county]) { await asAuthed(run, who); expect(await fails(run("select * from public.mg_wv_attachments($1)", [wid]))).toContain("FORBIDDEN"); expect(await fails(run("select * from public.mg_mv_attachments($1)", [mid]))).toContain("FORBIDDEN"); }
    });
  });
  test("anything with hidden data, or not a plain JPEG, is refused on both channels and nothing is stored", async () => {
    await world(async (run, c) => {
      const wc = await companyCodeFor(run, WK, c.siteA); const mc = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const bad: Record<string, Buffer> = { "EXIF": jpeg({ before: EXIF }), "after scan": jpeg({ afterScan: EXIF }), "wide": jpeg({ w: 5000 }), "oversized": jpeg({ entropy: 1_000_100 }), "script": Buffer.from("<script>alert(1)</script>".repeat(10)) };
      for (const [name, buf] of Object.entries(bad)) {
        expect([name, (await wAnon(run, wc, newCode(), { photos: [b64(buf)] })).status]).toEqual([name, "invalid"]);
        expect([name, (await mAnonP(run, mc, newCode(), { photos: [b64(buf)] })).status]).toEqual([name, "invalid"]);
      }
      expect((await wAnon(run, wc, newCode(), { photos: [b64(jpeg()), b64(jpeg()), b64(jpeg()), b64(jpeg())] })).status).toBe("invalid");
      expect((await mAnonP(run, mc, newCode(), { photos: ["not base64 !!!"] })).status).toBe("invalid");
      expect((await owner(run, "select (select count(*) from public.worker_voice_reports) + (select count(*) from public.ministry_voice_reports) + (select count(*) from public.worker_voice_attachments) + (select count(*) from public.ministry_voice_attachments) as n"))[0].n).toBe(0);
    });
  });
  test("evidence cannot be altered or removed except by an authorised disposal", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await wMember(run, "named", c.siteA, newCode(), { photos: [b64(jpeg())] });
      await run("reset role");
      expect(await fails(run("update public.worker_voice_attachments set content = '\\x00'::bytea"))).toContain("IMMUTABLE");
      expect(await fails(run("delete from public.worker_voice_attachments"))).toContain("IMMUTABLE");
    });
  });
});

describe("A6 · small sites, both channels", () => {
  test("fewer than 10 people assigned: flagged, warned, and times coarsened to the day; named keeps its precision", async () => {
    await world(async (run, c) => {
      const wc = await companyCodeFor(run, WK, c.siteA); const mc = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      expect(((await run("select public.mg_wv_site_info($1) as r", [wc]))[0].r as any)).toEqual({ valid: true, smallSite: true, paused: false });
      expect(((await run("select public.mg_mv_site_info($1) as r", [mc]))[0].r as any)).toEqual({ valid: true, smallSite: true, paused: false });
      await wAnon(run, wc, newCode(), { occurred: "2026-11-05T14:37:12Z" });
      await mAnonP(run, mc, newCode(), { occurred: "2026-11-05T14:37:12Z" });
      await asAuthed(run, WK);
      await mMember(run, "named", c.siteA, newCode(), { occurred: "2026-11-05T14:37:12Z", description: "A named concern about missing safety boots for the whole crew." });
      for (const t of ["worker_voice_reports", "ministry_voice_reports"]) {
        for (const row of await owner(run, `select mode, small_site, to_char(created_at, 'HH24:MI:SS') as t, to_char(occurred_at at time zone 'UTC', 'HH24:MI:SS') as o from public.${t}`)) {
          if (row.mode === "named") { expect(row.o).toBe("14:37:12"); continue; }
          expect(row.small_site).toBe(true); expect(row.t).toBe("00:00:00"); expect(row.o).toBe("00:00:00");
        }
      }
      expect((await run("select public.mg_wv_site_small($1) as s", [c.siteA]))[0].s).toBe(true);
      await asAuthed(run, OTH);
      expect(await fails(run("select public.mg_wv_site_small($1)", [c.siteA]))).toContain("FORBIDDEN");
    });
  });
});

describe("A7 · Ministry trends", () => {
  test("reviewers only; monthly counts; companies for attention need three reports or two serious; no text, no identity; honest notice", async () => {
    await world(async (run, c) => {
      const mc = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      for (let i = 0; i < 3; i++) { await src2(run, `198.51.100.${i + 1}`); await mAnonP(run, mc, newCode(), { description: `Wages were not paid on time, report number ${i} from the north pit.`, category: i === 2 ? "hazard_ignored" : "wages_or_benefits" }); }
      const oc = await siteCodeFor(run, OTH, c.siteB);
      await asAnon(run);
      await src2(run, "198.51.100.50");
      await mAnonP(run, oc, newCode(), { description: "A single report about a missing guard at the other company site." });
      await asAuthed(run, f.admin);
      const t = (await run("select public.mg_mv_trends(3) as r"))[0].r as any;
      expect(t.months).toHaveLength(3);
      expect(t.months[t.months.length - 1].total).toBe(4);
      expect(t.attention).toHaveLength(1);
      expect(t.attention[0]).toMatchObject({ name: "AgriLib Mining", reports90: 3 });
      expect(t.notice).toMatch(/not a prediction/);
      expect(t.limits.length).toBeGreaterThanOrEqual(3);
      const dump = JSON.stringify(t);
      expect(dump).not.toMatch(/Wages were not paid|north pit|description|reporter_id|identity/);
      for (const who of [XA, SM, WK, OTH, f.county]) { await asAuthed(run, who); expect(await fails(run("select public.mg_mv_trends(3)"))).toContain("FORBIDDEN"); }
      await asAuthed(run, f.national);
      expect(((await run("select public.mg_mv_trends(1) as r"))[0].r as any).ageing).toBeTruthy();
    });
  });
  test("two serious reports are enough to flag a company; ageing counts follow the dates", async () => {
    await world(async (run, c) => {
      const mc = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      for (let i = 0; i < 2; i++) { await src2(run, `198.51.100.${i + 70}`); await mAnonP(run, mc, newCode(), { urgency: "critical", description: `A critical hazard has been ignored for weeks, case ${i}.`, category: "hazard_ignored" }); }
      await owner(run, "update public.ministry_voice_reports set created_at = now() - interval '20 days'");
      await asAuthed(run, f.admin);
      const t = (await run("select public.mg_mv_trends(2) as r"))[0].r as any;
      expect(t.attention).toHaveLength(1);
      expect(t.ageing).toMatchObject({ unacknowledged3d: 2, open14d: 2, open30d: 0 });
    });
  });
});

describe("A8 · retention, legal hold and disposal", () => {
  test("the policy is readable by everyone signed in and changeable only by a Ministry administrator, 12 to 120 months", async () => {
    await world(async (run) => {
      await asAuthed(run, WK);
      expect((await run("select channel, retention_months from public.voice_retention_policy order by channel")).map((r) => [r.channel, r.retention_months])).toEqual([["company", 36], ["ministry", 60]]);
      for (const who of [WK, XA, f.national, f.county]) { await asAuthed(run, who); expect(await fails(run("select public.mg_voice_set_retention('company', 24)"))).toContain("FORBIDDEN"); }
      await asAuthed(run, f.admin);
      for (const bad of [11, 121, 0]) expect(await fails(run("select public.mg_voice_set_retention('company', $1)", [bad]))).toContain("between 12 and 120");
      await run("select public.mg_voice_set_retention('company', 24)");
      expect((await run("select retention_months from public.voice_retention_policy where channel = 'company'"))[0].retention_months).toBe(24);
    });
  });
  test("company: only a company administrator holds or disposes; held, open and recent reports survive; dry run first; DISPOSE required; the log has counts only", async () => {
    await world(async (run, c) => {
      const code = await companyCodeFor(run, WK, c.siteA);
      await asAnon(run);
      for (let i = 0; i < 4; i++) { await src2(run, `198.51.100.${i + 100}`); await wAnon(run, code, newCode(), { description: `Concern ${i} about the washing plant that the manager Kollie ignored.` }); }
      const ids = (await wIds(run)).map((r) => r.id as string);
      await asAuthed(run, SM);
      for (const id of ids.slice(0, 3)) await run("select public.mg_wv_set_status($1,'closed','Resolved and verified by the manager on site')", [id]);
      expect(await fails(run("select public.mg_wv_set_hold($1,true,'Legal proceedings are pending')", [ids[0]]))).toContain("only a company administrator");
      await asAuthed(run, XA);
      expect(await fails(run("select public.mg_wv_set_hold($1,true,'short')", [ids[0]]))).toContain("INVALID");
      await run("select public.mg_wv_set_hold($1,true,'Legal proceedings are pending against the company')", [ids[0]]);
      expect((await owner(run, "select legal_hold from public.worker_voice_reports where id = $1", [ids[0]]))[0].legal_hold).toBe(true);
      expect(await fails(owner(run, "update public.worker_voice_reports set description = 'edited after the fact by someone else' where id = $1", [ids[0]]))).toContain("IMMUTABLE");
      // age two of the three closed reports beyond the 36 months; one of those is on hold
      await owner(run, "update public.worker_voice_reports set closed_at = now() - interval '40 months' where id = any ($1::uuid[])", [ids.slice(0, 2)]);
      for (const who of [SM, WK, OTH, f.admin]) { await asAuthed(run, who); expect(await fails(run("select public.mg_wv_dispose($1,true,null)", [c.orgA]))).toContain("FORBIDDEN"); }
      await asAuthed(run, XA);
      expect((await run("select public.mg_wv_dispose($1,true,null) as r", [c.orgA]))[0].r).toEqual({ dryRun: true, eligible: 1, retentionMonths: 36 });
      expect(await fails(run("select public.mg_wv_dispose($1,false,'yes')", [c.orgA]))).toContain("CONFIRMATION_REQUIRED");
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(4);
      expect((await run("select public.mg_wv_dispose($1,false,'DISPOSE') as r", [c.orgA]))[0].r).toEqual({ dryRun: false, deleted: 1, retentionMonths: 36 });
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(3);
      expect((await owner(run, "select id from public.worker_voice_reports where legal_hold")).length).toBe(1);
      const log = await owner(run, "select channel, deleted_reports, retention_months, actor_id from public.voice_disposal_log");
      expect(log).toEqual([{ channel: "company", deleted_reports: 1, retention_months: 36, actor_id: XA }]);
      expect(JSON.stringify(log)).not.toMatch(/Kollie|washing/);
      expect(await fails(owner(run, "delete from public.worker_voice_reports"))).toContain("never deleted");
    });
  });
  test("Ministry: only a Ministry administrator holds or disposes, and removes the whole report with its messages and photos", async () => {
    await world(async (run, c) => {
      const mc = await siteCodeFor(run, WK, c.siteA);
      await asAnon(run);
      const r = await mAnonP(run, mc, newCode(), { photos: [b64(jpeg())] });
      await run("select public.mg_mv_reply($1,'More detail on this.')", [r.code]);
      const id = (await mIds(run))[0].id as string;
      await asAuthed(run, f.national);
      expect(await fails(run("select public.mg_mv_set_hold($1,true,'Legal proceedings are pending')", [id]))).toContain("only a Ministry administrator");
      await run("select public.mg_mv_set_status($1,'closed','Referred and concluded after inspection')", [id]);
      await owner(run, "update public.ministry_voice_reports set closed_at = now() - interval '61 months'");
      expect(await fails(run("select public.mg_mv_dispose(true,null)"))).toContain("FORBIDDEN");
      await asAuthed(run, f.admin);
      expect((await run("select public.mg_mv_dispose(true,null) as r"))[0].r).toEqual({ dryRun: true, eligible: 1, retentionMonths: 60 });
      await run("select public.mg_mv_set_hold($1,true,'Legal proceedings are pending in court')", [id]);
      expect((await run("select public.mg_mv_dispose(true,null) as r"))[0].r).toMatchObject({ eligible: 0 });
      await run("select public.mg_mv_set_hold($1,false,null)", [id]);
      expect((await run("select public.mg_mv_dispose(false,'DISPOSE') as r"))[0].r).toEqual({ dryRun: false, deleted: 1, retentionMonths: 60 });
      for (const t of ["ministry_voice_reports", "ministry_voice_messages", "ministry_voice_attachments", "ministry_voice_events"]) expect((await owner(run, `select count(*)::int as n from public.${t}`))[0].n).toBe(0);
    });
  });
});

describe("A9 · Ministry requests to a company", () => {
  const topicReports = async (run: Runner, c: { siteA: string }, n: number, category: string) => {
    const mc = await siteCodeFor(run, WK, c.siteA);
    await asAnon(run);
    for (let i = 0; i < n; i++) { await src2(run, `198.51.100.${i + 140}`); await mAnonP(run, mc, newCode(), { category, description: `Report ${i} about working hours that run far past the agreed shift.` }); }
  };
  test("only a Ministry administrator can send one, and only when at least three reports match the topic; the request names no report", async () => {
    await world(async (run, c) => {
      await topicReports(run, c, 2, "working_hours");
      await asAuthed(run, f.admin);
      expect(await fails(run("select public.mg_mr_create($1,'working_hours_and_rest',null)", [c.orgA]))).toContain("TOO_FEW");
      await topicReports(run, c, 1, "working_hours");
      await asAuthed(run, f.admin);
      expect(await fails(run("select public.mg_mr_create($1,'child_labour',null)", [c.orgA]))).toContain("INVALID");
      expect(await fails(run("select public.mg_mr_create($1,'working_hours_and_rest',$2)", [c.orgA, "n".repeat(301)]))).toContain("300");
      for (const who of [f.national, f.county, XA, SM, WK, OTH]) { await asAuthed(run, who); expect(await fails(run("select public.mg_mr_create($1,'working_hours_and_rest',null)", [c.orgA]))).toContain("FORBIDDEN"); }
      await asAuthed(run, f.admin);
      const id = (await run("select public.mg_mr_create($1,'working_hours_and_rest','Please send your rosters policy.') as id", [c.orgA]))[0].id as string;
      expect(await fails(run("select public.mg_mr_create($1,'working_hours_and_rest',null)", [c.orgA]))).toContain("CONFLICT");
      const cols = (await owner(run, "select table_name, column_name from information_schema.columns where table_name in ('ministry_company_requests','ministry_company_responses')")).map((r) => `${r.table_name}.${r.column_name}`);
      expect(cols.filter((x) => /report|fingerprint|code|mode|site|reporter/.test(x))).toEqual([]);
      expect((await owner(run, "select organization_id, topic from public.ministry_company_requests where id = $1", [id]))[0]).toEqual({ organization_id: c.orgA, topic: "working_hours_and_rest" });
    });
  });
  test("company administrators (only) see their own requests, are told generically, answer, and the Ministry follows up or closes", async () => {
    await world(async (run, c) => {
      await topicReports(run, c, 3, "wages_or_benefits");
      await pushSub(run, XA, 9);
      await asAuthed(run, f.admin);
      await owner(run, "delete from public.notifications where kind = 'worker_voice'");
      const id = (await run("select public.mg_mr_create($1,'wages_and_benefits_records',null) as id", [c.orgA]))[0].id as string;
      const rows = await owner(run, "select user_id, title, body, link_to from public.notifications where kind = 'worker_voice' and source_key = $1", ["mr:" + id]);
      expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([XA, XA2]));
      expect(JSON.stringify(rows)).not.toMatch(/wage|report|anonymous/i);
      expect(rows.every((r) => r.link_to === "/operate/ministry-requests")).toBe(true);
      expect((await owner(run, "select kind from public.voice_push_outbox"))[0].kind).toBe("request");
      for (const who of [SM, SO, WK, OTH]) { await asAuthed(run, who); expect(await fails(run("select * from public.mg_mr_list()"))).toBeTruthy(); }
      for (const who of [SM, WK, OTH]) { await asAuthed(run, who); expect(await fails(run("select public.mg_mr_respond($1,'We answer')", [id]))).toContain("FORBIDDEN"); }
      await asAuthed(run, XA);
      expect((await run("select count(*)::int as n from public.mg_mr_list()"))[0].n).toBe(1);
      await run("select public.mg_mr_respond($1,'Our wage records are attached to the payroll file and available to inspectors.')", [id]);
      await asAuthed(run, OTH);
      expect((await run("select count(*)::int as n from public.mg_mr_list()"))[0].n).toBe(0);
      await asAuthed(run, f.admin);
      const list = (await run("select status, responses from public.mg_mr_list()"))[0] as any;
      expect(list.status).toBe("answered"); expect(list.responses).toHaveLength(1);
      await run("select public.mg_mr_followup($1,'Please also provide the last six pay periods.', false)", [id]);
      expect((await run("select status from public.mg_mr_list()"))[0].status).toBe("open");
      await run("select public.mg_mr_followup($1,'', true)", [id]);
      expect((await run("select status from public.mg_mr_list()"))[0].status).toBe("closed");
      await asAuthed(run, XA);
      expect(await fails(run("select public.mg_mr_respond($1,'too late')", [id]))).toContain("closed");
    });
  });
});
