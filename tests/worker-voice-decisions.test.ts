/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed RPC results in assertions */
// ---------------------------------------------------------------------------
// Migration 0049 — the five Worker Voice decisions. Real Postgres (PGlite), backend enforcement:
// Ministry-only confidential identity, validated photos, site-code controls, two-way messaging + push
// outbox, small-site protections.
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
  for (const m of ["0040_emergency_alerts", "0041_emergency_authority_corrections", "0043_jsa_with_human_review", "0044_role_assignment_and_emergency_contacts", "0046_worker_voice", "0049_worker_voice_decisions"]) {
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


import { createHash } from "node:crypto";
const submitMember = (run: Runner, mode: string, site: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...BASE, ...over } as typeof BASE & Record<string, unknown>;
  return run("select public.mg_wv_submit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) as r", [mode, site, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, p.concerns ?? false, code, p.photos ? JSON.stringify(p.photos) : null]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
const submitAnon = (run: Runner, siteCode: string, code = newCode(), over: Record<string, unknown> = {}) => {
  const p = { ...BASE, ...over } as typeof BASE & Record<string, unknown>;
  return run("select public.mg_wv_submit_anonymous($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as r", [siteCode, p.category, p.urgency, p.description, p.occurred ?? null, p.previously, p.concerns ?? false, code, p.photos ? JSON.stringify(p.photos) : null]).then((r) => ({ ...(r[0].r as Record<string, unknown>), code }));
};
const siteCodeFor = async (run: Runner, uid: string, site: string) => { await asAuthed(run, uid); return (await run("select public.mg_wv_site_code($1) as c", [site]))[0].c as string; };
const reportIds = async (run: Runner) => (await owner(run, "select id, mode from public.worker_voice_reports order by created_at, id"));

// ---- a tiny synthetic JPEG: right structure, no real pixels (the server checks structure, not pixels) ----
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const seg = (marker: number, data: number[]) => [0xff, marker, ...u16(data.length + 2), ...data];
const JFIF = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
interface JpegOpts { before?: number[]; w?: number; h?: number; afterScan?: number[]; entropy?: number; noEoi?: boolean; jfif?: number[] }
function jpeg(o: JpegOpts = {}): Buffer {
  const dqt = seg(0xdb, [0, ...Array.from({ length: 64 }, (_, i) => 1 + (i % 7))]);
  const sof = seg(0xc0, [8, ...u16(o.h ?? 480), ...u16(o.w ?? 640), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const dht = seg(0xc4, [0, ...Array.from({ length: 28 }, (_, i) => i % 5)]);
  const sos = seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]);
  const scan = Array.from({ length: o.entropy ?? 300 }, (_, i) => (i * 37 + 11) % 250); // never 0xFF
  return Buffer.from([0xff, 0xd8, ...(o.jfif ?? JFIF), ...(o.before ?? []), ...dqt, ...sof, ...dht, ...sos, ...scan, ...(o.afterScan ?? []), ...(o.noEoi ? [] : [0xff, 0xd9])]);
}
const b64 = (b: Buffer) => b.toString("base64");
const EXIF = seg(0xe1, [...Buffer.from("Exif\0\0"), 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x25, 0x88, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0]);
const COMMENT = seg(0xfe, [...Buffer.from("taken by Wale Worker")]);
const ICC = seg(0xe2, [...Buffer.from("ICC_PROFILE\0"), 1, 1, 0, 0, 0, 0]);

const SITE_CODE_OK = async (run: Runner, c: { siteA: string }) => siteCodeFor(run, WK, c.siteA);
const pushSub = (run: Runner, uid: string, n: number) => owner(run, "insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'p256dh-key', 'auth-key')", [uid, `https://push.example.test/sub/${n}`]);

describe("1 · confidential identity: Ministry staff only", () => {
  test("Ministry staff READ reports in their area and nothing else: no triage, status, update, escalation, incident or code change", async () => {
    await world(async (run, c) => {
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run); await submitAnon(run, code);
      const id = (await reportIds(run))[0].id as string;
      for (const who of [f.county, f.national, f.admin]) {
        await asAuthed(run, who);
        expect((await run("select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(1);
        for (const call of ["select public.mg_wv_triage($1,'high')", "select public.mg_wv_set_status($1,'investigating')", "select public.mg_wv_post_update($1,'hello')", "select public.mg_wv_escalate($1,'a long enough reason')", "select public.mg_wv_create_incident($1,'near_miss','Ministry staff cannot create incidents here.',null)"]) {
          expect(await fails(run(call, [id]))).toContain("FORBIDDEN");
        }
        expect(await fails(run("select public.mg_wv_rotate_code($1)", [c.siteA]))).toContain("FORBIDDEN");
        expect((await run("select count(*)::int as n from public.worker_voice_events"))[0].n).toBe(0); // reviewer history stays with the company
      }
    });
  });

  test("scope is respected: an inspector for another area sees nothing and cannot open an identity", async () => {
    await world(async (run, c) => {
      await asAuthed(run, OTH); // administrator of the other company, whose site is in Grand Cape Mount
      await submitMember(run, "confidential", c.siteB);
      const id = (await reportIds(run))[0].id as string;
      await asAuthed(run, f.county); // Bomi inspector
      expect((await run("select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(0);
      expect(await fails(run("select public.mg_wv_identity($1,'checking on a complaint raised')", [id]))).toContain("FORBIDDEN");
      expect(await fails(run("select * from public.mg_wv_attachments($1)", [id]))).toContain("FORBIDDEN");
      await asAuthed(run, f.national);
      expect((await run("select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(1); // national scope covers it
    });
  });

  test("named identity: the report's company reviewers and in-scope Ministry staff; anonymous: nothing to open for anyone", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK); await submitMember(run, "named", c.siteA);
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run); await submitAnon(run, code);
      const rows = await reportIds(run);
      const named = rows.find((r) => r.mode === "named")!.id as string;
      const anon = rows.find((r) => r.mode === "anonymous")!.id as string;
      for (const who of [XA, SM, SO, f.county, f.admin]) { await asAuthed(run, who); expect((await run("select (public.mg_wv_identity($1)) ->> 'name' as n", [named]))[0].n).toBe("Wale Worker"); }
      for (const who of [XA, f.admin, f.county]) { await asAuthed(run, who); expect(await fails(run("select public.mg_wv_identity($1,'trying to unmask this report')", [anon]))).toContain("NOT_AVAILABLE"); }
    });
  });

  test("a Ministry user who is also the reporter cannot open or review their own", async () => {
    await world(async (run, c) => {
      await asAuthed(run, XA2);
      await submitMember(run, "confidential", c.siteA);
      const id = (await reportIds(run))[0].id as string;
      await asAuthed(run, XA2);
      expect(await fails(run("select public.mg_wv_identity($1,'looking at my own report here')", [id]))).toContain("FORBIDDEN");
    });
  });
});

describe("2 · photos", () => {
  test("a clean JPEG is accepted in every mode, stored with a server-computed hash, and served only to authorized people", async () => {
    await world(async (run, c) => {
      const img = jpeg();
      const code = await SITE_CODE_OK(run, c);
      await asAuthed(run, WK);
      expect((await submitMember(run, "named", c.siteA, newCode(), { photos: [b64(img)] })).status).toBe("received");
      expect((await submitMember(run, "confidential", c.siteA, newCode(), { photos: [b64(img), b64(jpeg({ entropy: 400 }))], description: "A second concern about the crusher guard being removed." })).status).toBe("received");
      await asAnon(run);
      expect((await submitAnon(run, code, newCode(), { photos: [b64(img)], description: "A third concern about a leaking fuel hose at the depot." })).status).toBe("received");
      await asAuthed(run, SM);
      const counts = await run("select n from public.mg_wv_attachment_counts() order by n");
      expect(counts.map((r) => r.n)).toEqual([1, 1, 2]);
      const id = (await owner(run, "select id from public.worker_voice_reports where mode = 'named'"))[0].id as string;
      const got = await run("select bytes, sha256, data from public.mg_wv_attachments($1)", [id]);
      expect(got.length).toBe(1);
      expect(got[0].bytes).toBe(img.length);
      expect(got[0].sha256).toBe(createHash("sha256").update(img).digest("hex"));
      expect(Buffer.from(got[0].data as string, "base64").equals(img)).toBe(true);
    });
  });

  test("anything that could carry hidden data, or is not a plain JPEG, is REFUSED and nothing is stored", async () => {
    await world(async (run, c) => {
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run);
      const bad: Record<string, Buffer> = {
        "EXIF/GPS": jpeg({ before: EXIF }), "comment": jpeg({ before: COMMENT }), "ICC profile": jpeg({ before: ICC }),
        "thumbnail in JFIF": jpeg({ jfif: seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]).map((x, i) => (i === 16 ? 8 : x)) }),
        "metadata hidden after the scan": jpeg({ afterScan: EXIF }), "comment hidden after the scan": jpeg({ afterScan: [0xff, 0xfe, 0, 4, 65, 65] }),
        "truncated": jpeg({ noEoi: true }), "too large (pixels)": jpeg({ w: 5000 }), "zero size": jpeg({ h: 0 }),
        "oversized (>1 MB)": jpeg({ entropy: 1_000_100 }),
        "a PNG": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]),
        "a script": Buffer.from("<script>alert(1)</script>".repeat(10)),
        "tiny": Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      };
      for (const [name, buf] of Object.entries(bad)) {
        const r = await submitAnon(run, code, newCode(), { photos: [b64(buf)] });
        expect([name, r.status]).toEqual([name, "invalid"]);
      }
      expect((await submitAnon(run, code, newCode(), { photos: [b64(jpeg()), b64(jpeg()), b64(jpeg()), b64(jpeg())] })).status).toBe("invalid"); // 4 photos
      expect((await submitAnon(run, code, newCode(), { photos: ["not base64 !!!"] })).status).toBe("invalid");
      expect((await submitAnon(run, code, newCode(), { photos: [123] })).status).toBe("invalid");
      expect((await submitAnon(run, code, newCode(), { photos: { a: 1 } })).status).toBe("invalid");
      const big = [jpeg({ entropy: 900_000 }), jpeg({ entropy: 900_000 }), jpeg({ entropy: 900_000 })];
      expect((await submitAnon(run, code, newCode(), { photos: big.map(b64) })).status).toBe("invalid"); // 2.7 MB together
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_reports"))[0].n).toBe(0);
      expect((await owner(run, "select count(*)::int as n from public.worker_voice_attachments"))[0].n).toBe(0);
    });
  });

  test("no direct access: workers, other companies, the anonymous role and out-of-area staff cannot fetch a report's photos", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "named", c.siteA, newCode(), { photos: [b64(jpeg())] });
      const id = (await reportIds(run))[0].id as string;
      for (const who of [WK, WK2, SO2, OTH]) { await asAuthed(run, who); expect(await fails(run("select * from public.mg_wv_attachments($1)", [id]))).toContain("FORBIDDEN"); }
      await asAnon(run);
      expect(await fails(run("select * from public.mg_wv_attachments($1)", [id]))).toContain("permission denied");
      for (const who of [XA, SM, SO, f.county, f.admin]) { await asAuthed(run, who); expect((await run("select count(*)::int as n from public.mg_wv_attachments($1)", [id]))[0].n).toBe(1); }
    });
  });

  test("evidence cannot be altered or removed", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "named", c.siteA, newCode(), { photos: [b64(jpeg())] });
      await run("reset role");
      expect(await fails(run("update public.worker_voice_attachments set content = '\\x00'::bytea"))).toContain("IMMUTABLE");
      expect(await fails(run("delete from public.worker_voice_attachments"))).toContain("IMMUTABLE");
    });
  });
});

