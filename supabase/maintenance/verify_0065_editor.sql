-- ============================================================================
-- POST-DEPLOY VERIFICATION for migration 0065, for the Supabase SQL editor (no psql commands). READ-ONLY: one SELECT.
-- Every row must say PASS (row 17 says REVIEW until migration 0066 is applied). Any FAIL = stop and follow the rollback in docs/27.
-- This is the ONLY verify script for production: read-only, one SELECT. verify_0065.sql runs write probes: scratch or staging only.
-- (The "code update is rejected" probe is not here because it would write; it is in verify_0065.sql for psql, and in the manual
--  post-deploy checks in docs/27.)
-- ============================================================================
with
c1 as (select case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(m.p || ' counter ' || coalesce(c.last_number::text, 'MISSING') || ' < max ' || m.mx, '; ') end r
         from (select (regexp_match(code, '^MGL-([A-Z]+)-([0-9]{1,9})$'))[1] p, max(((regexp_match(code, '^MGL-([A-Z]+)-([0-9]{1,9})$'))[2])::int) mx
                 from public.sites where code ~ '^MGL-[A-Z]+-[0-9]{1,9}$' group by 1) m
         left join public.site_code_counters c on c.prefix = m.p where c.last_number is null or c.last_number < m.mx),
c2 as (select case when count(*) = 0 then 'PASS' else 'FAIL' end r from (select code from public.sites group by code having count(*) > 1) d),
c3 as (select case when count(*) = 5 then 'PASS' else 'FAIL: ' || count(*) || ' of 5 enabled (' || coalesce(string_agg(tgname, ', '), 'none') || ')' end r from pg_trigger
         where tgname in ('sites_code_guard', 'organizations_identity_guard', 'organizations_licence_guard', 'platform_settings_guard', 'platform_settings_changelog') and tgenabled <> 'D' and not tgisinternal),
