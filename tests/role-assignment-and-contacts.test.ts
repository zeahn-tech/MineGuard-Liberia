// ---------------------------------------------------------------------------
// Migration 0044 — (1) role assignment is a company-administrator act; (2) the JSA
// review matrix by role (who submits, who approves, who does neither); (3) emergency
// contacts live in the database with scoped read/write. Real Postgres (PGlite).
// ---------------------------------------------------------------------------
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const SM = "aaaaaaaa-0000-4000-8000-0000000000b1"; // site manager (assigned siteA)
const SO = "aaaaaaaa-0000-4000-8000-0000000000b2"; // safety officer (assigned siteA)
const SO2 = "aaaaaaaa-0000-4000-8000-0000000000b3"; // safety officer, NOT assigned to any site
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // worker (assigned siteA)
const OO = "aaaaaaaa-0000-4000-8000-0000000000e1"; // onboarding officer
const NB = "aaaaaaaa-0000-4000-8000-0000000000f1"; // newcomer asking to join
const OTH = "aaaaaaaa-0000-4000-8000-0000000000d1"; // another company's administrator

beforeAll(async () => { f = await getFixture(); });
beforeEach(async () => {
  const db = await getDb();
  for (const m of ["0040_emergency_alerts", "0041_emergency_authority_corrections", "0043_jsa_with_human_review", "0044_role_assignment_and_emergency_contacts"]) {
    await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", `${m}.sql`), "utf8"));
  }
});

const as = (run: Runner, uid: string) => run(`select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true)`);
async function fails(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return String((e as Error).message); }
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

async function world<T>(fn: (run: Runner, c: { orgA: string; orgB: string; siteA: string; siteB: string; member: (u: string) => Promise<string> }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email, raw_user_meta_data) values
      ('${XA}','xa@agrilib.test','{"name":"Xavier Admin"}'), ('${SM}','sm@agrilib.test','{"name":"Sia Manager"}'),
      ('${SO}','so@agrilib.test','{"name":"Sam Safety"}'), ('${SO2}','so2@agrilib.test','{"name":"Sana Safety"}'),
      ('${WK}','wk@agrilib.test','{"name":"Wale Worker"}'), ('${OO}','oo@agrilib.test','{"name":"Ona Officer"}'),
      ('${NB}','nb@agrilib.test','{"name":"Nia Newcomer"}'), ('${OTH}','oth@ore.test','{"name":"Olu Other"}')`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    await run(`update public.sites set organization_id = '${orgA}' where id = '${f.siteA}'`);
    await run(`update public.sites set organization_id = '${orgB}' where id = '${f.siteB}'`);
    await run("set local role authenticated");
    const accept = async (uid: string, org: string, email: string, role: string | null) => {
      await as(run, role ? XA : f.admin);
      const id = role
        ? (await run(`select public.mg_create_org_invitation('${org}', '${email}', '${role}') as id`))[0].id
        : (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${id}')`);
    };
    await accept(XA, orgA, "xa@agrilib.test", null);
    await accept(SM, orgA, "sm@agrilib.test", "site_manager");
    await accept(SO, orgA, "so@agrilib.test", "safety_officer");
    await accept(SO2, orgA, "so2@agrilib.test", "safety_officer");
    await accept(WK, orgA, "wk@agrilib.test", "worker");
    await accept(OO, orgA, "oo@agrilib.test", "onboarding_officer");
    await accept(OTH, orgB, "oth@ore.test", null);
    await as(run, XA);
    const member = async (u: string) => (await owner(run, `select id from public.organization_members where user_id = '${u}'`))[0].id as string;
    for (const u of [SM, SO, WK]) await run(`select public.mg_assign_member_site('${await member(u)}', '${f.siteA}')`);
    await as(run, f.admin);
    return fn(run, { orgA, orgB, siteA: f.siteA, siteB: f.siteB, member });
  });
}

