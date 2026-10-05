import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  create type user_scope as enum ('national','county','site');
  create table profiles (id int, s user_scope, operator_name text);
  insert into profiles values (1,'site','AgriLib');
  create or replace function cast_scope(p text) returns text
  language plpgsql as $fn$ begin return (p::user_scope)::text; end $fn$;
`);

const SHAPE = `
  do $do$
  begin
    if exists (select 1 from pg_enum e
                where e.enumtypid = 'public.user_scope'::regtype
                  and e.enumlabel = 'site')
       and not exists (select 1 from pg_enum e
                        where e.enumtypid = 'public.user_scope'::regtype
                          and e.enumlabel = 'operator') then
      execute 'alter type public.user_scope rename to user_scope_v1';
    end if;
  end $do$;

  do $do$
  begin
    if not exists (select 1 from pg_type t
                     join pg_namespace n on n.oid = t.typnamespace
                    where n.nspname = 'public' and t.typname = 'user_scope') then
      execute 'create type public.user_scope as enum (''national'',''regional'',''county'',''district'',''site'',''operator'')';
    end if;
  end $do$;

  alter table public.profiles
    alter column s type public.user_scope
    using (s::text::public.user_scope);

  do $do$
  begin
    if exists (select 1 from pg_type t
                     join pg_namespace n on n.oid = t.typnamespace
                    where n.nspname = 'public' and t.typname = 'user_scope_v1')
       and not exists (select 1 from pg_depend d
                        where d.refclassid = 'pg_type'::regclass
                          and d.refobjid = 'public.user_scope_v1'::regtype) then
      execute 'drop type public.user_scope_v1';
    end if;
  end $do$;

  update public.profiles set s = 'operator' where id = 1;
  insert into public.profiles values (2, 'regional'::public.user_scope);
  select cast_scope('district');
`;

for (const label of ["RUN1", "RUN2", "RUN3"]) {
  try {
    await db.exec(`begin; ${SHAPE} commit;`);
    console.log(label, "OK");
  } catch (e) {
    console.log(label, "FAILED:", e instanceof Error ? e.message : String(e));
    await db.exec("rollback").catch(() => {});
  }
}

const t = await db.query<{ n: string }>(
  `select count(*)::text n from pg_type t join pg_namespace n on n.oid=t.typnamespace
    where n.nspname='public' and t.typname like 'user_scope%'`,
);
console.log("user_scope* types left:", t.rows[0].n);
const v = await db.query<{ s: string }>("select s::text s from profiles order by id");
console.log("rows:", JSON.stringify(v.rows));
console.log("fn:", (await db.query<{ r: string }>("select cast_scope('site') r")).rows[0].r);