c5 as (select string_agg(p.proname || '=' ||
   case when has_function_privilege('anon', p.oid, 'EXECUTE') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) then 'FAIL(anon/PUBLIC)'
        when p.proname in ('mg_company_registration_check', 'mg_register_company', 'mg_set_company_licence', 'mg_request_site', 'mg_licence_grace_until', 'mg_validate_licence')
             then case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'PASS(client RPC)' else 'FAIL(no authenticated)' end
        when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'FAIL(helper exposed)' else 'PASS(internal)' end, '; ' order by p.proname) r
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('mg_county_prefix', 'mg_county_canonical', 'mg_allocate_site_code', 'mg_sites_code_guard', 'mg_organizations_identity_guard',
        'mg_organizations_licence_guard', 'mg_platform_settings_guard', 'mg_platform_settings_changelog', 'mg_resolve_organization',
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
c11 as (select case when count(*) filter (where version = '0065') = 1 then 'PASS (latest recorded: ' || max(version) || ')' else 'FAIL/REVIEW: 0065 recorded ' || count(*) filter (where version = '0065') || ' time(s); latest is ' || coalesce(max(version), '?') || ' (record 0065 in the history if it is missing)' end r from supabase_migrations.schema_migrations),
-- F-1: numbering. A counter at 10000+ must correspond to a real 5-digit code (the truncation bug produced MGL-XXXX-1000 while the counter moved on),
--      and no code may have fewer than 4 digits.
f1 as (select case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(x, '; ') end r from (
         select c.prefix || ' counter ' || c.last_number || ' has no code MGL-' || c.prefix || '-' || c.last_number as x
           from public.site_code_counters c
          where c.last_number >= 10000 and not exists (select 1 from public.sites s where s.code = 'MGL-' || c.prefix || '-' || c.last_number)
         union all
         select 'short number part: ' || code from public.sites where code ~ '^MGL-[A-Z]+-[0-9]{1,3}$') z),
-- F-2: counties stored verbatim. Legacy rows keep their spelling (never rewritten), so this REVIEWS rather than fails.
f2 as (select case when count(*) = 0 then 'PASS' else 'REVIEW: ' || count(*) || ' site(s) not in canonical spelling, e.g. ' || (array_agg(distinct county))[1] || ' (legacy rows keep their spelling; none may appear for sites created after 0065)' end r
         from public.sites where county not in (select county from public.county_codes)),
-- F-3: licence integrity: every stored licence number passes the rules (no APL-/CLC-, 5-30 chars, letters/digits//, a digit); never blank
f3 as (select case when count(*) = 0 then 'PASS' else 'FAIL: ' || count(*) || ' invalid, e.g. ' || (array_agg(name || ' = ' || licence_number))[1] end r
         from (select name, licence_number, upper(regexp_replace(licence_number, '[[:space:]-]', '', 'g')) as n from public.organizations where licence_number is not null) o
        where upper(btrim(licence_number)) ~ '^(APL|CLC)[[:space:]]*-' or char_length(n) < 5 or char_length(n) > 30 or n !~ '^[A-Z0-9/]+$' or n !~ '[0-9]'),
f3b as (select 'approved/pending companies without a licence number: ' || count(*) filter (where status in ('approved', 'pending_review')) || ' (registrar to-do list; ' || count(*) filter (where status = 'pending_review') || ' pending review)' r
          from public.organizations where licence_number is null and status <> 'deactivated'),
-- F-7: a code whose prefix does not belong to its county (REVIEW: legacy rows may differ), and counter rows for prefixes that are not county prefixes
f7 as (select case when count(*) = 0 then 'PASS' else 'REVIEW: ' || count(*) || ' site(s), e.g. ' || (array_agg(s.code || ' in ' || s.county))[1] end r
         from public.sites s join public.county_codes cc on cc.county_key = lower(regexp_replace(coalesce(s.county, ''), '[^A-Za-z]', '', 'g'))
        where (regexp_match(s.code, '^MGL-([A-Z]+)-'))[1] is distinct from cc.prefix),
f7b as (select case when count(*) = 0 then 'PASS' else 'REVIEW: stray counter prefix(es) ' || string_agg(prefix, ', ') || ' (from legacy codes; a stray prefix created AFTER 0065 would be a bug)' end r
          from public.site_code_counters where prefix not in (select prefix from public.county_codes)),
-- G-3: the grace setting is audited
g3 as (select case when exists (select 1 from pg_trigger where tgname = 'platform_settings_changelog' and tgenabled <> 'D')
                    then 'PASS (changes recorded in audit_log; ' || (select count(*) from public.audit_log where entity_type = 'platform_settings') || ' entries so far)' else 'FAIL: audit trigger missing' end r),
-- 0066 (N-1): the two county functions refuse text containing a digit. Read-only: it inspects the function source, it does not call it.
-- REVIEW (not FAIL) when 0066 has not been applied yet.
n1 as (select case when count(*) = 2 and bool_and(pg_get_functiondef(p.oid) ~ '\[0-9') then 'PASS (county digits refused)'
                   else 'REVIEW: 0066 not applied (a county containing a digit is still accepted and stored without it)' end r
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('mg_county_prefix', 'mg_county_canonical'))

select '1 counters cover every code' as check_name, c1.r as result from c1
union all select '2 no duplicate site codes', c2.r from c2
union all select '3 all five guard and audit triggers enabled', c3.r from c3
union all select '5 function grants (no anon/PUBLIC; helpers closed)', c5.r from c5
union all select '6 tables closed to client roles', c6.r from c6
union all select '7 fifteen counties', c7.r from c7
union all select '8 unique indexes', c8.r from c8
union all select '9 licence grace setting (informational)', c9.r from c9
union all select '10 one mg_register_company (name, licence)', c10.r from c10
union all select '11 migration history records 0065', c11.r from c11
union all select '12 F-1 numbering: counter vs code length', f1.r from f1
union all select '13 F-2 counties in canonical spelling', f2.r from f2
union all select '14 F-3 stored licence numbers are valid', f3.r from f3
union all select '14b companies still without a licence (informational)', f3b.r from f3b
union all select '15 F-7 code prefix matches its county', f7.r from f7
union all select '15b F-7 counter rows only for county prefixes', f7b.r from f7b
union all select '16 G-3 grace setting changes are audited', g3.r from g3
union all select '17 N-1 county text with a digit is refused (0066)', n1.r from n1
order by 1;
