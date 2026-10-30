// ---------------------------------------------------------------------------
// Phase E — onboarding officer + bulk workforce import (migration 0029).
// Boundaries under test: an onboarding officer can ONLY bring people in; an
// import can ONLY create pending invitations for worker / safety_officer; every
// row is validated by the database; retries never duplicate; nothing crosses
// company lines. Every case rolls back.
// ---------------------------------------------------------------------------
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, getFixture, withRole, type Runner } from "./helpers/pglite-db";

let f: Awaited<ReturnType<typeof getFixture>>;
const XA = "aaaaaaaa-0000-4000-8000-0000000000a1"; // AgriLib company administrator
const YA = "aaaaaaaa-0000-4000-8000-0000000000b1"; // OreCo company administrator
const OF = "aaaaaaaa-0000-4000-8000-0000000000f1"; // AgriLib onboarding officer
const P1 = "aaaaaaaa-0000-4000-8000-0000000000e1"; // outsider who gets imported
const KEY = "bbbbbbbb-0000-4000-8000-0000000000aa";

beforeAll(async () => {
  f = await getFixture();
  const db = await getDb();
  for (const m of [
    "0024_self_service_tenant_lockdown.sql",
    "0025_company_status_membership_invitations.sql",
    "0026_company_workforce.sql",
    "0027_site_scoped_access.sql",
    "0028_account_names_invitation_cleanup.sql",
    "0029_onboarding_officer_bulk_import.sql", "0030_registrar_role_value.sql", "0031_company_registrar.sql", "0032_government_roles_hold_no_company.sql", "0033_companies_are_registered_not_typed.sql",
  ]) await db.exec(readFileSync(join(import.meta.dir, "..", "supabase", "migrations", m), "utf8"));
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
  await run("reset role");
  const rows = await run(sql);
  await run("set local role authenticated");
  return rows;
}
const rowsJson = (rows: Record<string, unknown>[]) => JSON.stringify(rows).replace(/'/g, "''");

async function world<T>(fn: (run: Runner, c: { orgA: string; orgB: string; site2: string }) => Promise<T>) {
  return withRole("postgres", null, async (run) => {
    await run(
      `insert into auth.users (id, email) values
        ('${XA}','xa@agrilib.test'), ('${YA}','ya@oreco.test'), ('${OF}','of@agrilib.test'), ('${P1}','p1@mail.test')`,
    );
    const orgA = (await run("select id from public.organizations where name = 'AgriLib Mining'"))[0].id as string;
    const orgB = (await run("select id from public.organizations where name = 'OreCo Liberia'"))[0].id as string;
    const site2 = (
      await run(
        `insert into public.sites (code, name, operator_name, mineral_type, county, district, community, status, latitude, longitude, created_by)
         values ('LB-BOM-002','Bomi North Pit','AgriLib Mining','Gold','Bomi','Senjeh','Bomi Hills','active',6.9,-10.9,'${f.admin}') returning id`,
      )
    )[0].id as string;
    await run("set local role authenticated");
    await as(run, f.admin);
    for (const [org, uid, email] of [[orgA, XA, "xa@agrilib.test"], [orgB, YA, "ya@oreco.test"]] as const) {
      const inv = (await run(`select public.mg_create_company_admin_invitation('${org}', '${email}') as id`))[0].id;
      await as(run, uid);
      await run(`select public.mg_accept_invitation('${inv}')`);
      await as(run, f.admin);
    }
    await as(run, XA);
    const invOf = (await run(`select public.mg_create_org_invitation('${orgA}', 'of@agrilib.test', 'onboarding_officer') as id`))[0].id;
    await as(run, OF);
    await run(`select public.mg_accept_invitation('${invOf}')`);
    await as(run, XA);
    return fn(run, { orgA, orgB, site2 });
  });
}

async function startImport(run: Runner, org: string, total: number) {
  return (await run(`select public.mg_import_start('${org}', '${KEY}', 'workers.csv', ${total}) as id`))[0].id as string;
}
const apply = async (run: Runner, imp: string, rows: Record<string, unknown>[]) =>
  (await run(`select public.mg_import_apply('${imp}', '${rowsJson(rows)}'::jsonb) as r`))[0].r as { row: number; outcome: string; message: string }[];

describe("the onboarding officer is least-privilege", () => {
  test("only a company administrator can appoint an officer; an officer cannot appoint, promote or invite administrative roles", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      for (const role of ["onboarding_officer", "site_manager", "company_admin"]) {
        expect(await fails(run(`select public.mg_create_org_invitation('${orgA}', 'x@y.zz', '${role}')`))).toMatch(/FORBIDDEN/);
      }
      expect(await fails(run(`select public.mg_set_member_role((select id from public.organization_members where user_id = auth.uid()), 'company_admin')`))).toMatch(/FORBIDDEN|INVALID_ROLE/);
      // allowed: workers and safety officers
      for (const role of ["worker", "safety_officer"]) {
        expect((await run(`select public.mg_create_org_invitation('${orgA}', '${role}@y.zz', '${role}') as id`))[0].id).toBeTruthy();
      }
    });
  });

  test("an officer cannot decide requests, change roles, remove people, assign sites, or read any site data", async () => {
    await world(async (run, { orgA, site2 }) => {
      await as(run, XA);
      const wk = (await run(`select public.mg_create_org_invitation('${orgA}', 'wk@agrilib.test', 'worker') as id`))[0].id;
      await owner(run, "insert into auth.users (id, email) values ('aaaaaaaa-0000-4000-8000-0000000000c1','wk@agrilib.test')");
      await as(run, "aaaaaaaa-0000-4000-8000-0000000000c1");
      await run(`select public.mg_accept_invitation('${wk}')`);
      const mWk = (await owner(run, "select id from public.organization_members where user_id = 'aaaaaaaa-0000-4000-8000-0000000000c1'"))[0].id;
      await as(run, P1);
      const req = (await run(`select public.mg_request_membership('${orgA}') as id`))[0].id;
      await as(run, OF);
      for (const sql of [
        `select public.mg_decide_membership_request('${req}', true, 'worker')`,
        `select public.mg_set_member_role('${mWk}', 'safety_officer')`,
        `select public.mg_revoke_member('${mWk}')`,
        `select public.mg_assign_member_site('${mWk}', '${site2}')`,
        `select * from public.mg_site_roster('${site2}')`,
      ]) expect(await fails(run(sql))).toMatch(/FORBIDDEN/);
      expect((await run("select id from public.sites")).length).toBe(0);
      expect((await run("select id from public.findings")).length).toBe(0);
      expect((await run("select id from public.incidents")).length).toBe(0);
      // but the workforce list is readable (names + emails only) so they can see who is already in
      expect((await run(`select * from public.mg_company_workforce('${orgA}')`)).length).toBeGreaterThan(1);
    });
  });

  test("officers can resend/revoke worker invitations but not site-manager or administrator ones; other companies are closed", async () => {
    await world(async (run, { orgA, orgB }) => {
      await as(run, XA);
      const sm = (await run(`select public.mg_create_org_invitation('${orgA}', 'sm@agrilib.test', 'site_manager') as id`))[0].id;
      await as(run, OF);
      const w = (await run(`select public.mg_create_org_invitation('${orgA}', 'w@agrilib.test', 'worker') as id`))[0].id;
      await run(`select public.mg_prepare_invitation_send('${w}')`);
      await run(`select public.mg_revoke_invitation('${w}')`);
      expect(await fails(run(`select public.mg_revoke_invitation('${sm}')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_prepare_invitation_send('${sm}')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select public.mg_create_org_invitation('${orgB}', 'z@y.zz', 'worker')`))).toMatch(/FORBIDDEN/);
      expect(await fails(run(`select * from public.mg_company_workforce('${orgB}')`))).toMatch(/FORBIDDEN/);
    });
  });
});

