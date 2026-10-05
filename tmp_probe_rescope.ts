import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  create table p (id int primary key, org text, v text);
  create table ch (pid int, v text);
  insert into p values (1, 'a', 'x');
  insert into ch values (1, 'x');

  -- BEFORE trigger modifies v on any update (like sites_org)
  create or replace function bump() returns trigger
  language plpgsql as $$ begin new.v := upper(new.v); return new; end $$;
  create trigger p_b before update on p for each row execute function bump();

  -- AFTER UPDATE OF v (like sites_rescope)
  create or replace function aft() returns trigger
  language plpgsql as $$ begin update ch set v = new.v where pid = new.id; return new; end $$;
  create trigger p_a after update of v on p for each row execute function aft();
`);

// Case 1: SET clause does NOT mention v, but before-trigger changes it.
await db.exec(`update p set org = 'b' where id = 1`);
let ch = await db.query<{ v: string }>("select v from ch");
console.log("after update of non-listed col (trigger modified v): ch.v =", JSON.stringify(ch.rows));

// reset
await db.exec(`update ch set v = 'x'; update p set v = 'x' where id = 1;`);
// hmm p update sets v listed -> would fire after trigger; reset ch after
await db.exec(`update ch set v = 'x'`);

// Case 2: SET clause mentions v with SAME value.
await db.exec(`update p set v = 'X' where id = 1`);
ch = await db.query<{ v: string }>("select v from ch");
console.log("after update listing v (same value): ch.v =", JSON.stringify(ch.rows));
