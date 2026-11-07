// ---------------------------------------------------------------------------
// Migration 0037 — company profile editing and site registration requests.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const WK = "aaaaaaaa-0000-4000-8000-0000000000c1"; // AgriLib worker
const YA = "aaaaaaaa-0000-4000-8000-0000000000b1"; // OreCo company administrator
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
async function owner(run: Runner, sql: string) {
  const claims = String((await run("select coalesce(current_setting('request.jwt.claims', true), '') as c"))[0].c);
  await run("reset role");
  await run("select set_config('request.jwt.claims', '', true)");
  const rows = await run(sql);
  await run("select set_config('request.jwt.claims', $1, true)", [claims]);
  await run("set local role authenticated");
  return rows;
}

async function world<T>(fn: (run: Runner, c: { orgA: string; orgB: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email) values ('${XA}','xa@agrilib.test'), ('${YA}','ya@oreco.test'), ('${WK}','wk@agrilib.test'), ('${REG}','reg@ministry.test')`);
    await run(`update public.profiles set role = 'registrar', scope = 'national', profile_complete = true where id = '${REG}'`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    await run("set local role authenticated");
    for (const [org, uid, email] of [[orgA, XA, "xa@agrilib.test"], [orgB, YA, "ya@oreco.test"]] as const) {
      await as(run, f.admin);
      const inv = (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${inv}')`);
    }
    await as(run, XA);
    const w = (await run(`select public.mg_create_org_invitation('${orgA}', 'wk@agrilib.test', 'worker') as id`))[0].id;
    await as(run, WK);
    await run(`select public.mg_accept_invitation('${w}')`);
    await as(run, XA);
    return fn(run, { orgA, orgB });
  });
}

const REQ = (org: string, name = "Bomi North Pit") =>
  `select public.mg_request_site('${org}', '${name}', 'Bomi', 'Senjeh', 'Bomi Hills', 'Gold', 6.9, -10.9, 'near the river')`;

describe("company profile", () => {
  test("a company administrator maintains the contact details; the validation lives in the database", async () => {
    await world(async (run, { orgA }) => {
      await run(`select public.mg_update_company_profile('${orgA}', ' hello@agrilib.test ', '+231 77 000 0000', '1 Mine Road, Tubmanburg', 'https://agrilib.test', 'Iron ore operator')`);
      const o = (await run(`select contact_email, contact_phone, website, name, status from public.organizations where id = '${orgA}'`))[0];
      expect(o).toEqual({ contact_email: "hello@agrilib.test", contact_phone: "+231 77 000 0000", website: "https://agrilib.test", name: "AgriLib Mining", status: "approved" });
      expect(await fails(run(`select public.mg_update_company_profile('${orgA}', 'nope', null, null, null, null)`))).toMatch(/INVALID_EMAIL/);
      expect(await fails(run(`select public.mg_update_company_profile('${orgA}', null, 'call me', null, null, null)`))).toMatch(/INVALID_PHONE/);
      expect(await fails(run(`select public.mg_update_company_profile('${orgA}', null, null, null, 'javascript:alert(1)', null)`))).toMatch(/INVALID_WEBSITE/);
      expect(await fails(run(`select public.mg_update_company_profile('${orgA}', null, null, null, 'http://insecure.test', null)`))).toMatch(/INVALID_WEBSITE/);
      expect(await fails(run(`select public.mg_update_company_profile('${orgA}', null, null, '${"a".repeat(301)}', null, null)`))).toMatch(/INVALID_ADDRESS/);
      // clearing a field is allowed
      await run(`select public.mg_update_company_profile('${orgA}', null, null, null, null, null)`);
      expect((await run(`select contact_email from public.organizations where id = '${orgA}'`))[0].contact_email).toBeNull();
    });
  });

  test("the name and status can NOT be changed through the profile, and other people cannot edit it", async () => {
    await world(async (run, { orgA, orgB }) => {
      expect(await run(`update public.organizations set name = 'Renamed Ltd' where id = '${orgA}' returning id`)).toEqual([]);
      expect((await run(`select name from public.organizations where id = '${orgA}'`))[0].name).toBe("AgriLib Mining");
      expect(await run(`update public.organizations set status = 'approved' where id = '${orgA}' returning id`)).toEqual([]);
      expect(await fails(run(`select public.mg_update_company_profile('${orgB}', null, null, null, null, null)`))).toMatch(/FORBIDDEN/); // another company
      await as(run, WK);
      expect(await fails(run(`select public.mg_update_company_profile('${orgA}', 'a@b.cc', null, null, null, null)`))).toMatch(/FORBIDDEN/); // a worker
      await as(run, REG);
      expect(await fails(run(`select public.mg_update_company_profile('${orgA}', 'a@b.cc', null, null, null, null)`))).toMatch(/FORBIDDEN/); // the registrar
      await as(run, f.admin);
      await run(`select public.mg_update_company_profile('${orgA}', 'oversight@agrilib.test', null, null, null, null)`); // Ministry oversight
    });
  });

  test("a suspended company's administrator cannot edit; the change is audit-trailed", async () => {
    await world(async (run, { orgA }) => {
      await run(`select public.mg_update_company_profile('${orgA}', 'one@agrilib.test', null, null, null, null)`);
      const audit = await owner(run, `select action from public.audit_log where entity_type = 'organizations' and entity_id = '${orgA}' and actor_id = '${XA}'`);
      expect(audit.length).toBeGreaterThan(0);
      await as(run, f.admin);
      await run(`select public.mg_set_company_status('${orgA}', 'suspended', 'licence under review')`);
      await as(run, XA);
      expect(await fails(run(`select public.mg_update_company_profile('${orgA}', 'two@agrilib.test', null, null, null, null)`))).toMatch(/FORBIDDEN/);
    });
  });
});

