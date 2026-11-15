-- READ-ONLY. Run against the target database BEFORE applying 0060 and keep the output (the apply job does this and
-- uploads it as an artifact for 90 days). It records the exact objects 0060 removes or replaces so they can be restored.
-- Dropped data is not captured: the legacy inspections.county/operator_name stamps can be rebuilt from sites.
select 'policy' as kind, schemaname||'.'||tablename||'.'||policyname as obj,
       format('create policy %I on %I.%I for %s to %s%s%s;', policyname, schemaname, tablename, lower(cmd),
              array_to_string(roles, ', '),
              case when qual is not null then ' using ('||qual||')' else '' end,
              case when with_check is not null then ' with check ('||with_check||')' else '' end) as restore_sql
  from pg_policies where schemaname in ('public','storage')
union all
select 'trigger', c.relname||'.'||t.tgname, pg_get_triggerdef(t.oid)||';'
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and not t.tgisinternal
union all
select 'index', indexname, indexdef||';' from pg_indexes where schemaname='public' and tablename='inspections'
union all
select 'function', p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('mg_can_access_site','mg_can_access_site_row','mg_guard_finding_update','mg_guard_staff_update',
       'mg_stamp_site','mg_is_operator','mg_can_read_county_rows','mg_operator_name','mg_backfill_scope_stamps','mg_guard_report_update',
       'mg_guard_incident_update','mg_guard_observation_update','mg_is_admin','mg_is_reviewer','mg_is_staff','mg_profile','mg_role')
union all
select 'column', table_name||'.'||column_name, data_type||' nullable='||is_nullable||' default='||coalesce(column_default,'-')
  from information_schema.columns where table_schema='public' and table_name='inspections' and column_name in ('county','operator_name')
order by 1,2;
