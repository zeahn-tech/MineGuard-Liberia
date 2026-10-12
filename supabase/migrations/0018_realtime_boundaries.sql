-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0018: publish boundary changes to Realtime
--
-- 0001 added the operational tables to the supabase_realtime publication;
-- 0015's two boundary tables were never added, so a boundary loaded by one
-- administrator never refreshed another person's open National map (the map
-- watches these tables). Added only when missing, so this is safe to re-run
-- and safe where the publication is managed elsewhere.
-- ===========================================================================
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return; -- no Realtime in this environment; nothing to publish to
  end if;
  foreach t in array array['admin_boundaries', 'site_boundaries'] loop
    if to_regclass(format('public.%I', t)) is null then
      raise exception using
        message = format('MineGuard migration 0018_realtime_boundaries cannot run: public.%s does not exist.', t),
        detail  = 'The boundary tables are created by migration 0015_gis.sql. Apply 0015 first (and 0001-0014 before it).',
        hint    = 'Check you are connected to the project whose ref matches src/lib/supabase.ts. Safest: SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts supabase/migrations/0018_realtime_boundaries.sql';
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
