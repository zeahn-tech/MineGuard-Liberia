import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIR = join(ROOT, "supabase", "migrations");
const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
const stub = readFileSync(join(ROOT, "tests", "helpers", "pglite-db.ts"), "utf8");
void stub;
// reuse PLATFORM_STUB via import
const { PLATFORM_STUB } = await import(join(ROOT, "tests", "helpers", "pglite-db.ts"));
await db.exec(PLATFORM_STUB as string);
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort().filter((f) => f < "0010");
for (const f of files) {
  await db.exec(readFileSync(join(DIR, f), "utf8"));
}

const attnum = await db.query<{ a: string }>(
  `select a.attnum::text a from pg_attribute a
    where a.attrelid = 'public.profiles'::regclass and a.attname = 'scope'`,
);
const n = attnum.rows[0].a;
const deps = await db.query(
  `select d.classid::regclass::text as classid, d.objid::text as objid, d.objsubid,
          d.refclassid::regclass::text as refclassid, d.deptype
     from pg_depend d
    where d.refobjid = 'public.profiles'::regclass and d.refobjsubid = ${n}`,
);
console.log("column deps:", JSON.stringify(deps.rows, null, 1));

// resolve object names for policy-class deps
for (const r of deps.rows as Array<Record<string, string | number>>) {
  if (r.classid === "pg_policy") {
    const p = await db.query<{ tablename: string; polname: string }>(
      `select c.relname::text tablename, p.polname from pg_policy p
         join pg_class c on c.oid = p.polrelid where p.oid = ${r.objid}`,
    );
    console.log("policy dep:", JSON.stringify(p.rows));
  } else if (r.classid === "pg_rewrite") {
    const rw = await db.query<{ ev_class: string }>(
      `select ev_class::regclass::text ev_class from pg_rewrite where oid = ${r.objid}`,
    );
    console.log("rewrite dep:", JSON.stringify(rw.rows));
  }
}
