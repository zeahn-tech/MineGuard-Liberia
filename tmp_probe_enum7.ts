import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
await db.exec(`
  create type user_scope as enum ('national','county','site');
  create table profiles (id int, s user_scope);
  do $do$
  begin
    execute 'alter type public.user_scope rename to user_scope_v1';
  end $do$;
  create type public.user_scope as enum ('national','regional','county','district','site','operator');
  alter table public.profiles alter column s type public.user_scope using (s::text::public.user_scope);
  do $do$
  begin
    if exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
                where n.nspname='public' and t.typname='user_scope_v1')
       and not exists (select 1 from pg_depend d
                        where d.refclassid = 'pg_type'::regclass
                          and d.refobjid = 'public.user_scope_v1'::regtype
                          and d.deptype <> 'i') then
      execute 'drop type public.user_scope_v1';
    end if;
  end $do$;
`);
const types = await db.query(`select t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and (t.typname like '%user_scope%')`);
console.log("types:", JSON.stringify(types.rows));