describe("3 · site code controls", () => {
  test("a reviewer can pause anonymous intake; paused sites say so, named reports continue; resuming works; workers cannot pause", async () => {
    await world(async (run, c) => {
      const code = await SITE_CODE_OK(run, c);
      await asAuthed(run, WK);
      expect(await fails(run("select public.mg_wv_set_anonymous($1,false)", [c.siteA]))).toContain("FORBIDDEN");
      await asAuthed(run, SM);
      await run("select public.mg_wv_set_anonymous($1,false)", [c.siteA]);
      await asAnon(run);
      expect((await submitAnon(run, code)).status).toBe("anonymous_paused");
      expect(((await run("select public.mg_wv_site_info($1) as r", [code]))[0].r as any).paused).toBe(true);
      await asAuthed(run, WK);
      expect((await submitMember(run, "named", c.siteA)).status).toBe("received");
      await asAuthed(run, SM);
      await run("select public.mg_wv_set_anonymous($1,true)", [c.siteA]);
      await asAnon(run);
      expect((await submitAnon(run, code, newCode(), { description: "Anonymous intake is open again at this site now." })).status).toBe("received");
    });
  });

  test("codes expire after 90 days: the old poster stops working and a member's next request issues a new code", async () => {
    await world(async (run, c) => {
      const old = await SITE_CODE_OK(run, c);
      const info = await owner(run, "select (expires_at - now()) > interval '89 days' as ok from public.worker_voice_site_codes");
      expect(info[0].ok).toBe(true);
      await owner(run, "update public.worker_voice_site_codes set expires_at = now() - interval '1 day'");
      await asAnon(run);
      expect((await submitAnon(run, old)).status).toBe("invalid_site_code");
      const fresh = await siteCodeFor(run, WK2, c.siteA);
      expect(fresh).not.toBe(old);
      await asAnon(run);
      expect((await submitAnon(run, fresh)).status).toBe("received");
      expect((await submitAnon(run, old, newCode(), { description: "The expired poster code must not work any more." })).status).toBe("invalid_site_code");
    });
  });

  test("reviewers see the code, expiry and intake counts; an unusual surge is flagged; counts are not tied to any report", async () => {
    await world(async (run, c) => {
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run);
      for (let i = 0; i < 21; i++) {
        await src(run, `198.51.100.${i + 1}`);
        expect((await submitAnon(run, code, newCode(), { description: `Concern number ${i} about a different hazard at the north pit.` })).status).toBe("received");
      }
      await asAuthed(run, SO);
      const info = (await run("select public.mg_wv_code_info($1) as r", [c.siteA]))[0].r as any;
      expect(info.code).toBe(code); expect(info.today).toBe(21); expect(info.week).toBe(21); expect(info.unusual).toBe(true); expect(info.enabled).toBe(true);
      const cols = (await owner(run, "select column_name from information_schema.columns where table_name = 'worker_voice_code_usage'")).map((r) => r.column_name);
      expect(cols.sort()).toEqual(["day", "n", "site_id"]);
      for (const who of [WK, OTH, SO2]) { await asAuthed(run, who); expect(await fails(run("select public.mg_wv_code_info($1)", [c.siteA]))).toContain("FORBIDDEN"); }
    });
  });

  test("changing the code resets expiry and keeps the pause setting", async () => {
    await world(async (run, c) => {
      await SITE_CODE_OK(run, c);
      await owner(run, "update public.worker_voice_site_codes set expires_at = now() + interval '2 days', anonymous_enabled = false");
      await asAuthed(run, XA);
      await run("select public.mg_wv_rotate_code($1)", [c.siteA]);
      expect((await owner(run, "select (expires_at - now()) > interval '89 days' as ok, anonymous_enabled from public.worker_voice_site_codes"))[0]).toEqual({ ok: true, anonymous_enabled: false });
    });
  });
});

