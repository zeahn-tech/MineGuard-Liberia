// Temporary debug: runs the fixture seed statement-by-statement to find the
// exact RLS WITH CHECK failure on public.evidence. Delete after use.
import { getDb } from "../tests/helpers/pglite-db";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const adminClaims = JSON.stringify({ sub: A, role: "authenticated" });

type Step = [string, string[]];
const steps: Step[] = [
  ["users", [
    `insert into auth.users (id, email, raw_user_meta_data) values
      ('${A}', 'alice@mineguard.test', '{"name":"Alice Admin"}'),
      ('aaaaaaaa-0000-4000-8000-000000000002', 'bob@agrilib.test', '{"name":"Bob"}')`,
  ]],
  ["bootstrap-admin", [
    "set local role authenticated",
    `set local request.jwt.claims = '${adminClaims}'`,
    `update public.profiles set role='admin', scope='national', profile_complete=true where id = '${A}'`,
    "reset role",
    "set local request.jwt.claims = ''",
  ]],
  ["siteA", [
    "set local role authenticated",
    `set local request.jwt.claims = '${adminClaims}'`,
    `insert into public.sites (id, code, name, operator_name, county, status, created_by)
       values ('bbbbbbbb-0000-4000-8000-000000000001','LB-BOM-001','Bomi River','AgriLib Mining','Bomi','active','${A}')`,
    "reset role",
    "set local request.jwt.claims = ''",
  ]],
  ["probe-policy-fn", [
    "set local role authenticated",
    `set local request.jwt.claims = '${adminClaims}'`,
    `select public.mg_is_admin() as is_admin, public.mg_can_access_site('bbbbbbbb-0000-4000-8000-000000000001') as can_site, auth.uid() as uid, current_user as cur`,
    "reset role",
    "set local request.jwt.claims = ''",
  ]],
  ["evidence-insert", [
    "set local role authenticated",
    `set local request.jwt.claims = '${adminClaims}'`,
    `insert into public.evidence (id, storage_path, parent_type, parent_id, site_id, kind,
        file_name, mime_type, size_bytes, uploaded_by_id)
       values ('99999999-0000-4000-8000-000000000001',
               '${A}/99999999-0000-4000-8000-000000000001__x.jpg',
               'incident', 'ffffffff-0000-4000-8000-000000000001',
               'bbbbbbbb-0000-4000-8000-000000000001', 'photo', 'x.jpg',
               'image/jpeg', 100, '${A}')
       returning id`,
    "reset role",
    "set local request.jwt.claims = ''",
  ]],
];

const db = await getDb();
// One transaction across all steps (they build on each other), with
// per-statement logging so the first failure is pinpointed.
const flat: Array<[string, string]> = [
  ["begin", "begin"],
  ...steps.flatMap(([name, stmts]) => stmts.map((s) => [name, s] as [string, string])),
  ["cleanup", "rollback"],
];
for (const [name, sql] of flat) {
  {
    try {
      const res = await db.query(sql);
      if (res.rows.length) console.log(`OK   ${name}:`, JSON.stringify(res.rows[0]));
    } catch (e) {
      console.log(`FAIL ${name}:`, e instanceof Error ? e.message : String(e));
      console.log("  stmt:", sql.slice(0, 140).replace(/\s+/g, " "));
      await db.exec("rollback").catch(() => {});
      await db.close();
      process.exit(1);
    }
  }
}
await db.close();
