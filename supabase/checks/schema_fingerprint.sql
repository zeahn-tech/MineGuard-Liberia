-- READ-ONLY schema fingerprint of schema public (function bodies are compared with CR removed: Windows-edited SQL carries CRLF). One row per object: kind | object | md5.
select kind, obj, md5(def) as h from (
  select 'function' as kind, p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as obj, replace(p.prosrc, E'\r', '')||coalesce(p.prosecdef::text,'')||coalesce(array_to_string(p.proconfig,','),'') as def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
  union all
  select 'policy', tablename||'.'||policyname, cmd||coalesce(roles::text,'')||coalesce(qual,'')||'|'||coalesce(with_check,'')
    from pg_policies where schemaname='public'
  union all
  select 'trigger', c.relname||'.'||t.tgname, regexp_replace(pg_get_triggerdef(t.oid),'\s+',' ','g')
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
  union all
  select 'column', table_name||'.'||column_name, data_type||'|'||is_nullable
    from information_schema.columns where table_schema='public'
  union all
  select 'constraint', c.relname||'.'||k.conname, pg_get_constraintdef(k.oid)
    from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
  union all
  select 'rls', c.relname, c.relrowsecurity::text||c.relforcerowsecurity::text
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'
) x order by kind, obj;