describe("4 · two-way messaging", () => {
  test("the reporter replies with the code alone; reviewers read it; the reply carries no identity and only an hourly time", async () => {
    await world(async (run, c) => {
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run);
      const r = await submitAnon(run, code);
      await asAuthed(run, SM);
      const id = (await reportIds(run))[0].id as string;
      await run("select public.mg_wv_post_update($1,'Can you tell us which shift this was?')", [id]);
      await asAnon(run);
      expect((await run("select public.mg_wv_reply($1,$2) ->> 'status' as s", [r.code, "It was the night shift on the north haul road."]))[0].s).toBe("received");
      const st = (await run("select public.mg_wv_status($1) as r", [r.code]))[0].r as any;
      expect(st.canReply).toBe(true);
      expect(st.messages.map((m: any) => [m.from, m.text])).toEqual([["reviewers", "Can you tell us which shift this was?"], ["you", "It was the night shift on the north haul road."]]);
      await asAuthed(run, XA);
      const thread = await run("select from_reporter, body, extract(minute from at)::int as m from public.worker_voice_messages order by seq");
      expect(thread.filter((t) => t.from_reporter).map((t) => t.m)).toEqual([0]);
      const cols = (await owner(run, "select column_name from information_schema.columns where table_name = 'worker_voice_messages'")).map((x) => x.column_name);
      expect(cols.sort()).toEqual(["at", "body", "from_reporter", "id", "report_id", "seq"]);
      expect((await owner(run, "select count(*)::int as n from public.audit_log where entity_type like 'worker_voice%'"))[0].n).toBe(0);
    });
  });

  test("a reply raises the same generic notification, and nothing else sees the thread", async () => {
    await world(async (run, c) => {
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run);
      const r = await submitAnon(run, code);
      await owner(run, "delete from public.notifications where kind = 'worker_voice'");
      await run("select public.mg_wv_reply($1,'The foreman Kollie was there and saw it all.')", [r.code]);
      const rows = await owner(run, "select title, body from public.notifications where kind = 'worker_voice'");
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain("Kollie");
      for (const who of [WK, WK2, SO2, OTH]) { await asAuthed(run, who); expect((await run("select count(*)::int as n from public.worker_voice_messages"))[0].n).toBe(0); }
      for (const who of [SM, SO, XA, f.county]) { await asAuthed(run, who); expect((await run("select count(*)::int as n from public.worker_voice_messages"))[0].n).toBe(1); }
    });
  });

  test("replies are validated and limited: wrong code, empty, oversized, closed report, and ten a day", async () => {
    await world(async (run, c) => {
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run);
      const r = await submitAnon(run, code);
      const reply = async (t: string, k = r.code) => (await run("select public.mg_wv_reply($1,$2) as r", [k, t]))[0].r as any;
      expect((await reply("ok", newCode())).status).toBe("not_found");
      expect((await reply("   ")).status).toBe("invalid");
      expect((await reply("x".repeat(1001))).status).toBe("invalid");
      for (let i = 0; i < 10; i++) expect((await reply(`message ${i}`)).status).toBe("received");
      expect((await reply("one too many")).status).toBe("rate_limited");
      await asAuthed(run, SM);
      const id = (await reportIds(run))[0].id as string;
      await owner(run, "delete from public.worker_voice_messages where false");
      await run("select public.mg_wv_set_status($1,'closed','Resolved and verified on site by the manager')", [id]);
      await asAnon(run);
      expect((await reply("after closing")).status).toBe("closed");
      expect(((await run("select public.mg_wv_status($1) as r", [r.code]))[0].r as any).canReply).toBe(false);
    });
  });

  test("guessing codes through the reply route is limited like the status route", async () => {
    await world(async (run) => {
      await asAnon(run);
      await src(run, "198.51.100.90");
      let limited = 0;
      for (let i = 0; i < 14; i++) if (((await run("select public.mg_wv_reply($1,'hello there') ->> 'status' as s", [`${i.toString(16).padStart(2, "0")}ABCDEF0123456789ABCDEF`.toUpperCase()]))[0].s) === "rate_limited") limited++;
      expect(limited).toBeGreaterThanOrEqual(3);
    });
  });

  test("a named/confidential reporter replies from their own list; others cannot reply to it", async () => {
    await world(async (run, c) => {
      await asAuthed(run, WK);
      await submitMember(run, "confidential", c.siteA);
      const id = (await reportIds(run))[0].id as string;
      await run("select public.mg_wv_reply_mine($1,'Adding that it happened again today.')", [id]);
      for (const who of [WK2, XA, f.admin, OTH]) { await asAuthed(run, who); expect(await fails(run("select public.mg_wv_reply_mine($1,'pretending to be the reporter')", [id]))).toContain("FORBIDDEN"); }
      await asAuthed(run, SM);
      expect((await run("select body from public.worker_voice_messages"))[0].body).toBe("Adding that it happened again today.");
    });
  });
});