describe("role assignment is a company-administrator act", () => {
  const invite = (run: Runner, org: string, email: string, role: string) => run(`select public.mg_create_org_invitation('${org}', '${email}', '${role}') as id`);

  test("the company administrator can appoint every company role below administrator", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      for (const [i, role] of ["site_manager", "safety_officer", "worker", "onboarding_officer"].entries()) {
        expect((await invite(run, c.orgA, `new${i}@agrilib.test`, role))[0].id).toBeTruthy();
      }
    });
  });

  test("site managers, safety officers and workers cannot appoint anyone", async () => {
    await world(async (run, c) => {
      for (const who of [SM, SO, WK]) {
        await as(run, who);
        for (const role of ["site_manager", "safety_officer", "worker", "onboarding_officer"]) {
          expect(await fails(invite(run, c.orgA, `x-${role}@agrilib.test`, role))).toContain("FORBIDDEN");
        }
      }
    });
  });

  test("an onboarding officer may add workers only: never a safety officer, site manager or another officer", async () => {
    await world(async (run, c) => {
      await as(run, OO);
      expect((await invite(run, c.orgA, "w1@agrilib.test", "worker"))[0].id).toBeTruthy();
      for (const role of ["safety_officer", "site_manager", "onboarding_officer"]) {
        expect(await fails(invite(run, c.orgA, `o-${role}@agrilib.test`, role))).toContain("only a company administrator");
      }
    });
  });

  test("the Ministry's full admin cannot assign company roles (it still appoints the company administrator)", async () => {
    await world(async (run, c) => {
      await as(run, f.admin);
      for (const role of ["site_manager", "safety_officer", "worker", "onboarding_officer"]) {
        expect(await fails(invite(run, c.orgA, `m-${role}@agrilib.test`, role))).toContain("FORBIDDEN");
      }
      expect((await run(`select public.mg_create_company_admin_invitation('${c.orgA}', 'second-admin@agrilib.test') as id`))[0].id).toBeTruthy();
    });
  });

  test("another company's administrator cannot appoint into this company", async () => {
    await world(async (run, c) => {
      await as(run, OTH);
      expect(await fails(invite(run, c.orgA, "z@agrilib.test", "worker"))).toContain("FORBIDDEN");
    });
  });

  test("changing a member's role: company administrator only; never self, never an administrator", async () => {
    await world(async (run, c) => {
      const wk = await c.member(WK);
      await as(run, XA);
      await run(`select public.mg_set_member_role('${wk}', 'safety_officer')`);
      expect((await owner(run, `select org_role from public.organization_members where id = '${wk}'`))[0].org_role).toBe("safety_officer");
      for (const who of [SM, SO, WK, OO, f.admin, OTH]) {
        await as(run, who);
        expect(await fails(run(`select public.mg_set_member_role('${wk}', 'worker')`))).toContain("FORBIDDEN");
      }
      await as(run, XA);
      expect(await fails(run(`select public.mg_set_member_role('${await c.member(XA)}', 'worker')`))).toContain("FORBIDDEN");
      await as(run, XA);
      expect(await fails(run(`select public.mg_set_member_role('${wk}', 'company_admin')`))).toContain("INVALID_ROLE");
    });
  });

  test("approving a join request (which sets a role) is the company administrator's; the Ministry cannot", async () => {
    await world(async (run, c) => {
      await as(run, NB);
      const req = (await run(`select public.mg_request_membership('${c.orgA}') as id`))[0].id as string;
      for (const who of [SM, SO, OO, f.admin]) {
        await as(run, who);
        expect(await fails(run(`select public.mg_decide_membership_request('${req}', true, 'worker')`))).toContain("FORBIDDEN");
      }
      await as(run, XA);
      await run(`select public.mg_decide_membership_request('${req}', true, 'safety_officer')`);
      expect((await owner(run, `select org_role, status from public.organization_members where id = '${req}'`))[0]).toEqual({ org_role: "safety_officer", status: "active" });
    });
  });
});

