// ---------------------------------------------------------------------------
// Dedicated Ministry role: the Company registrar (migrations 0030 + 0031).
// It authorizes companies and nothing else: no safety records, no accounts, no
// workforce data. Every case rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const REG = "aaaaaaaa-0000-4000-8000-000000000091";
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1";
const NEWADMIN = "aaaaaaaa-0000-4000-8000-0000000000a2";
const ROOT = join(import.meta.dir, "..");

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of [
    "0024_self_service_tenant_lockdown.sql",
    "0025_company_status_membership_invitations.sql",
    "0026_company_workforce.sql",
    "0027_site_scoped_access.sql",
    "0028_account_names_invitation_cleanup.sql",
    "0029_onboarding_officer_bulk_import.sql",
    "0030_registrar_role_value.sql",
    "0031_company_registrar.sql", "0032_government_roles_hold_no_company.sql", "0033_companies_are_registered_not_typed.sql",
  ]) await db.exec(readFileSync(join(ROOT, "supabase", "migrations", m), "utf8"));
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

/** A registrar (REG) and a company administrator (XA of AgriLib). Session starts as REG. */
async function world<T>(fn: (run: Runner, c: { orgA: string; orgB: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(`insert into auth.users (id, email) values ('${REG}','registrar@ministry.test'), ('${XA}','xa@agrilib.test'), ('${NEWADMIN}','newadmin@x.test')`);
    await run(`update public.profiles set role = 'registrar', scope = 'national', profile_complete = true where id = '${REG}'`);
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    await run("set local role authenticated");
    await as(run, REG);
    const inv = (await run(`select public.mg_create_company_admin_invitation('${orgA}', 'xa@agrilib.test') as id`))[0].id;
    await as(run, XA);
    await run(`select public.mg_accept_invitation('${inv}')`);
    await as(run, REG);
    return fn(run, { orgA, orgB });
  });
}

describe("the registrar's permissions are exactly what the role is for", () => {
  test("the matrix: registrar holds ONLY organizations.write; workforce oversight is the admin's own", async () => {
    await withRole("postgres", null, async (run) => {
      const reg = await run("select permission from public.permissions where role = 'registrar' order by 1");
      expect(reg).toEqual([{ permission: "organizations.write" }]);
      const adm = (await run("select permission from public.permissions where role = 'admin'")).map((r) => r.permission);
      expect(adm).toContain("workforce.oversee");
      expect(adm).toContain("organizations.write");
    });
  });

  test("only a full admin can assign the role; an ordinary account cannot make itself or anyone a registrar", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${NEWADMIN}','newadmin@x.test')`);
      await run("set local role authenticated");
      await as(run, f.admin);
      await run("select public.provision_user_by_email('newadmin@x.test','registrar','national')");
      expect((await run(`select role from public.profiles where id = '${NEWADMIN}'`))[0].role).toBe("registrar");
      for (const uid of [f.opA, f.county, f.guest, NEWADMIN]) {
        await as(run, uid);
        expect(await fails(run("select public.provision_user_by_email('x@y.zz','registrar','national')"))).toMatch(/FORBIDDEN/);
        // nobody can promote themselves — to registrar, or beyond it
        expect(await fails(run("update public.profiles set role = 'admin' where id = auth.uid()"))).toMatch(/FORBIDDEN|permission|violat/i);
        if (uid !== NEWADMIN) {
          expect(await fails(run("update public.profiles set role = 'registrar' where id = auth.uid()"))).toMatch(/FORBIDDEN|permission|violat/i);
        }
      }
    });
  });
});

