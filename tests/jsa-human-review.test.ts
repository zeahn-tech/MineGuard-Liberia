// ---------------------------------------------------------------------------
// Migration 0043 — JSA with mandatory human review. Real Postgres (PGlite).
// Covers: who may prepare, who may review, distinct reviewer, confirmation word,
// frozen content, no AI approval path, cross-organization isolation, derived ai_assisted.
// ---------------------------------------------------------------------------
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company admin
const SM = "aaaaaaaa-0000-4000-8000-0000000000b1"; // AgriLib site manager (assigned siteA)
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // AgriLib worker (assigned siteA)
const OTH = "aaaaaaaa-0000-4000-8000-0000000000d1"; // other company's administrator

beforeAll(async () => { f = await getFixture(); });
beforeEach(async () => {
  const db = await getDb();
  for (const m of ["0040_emergency_alerts", "0041_emergency_authority_corrections", "0043_jsa_with_human_review"]) {
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

async function world<T>(fn: (run: Runner, c: { siteA: string; siteB: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email, raw_user_meta_data) values
      ('${XA}','xa@agrilib.test','{"name":"Xavier Admin"}'), ('${SM}','sm@agrilib.test','{"name":"Sia Manager"}'),
      ('${WK}','wk@agrilib.test','{"name":"Wale Worker"}'), ('${OTH}','oth@ore.test','{"name":"Olu Other"}')`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0]?.id as string | undefined;
    await run(`update public.sites set organization_id = '${orgA}' where id = '${f.siteA}'`);
    if (orgB) await run(`update public.sites set organization_id = '${orgB}' where id = '${f.siteB}'`);
    await run("set local role authenticated");
    const accept = async (uid: string, org: string, email: string, role: string | null) => {
      await as(run, role ? XA : f.admin); // roles below administrator are assigned by the company administrator
      const id = role
        ? (await run(`select public.mg_create_org_invitation('${org}', '${email}', '${role}') as id`))[0].id
        : (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${id}')`);
    };
    await accept(XA, orgA, "xa@agrilib.test", null);
    await accept(SM, orgA, "sm@agrilib.test", "site_manager");
    await accept(WK, orgA, "wk@agrilib.test", "worker");
    if (orgB) await accept(OTH, orgB, "oth@ore.test", null);
    await as(run, XA);
    for (const u of [SM, WK]) {
      const m = (await run(`select id from public.organization_members where user_id = '${u}'`))[0].id;
      await run(`select public.mg_assign_member_site('${m}', '${f.siteA}')`);
    }
    await as(run, f.admin);
    return fn(run, { siteA: f.siteA, siteB: f.siteB });
  });
}

const H = (extra: Record<string, unknown> = {}) => [{ hazard: "Fall from bench edge", risk_level: "high", control: "Barricade the edge", ...extra }];
let n = 0;
const save = (run: Runner, site: string, hazards: unknown = H(), id: string | null = null) =>
  run("select public.mg_jsa_save($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8) as id", [
    site, "Inspect the bench edge before drilling", "2026-11-07", JSON.stringify(hazards), JSON.stringify(["ref:ppe:hard-hat"]), `idem-key-${++n}-${Math.random()}`, "Pit 3", id,
  ]).then((r) => r[0].id as string);