describe("site registration requests", () => {
  test("only a company administrator of THAT company can ask; it is validated, retry-safe and capped", async () => {
    await world(async (run, { orgA, orgB }) => {
      const id = (await run(REQ(orgA)))[0].mg_request_site ?? Object.values((await run(REQ(orgA)))[0])[0];
      expect(Object.values((await run(REQ(orgA)))[0])[0]).toBe(id); // same request, not a duplicate
      expect((await owner(run, `select count(*)::int as n from public.site_registration_requests where organization_id = '${orgA}'`))[0].n).toBe(1);
      expect(await fails(run(REQ(orgB, "Other Pit")))).toMatch(/FORBIDDEN/); // another company
      expect(await fails(run(`select public.mg_request_site('${orgA}', 'x', 'Bomi', null, null, null, null, null, null)`))).toMatch(/INVALID_NAME/);
      expect(await fails(run(`select public.mg_request_site('${orgA}', 'Pit', 'Bomi', null, null, null, 95, 10, null)`))).toMatch(/INVALID_POSITION/);
      expect(await fails(run(`select public.mg_request_site('${orgA}', 'Pit', 'Bomi', null, null, null, 5, null, null)`))).toMatch(/INVALID_POSITION/);
      for (const uid of [WK, REG, f.opA, f.county]) {
        await as(run, uid);
        expect(await fails(run(REQ(orgA, "Sneaky Pit"))), String(uid)).toMatch(/FORBIDDEN/);
      }
      await as(run, XA);
      for (let i = 0; i < 19; i++) await run(REQ(orgA, `Pit ${i}`));
      expect(await fails(run(REQ(orgA, "One Too Many")))).toMatch(/TOO_MANY_PENDING/);
    });
  });

  test("the Ministry (and only the Ministry) sees and decides; approval needs the site to exist for that company", async () => {
    await world(async (run, { orgA, orgB }) => {
      const id = String(Object.values((await run(REQ(orgA)))[0])[0]);
      await as(run, YA);
      expect((await run("select id from public.site_registration_requests")).length).toBe(0); // another company cannot see it
      await as(run, REG);
      expect((await run("select id from public.site_registration_requests")).length).toBe(0); // the registrar neither
      for (const uid of [XA, WK, REG, f.opA]) {
        await as(run, uid);
        expect(await fails(run(`select public.mg_decide_site_request('${id}', 'rejected', 'no reason given here')`))).toMatch(/FORBIDDEN/);
      }
      await as(run, f.admin);
      expect((await run("select id from public.site_registration_requests")).length).toBe(1);
      expect(await fails(run(`select public.mg_decide_site_request('${id}', 'approved')`))).toMatch(/INVALID_SITE/);
      expect(await fails(run(`select public.mg_decide_site_request('${id}', 'rejected', 'no')`))).toMatch(/REASON_REQUIRED/);
      // a site of ANOTHER company cannot satisfy the request
      const siteB = (await run(`select id from public.sites where organization_id = '${orgB}' limit 1`))[0].id;
      expect(await fails(run(`select public.mg_decide_site_request('${id}', 'approved', null, '${siteB}')`))).toMatch(/INVALID_SITE/);
      // register the real site (as the Ministry does), then approve
      const site = (await run(`insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, created_by)
        values ('LB-BOM-777', 'Bomi North Pit', 'AgriLib Mining', 'Gold', 'Bomi', 'Senjeh', 'Bomi Hills', 'pending_verification', '${f.admin}') returning id`))[0].id;
      await run(`select public.mg_decide_site_request('${id}', 'approved', null, '${site}')`);
      expect(await fails(run(`select public.mg_decide_site_request('${id}', 'rejected', 'changed my mind')`))).toMatch(/REQUEST_NOT_PENDING/);
      const q = (await run(`select status, site_id, decided_by from public.site_registration_requests where id = '${id}'`))[0];
      expect(q).toEqual({ status: "approved", site_id: site, decided_by: f.admin });
    });
  });

  test("both sides are notified without sensitive detail; the company can cancel its own pending request", async () => {
    await world(async (run, { orgA }) => {
      const a = String(Object.values((await run(REQ(orgA)))[0])[0]);
      const b = String(Object.values((await run(REQ(orgA, "Second Pit")))[0])[0]);
      await run(`select public.mg_cancel_site_request('${b}')`);
      expect(await fails(run(`select public.mg_cancel_site_request('${b}')`))).toMatch(/REQUEST_NOT_PENDING/);
      await as(run, f.admin);
      const ministry = await run("select kind, title, link_to from public.notifications");
      expect(ministry.map((n) => [n.kind, n.link_to])).toContainEqual(["org_site_request", "/portal/site-requests"]);
      await run(`select public.mg_decide_site_request('${a}', 'rejected', 'coordinates are not inside Bomi')`);
      await as(run, XA);
      const company = await run("select kind, title, body, link_to from public.notifications where kind = 'org_site_request'");
      expect(company.map((n) => n.title)).toContain("Site request declined");
      expect(JSON.stringify(company)).not.toMatch(/@/);
      await as(run, WK); // a worker hears nothing about it
      expect((await run("select id from public.notifications where kind = 'org_site_request'")).length).toBe(0);
    });
  });

  test("clients cannot write the requests table directly", async () => {
    await world(async (run, { orgA }) => {
      expect(await fails(run(`insert into public.site_registration_requests (organization_id, requested_by, name, county) values ('${orgA}', '${XA}', 'Direct', 'Bomi')`))).toMatch(/permission denied/i);
      expect(await fails(run("update public.site_registration_requests set status = 'approved'"))).toMatch(/permission denied/i);
    });
  });
});

describe("screens (UI contracts; the database is the boundary)", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
  test("company profile: administrators edit, others read; name and status are never editable", () => {
    const s = read("src/pages/operate/OperatorCompany.tsx");
    expect(s).toContain('me.orgRole === "company_admin"');
    expect(s).toContain("managed by the Ministry");
    expect(s).not.toMatch(/<Input[^>]*value=\{profile\.name/);
    expect(read("src/main.tsx")).toContain('path="company"');
  });
  test("site requests: company administrators ask, only Ministry administrators decide, approval uses the normal site registration", () => {
    expect(read("src/pages/operate/OperatorSiteRequests.tsx")).toContain('me.orgRole !== "company_admin"');
    expect(read("src/pages/SiteRequests.tsx")).toContain('user.role !== "admin"');
    const b = read("src/lib/backend.ts");
    expect(b).toMatch(/approve: async \(request: SiteRequest\)[\s\S]{0,400}api\.sites\.create/);
    expect(read("src/pages/PortalLayout.tsx")).toContain('"/portal/site-requests"');
    expect(read("src/pages/operate/OperatorLayout.tsx")).toContain('"/operate/site-requests"');
  });
});