describe("bulk import: validation", () => {
  test("the preview is a dry run that writes nothing", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      const before = (await owner(run, "select count(*)::int as n from public.organization_invitations"))[0].n;
      const out = (await run(`select public.mg_import_check('${orgA}', '${rowsJson([{ row: 1, email: "new@x.test", role: "worker" }, { row: 2, email: "bad", role: "worker" }])}'::jsonb) as r`))[0].r as { row: number; outcome: string }[];
      expect(out.map((o) => o.outcome)).toEqual(["ok", "error"]);
      expect((await owner(run, "select count(*)::int as n from public.organization_invitations"))[0].n).toBe(before);
    });
  });

  test("administrative roles, bad data, unknown sites, duplicates and existing members are row errors — never invitations", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      const imp = await startImport(run, orgA, 9);
      const gov = "dave@mineguard.test";
      const elsewhere = (await owner(run, `select email from public.profiles where id = '${f.opB}'`))[0].email as string;
      const out = await apply(run, imp, [
        { row: 1, email: "ok1@x.test", role: "worker" },
        { row: 2, email: "boss@x.test", role: "company_admin" },
        { row: 3, email: "sm@x.test", role: "site_manager" },
        { row: 4, email: "officer@x.test", role: "onboarding_officer" },
        { row: 5, email: "OK1@x.test", role: "worker" },
        { row: 6, email: "nosite@x.test", role: "worker", site_code: "NOPE-1" },
        { row: 7, email: gov, role: "worker" },
        { row: 8, email: elsewhere, role: "worker" },
        { row: 9, email: "xa@agrilib.test", role: "worker" },
      ]);
      const by = Object.fromEntries(out.map((o) => [o.row, o]));
      expect(by[1].outcome).toBe("invited");
      for (const n of [2, 3, 4]) {
        expect(by[n].outcome).toBe("error");
        expect(by[n].message).toMatch(/administrative roles cannot be imported/);
      }
      expect(by[5].outcome).toBe("duplicate_in_file");
      expect(by[6]).toMatchObject({ outcome: "error", message: "Unknown site code for this company" });
      // identical wording: nothing reveals whether the address is government or belongs to another company
      expect(by[7].message).toBe("This address cannot be invited");
      expect(by[8].message).toBe("This address cannot be invited");
      expect(by[9].outcome).toBe("already_member");
      const made = await owner(run, "select email, org_role from public.organization_invitations where created_by = '" + OF + "'");
      expect(made).toEqual([{ email: "ok1@x.test", org_role: "worker" }]); // ONE invitation, a worker, nothing else
    });
  });

  test("an import creates no accounts and no memberships; the person still has to sign in and accept", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      const users = (await owner(run, "select count(*)::int as n from auth.users"))[0].n;
      const members = (await owner(run, "select count(*)::int as n from public.organization_members"))[0].n;
      const imp = await startImport(run, orgA, 2);
      await apply(run, imp, [{ row: 1, email: "brand.new@x.test" }, { row: 2, email: "p1@mail.test", role: "safety_officer" }]);
      expect((await owner(run, "select count(*)::int as n from auth.users"))[0].n).toBe(users);
      expect((await owner(run, "select count(*)::int as n from public.organization_members"))[0].n).toBe(members);
      await as(run, P1);
      expect((await run("select role from public.profiles where id = auth.uid()"))[0].role).toBeNull(); // no access yet
      expect((await run("select id from public.sites")).length).toBe(0);
    });
  });

  test("size limits are enforced by the database, not only the browser", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      expect(await fails(run(`select public.mg_import_start('${orgA}', '${KEY}', 'x.csv', 2001)`))).toMatch(/INVALID_IMPORT/);
      expect(await fails(run(`select public.mg_import_start('${orgA}', '${KEY}', 'x.csv', 0)`))).toMatch(/INVALID_IMPORT/);
      const imp = await startImport(run, orgA, 150);
      const many = Array.from({ length: 101 }, (_, i) => ({ row: i + 1, email: `u${i}@x.test` }));
      expect(await fails(apply(run, imp, many))).toMatch(/INVALID_IMPORT/);
      expect(await fails(apply(run, imp, [{ row: 151, email: "a@b.cc" }]))).toMatch(/INVALID_IMPORT/);
      expect(await fails(run(`select public.mg_import_check('${orgA}', '${rowsJson(many)}'::jsonb)`))).toMatch(/INVALID_IMPORT/);
    });
  });
});