describe("4 · push for reviewers", () => {
  test("only reviewers with a live subscription are queued; the queue says who to wake and nothing about why", async () => {
    await world(async (run, c) => {
      await pushSub(run, SM, 1); await pushSub(run, XA, 2); await pushSub(run, WK, 3);
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run);
      await submitAnon(run, code, newCode(), { description: "Foreman Kollie shouted at the night shift about the gas alarm." });
      const rows = await owner(run, "select user_id, state from public.worker_voice_push_outbox order by user_id");
      expect(rows.map((r) => r.user_id).sort()).toEqual([SM, XA].sort());
      expect(rows.every((r) => r.state === "queued")).toBe(true);
      const cols = (await owner(run, "select column_name from information_schema.columns where table_name = 'worker_voice_push_outbox'")).map((x) => x.column_name);
      expect(cols.sort()).toEqual(["attempts", "created_at", "detail", "id", "state", "updated_at", "user_id"]);
      expect(JSON.stringify(await owner(run, "select * from public.worker_voice_push_outbox"))).not.toMatch(/Kollie|gas alarm|anonymous/);
    });
  });

  test("the dispatcher claims queued rows once, records outcomes, and expires stale ones; clients cannot touch it", async () => {
    await world(async (run, c) => {
      await pushSub(run, SM, 1);
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run); await submitAnon(run, code);
      for (const who of [SM, XA, f.admin]) { await asAuthed(run, who); expect(await fails(run("select * from public.mg_wv_push_claim(10)"))).toContain("permission denied"); }
      await asAnon(run);
      expect(await fails(run("select * from public.mg_wv_push_claim(10)"))).toContain("permission denied");
      await run("reset role"); await run("set local role service_role");
      const first = await run("select outbox_id, endpoint from public.mg_wv_push_claim(10)");
      expect(first.length).toBe(1);
      expect(first[0].endpoint).toBe("https://push.example.test/sub/1");
      expect((await run("select count(*)::int as n from public.mg_wv_push_claim(10)"))[0].n).toBe(0); // already claimed
      await run("select public.mg_wv_push_record($1,'sent','accepted',null)", [first[0].outbox_id]);
      expect((await owner(run, "select state from public.worker_voice_push_outbox"))[0].state).toBe("sent");
      await owner(run, "update public.worker_voice_push_outbox set state = 'queued', created_at = now() - interval '7 hours'");
      expect((await run("select count(*)::int as n from public.mg_wv_push_claim(10)"))[0].n).toBe(0);
      expect((await owner(run, "select state from public.worker_voice_push_outbox"))[0].state).toBe("expired");
    });
  });
});

