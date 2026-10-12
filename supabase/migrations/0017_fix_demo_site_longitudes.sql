-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0017: correct demo-site longitudes
--
-- The demo seed (non-production builds only) stored its six sites with
-- POSITIVE longitudes (e.g. 9.4236), which is Nigeria/Cameroon. Liberia lies
-- west of the prime meridian: its longitudes are -11.6 … -7.3. The National
-- map (correctly) refuses to plot positions outside Liberia, so a database
-- seeded before this fix showed an empty map.
--
-- The seed is fixed in code; this repairs rows it already wrote. It is
-- deliberately narrow — ONLY rows carrying the seed's own synthetic-record
-- marker, ONLY when the mirrored value lands inside Liberia — so real sites a
-- user entered are never touched (the app now rejects such input up front;
-- an existing real site with a mistyped sign is corrected by editing it).
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- Precondition: fail early, in plain words, instead of halfway through with an
-- opaque 'relation does not exist'. The usual cause is running this file in the
-- WRONG Supabase project (the project ref must match src/lib/supabase.ts), or
-- running it before the earlier migrations.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.sites') is null then
    raise exception using
      message = 'MineGuard migration 0017_fix_demo_site_longitudes cannot run: public.sites does not exist.',
      detail  = 'The base schema is missing in this database. Apply migrations 0001-0016 first, in order.',
      hint    = 'Check you are connected to the project whose ref matches src/lib/supabase.ts. Safest: SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts supabase/migrations/0017_fix_demo_site_longitudes.sql (the runner is tied to the right project).';
  end if;
end $$;

update public.sites
   set longitude = -longitude
 where notes = 'Synthetic demonstration record — not real operational data.'
   and name like 'Demo %'
   and longitude > 0
   and -longitude between -11.6 and -7.3;
