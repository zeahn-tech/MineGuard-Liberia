-- ============================================================================
-- POST-DEPLOY VERIFICATION for migration 0065. Safe to run on staging and production: it only reads, and the one probe
-- that tries to change a code runs inside a block that always rolls back. Every check prints PASS or FAIL; any FAIL = stop
-- and follow the rollback in docs/27.   psql "$DATABASE_URL" -f supabase/maintenance/verify_0065.sql
-- ============================================================================
\echo '== 1. counters match the current maximum per prefix (counter >= max; equal right after apply)'
select case when count(*) = 0 then 'PASS' else 'FAIL' end as counters_cover_every_code, coalesce(string_agg(prefix || ': counter ' || coalesce(c.last_number::text,'MISSING') || ' < max ' || mx, '; '), '') as problems
from (select (regexp_match(code, '^MGL-([A-Z]+)-([0-9]{1,9})$'))[1] as prefix, max(((regexp_match(code, '^MGL-([A-Z]+)-([0-9]{1,9})$'))[2])::int) as mx
        from public.sites where code ~ '^MGL-[A-Z]+-[0-9]{1,9}$' group by 1) m
left join public.site_code_counters c using (prefix)
where c.last_number is null or c.last_number < m.mx;

select prefix, last_number as counter, (select max(((regexp_match(code, '^MGL-[A-Z]+-([0-9]+)$'))[1])::int) from public.sites s where s.code like 'MGL-' || c.prefix || '-%') as current_max
from public.site_code_counters c order by prefix;

\echo '== 2. no duplicate site codes'
select case when count(*) = 0 then 'PASS' else 'FAIL' end as no_duplicate_codes from (select code from public.sites group by code having count(*) > 1) d;

\echo '== 3. immutability and allocation triggers are present and enabled'
select case when count(*) = 2 then 'PASS' else 'FAIL' end as site_and_company_triggers_enabled
from pg_trigger where tgname in ('sites_code_guard', 'organizations_identity_guard') and tgenabled <> 'D' and not tgisinternal;

\echo '== 4. immutability actually rejects an update (rolled back whatever happens)'
do $$
declare v_id uuid; v_ok boolean := false;
begin
  select id into v_id from public.sites limit 1;
  if v_id is null then raise notice 'SKIP: no site rows to probe'; return; end if;
  begin
    update public.sites set code = code || 'X' where id = v_id;
  exception when others then
    v_ok := sqlerrm like 'CODE_IMMUTABLE%';
  end;
  raise notice '%', case when v_ok then 'PASS: code update rejected' else 'FAIL: code update was not rejected' end;
  if not v_ok then raise exception 'FAIL: sites.code is mutable — this block rolls back its own change'; end if;
end $$;

\echo '== 5. new functions: no PUBLIC and no anon execute; internal helpers not executable by authenticated either'
with f as (select p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig, p.proname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('mg_county_prefix','mg_allocate_site_code','mg_sites_code_guard','mg_organizations_identity_guard',
              'mg_norm_name','mg_norm_licence','mg_licence_format_recognised','mg_validate_licence','mg_company_registration_check',
              'mg_register_company','mg_set_company_licence','mg_request_site','mg_licence_grace_until'))
select sig,
       has_function_privilege('anon', oid, 'EXECUTE') as anon_can_execute,
       exists (select 1 from pg_proc p2, aclexplode(coalesce(p2.proacl, acldefault('f', p2.proowner))) a where p2.oid = f.oid and a.grantee = 0) as public_can_execute,
       has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated_can_execute,
       case when has_function_privilege('anon', oid, 'EXECUTE')
              or exists (select 1 from pg_proc p2, aclexplode(coalesce(p2.proacl, acldefault('f', p2.proowner))) a where p2.oid = f.oid and a.grantee = 0) then 'FAIL'
            when proname in ('mg_company_registration_check','mg_register_company','mg_set_company_licence','mg_request_site','mg_licence_grace_until') then 'PASS (client RPC)'
            when has_function_privilege('authenticated', oid, 'EXECUTE') then 'FAIL (internal helper exposed)'
            else 'PASS (internal)' end as verdict
from f order by sig;

\echo '== 6. reference/counter tables are not reachable by client roles'
select c.relname, c.relrowsecurity as rls_on,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select, has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
       case when c.relrowsecurity and not has_table_privilege('anon', c.oid, 'SELECT') and not has_table_privilege('authenticated', c.oid, 'SELECT') then 'PASS' else 'FAIL' end as verdict
from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('county_codes', 'site_code_counters', 'platform_settings');

\echo '== 7. county table = the 15 official counties'
select case when count(*) = 15 then 'PASS' else 'FAIL' end as fifteen_counties from public.county_codes;

\echo '== 8. company identity: indexes present (name index may be absent if legacy duplicates existed: then 0065 printed a WARNING)'
select indexname from pg_indexes where indexname in ('organizations_licence_norm_uq', 'organizations_name_norm_uq') order by 1;
