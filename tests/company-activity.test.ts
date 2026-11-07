// ---------------------------------------------------------------------------
// Migration 0038 — activity history for companies and site managers.
// Curated and scoped by the database; never emails, ids or raw records.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const YA = "aaaaaaaa-0000-4000-8000-0000000000b1"; // OreCo company administrator
const SM = "aaaaaaaa-0000-4000-8000-0000000000d1"; // AgriLib site manager (assigned to site2)
const SM2 = "aaaaaaaa-0000-4000-8000-0000000000d2"; // AgriLib site manager (assigned to nothing)
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // worker
const OF = "aaaaaaaa-0000-4000-8000-0000000000f1"; // onboarding officer
const REG = "aaaaaaaa-0000-4000-8000-000000000091"; // registrar

beforeAll(async () => {
  f = await getFixture();
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
const ACT = (org: string, site: string | null = null, limit = 100) =>
  `select * from public.mg_company_activity('${org}', ${site ? `'${site}'` : "null"}, ${limit}, null, null)`;

async function world<T>(fn: (run: Runner, c: { orgA: string; orgB: string; siteA: string; site2: string; siteB: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email, raw_user_meta_data) values
      ('${XA}','xa@agrilib.test','{"name":"Xavier Admin"}'), ('${YA}','ya@oreco.test','{"name":"Yolanda Admin"}'),
      ('${SM}','sm@agrilib.test','{"name":"Sam Manager"}'), ('${SM2}','sm2@agrilib.test','{"name":"Sia Manager"}'),
      ('${WK}','wk@agrilib.test','{"name":"Wale Worker"}'), ('${OF}','of@agrilib.test','{"name":"Ola Officer"}'),
      ('${REG}','reg@ministry.test','{"name":"Rita Registrar"}')`);
    await run(`update public.profiles set role = 'registrar', scope = 'national', profile_complete = true where id = '${REG}'`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    const siteA = (await run("select id from public.sites where code = 'LB-BOM-001'"))[0].id as string;
    const siteB = (await run("select id from public.sites where code = 'LB-GCM-001'"))[0].id as string;
    const site2 = (await run(`insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude, created_by)
      values ('LB-BOM-002','Bomi North Pit','AgriLib Mining','Gold','Bomi','Senjeh','Bomi Hills','active',6.9,-10.9,'${f.admin}') returning id`))[0].id as string;
    await run("set local role authenticated");
    for (const [org, uid, email] of [[orgA, XA, "xa@agrilib.test"], [orgB, YA, "ya@oreco.test"]] as const) {
      await as(run, REG);
      const inv = (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${inv}')`);
    }
    await as(run, XA);
    for (const [uid, email, role] of [[SM, "sm@agrilib.test", "site_manager"], [SM2, "sm2@agrilib.test", "site_manager"], [WK, "wk@agrilib.test", "worker"], [OF, "of@agrilib.test", "onboarding_officer"]] as const) {
      const inv = (await run(`select public.mg_create_org_invitation('${orgA}', '${email}', '${role}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${inv}')`);
      await as(run, XA);
    }
    const mSm = (await run("reset role").then(() => run(`select id from public.organization_members where user_id = '${SM}'`)).then(async (r) => (await run("set local role authenticated"), r)))[0].id;
    await run(`select public.mg_assign_member_site('${mSm}', '${site2}')`);
    return fn(run, { orgA, orgB, siteA, site2, siteB });
  });
}

