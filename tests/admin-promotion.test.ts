// ---------------------------------------------------------------------------
// supabase/maintenance/promote_to_admin.sql — making an existing account an
// administrator.
//
// The reported problem: an account stayed on the OPERATOR screen after
// `update public.users set system_role = 'platform_admin' …` was run — a
// statement for another application's schema. MineGuard's role is
// public.profiles.role. This runs the reusable statement against the real
// schema (guard trigger, organisation trigger, audit trail all active) for an
// account that signed up exactly as in production and is an operator.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminExec, adminSql, getEdgeDb } from "./helpers/backend-edge";

const SCRIPT = readFileSync(join(import.meta.dir, "..", "supabase", "maintenance", "promote_to_admin.sql"), "utf8");
const PLACEHOLDER = "replace-with-email@example.org";
const forEmail = (email: string) => SCRIPT.replace(PLACEHOLDER, email);

const OP_ID = "bbbbbb09-0000-4000-8000-000000000001";
const OTHER_ID = "bbbbbb09-0000-4000-8000-000000000002";
const OP_EMAIL = "Promote.Me@Example.org"; // mixed case on purpose
const OTHER_EMAIL = "stays.operator@example.org";

const profile = async (id: string) =>
  (
    await adminSql(
      `select role::text as role, scope::text as scope, county, operator_name, organization_id, profile_complete
         from public.profiles where id = '${id}'`,
    )
  )[0];

/** A real sign-up (the on_auth_user_created trigger makes the profile), turned
 *  into an operator bound to an organisation — the state in the report. */
async function signUpAsOperator(id: string, email: string, operatorName: string) {
  await adminSql(
    `insert into auth.users (id, email, raw_user_meta_data) values ('${id}', '${email}', '{}'::jsonb)`,
  );
  await adminSql(
    `update public.profiles
        set role = 'operator', scope = 'operator', operator_name = '${operatorName}', county = null, profile_complete = true
      where id = '${id}'`,
  );
}

const asUser = (uid: string, sql: string) =>
  `set local role authenticated; set local request.jwt.claims='${JSON.stringify({ sub: uid, role: "authenticated" })}'; ${sql}`;

beforeAll(async () => {
  await getEdgeDb();
  await signUpAsOperator(OP_ID, OP_EMAIL, "Promotion Probe Mining Ltd");
  await signUpAsOperator(OTHER_ID, OTHER_EMAIL, "Other Probe Mining Ltd");
});

afterAll(async () => {
  await adminExec(
    `set session_replication_role = replica;
     delete from public.profiles where id in ('${OP_ID}', '${OTHER_ID}');
     delete from auth.users where id in ('${OP_ID}', '${OTHER_ID}');
     set session_replication_role = origin;`,
  );
});

describe("the starting point matches the report", () => {
  test("the account is an operator, tied to an organisation — it is sent to the operator screen", async () => {
    const p = await profile(OP_ID);
    expect(p).toMatchObject({ role: "operator", scope: "operator", operator_name: "Promotion Probe Mining Ltd" });
    expect(p.organization_id).not.toBeNull();
    const [r] = await adminExec(asUser(OP_ID, "select public.mg_is_admin() as is_admin"));
    expect((r as { is_admin: boolean }).is_admin).toBe(false);
  });
});

describe("promote_to_admin.sql", () => {
  test("the script has exactly one email to edit and nothing destructive", () => {
    expect(SCRIPT.split(PLACEHOLDER)).toHaveLength(2); // one occurrence
    const code = SCRIPT.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
    expect(code).not.toMatch(/\b(delete|drop|truncate|insert|alter|grant|revoke)\b/i);
    expect(code.split(";").filter((x) => x.trim()).length).toBe(1); // a single statement
  });

  test("promotes the account: admin, national, no operator tenant — and the database now agrees it is an admin", async () => {
    const rows = await adminSql(forEmail(OP_EMAIL.toLowerCase())); // typed in a different case than stored
    expect(rows).toHaveLength(1); // one account, and the script says which
    expect(rows[0]).toMatchObject({ role: "admin", scope: "national", county: null, operator_name: null, profile_complete: true });

    const p = await profile(OP_ID);
    expect(p).toMatchObject({ role: "admin", scope: "national", county: null, operator_name: null });
    expect(p.organization_id).toBeNull(); // no longer bound to the operator's organisation

    const [r] = await adminExec(asUser(OP_ID, "select public.mg_is_admin() as is_admin"));
    expect((r as { is_admin: boolean }).is_admin).toBe(true);
  });

  test("changes ONLY that account", async () => {
    expect(await profile(OTHER_ID)).toMatchObject({ role: "operator", scope: "operator", operator_name: "Other Probe Mining Ltd" });
  });

  test("is safe to run again (nothing drifts)", async () => {
    const before = await profile(OP_ID);
    const rows = await adminSql(forEmail(OP_EMAIL));
    expect(rows).toHaveLength(1);
    expect(await profile(OP_ID)).toEqual(before);
  });

  test("the change is recorded in the audit trail", async () => {
    const [row] = await adminSql(
      `select count(*)::int as n from public.audit_log where entity_id = '${OP_ID}'`,
    );
    expect((row as { n: number }).n).toBeGreaterThan(0);
  });

  test("an email with no profile (never signed in) changes nothing and says so by returning ZERO rows", async () => {
    const before = await adminSql(`select count(*)::int as n from public.profiles where role = 'admin'`);
    const rows = await adminSql(forEmail("nobody.has.this.email@example.org"));
    expect(rows).toHaveLength(0);
    const after = await adminSql(`select count(*)::int as n from public.profiles where role = 'admin'`);
    expect(after).toEqual(before);
  });
});