describe("preparing", () => {
  test("a worker assigned to the site can prepare a draft; a stranger and another company cannot", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      expect(await save(run, c.siteA)).toBeTruthy();
      await as(run, OTH);
      expect(await fails(save(run, c.siteA))).toContain("FORBIDDEN");
      await as(run, f.national);
      expect(await fails(save(run, c.siteA))).toContain("FORBIDDEN");
      await run("select set_config('request.jwt.claims', '', true)");
      expect(await fails(save(run, c.siteA))).toContain("UNAUTHENTICATED");
    });
  });

  test("the same idempotency key returns the same JSA (no duplicates)", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      const args = [c.siteA, "Inspect the bench edge before drilling", "2026-11-07", JSON.stringify(H()), "[]", "fixed-idem-key", null, null];
      const a = (await run("select public.mg_jsa_save($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8) as id", args))[0].id;
      const b = (await run("select public.mg_jsa_save($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8) as id", args))[0].id;
      expect(b).toBe(a);
    });
  });

  test("hazards are validated: risk level, control text, size; bad input is refused", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      expect(await fails(save(run, c.siteA, [{ hazard: "x", risk_level: "severe", control: "y" }]))).toContain("INVALID");
      expect(await fails(save(run, c.siteA, [{ hazard: "x", risk_level: "low", control: "" }]))).toContain("INVALID");
      expect(await fails(save(run, c.siteA, Array.from({ length: 21 }, () => H()[0])))).toBeTruthy();
      expect(await fails(save(run, c.siteA, H({ source: "robot" })))).toContain("INVALID");
    });
  });

  test("ai_assisted is DERIVED from hazard sources and cannot be set directly", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      const person = await save(run, c.siteA, H({ source: "person" }));
      const ai = await save(run, c.siteA, H({ source: "ai_suggested" }));
      const rows = await owner(run, "select id, ai_assisted from public.job_safety_analyses where id in ($1,$2)", [person, ai]);
      expect(rows.find((r) => r.id === person)!.ai_assisted).toBe(false);
      expect(rows.find((r) => r.id === ai)!.ai_assisted).toBe(true);
      expect(await fails(run("update public.job_safety_analyses set ai_assisted = false where id = $1", [ai]))).toBeTruthy(); // no client UPDATE grant
    });
  });
});

describe("human review is mandatory", () => {
  const submitted = async (run: Runner, site: string, preparer = WK, hazards: unknown = H({ source: "ai_suggested" })) => {
    await as(run, preparer);
    const id = await save(run, site, hazards);
    await run("select public.mg_jsa_submit($1)", [id]);
    return id;
  };

  test("a draft cannot be approved; nothing can approve without APPROVE and a distinct reviewer", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      const id = await save(run, c.siteA);
      await as(run, SM);
      expect(await fails(run("select public.mg_jsa_review($1,'approve','APPROVE')", [id]))).toContain("CONFLICT");
      await as(run, WK);
      await run("select public.mg_jsa_submit($1)", [id]);
      await as(run, SM);
      expect(await fails(run("select public.mg_jsa_review($1,'approve',null)", [id]))).toContain("CONFIRMATION_REQUIRED");
      expect(await fails(run("select public.mg_jsa_review($1,'approve','yes')", [id]))).toContain("CONFIRMATION_REQUIRED");
      const ok = (await run("select public.mg_jsa_review($1,'approve','APPROVE') as r", [id]))[0].r;
      expect(ok.status).toBe("approved");
      const row = (await owner(run, "select reviewed_by, prepared_by from public.job_safety_analyses where id = $1", [id]))[0];
      expect(row.reviewed_by).toBe(SM);
      expect(row.reviewed_by).not.toBe(row.prepared_by);
    });
  });

  test("the preparer cannot review their own JSA, even as site manager or company admin", async () => {
    await world(async (run, c) => {
      const mine = await submitted(run, c.siteA, SM);
      await as(run, SM);
      expect(await fails(run("select public.mg_jsa_review($1,'approve','APPROVE')", [mine]))).toContain("cannot be reviewed by the person who prepared");
      const adminOwn = await submitted(run, c.siteA, XA);
      await as(run, XA);
      expect(await fails(run("select public.mg_jsa_review($1,'approve','APPROVE')", [adminOwn]))).toContain("cannot be reviewed by the person who prepared");
    });
  });

  test("workers, other companies and Ministry staff cannot approve", async () => {
    await world(async (run, c) => {
      const id = await submitted(run, c.siteA);
      for (const who of [WK, OTH, f.admin, f.national]) {
        await as(run, who);
        expect(await fails(run("select public.mg_jsa_review($1,'approve','APPROVE')", [id]))).toContain("FORBIDDEN");
      }
      const st = (await owner(run, "select status from public.job_safety_analyses where id = $1", [id]))[0].status;
      expect(st).toBe("submitted");
    });
  });

  test("the database refuses an approved row with no distinct reviewer, whatever code writes it", async () => {
    await world(async (run, c) => {
      const id = await submitted(run, c.siteA);
      await run("reset role");
      expect(await fails(run("update public.job_safety_analyses set status='approved' where id=$1", [id]))).toContain("jsa_approval_needs_distinct_reviewer");
      expect(await fails(run("update public.job_safety_analyses set status='approved', reviewed_by=prepared_by, reviewed_at=now() where id=$1", [id]))).toContain("jsa_approval_needs_distinct_reviewer");
    });
  });

  test("rejection needs a note; the preparer can revise, which clears the review and returns it to draft", async () => {
    await world(async (run, c) => {
      const id = await submitted(run, c.siteA);
      await as(run, SM);
      expect(await fails(run("select public.mg_jsa_review($1,'reject','REJECT',null)", [id]))).toContain("NOTE_REQUIRED");
      await run("select public.mg_jsa_review($1,'reject','REJECT','Add a rescue plan')", [id]);
      await as(run, WK);
      await save(run, c.siteA, H({ control: "Barricade and add rescue plan" }), id);
      const row = (await owner(run, "select status, reviewed_by from public.job_safety_analyses where id = $1", [id]))[0];
      expect(row.status).toBe("draft");
      expect(row.reviewed_by).toBeNull();
    });
  });

  test("submitted and approved JSAs are frozen; approved ones cannot be reopened", async () => {
    await world(async (run, c) => {
      const id = await submitted(run, c.siteA);
      await as(run, WK);
      expect(await fails(save(run, c.siteA, H(), id))).toContain("CONFLICT");
      await as(run, SM);
      await run("select public.mg_jsa_review($1,'approve','APPROVE')", [id]);
      await as(run, WK);
      expect(await fails(save(run, c.siteA, H(), id))).toContain("CONFLICT");
      await run("reset role");
      expect(await fails(run("update public.job_safety_analyses set task_description='changed after approval' where id=$1", [id]))).toContain("IMMUTABLE");
      expect(await fails(run("delete from public.job_safety_analyses where id=$1", [id]))).toContain("never deleted");
    });
  });

  test("an empty JSA cannot be submitted", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      const id = await save(run, c.siteA, []);
      expect(await fails(run("select public.mg_jsa_submit($1)", [id]))).toContain("at least one hazard");
    });
  });
});

