-- READ-ONLY post-deployment verification. Raises an exception (non-zero exit under psql
-- -v ON_ERROR_STOP=1) if the database's security posture is not what the migrations define.
-- Run by .github/workflows/db-migrate.yml after every apply; also safe to run by hand.
do $$
declare bad text;
begin
  -- 1. row-level security is enabled on every public table
  select string_agg(c.relname, ', ' order by c.relname) into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if bad is not null then raise exception 'SECURITY POSTURE: RLS disabled on: %', bad; end if;

  -- 2. no legacy access policies (retired by 0055)
  select string_agg(tablename || '.' || policyname, ', ' order by tablename, policyname) into bad
    from pg_policies
   where schemaname = 'public' and policyname in (
     'audit insert authenticated','audit select staff','reports update reviewer',
     'cas insert staff visible','cas select scoped','cas update guard',
     'obs insert assigned visible','obs select scoped','obs update staff',
     'evidence insert assigned visible','evidence select scoped',
     'findings insert staff visible','findings select scoped','findings update guard',
     'incidents insert assigned visible','incidents select scoped','incidents update staff',
     'templates insert admin','templates select assigned','templates update admin',
     'inspections insert staff visible','inspections select scoped','inspections update guard',
     'sites select scoped','sites insert admin','sites update admin');
  if bad is not null then raise exception 'SECURITY POSTURE: legacy policies present: %', bad; end if;

  -- 3. the site access check is the organisation-aware one
  if pg_get_functiondef('public.mg_can_access_site(uuid)'::regprocedure) not like '%s.organization_id%' then
    raise exception 'SECURITY POSTURE: mg_can_access_site(uuid) is not the organisation-aware definition';
  end if;

  -- 4. client roles: anon reads no table directly; nobody but the server writes audit_log; no TRUNCATE
  select string_agg(c.relname || ':' || r.rolname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (select rolname from pg_roles where rolname in ('anon','authenticated')) r
   where n.nspname = 'public' and c.relkind = 'r'
     and ( has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
        or (c.relname = 'audit_log' and (has_table_privilege(r.rolname, c.oid, 'INSERT')
                                      or has_table_privilege(r.rolname, c.oid, 'UPDATE')
                                      or has_table_privilege(r.rolname, c.oid, 'DELETE')))
        or (r.rolname = 'anon' and has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE')));
  if bad is not null then raise exception 'SECURITY POSTURE: excess client privileges: %', bad; end if;
end $$;
select 'security posture ok' as result;