describe("what a registrar can do", () => {
  test("register + approve a company, nominate its first administrator, resend and revoke, suspend and reactivate", async () => {
    await world(async (run, { orgA }) => {
      const org = (await run("select public.mg_register_company('Atlas Iron Liberia') as id"))[0].id as string;
      const inv = (await run(`select public.mg_create_company_admin_invitation('${org}', 'boss@atlas.test') as id`))[0].id as string;
      expect((await run(`select public.mg_prepare_invitation_send('${inv}') as r`))[0].r).toMatchObject({ email: "boss@atlas.test" });
      await run(`select public.mg_release_invitation_send('${inv}')`);
      await run(`select public.mg_revoke_invitation('${inv}')`);
      expect(await fails(run(`select public.mg_set_company_status('${orgA}', 'suspended', 'no')`))).toMatch(/REASON_REQUIRED/);
      const statusOf = async () =>
        ((await run("select public.mg_company_directory() as d"))[0].d as Array<{ id: string; status: string }>).find((c) => c.id === orgA)!.status;
      await run(`select public.mg_set_company_status('${orgA}', 'suspended', 'licence under review')`);
      expect(await statusOf()).toBe("suspended");
      await run(`select public.mg_set_company_status('${orgA}', 'approved')`);
      expect(await statusOf()).toBe("approved");
      // the new company shows up in the directory, with its (revoked) invitation
      const d = (await run("select public.mg_company_directory() as d"))[0].d as Array<{ id: string; invitations: Array<{ status: string }> }>;
      expect(d.find((c) => c.id === org)!.invitations.map((i) => i.status)).toEqual(["revoked"]);
    });
  });

  test("the directory shows companies, their administrators and invitations — and only COUNTS for everyone else", async () => {
    await world(async (run, { orgA }) => {
      const dir = (await run("select public.mg_company_directory() as d"))[0].d as Array<Record<string, unknown>>;
      const a = dir.find((c) => c.id === orgA)!;
      expect(a.name).toBe("AgriLib Mining");
      expect((a.admins as Array<{ email: string }>).map((x) => x.email)).toEqual(["xa@agrilib.test"]);
      expect(Number(a.activeMembers)).toBeGreaterThanOrEqual(2); // counted, not listed
      expect(Number(a.siteCount)).toBeGreaterThanOrEqual(1);
      const text = JSON.stringify(dir);
      // no worker identity leaks into the directory
      const workers = await run(`select email from public.profiles where id in ('${f.opA}', '${f.opB}')`).catch(() => []);
      void workers;
      expect(text).not.toContain("bob@");
      expect(Object.keys(a).sort()).toEqual(["activeMembers", "admins", "id", "invitations", "name", "pendingRequests", "siteCount", "status", "statusReason"]);
    });
  });
});