describe("JSA: who submits and who approves", () => {
  const draft = async (run: Runner, site: string) =>
    (await run("select public.mg_jsa_save($1,'Inspect the bench edge before drilling','2026-11-07','[{\"hazard\":\"Fall\",\"risk_level\":\"high\",\"control\":\"Barricade\"}]'::jsonb,'[]'::jsonb,$2,null,null) as id", [site, `k-${Math.random()}`]))[0].id as string;
  const submitted = async (run: Runner, site: string, by: string) => { await as(run, by); const id = await draft(run, site); await run("select public.mg_jsa_submit($1)", [id]); return id; };
  const approve = (run: Runner, id: string) => run("select public.mg_jsa_review($1,'approve','APPROVE') as r", [id]);

  test("a worker prepares and submits but can never approve; a safety officer approves", async () => {
    await world(async (run, c) => {
      const id = await submitted(run, c.siteA, WK);
      await as(run, WK);
      expect(await fails(approve(run, id))).toContain("FORBIDDEN");
      await as(run, SO);
      expect((await approve(run, id))[0].r.status).toBe("approved");
    });
  });

  test("a site manager approves a worker's JSA, and a safety officer's JSA", async () => {
    await world(async (run, c) => {
      const a = await submitted(run, c.siteA, WK);
      const b = await submitted(run, c.siteA, SO);
      await as(run, SM);
      expect((await approve(run, a))[0].r.status).toBe("approved");
      expect((await approve(run, b))[0].r.status).toBe("approved");
    });
  });

  test("safety officers and site managers can submit their own JSA, but cannot approve it", async () => {
    await world(async (run, c) => {
      for (const who of [SO, SM]) {
        const id = await submitted(run, c.siteA, who);
        await as(run, who);
        expect(await fails(approve(run, id))).toContain("cannot be reviewed by the person who prepared");
      }
    });
  });

  test("the company administrator approves; a safety officer NOT assigned to the site cannot", async () => {
    await world(async (run, c) => {
      const id = await submitted(run, c.siteA, WK);
      await as(run, SO2);
      expect(await fails(approve(run, id))).toContain("FORBIDDEN");
      await as(run, XA);
      expect((await approve(run, id))[0].r.status).toBe("approved");
    });
  });

  test("an onboarding officer neither prepares nor approves; Ministry staff and other companies are read-only or out", async () => {
    await world(async (run, c) => {
      const id = await submitted(run, c.siteA, WK);
      await as(run, OO);
      expect(await fails(draft(run, c.siteA))).toContain("FORBIDDEN");
      for (const who of [OO, f.admin, f.national, OTH]) {
        await as(run, who);
        expect(await fails(approve(run, id))).toContain("FORBIDDEN");
      }
    });
  });
});

