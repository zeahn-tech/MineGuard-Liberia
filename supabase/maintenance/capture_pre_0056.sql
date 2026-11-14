-- READ-ONLY. Run against the target database BEFORE applying 0056 and keep the output.
-- It records the exact policies and the access function that 0056 will replace, so they can be restored.
select 'policy' as kind, tablename||'.'||policyname as obj,
       format('create policy %I on public.%I for %s to %s%s%s;', policyname, tablename, lower(cmd),
              array_to_string(roles, ', '),
              case when qual is not null then ' using ('||qual||')' else '' end,
              case when with_check is not null then ' with check ('||with_check||')' else '' end) as restore_sql
  from pg_policies where schemaname='public'
union all
select 'function', p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('mg_can_access_site','mg_can_access_site_row')
order by 1,2;