describe("what a registrar cannot do", () => {
  test("no site, incident, inspection, finding, corrective action, audit or other-people data", async () => {
    await world(async (run) => {
      for (const t of ["sites", "incidents", "inspections", "findings", "corrective_actions", "audit_log", "observations"]) {
        const rows = await run(`select * from public.${t}`).catch(() => []);
        expect(rows.length, t).toBe(0);
      }
      expect((await run("select id from public.profiles")).map((r) => r.id)).toEqual([REG]); // only their own profile
      expect((await run("select id from public.organization_members")).length).toBe(0);
      expect((await run("select id from public.organization_invitations")).length).toBe(0);
    });
  });

  test("no workforce power over ANY company: list, requests, roles, removal, sites, invitations, imports", async () => {
    await world(async (run, { orgA }) => {
      const mem = await run("reset role").then(() => run(`select id from public.organization_members where user_id = '${XA}'`)).then(async (r) => (await run("set local role authenticated"), r));
      const mXa = mem[0].id as string;
      const site = await run("reset role").then(() => run("select id from public.sites limit 1")).then(async (r) => (await run("set local role authenticated"), r));
      for (const sql of [
        `select * from public.mg_company_workforce('${orgA}')`,
        `select public.mg_create_org_invitation('${orgA}', 'w@x.test', 'worker')`,
        `select public.mg_create_org_invitation('${orgA}', 'w@x.test', 'onboarding_officer')`,
        `select public.mg_set_member_role('${mXa}', 'worker')`,
        `select public.mg_revoke_member('${mXa}')`,
        `select public.mg_decide_membership_request('${mXa}', true, 'worker')`,
        `select public.mg_assign_member_site('${mXa}', '${site[0].id}')`,
        `select * from public.mg_site_roster('${site[0].id}')`,
        `select public.mg_import_start('${orgA}', gen_random_uuid(), 'x.csv', 1)`,
        `select public.mg_import_check('${orgA}', '[]'::jsonb)`,
      ]) expect(await fails(run(sql)), sql).toMatch(/FORBIDDEN/);
    });
  });

  test("no platform administration: roles, accounts, templates, boundaries", async () => {
    await world(async (run) => {
      expect(await fails(run("select public.provision_user_by_email('x@y.zz','admin','national')"))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`update public.profiles set role = 'admin' where id = auth.uid()`))).toMatch(/FORBIDDEN|permission|violat/i);
      expect(await fails(run(`insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude) values ('X','x','AgriLib Mining','Gold','Bomi','Senjeh','c','active',1,1)`))).toMatch(/FORBIDDEN|row-level|permission|violat/i);
    });
  });

  test("a registrar can never be turned into a company user, whichever route is tried", async () => {
    await world(async (run, { orgA }) => {
      await as(run, XA);
      expect(await fails(run(`select public.mg_create_org_invitation('${orgA}', 'registrar@ministry.test', 'worker')`))).toMatch(/INELIGIBLE/);
      await as(run, REG);
      expect(await fails(run(`select public.mg_request_membership('${orgA}')`))).toMatch(/INELIGIBLE/);
      // an invitation that existed BEFORE they became a registrar still cannot be accepted
      await run("reset role");
      await run(`update public.profiles set role = null where id = '${REG}'`);
      await run("set local role authenticated");
      await as(run, XA);
      const inv = (await run(`select public.mg_create_org_invitation('${orgA}', 'registrar@ministry.test', 'worker') as id`))[0].id;
      await run("reset role");
      await run(`update public.profiles set role = 'registrar' where id = '${REG}'`);
      await run("set local role authenticated");
      await as(run, REG);
      expect(await fails(run(`select public.mg_accept_invitation('${inv}')`))).toMatch(/INELIGIBLE/);
      expect((await run("select role from public.profiles where id = auth.uid()"))[0].role).toBe("registrar");
    });
  });

  test("the company's own administrators lose nothing: admin oversight and company admin powers are unchanged", async () => {
    await world(async (run, { orgA }) => {
      await as(run, XA);
      expect((await run(`select * from public.mg_company_workforce('${orgA}')`)).length).toBeGreaterThan(0);
      await as(run, f.admin);
      expect((await run(`select * from public.mg_company_workforce('${orgA}')`)).length).toBeGreaterThan(0);
      expect((await run("select public.mg_company_directory() as d"))[0].d).toBeTruthy();
    });
  });
});