describe("company-wide history (company administrators)", () => {
  test("shows the company's own membership, invitation and assignment events, newest first, in plain words", async () => {
    await world(async (run, { orgA }) => {
      await as(run, XA);
      const rows = await run(ACT(orgA));
      const subjects = new Set(rows.map((r) => r.subject));
      for (const s of ["Membership", "Invitation", "Site assignment"]) expect(subjects.has(s), s).toBe(true);
      const sorted = [...rows].sort((a, b) => +new Date(b.at as string) - +new Date(a.at as string));
      expect(rows.map((r) => r.id)).toEqual(sorted.map((r) => r.id).slice(0, rows.length));
      expect(rows.some((r) => r.who === "Xavier Admin")).toBe(true);
      expect(rows.some((r) => String(r.detail).includes("role: site manager"))).toBe(true);
    });
  });

  test("nothing private leaks: no email address, no id, no raw record, no other company", async () => {
    await world(async (run, { orgA, orgB }) => {
      await as(run, XA);
      const rows = await run(ACT(orgA));
      const text = JSON.stringify(rows);
      expect(text).not.toMatch(/@/);                                  // no email addresses
      // what is SHOWN (everything except the entry's own row id) carries no record ids
      expect(JSON.stringify(rows.map(({ who, subject, what, detail }) => ({ who, subject, what, detail })))).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
      expect(Object.keys(rows[0]).sort()).toEqual(["at", "detail", "id", "subject", "what", "who"]);
      expect(text).not.toContain("OreCo");
      expect(text).not.toContain("Yolanda");
      await as(run, YA);
      expect(JSON.stringify(await run(ACT(orgB)))).not.toContain("AgriLib");
    });
  });

  test("Ministry actions appear as 'Ministry', never by name", async () => {
    await world(async (run, { orgA }) => {
      await as(run, REG);
      await run(`select public.mg_set_company_status('${orgA}', 'suspended', 'licence under review')`);
      await run(`select public.mg_set_company_status('${orgA}', 'approved')`);
      await as(run, XA);
      const rows = await run(ACT(orgA));
      const status = rows.filter((r) => r.subject === "Company" && String(r.detail).startsWith("status:"));
      expect(status.length).toBeGreaterThanOrEqual(2);
      expect(status.every((r) => r.who === "Ministry")).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("Rita");
      expect(JSON.stringify(rows)).not.toContain("licence under review"); // the reason is not copied into history
    });
  });

  test("pagination walks the history with a (time, id) cursor: no gaps, no repeats — even when many entries share one timestamp", async () => {
    await world(async (run, { orgA }) => {
      await as(run, XA);
      const all = await run(ACT(orgA, null, 100));
      expect(all.length).toBeGreaterThan(6);
      // inside this test everything was written in ONE transaction: every entry shares a timestamp
      expect(new Set(all.map((r) => String(r.at))).size).toBeLessThan(all.length);
      const seen: string[] = [];
      let cursor: { at: string; id: string } | null = null;
      for (let page = 0; page < 50; page++) {
        // The cursor travels as the server's own TEXT (microsecond precision), exactly as the
        // app keeps it; a JavaScript date would round to milliseconds and could miss rows.
        const rows: Record<string, unknown>[] = cursor
          ? await run(`select t.*, t.at::text as at_raw from public.mg_company_activity('${orgA}', null, 3, $1::timestamptz, $2::uuid) t`, [cursor.at, cursor.id])
          : await run(`select t.*, t.at::text as at_raw from public.mg_company_activity('${orgA}', null, 3, null, null) t`);
        if (rows.length === 0) break;
        for (const r of rows) seen.push(String(r.id));
        const last = rows[rows.length - 1];
        cursor = { at: String(last.at_raw), id: String(last.id) };
      }
      expect(seen.length).toBe(all.length);                       // nothing skipped
      expect(new Set(seen).size).toBe(seen.length);               // nothing repeated
      expect([...seen].sort()).toEqual(all.map((r) => String(r.id)).sort());
      expect((await run(`select * from public.mg_company_activity('${orgA}', null, 100000, null, null)`)).length).toBeLessThanOrEqual(100); // server caps the page
    });
  });
});

