import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  create type us as enum ('national','county','site');
  create table prof (id int, s us);
  insert into prof values (1,'site');
`);
try {
  await db.exec(`
    begin;
    alter type us add value if not exists 'operator';
    update prof set s = 'operator' where id = 1;
    insert into prof values (2,'operator');
    commit;
  `);
  const r = await db.query<{ s: string }>("select s from prof order by id");
  console.log("EXISTING-TABLE ADD+USE OK:", JSON.stringify(r.rows));
} catch (e) {
  console.log("EXISTING-TABLE ADD+USE FAILED:", e instanceof Error ? e.message : String(e));
}