describe("bulk import: retry safety", () => {
  test("re-sending a batch (or the whole import) never duplicates invitations or changes recorded outcomes", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      const imp = await startImport(run, orgA, 3);
      const rows = [{ row: 1, email: "a@x.test" }, { row: 2, email: "b@x.test" }, { row: 3, email: "nope", role: "worker" }];
      const first = await apply(run, imp, rows);
      const again = await apply(run, imp, rows);
      expect(again).toEqual(first);
      expect((await run(`select public.mg_import_start('${orgA}', '${KEY}', 'x.csv', 3) as id`))[0].id).toBe(imp); // same key, same import
      const invs = await owner(run, "select email from public.organization_invitations where created_by = '" + OF + "' order by email");
      expect(invs).toEqual([{ email: "a@x.test" }, { email: "b@x.test" }]);
      const st = (await run(`select public.mg_import_status('${imp}') as s`))[0].s as Record<string, number | string>;
      expect(st).toMatchObject({ status: "completed_with_errors", total: 3, processed: 3, invited: 2, errors: 1, unsent: 2 });
    });
  });

  test("a partial failure resumes: the remaining rows are processed on retry and the import completes", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      const imp = await startImport(run, orgA, 4);
      await apply(run, imp, [{ row: 1, email: "a@x.test" }, { row: 2, email: "b@x.test" }]); // "connection dropped" here
      expect(((await run(`select public.mg_import_status('${imp}') as s`))[0].s as { status: string }).status).toBe("processing");
      await apply(run, imp, [{ row: 1, email: "a@x.test" }, { row: 2, email: "b@x.test" }, { row: 3, email: "c@x.test" }, { row: 4, email: "d@x.test" }]);
      expect(((await run(`select public.mg_import_status('${imp}') as s`))[0].s as { status: string; invited: number })).toMatchObject({ status: "completed", invited: 4 });
    });
  });

  test("email delivery is a separate, retry-safe queue: a failed send returns to the queue", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      const imp = await startImport(run, orgA, 2);
      await apply(run, imp, [{ row: 1, email: "a@x.test" }, { row: 2, email: "b@x.test" }]);
      const q = await run(`select * from public.mg_import_unsent('${imp}', 25)`);
      expect(q.length).toBe(2);
      await run(`select public.mg_prepare_invitation_send('${q[0].invitation_id}')`); // reserved
      expect((await run(`select * from public.mg_import_unsent('${imp}', 25)`)).length).toBe(1);
      await run(`select public.mg_release_invitation_send('${q[0].invitation_id}')`); // the email failed
      expect((await run(`select * from public.mg_import_unsent('${imp}', 25)`)).length).toBe(2);
      // and an immediate retry is not throttled
      await run(`select public.mg_prepare_invitation_send('${q[0].invitation_id}')`);
    });
  });
});

