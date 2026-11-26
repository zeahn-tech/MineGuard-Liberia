-- ============================================================================
-- POST-DEPLOY VERIFICATION for migration 0065, for the Supabase SQL editor (no psql commands). READ-ONLY: one SELECT.
-- Every row must say PASS. Any FAIL = stop and follow the rollback in docs/27.
-- (The "code update is rejected" probe is not here because it would write; it is in verify_0065.sql for psql, and in the manual
--  post-deploy checks in docs/27.)
-- ============================================================================
with
c1 as (select case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(m.p || ' counter ' || coalesce(c.last_number::text, 'MISSING') || ' < max ' || m.mx, '; ') end r
         from (select (regexp_match(code, '^MGL-([A-Z]+)-([0-9]{1,9})$'))[1] p, max(((regexp_match(code, '^MGL-([A-Z]+)-([0-9]{1,9})$'))[2])::int) mx
                 from public.sites where code ~ '^MGL-[A-Z]+-[0-9]{1,9}$' group by 1) m
         left join public.site_code_counters c on c.prefix = m.p where c.last_number is null or c.last_number < m.mx),
c2 as (select case when count(*) = 0 then 'PASS' else 'FAIL' end r from (select code from public.sites group by code having count(*) > 1) d),
c3 as (select case when count(*) = 2 then 'PASS' else 'FAIL' end r from pg_trigger where tgname in ('sites_code_guard', 'organizations_identity_guard') and tgenabled <> 'D' and not tgisinternal),
c5 as (select string_agg(p.proname || '=' ||
   case when has_function_privilege('anon', p.oid, 'EXECUTE') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) then 'FAIL(anon/PUBLIC)'
        when p.proname in ('mg_company_registration_check', 'mg_register_company', 'mg_set_company_licence', 'mg_request_site', 'mg_licence_grace_until')
             then case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'PASS(client RPC)' else 'FAIL(no authenticated)' end
        when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'FAIL(helper exposed)' else 'PASS(internal)' end, '; ' order by p.proname) r
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('mg_county_prefix', 'mg_allocate_site_code', 'mg_sites_code_guard', 'mg_organizations_identity_guard',
        'mg_norm_name', 'mg_norm_licence', 'mg_licence_format_recognised', 'mg_validate_licence', 'mg_company_registration_check', 'mg_register_company',
        'mg_set_company_licence', 'mg_request_site', 'mg_licence_grace_until')),
c6 as (select string_agg(c.relname || '=' || case when c.relrowsecurity and not has_table_privilege('anon', c.oid, 'SELECT') and not has_table_privilege('authenticated', c.oid, 'SELECT') then 'PASS' else 'FAIL' end, '; ' order by c.relname) r
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('county_codes', 'site_code_counters', 'platform_settings')),
c7 as (select case when count(*) = 15 then 'PASS' else 'FAIL: ' || count(*) || ' counties' end r from public.county_codes),
c8 as (select case when count(*) = 2 then 'PASS (both)' else 'REVIEW: ' || coalesce(string_agg(indexname, ', '), 'none') || ' (name index is skipped if legacy names collide: see the 0065 WARNING)' end r
         from pg_indexes where indexname in ('organizations_licence_norm_uq', 'organizations_name_norm_uq')),
c9 as (select coalesce((select 'grace ends ' || coalesce(value, 'NULL (OFF)') from public.platform_settings where key = 'licence_grace_until_for_site_requests'), 'FAIL: setting missing') r),
c10 as (select case when count(*) = 1 and bool_and(pg_get_function_identity_arguments(oid) = 'p_name text, p_licence text') then 'PASS' else 'FAIL' end r
          from pg_proc where proname = 'mg_register_company' and pronamespace = 'public'::regnamespace),
c11 as (select case when max(version) = '0065' and count(*) filter (where version = '0065') = 1 then 'PASS' else 'FAIL/REVIEW: latest is ' || coalesce(max(version), '?') || ' (record 0065 in the history if it is missing)' end r from supabase_migrations.schema_migrations)
select '1 counters cover every code' as check_name, c1.r as result from c1
union all select '2 no duplicate site codes', c2.r from c2
union all select '3 both guard triggers enabled', c3.r from c3
union all select '5 function grants (no anon/PUBLIC; helpers closed)', c5.r from c5
union all select '6 tables closed to client roles', c6.r from c6
union all select '7 fifteen counties', c7.r from c7
union all select '8 unique indexes', c8.r from c8
union all select '9 licence grace setting (informational)', c9.r from c9
union all select '10 one mg_register_company (name, licence)', c10.r from c10
union all select '11 migration history ends at 0065', c11.r from c11
order by 1;