describe("site history (site managers)", () => {
  test("a site manager sees ONLY their assigned site, never membership or invitation history", async () => {
    await world(async (run, { orgA, site2, siteA }) => {
      await as(run, SM);
      const rows = await run(ACT(orgA, site2));
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.subject))).toEqual(new Set(["Site", "Site assignment"]));
      expect(await fails(run(ACT(orgA, siteA)))).toMatch(/FORBIDDEN/); // the company's other site
      expect(await fails(run(ACT(orgA)))).toMatch(/FORBIDDEN/);        // company-wide
      await as(run, SM2);
      expect(await fails(run(ACT(orgA, site2)))).toMatch(/FORBIDDEN/); // a site manager with no assignment
    });
  });

  test("the company administrator can read any site of their company; another company's administrator cannot", async () => {
    await world(async (run, { orgA, site2, siteB }) => {
      await as(run, XA);
      expect((await run(ACT(orgA, site2))).length).toBeGreaterThan(0);
      expect(await fails(run(ACT(orgA, siteB)))).toMatch(/FORBIDDEN/); // a site of another company
      await as(run, YA);
      expect(await fails(run(ACT(orgA, site2)))).toMatch(/FORBIDDEN/);
    });
  });

  test("safety records at the site appear in its history (so the site manager can follow them)", async () => {
    await world(async (run, { orgA, site2 }) => {
      await run("reset role");
      const insp = (await run("select id from public.inspections limit 1"))[0].id;
      await run(`insert into public.findings (inspection_id, site_id, title, severity, created_by_id) values ('${insp}', '${site2}', 'Loose bench edge', 'high', '${f.admin}')`);
      await run("set local role authenticated");
      await as(run, SM);
      expect((await run(ACT(orgA, site2))).map((r) => r.subject)).toContain("Finding");
    });
  });
});

describe("who may read any of it", () => {
  test("workers, onboarding officers, the registrar, outsiders and staff without company authority are refused", async () => {
    await world(async (run, { orgA, site2 }) => {
      for (const uid of [WK, OF, REG, f.opB, f.guest]) {
        await as(run, uid);
        expect(await fails(run(ACT(orgA))), String(uid)).toMatch(/FORBIDDEN/);
        expect(await fails(run(ACT(orgA, site2))), String(uid)).toMatch(/FORBIDDEN/);
      }
    });
  });

  test("a suspended company's own administrators are paused; the Ministry can still read it", async () => {
    await world(async (run, { orgA }) => {
      await as(run, REG);
      await run(`select public.mg_set_company_status('${orgA}', 'suspended', 'licence under review')`);
      await as(run, XA);
      expect(await fails(run(ACT(orgA)))).toMatch(/FORBIDDEN/);
      await as(run, f.admin);
      expect((await run(ACT(orgA))).length).toBeGreaterThan(0);
    });
  });

  test("the raw audit trail stays closed to companies", async () => {
    await world(async (run) => {
      await as(run, XA);
      expect((await run("select id from public.audit_log")).length).toBe(0);
      await as(run, SM);
      expect((await run("select id from public.audit_log")).length).toBe(0);
    });
  });
});

describe("screens (UI contracts; the database is the boundary)", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
  test("the history pages with the server's raw (time, id) cursor, never a JavaScript date", () => {
    const b = read("src/lib/backend.ts");
    expect(b).toContain("p_before_id: args.before?.id");
    expect(b).toContain("atRaw: r.at as string");
    expect(read("src/components/ActivityFeed.tsx")).toContain("api.activity.page");
  });
  test("company Activity is for company administrators; the Site activity card is for administrators and site managers only", () => {
    expect(read("src/pages/operate/OperatorActivity.tsx")).toContain('me.orgRole !== "company_admin"');
    const sites = read("src/pages/operate/OperatorSites.tsx");
    expect(sites).toMatch(/me\.orgRole === "company_admin" \|\| me\.orgRole === "site_manager"[\s\S]{0,900}<ActivityFeed/);
    expect(read("src/pages/operate/OperatorLayout.tsx")).toMatch(/"\/operate\/activity"[^}]*adminOnly: true/);
  });
});