describe("bulk import: boundaries", () => {
  test("only the company's own onboarding access can import; other companies, workers, outsiders and suspended companies cannot", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      const imp = await startImport(run, orgA, 1);
      await apply(run, imp, [{ row: 1, email: "a@x.test" }]);
      for (const uid of [YA, P1, f.opA, f.county, f.national]) {
        await as(run, uid);
        expect(await fails(run(`select public.mg_import_start('${orgA}', 'bbbbbbbb-0000-4000-8000-0000000000ab', 'x.csv', 1)`))).toMatch(/FORBIDDEN/);
        expect(await fails(run(`select public.mg_import_check('${orgA}', '[]'::jsonb)`))).toMatch(/FORBIDDEN/);
        expect(await fails(run(`select public.mg_import_apply('${imp}', '[]'::jsonb)`))).toMatch(/FORBIDDEN/);
        expect(await fails(run(`select public.mg_import_status('${imp}')`))).toMatch(/FORBIDDEN/);
        expect(await fails(run(`select * from public.mg_import_unsent('${imp}', 5)`))).toMatch(/FORBIDDEN/);
        expect((await run("select id from public.organization_imports")).length).toBe(0);
        expect((await run("select import_id from public.organization_import_rows")).length).toBe(0);
      }
      // the key is per company: another person cannot hijack an existing import by reusing its key
      await as(run, XA);
      expect((await run("select id from public.organization_imports")).length).toBe(1); // the administrator can read it
      await as(run, f.admin);
      await run(`select public.mg_set_company_status('${orgA}', 'suspended', 'licence review')`);
      await as(run, OF);
      expect(await fails(run(`select public.mg_import_start('${orgA}', 'bbbbbbbb-0000-4000-8000-0000000000ac', 'x.csv', 1)`))).toMatch(/FORBIDDEN/);
    });
  });

  test("direct table writes are closed; audit records the import and each invitation with the acting user", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      const imp = await startImport(run, orgA, 1);
      await apply(run, imp, [{ row: 1, email: "a@x.test" }]);
      for (const sql of [
        `insert into public.organization_imports (organization_id, idempotency_key, total_rows, created_by) values ('${orgA}', gen_random_uuid(), 1, '${OF}')`,
        "delete from public.organization_import_rows",
      ]) expect(await fails(run(sql))).toMatch(/permission denied/i);
      expect(await fails(run("update public.organization_imports set total_rows = 2000"))).toMatch(/permission denied/i);
      const audit = await owner(run, `select action, actor_label from public.audit_log where entity_type in ('organization_imports','organization_invitations') and actor_id = '${OF}'`);
      expect(audit.map((a) => a.action).sort()).toContain("organization_imports.insert");
      expect(audit.map((a) => a.action)).toContain("organization_invitations.insert");
    });
  });

  test("an imported invitation carries its site: acceptance assigns exactly that site, and only a worker role results", async () => {
    await world(async (run, { orgA }) => {
      await as(run, OF);
      const imp = await startImport(run, orgA, 1);
      await apply(run, imp, [{ row: 1, email: "p1@mail.test", role: "safety_officer", site_code: "lb-bom-002" }]);
      await as(run, P1);
      await run(`select public.mg_accept_invitation((select id from public.mg_my_pending_invitations() limit 1))`);
      expect((await run("select org_role from public.organization_members where user_id = auth.uid() and status = 'active'"))[0].org_role).toBe("safety_officer");
      expect((await run("select code from public.sites order by code")).map((r) => r.code)).toEqual(["LB-BOM-002"]); // scoped to the imported site, not the whole company
    });
  });
});
