import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
try {
  await db.exec(`
    begin;
    create type user_scope_probe as enum ('national','county','site');
    alter type user_scope_probe add value if not exists 'regional';
    alter type user_scope_probe add value if not exists 'operator';
    create table probe_tbl (s user_scope_probe);
    insert into probe_tbl values ('regional');
    insert into probe_tbl values ('operator');
    commit;
  `);
  const r = await db.query<{ n: string }>("select count(*)::text n from probe_tbl");
  console.log("IN-TX ADD+USE OK:", r.rows[0].n);
} catch (e) {
  console.log("IN-TX ADD+USE FAILED:", e instanceof Error ? e.message : String(e));
}

// separate tx: add then use later
try {
  await db.exec("create type user_scope_probe2 as enum ('a');");
  await db.exec("alter type user_scope_probe2 add value 'b';");
  await db.exec("begin; create table t2 (s user_scope_probe2); insert into t2 values ('b'); commit;");
  console.log("CROSS-TX OK");
} catch (e) {
  console.log("CROSS-TX FAILED:", e instanceof Error ? e.message : String(e));
}
