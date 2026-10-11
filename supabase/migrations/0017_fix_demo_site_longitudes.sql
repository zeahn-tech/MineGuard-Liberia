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
update public.sites
   set longitude = -longitude
 where notes = 'Synthetic demonstration record — not real operational data.'
   and name like 'Demo %'
   and longitude > 0
   and -longitude between -11.6 and -7.3;
