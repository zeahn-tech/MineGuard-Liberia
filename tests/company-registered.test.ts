// ---------------------------------------------------------------------------
// Migration 0033 — a company must be REGISTERED, never typed into existence.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asUser, getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", "0033_companies_are_registered_not_typed.sql"), "utf8"));
});

async function fails(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}
const insertSite = (run: Runner, code: string, operator: string) =>
  run(
    `insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude, created_by)
     values ('${code}', 'Probe ${code}', '${operator}', 'Gold', 'Bomi', 'Senjeh', 'Probe Hills', 'active', 6.9, -10.9, '${f.admin}') returning id`,
  );
const orgCount = async (run: Runner) => Number((await run("select count(*)::int as n from public.organizations"))[0].n);

describe("registering a site", () => {
  test("a name that matches no registered company is refused and creates NOTHING", async () => {
    await asUser(f.admin, async (run) => {
      expect(await fails(insertSite(run, "T-001", "Arcelor Mittal Liberia"))).toMatch(/UNKNOWN_COMPANY/);
    });
    await asUser(f.admin, async (run) => {
      const before = await orgCount(run);
      await fails(insertSite(run, "T-002", "AgriLib Minning")); // a typo of a real company
      expect(await orgCount(run)).toBe(before);
    });
  });

  test("a registered company matches regardless of capitals and stray spaces, and the site is linked to it", async () => {
    await asUser(f.admin, async (run) => {
      const id = (await insertSite(run, "T-003", "  agrilib MINING "))[0].id;
      const row = (await run(`select s.operator_name, o.name from public.sites s join public.organizations o on o.id = s.organization_id where s.id = '${id}'`))[0];
      expect(row).toEqual({ operator_name: "AgriLib Mining", name: "AgriLib Mining" });
    });
  });

  test("a company that is not approved cannot receive a NEW site; its existing sites stay editable", async () => {
    await asUser(f.admin, async (run) => {
      const org = (await run("select public.mg_register_company('Pending Co') as id"))[0].id as string;
      await run(`select public.mg_set_company_status('${org}', 'pending_review')`);
      expect(await fails(insertSite(run, "T-004", "Pending Co"))).toMatch(/COMPANY_NOT_APPROVED/);
      await run(`select public.mg_set_company_status('${org}', 'approved')`);
      const id = (await insertSite(run, "T-005", "Pending Co"))[0].id;
      await run(`select public.mg_set_company_status('${org}', 'suspended', 'licence under review')`);
      // changing something other than the company link is not blocked by the company's status
      expect((await run(`update public.sites set community = 'Renamed Hills' where id = '${id}' returning id`)).length).toBe(1);
    });
  });
});

describe("assigning an operator role", () => {
  test("the admin dialog cannot mint a company by typing a name either", async () => {
    await withRole("postgres", null, async (run) => {
      await run("set local role authenticated");
      await run(`select set_config('request.jwt.claims', '{"sub":"${f.admin}","role":"authenticated"}', true)`);
      const before = await orgCount(run);
      expect(await fails(run("select public.provision_user_by_email('frank@guest.test','operator','operator',null,'Typed Into Existence Ltd')"))).toMatch(/UNKNOWN_COMPANY/);
      expect(await orgCount(run)).toBe(before);
      await run("select public.provision_user_by_email('frank@guest.test','operator','operator',null,'OreCo Liberia')"); // a registered one works
    });
  });
});

describe("owner-run maintenance keeps its historical behaviour", () => {
  test("SQL-editor / seed contexts (no signed-in user) can still create a company from a name", async () => {
    await withRole("postgres", null, async (run) => {
      const id = (await run("select public.mg_resolve_organization('Seeded By Owner Ltd') as id"))[0].id;
      expect(id).toBeTruthy();
    });
  });
});

describe("screens: Mining sites ↔ Companies (UI contracts; the database is the boundary)", () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");
  test("Register site chooses from registered companies — there is no free-text company box", () => {
    const s = read("src/pages/Sites.tsx");
    expect(s).toContain("api.companies.approvedOptions");
    expect(s).not.toContain('placeholder="Exact operator name"');
    expect(s).toMatch(/Register it first/);
  });
  test("Mining sites filters by company and links the company name to its detail page (admins)", () => {
    const s = read("src/pages/Sites.tsx");
    expect(s).toContain('params.get("company")');
    expect(s).toContain("/portal/companies/${s.organizationId}");
    expect(s).toMatch(/>Company<\/th>/);
  });
  test("the company detail page is admin-only, reuses the company card, and lists the company's sites", () => {
    const d = read("src/pages/CompanyDetail.tsx");
    expect(d).toContain('user.role !== "admin"');
    expect(d).toContain("<CompanyCard company={company} />");
    expect(d).toContain("s.organizationId === company.id");
    const m = read("src/main.tsx");
    expect(m).toContain('path="companies/:companyId"');
  });
  test("the registry (registrar) cards link nowhere: they have no site access", () => {
    expect(read("src/pages/Companies.tsx")).toContain('user.role === "admin" ? `/portal/companies/${c.id}` : undefined');
  });
});
