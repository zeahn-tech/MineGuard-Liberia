-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0022: mark the geoBoundaries administrative
-- areas (15 counties + 136 districts = 151) as VERIFIED.
--
-- The boundary seed originally loaded these rows with geo_verified = false.
-- The owner has confirmed the geoBoundaries gbOpen dataset (UNMIL / OCHA
-- ROWCA) as the authoritative source, so they are now verified.
--
-- Scope is deliberately narrow: only rows whose source is exactly the seed's
-- attribution string are touched. Boundaries an administrator loaded by hand
-- from another source keep whatever verification level they were given.
-- Safe to run more than once. The audit trigger records the change (actor
-- 'system' when run as the migration owner).
-- ===========================================================================

update public.admin_boundaries
   set geo_verified = true
 where geo_verified = false
   and source = 'UNMIL; OCHA ROWCA, via geoBoundaries gbOpen (William & Mary geoLab, www.geoboundaries.org); simplified geometry; CC BY 3.0 IGO';

select level, geo_verified, count(*) as boundaries
  from public.admin_boundaries
 group by level, geo_verified
 order by level, geo_verified;
