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
     'sites select scoped','sites insert admin','sites update admin','tracking select public');
  if bad is not null then raise exception 'SECURITY POSTURE: legacy policies present: %', bad; end if;

  -- 2b. no legacy storage policy, and the legacy helper functions are gone (retired by 0060)
  select string_agg(policyname, ', ') into bad from pg_policies where schemaname = 'storage' and policyname = 'evidence storage read';
  if bad is not null then raise exception 'SECURITY POSTURE: legacy storage policy present: %', bad; end if;
  select string_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and ((p.proname in ('mg_stamp_site','mg_guard_staff_update','mg_is_operator','mg_can_read_county_rows')) or (p.proname in ('mg_can_access_site','mg_can_access_site_row') and pg_get_function_identity_arguments(p.oid) like 'p_county text,%'));
  if bad is not null then raise exception 'SECURITY POSTURE: legacy functions present: %', bad; end if;

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

  -- 5. the anonymous API surface is exactly the public RPCs (add a function here only when it is meant to be public)
  select string_agg(p.proname, ', ' order by p.proname) into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute')
     and p.proname !~ '^(armor|crypt|dearmor|decrypt|digest|encrypt|fips_mode|gen_|gin_|gtrgm|hmac|pgp_|show_|similarity|set_limit|strict_word|word_similarity|uuid_|gist_)'
     and p.proname not in ('mg_content_guard','mg_mv_reply','mg_mv_site_info','mg_mv_status','mg_mv_submit_anonymous','mg_wv_reply','mg_wv_site_info','mg_wv_status','mg_wv_submit_anonymous','refresh_public_stats','submit_community_report','track_community_report');
  if bad is not null then raise exception 'SECURITY POSTURE: anon can execute unexpected functions: %', bad; end if;
end $$;
select 'security posture ok' as result;
