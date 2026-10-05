import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
await db.exec(`
  create type user_scope as enum ('national','county','site');
  create table profiles (id int, s user_scope);
  insert into profiles values (1,'site');
  create or replace function cast_scope(p text) returns user_scope
  language plpgsql as $$ begin return p::user_scope; end $$;
`);

try {
  await db.exec(`
    begin;
    create type public.user_scope_full as enum ('national','regional','county','district','site','operator');
    alter table public.profiles alter column s type public.user_scope_full using (s::text::public.user_scope_full);
    alter type public.user_scope rename to user_scope_legacy;
    alter type public.user_scope_full rename to user_scope;
    drop type if exists public.user_scope_legacy;
    update public.profiles set s = 'operator' where id = 1;
    insert into public.profiles values (2, cast_scope('regional'));
    commit;
  `);
  const r = await db.query<{ s: string }>("select s from profiles order by id");
  console.log("SWAP OK:", JSON.stringify(r.rows));
} catch (e) {
  console.log("SWAP FAILED:", e instanceof Error ? e.message : String(e));
}

// re-run idempotency shape
try {
  await db.exec(`
    begin;
    do $$
    begin
      if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                      where n.nspname = 'public' and t.typname = 'user_scope_full') then
        execute $$
          create type public.user_scope_full as enum ('national','regional','county','district','site','operator')
        $$;
      end if;
    end $$;
    alter table public.profiles alter column s type public.user_scope_full using (s::text::public.user_scope_full);
    alter type public.user_scope rename to user_scope_legacy;
    alter type public.user_scope_full rename to user_scope;
    drop type if exists public.user_scope_legacy;
    insert into public.profiles values (3, 'district');
    commit;
  `);
  console.log("RERUN SHAPE OK");
} catch (e) {
  console.log("RERUN SHAPE FAILED:", e instanceof Error ? e.message : String(e));
}
