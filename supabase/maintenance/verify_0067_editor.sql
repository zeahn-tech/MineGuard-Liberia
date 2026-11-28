-- ============================================================================
-- POST-DEPLOY VERIFICATION for migration 0067 (Ministry-controlled licence grace period), for the Supabase SQL editor.
-- READ-ONLY: one SELECT, no writes, safe on production. Every row must say PASS (row 6 is informational). Any FAIL = stop and
-- follow the 0067 rollback in docs/27 (supabase/maintenance/rollback_0067_grace_period_control.sql).
-- The behaviour probes (who may call it, validation, audit, notifications, immediate effect on site requests) are in
-- tests/grace-period-control.test.ts and ran on a scratch database; they write, so they are not repeated here.
-- ============================================================================
with
c1 as (select case when coalesce(string_agg(role::text, ',' order by role::text), '') = 'admin,registrar'
                   then 'PASS (admin, registrar)'
                   else 'FAIL: platform_settings.write is held by [' || coalesce(string_agg(role::text, ',' order by role::text), 'nobody') || ']' end r
         from public.permissions where permission = 'platform_settings.write'),
c2 as (select case when count(*) = 2 then 'PASS' else 'FAIL: ' || count(*) || ' of 2 functions exist' end r
         from pg_proc where pronamespace = 'public'::regnamespace
          and oid::regprocedure::text in ('mg_set_licence_grace_until(date,text)', 'mg_licence_grace_status()')),
c3 as (select coalesce(string_agg(p.proname || '=' ||
          case when has_function_privilege('anon', p.oid, 'EXECUTE') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) then 'FAIL(anon/PUBLIC)'
               when not has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'FAIL(no authenticated)'
               when not p.prosecdef then 'FAIL(not security definer)'
               when not (coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public']) then 'FAIL(search_path)'
               else 'PASS' end, '; ' order by p.proname), 'FAIL: functions missing') r
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('mg_set_licence_grace_until', 'mg_licence_grace_status')),
c4 as (select case when c.relrowsecurity and not has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
                    and not has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
                   then 'PASS (closed to client roles)' else 'FAIL: platform_settings is open' end r
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = 'platform_settings'),
c5 as (select case when count(*) = 1 then 'PASS' else 'FAIL: audit trigger function does not read the reason' end r
         from pg_proc where pronamespace = 'public'::regnamespace and proname = 'mg_platform_settings_changelog'
          and prosrc like '%mg.grace_change_reason%'),
c6 as (select 'INFO: grace ends ' || coalesce((select value from public.platform_settings where key = 'licence_grace_until_for_site_requests'), 'NULL (OFF) or setting missing') r),
c7 as (select case when count(*) filter (where version = '0067') = 1 then 'PASS' else 'FAIL/REVIEW: 0067 recorded ' || count(*) filter (where version = '0067') || ' time(s) (record it in the history after applying)' end r
         from supabase_migrations.schema_migrations),
c8 as (select case when count(*) = 5 then 'PASS' else 'FAIL: ' || count(*) || ' of 5 0065 triggers enabled' end r from pg_trigger
         where tgname in ('sites_code_guard', 'organizations_identity_guard', 'organizations_licence_guard', 'platform_settings_guard', 'platform_settings_changelog')
           and tgenabled <> 'D' and not tgisinternal)
select n, check_name, result from (
  select 1 n, 'permission platform_settings.write held by exactly admin and registrar' check_name, r result from c1 union all
  select 2, 'both functions exist', r from c2 union all
  select 3, 'grants: authenticated only, security definer, search_path = public', r from c3 union all
  select 4, 'platform_settings still closed (RLS on, no client grants)', r from c4 union all
  select 5, 'audit trigger records the reason', r from c5 union all
  select 6, 'current grace setting (informational)', r from c6 union all
  select 7, '0067 recorded in schema_migrations', r from c7 union all
  select 8, '0065 guards and audit trigger still enabled', r from c8
) x order by n;