describe("emergency contacts", () => {
  const save = (run: Runner, org: string, site: string | null, name: string, phone = "+231 77 123 4567", label: string | null = "Site medic") =>
    run("select public.mg_emergency_contact_save($1,$2,$3,$4,$5) as id", [org, site, name, phone, label]).then((r) => r[0].id as string);
  const visible = async (run: Runner, who: string) => { await as(run, who); return (await run("select name from public.emergency_contacts order by name")).map((r) => r.name as string); };

  test("the company administrator adds company-wide and site contacts; they appear for the right people", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      await save(run, c.orgA, null, "Company hotline", "0800 123 456", "Head office");
      await save(run, c.orgA, c.siteA, "Pit 3 medic");
      expect(await visible(run, XA)).toEqual(["Company hotline", "Pit 3 medic"]);
      expect(await visible(run, WK)).toEqual(["Company hotline", "Pit 3 medic"]); // assigned to siteA
      expect(await visible(run, SO2)).toEqual(["Company hotline"]); // company-wide only: no site assignment
      expect(await visible(run, OTH)).toEqual([]); // another company never sees them
    });
  });

  test("an assigned site manager or safety officer maintains their own site's contacts only", async () => {
    await world(async (run, c) => {
      for (const who of [SM, SO]) {
        await as(run, who);
        expect(await save(run, c.orgA, c.siteA, `${who === SM ? "SM" : "SO"} contact`)).toBeTruthy();
        expect(await fails(save(run, c.orgA, null, "company-wide attempt"))).toContain("FORBIDDEN");
        expect(await fails(save(run, c.orgB, c.siteB, "other company attempt"))).toContain("FORBIDDEN");
        expect(await fails(save(run, c.orgA, c.siteB, "wrong-company site"))).toContain("FORBIDDEN");
      }
      await as(run, SO2); // safety officer with no site
      expect(await fails(save(run, c.orgA, c.siteA, "unassigned attempt"))).toContain("FORBIDDEN");
    });
  });

  test("workers, onboarding officers, Ministry staff and other companies cannot add or change contacts", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      const id = await save(run, c.orgA, c.siteA, "Pit 3 medic");
      for (const who of [WK, OO, f.admin, f.national, OTH]) {
        await as(run, who);
        expect(await fails(save(run, c.orgA, c.siteA, "x"))).toContain("FORBIDDEN");
        expect(await fails(run("select public.mg_emergency_contact_save($1,$2,$3,$4,null,100,true,$5)", [c.orgA, c.siteA, "renamed", "123 456", id]))).toContain("FORBIDDEN");
        expect(await fails(run("select public.mg_emergency_contact_remove($1)", [id]))).toContain("FORBIDDEN");
      }
      expect(await fails(run("insert into public.emergency_contacts (organization_id, name, phone) values ($1,'direct','123456')", [c.orgA]))).toBeTruthy();
    });
  });

  test("numbers are validated; names and notes are bounded", async () => {
    await world(async (run, c) => {
      await as(run, XA);
      for (const bad of ["abc", "12", "+231 77 <script>", "1".repeat(30), ""]) expect(await fails(save(run, c.orgA, null, "x", bad))).toBeTruthy();
      expect(await fails(save(run, c.orgA, null, "n".repeat(81)))).toBeTruthy();
      expect(await fails(save(run, c.orgA, null, "ok", "+231 77 123 4567", "l".repeat(61)))).toBeTruthy();
      expect(await save(run, c.orgA, null, "ok", "(0231) 77-123")).toBeTruthy();
    });
  });

  test("editing keeps the contact in its company and site; removal archives it for everyone but managers", async () => {
    await world(async (run, c) => {
      await as(run, SM);
      const id = await save(run, c.orgA, c.siteA, "Pit 3 medic");
      await run("select public.mg_emergency_contact_save($1,$2,$3,$4,null,100,true,$5)", [c.orgA, c.siteA, "Pit 3 paramedic", "0800 111 222", id]);
      expect((await owner(run, "select name, site_id from public.emergency_contacts where id = $1", [id]))[0]).toEqual({ name: "Pit 3 paramedic", site_id: c.siteA });
      await run("select public.mg_emergency_contact_remove($1)", [id]);
      expect(await visible(run, WK)).toEqual([]); // gone for workers
      expect(await visible(run, SM)).toEqual(["Pit 3 paramedic"]); // still listed for the manager, as removed
      expect((await owner(run, "select active from public.emergency_contacts where id = $1", [id]))[0].active).toBe(false);
    });
  });

  test("what each person may maintain: administrator = company + all sites; manager/officer = their site; others = nothing", async () => {
    await world(async (run, c) => {
      const scopes = async (who: string) => { await as(run, who); return (await run("select site_id from public.mg_emergency_contact_scopes() order by site_id nulls first")).map((r) => r.site_id as string | null); };
      expect(await scopes(XA)).toContain(null);
      expect(await scopes(XA)).toContain(c.siteA);
      expect(await scopes(SM)).toEqual([c.siteA]);
      expect(await scopes(SO)).toEqual([c.siteA]);
      for (const who of [WK, OO, SO2, f.admin, f.national]) expect(await scopes(who)).toEqual([]);
    });
  });

  test("every change is audited and nothing is seeded", async () => {
    await world(async (run, c) => {
      expect((await owner(run, "select count(*)::int as n from public.emergency_contacts"))[0].n).toBe(0);
      await as(run, XA);
      const id = await save(run, c.orgA, null, "Company hotline", "0800 123 456");
      await run("select public.mg_emergency_contact_remove($1)", [id]);
      const audit = await owner(run, "select actor_id, action from public.audit_log where entity_type = 'emergency_contacts' and entity_id = $1 order by created_at", [id]);
      expect(audit.length).toBe(2);
      expect(audit.every((a) => a.actor_id === XA)).toBe(true);
    });
  });
});
