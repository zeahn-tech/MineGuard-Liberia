-- ===========================================================================
-- READ-ONLY: which MineGuard migrations are applied in THIS database?
--
-- Run it in the project the app really uses (the ref in src/lib/supabase.ts),
-- either in the Supabase SQL Editor or:
--   SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts supabase/checks/migration_state.sql
--
-- Apply the migrations that show `false`, in filename order, then run it again.
-- Reads only the catalogs — it never touches your data and works on a database
-- where none of the tables exist yet (every row is then simply `false`).
-- (0017 repairs demo rows only: `select count(*) from public.sites where
--  longitude > 0 and name like 'Demo %'` should be 0 afterwards.)
-- ===========================================================================
with fns as (
  select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
)
select migration, applied
  from (values
    ('0001 base schema (public.sites)',
       to_regclass('public.sites') is not null),
    ('0010 organizations, scopes, permissions',
       to_regclass('public.admin_areas') is not null
       and exists (select 1 from fns where proname = 'mg_can_access_site')),
    ('0012 command-center stats',
       exists (select 1 from fns where proname = 'mg_command_center_stats')),
    ('0013 offline reliability (evidence parents)',
       exists (select 1 from fns where proname = 'evidence_for_parent')),
    ('0014 scale surfaces (keyset pages, risk scores)',
       exists (select 1 from fns where proname = 'mg_risk_scores')),
    ('0015 GIS (geo columns + boundary tables)',
       to_regclass('public.admin_boundaries') is not null
       and exists (
         select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'sites' and column_name = 'geo_verified')),
    ('0016 boundary hardening (no client DELETE)',
       case when to_regclass('public.admin_boundaries') is null then false
            else not has_table_privilege('authenticated', 'public.admin_boundaries', 'DELETE') end),
    ('0019 configurable risk (versioned weights, server-side scoring)',
       to_regclass('public.risk_config_versions') is not null
       and exists (select 1 from fns where proname = 'mg_risk_build')),
    ('0021 notifications, trends, summary report',
       to_regclass('public.notifications') is not null
       and exists (select 1 from fns where proname = 'mg_notifications_sync')
       and exists (select 1 from fns where proname = 'mg_summary_report')),
    ('0024 self-service tenant lockdown',
       exists (select 1 from pg_trigger where tgname = 'profiles_self_tenant_guard' and not tgisinternal)),
    ('0025 company status, membership, invitations',
       to_regclass('public.organization_invitations') is not null
       and to_regclass('public.organization_members') is not null
       and exists (select 1 from fns where proname = 'mg_accept_invitation')),
    ('0026 company workforce administration',
       exists (select 1 from fns where proname = 'mg_can_manage_company')
       and exists (select 1 from fns where proname = 'mg_decide_membership_request')),
    ('0027 site-scoped company access',
       exists (select 1 from fns where proname = 'mg_operator_site_ok')
       and exists (
         select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'site_assignments' and column_name = 'revoked_at')),
    ('0018 boundaries published to Realtime',
       exists (
         select 1 from pg_publication_tables
          where pubname = 'supabase_realtime' and schemaname = 'public'
            and tablename = 'site_boundaries'))
  ) as t(migration, applied)
 order by migration;