describe("visibility and isolation", () => {
  test("a JSA is visible to its preparer, reviewers of that site and in-scope Ministry staff only", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      const id = await save(run, c.siteA);
      const visible = async (uid: string) => { await as(run, uid); return (await run("select id from public.job_safety_analyses where id = $1", [id])).length; };
      expect(await visible(WK)).toBe(1);
      expect(await visible(SM)).toBe(1);
      expect(await visible(XA)).toBe(1);
      expect(await visible(OTH)).toBe(0); // another company never sees it
    });
  });

  test("the site picker offers only sites the caller may prepare for", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      expect((await run("select id from public.mg_jsa_sites()")).map((r) => r.id)).toEqual([c.siteA]);
      await as(run, f.national);
      expect(await run("select id from public.mg_jsa_sites()")).toEqual([]);
    });
  });

  test("clients have no direct write access to the table", async () => {
    await world(async (run, c) => {
      await as(run, SM);
      expect(await fails(run("insert into public.job_safety_analyses (site_id, prepared_by, task_description, job_date, idempotency_key) values ($1,$2,'direct insert attempt','2026-11-07','direct-key-1')", [c.siteA, SM]))).toBeTruthy();
    });
  });

  test("every change is audited", async () => {
    await world(async (run, c) => {
      await as(run, WK);
      const id = await save(run, c.siteA);
      const audit = await owner(run, "select actor_id, action from public.audit_log where entity_type = 'job_safety_analyses' and entity_id = $1", [id]);
      expect(audit.length).toBeGreaterThan(0);
      expect(audit[0].actor_id).toBe(WK);
    });
  });
});