describe("registrar UI contracts (routing only; the database is the boundary)", () => {
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  test("sign-in lands a registrar in /registry; staff and operator gates send them there too", () => {
    expect(read("src/pages/Auth.tsx")).toContain('if (role === "registrar") return "/registry";');
    const g = read("src/components/RequireAuth.tsx");
    expect((g.match(/Navigate to="\/registry"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(g).toContain("export function RequireRegistrar");
  });
  test("/registry renders the Companies screen only, behind RequireRegistrar", () => {
    const m = read("src/main.tsx");
    expect(m).toMatch(/path="\/registry"[\s\S]{0,200}RequireRegistrar[\s\S]{0,200}RegistryLayout/);
    expect(m).toMatch(/<Route index element=\{<Companies \/>\} \/>/);
  });
  test("the Companies screen admits exactly admin and registrar", () => {
    const c = read("src/pages/Companies.tsx");
    expect(c).toContain('user.role !== "admin" && user.role !== "registrar"');
  });
  test("the client never lists workers for the registry: the directory returns counts", () => {
    const b = read("src/lib/backend.ts");
    expect(b).toContain('supabase.rpc("mg_company_directory")');
    expect(b).toContain("requireCompanyAuthority");
  });
});

describe("government roles never hold a company (0032) and the Assign-role dialog", () => {
  test("provisioning a registrar always yields national scope with no county, area or company", async () => {
    await withRole("postgres", null, async (run) => {
      await run(`insert into auth.users (id, email) values ('${NEWADMIN}','newadmin@x.test')`);
      await run("set local role authenticated");
      await as(run, f.admin);
      await run("select public.provision_user_by_email('newadmin@x.test','registrar','county','Bomi','AgriLib Mining')");
      expect((await run(`select role, scope, county, operator_name, organization_id from public.profiles where id = '${NEWADMIN}'`))[0]).toEqual({
        role: "registrar", scope: "national", county: null, operator_name: null, organization_id: null,
      });
    });
  });

  test("making a company administrator a registrar removes every company power in the same step", async () => {
    await world(async (run, { orgA }) => {
      await as(run, XA);
      expect((await run(`select * from public.mg_company_workforce('${orgA}')`)).length).toBeGreaterThan(0); // before
      expect((await run("select id from public.sites")).length).toBeGreaterThan(0);
      await as(run, f.admin);
      await run("select public.provision_user_by_email('xa@agrilib.test','registrar','national')");
      await as(run, XA);
      expect((await run("select role, organization_id from public.profiles where id = auth.uid()"))[0]).toEqual({ role: "registrar", organization_id: null });
      expect(await fails(run(`select * from public.mg_company_workforce('${orgA}')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_create_org_invitation('${orgA}', 'w@x.test', 'worker')`))).toMatch(/FORBIDDEN/);
      expect((await run("select id from public.sites")).length).toBe(0);
      await run("reset role");
      expect((await run(`select status from public.organization_members where user_id = '${XA}'`))).toEqual([{ status: "revoked" }]);
    });
  });

  test("the same holds for a direct update and for the owner-run script path", async () => {
    await world(async (run, { orgA }) => {
      await run("reset role");
      await run(`update public.profiles set role = 'registrar' where id = '${XA}'`); // SQL-editor style, no session
      expect(await run(`select status from public.organization_members where user_id = '${XA}'`)).toEqual([{ status: "revoked" }]);
      expect((await run(`select organization_id, scope from public.profiles where id = '${XA}'`))[0]).toEqual({ organization_id: null, scope: "national" });
      void orgA;
    });
  });

  test("re-provisioning someone as the SAME government role does not wipe their staff site assignments", async () => {
    await withRole("postgres", null, async (run) => {
      await run("set local role authenticated");
      await as(run, f.admin);
      await run("select public.provision_user_by_email('frank@guest.test','inspector','national')");
      const site = (await run("select id from public.sites limit 1"))[0].id;
      await run("reset role");
      const uid = (await run("select id from public.profiles where email = 'frank@guest.test'"))[0].id;
      await run(`insert into public.site_assignments (user_id, site_id) values ('${uid}', '${site}')`);
      await run("set local role authenticated");
      await as(run, f.admin);
      await run("select public.provision_user_by_email('frank@guest.test','inspector','county','Bomi')");
      await run("reset role");
      expect(await run(`select revoked_at from public.site_assignments where user_id = '${uid}'`)).toEqual([{ revoked_at: null }]);
    });
  });

  test("the Assign platform role dialog offers Company registrar with the scope locked to national", () => {
    const d = readFileSync(join(ROOT, "src/pages/PortalLayout.tsx"), "utf8");
    expect(d).toContain('<SelectItem value="registrar">Company registrar</SelectItem>');
    expect(d).toContain('targetRole === "registrar" ? "national" : targetScope');
    expect(d).toContain('disabled={targetRole === "registrar"}');
  });
});
