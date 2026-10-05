import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  create type user_scope as enum ('national','county','site');
  create table profiles (id int, s user_scope, operator_name text);
  insert into profiles values (1,'site','AgriLib');
  -- realistic shape: plpgsql body references the type NAME only (no signature dep)
  create or replace function cast_scope(p text) returns text
  language plpgsql as $fn$ begin return (p::user_scope)::text; end $fn$;
  create or replace function mg_profile_s() returns user_scope
  language sql stable as $fn$ select s from profiles limit 1 $fn$;
`);

async function run0010Shape(label: string) {
  try {
    await db.exec(`
      begin;
      create type public.user_scope_full as enum ('national','regional','county','district','site','operator');
      alter table public.profiles alter column s type public.user_scope_full using (s::text::public.user_scope_full);
      alter type public.user_scope rename to user_scope_legacy;
      alter type public.user_scope_full rename to user_scope;
      do $do$
      begin
        if exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                    where n.nspname = 'public' and t.typname = 'user_scope_legacy')
           and not exists (select 1 from pg_depend d
                            where d.refclassid = 'pg_type'::regclass
                              and d.refobjid = 'public.user_scope_legacy'::regtype) then
          execute 'drop type public.user_scope_legacy';
        end if;
      end $do$;
      update public.profiles set s = 'operator' where id = 1;
      insert into public.profiles values (2, 'regional'::user_scope);
      select cast_scope('district');
      commit;
    `);
    console.log(label, "OK");
  } catch (e) {
    console.log(label, "FAILED:", e instanceof Error ? e.message : String(e));
  }
}

await run0010Shape("RUN1");
await run0010Shape("RUN2");

const t = await db.query<{ n: string }>(
  `select count(*)::text n from pg_type t join pg_namespace n on n.oid=t.typnamespace
    where n.nspname='public' and t.typname like 'user_scope%'`,
);
console.log("user_scope* types left:", t.rows[0].n);
const v = await db.query<{ s: string }>("select s::text s from profiles order by id");
console.log("rows:", JSON.stringify(v.rows));
const fn = await db.query<{ r: string }>("select cast_scope('site') r");
console.log("fn still works:", fn.rows[0].r);