describe("5 · small sites", () => {
  test("a site with fewer than 10 people assigned is flagged, warned about, and its times are coarsened to the DAY", async () => {
    await world(async (run, c) => {
      const code = await SITE_CODE_OK(run, c);
      expect(((await run("select public.mg_wv_site_info($1) as r", [code]))[0].r as any)).toBeTruthy();
      await asAnon(run);
      const info = (await run("select public.mg_wv_site_info($1) as r", [code]))[0].r as any;
      expect(info).toEqual({ valid: true, smallSite: true, paused: false });
      const r = await submitAnon(run, code, newCode(), { occurred: "2026-11-05T14:37:12Z" });
      expect(r.smallSite).toBe(true);
      await asAuthed(run, WK);
      expect((await run("select public.mg_wv_site_small($1) as s", [c.siteA]))[0].s).toBe(true);
      await submitMember(run, "named", c.siteA, newCode(), { occurred: "2026-11-05T14:37:12Z", description: "A named concern about the same site, written differently here." });
      await submitMember(run, "confidential", c.siteA, newCode(), { occurred: "2026-11-05T14:37:12Z", description: "A confidential concern about another hazard at the washing plant." });
      await asAuthed(run, XA);
      const rows = await run("select mode, small_site, to_char(created_at, 'HH24:MI:SS') as t, to_char(occurred_at at time zone 'UTC', 'HH24:MI:SS') as o from public.worker_voice_reports");
      for (const row of rows.filter((x) => x.mode !== "named")) { expect(row.small_site).toBe(true); expect(row.t).toBe("00:00:00"); expect(row.o).toBe("00:00:00"); }
      const named = rows.find((x) => x.mode === "named")!;
      expect(named.o).toBe("14:37:12"); // named reports keep what the person gave
      expect(named.t).not.toBe("00:00:00");
    });
  });

  test("a site above the threshold keeps the hourly rounding and is not flagged", async () => {
    await world(async (run, c) => {
      await owner(run, "create or replace function public.mg_wv_small_site_threshold() returns integer language sql immutable as $$ select 3 $$");
      const code = await SITE_CODE_OK(run, c);
      await asAnon(run);
      expect((await run("select public.mg_wv_site_info($1) as r", [code]))[0].r).toEqual({ valid: true, smallSite: false, paused: false });
      await submitAnon(run, code, newCode(), { occurred: "2026-11-05T14:37:12Z" });
      await asAuthed(run, XA);
      const row = (await run("select small_site, extract(hour from created_at)::int as h, extract(minute from created_at)::int as m, to_char(occurred_at at time zone 'UTC', 'HH24:MI:SS') as o from public.worker_voice_reports"))[0];
      expect(row.small_site).toBe(false); expect(row.m).toBe(0); expect(row.o).toBe("14:37:12");
    });
  });

  test("the site-info check is rate-limited like any code guess, and members only may ask about their own site", async () => {
    await world(async (run, c) => {
      await asAnon(run);
      await src(run, "198.51.100.120");
      for (let i = 0; i < 10; i++) expect((await run("select public.mg_wv_site_info('0000000000') as r"))[0].r).toEqual({ valid: false });
      expect(((await run("select public.mg_wv_site_info('0000000000') as r"))[0].r as any).status).toBe("rate_limited");
      await asAuthed(run, OTH);
      expect(await fails(run("select public.mg_wv_site_small($1)", [c.siteA]))).toContain("FORBIDDEN");
    });
  });
});
