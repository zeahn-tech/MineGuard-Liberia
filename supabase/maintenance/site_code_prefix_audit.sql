-- ============================================================================
-- READ-ONLY audit — run on staging / production BEFORE applying migration 0062 (it also works after).
-- It changes nothing: every statement is a SELECT, wrapped in a read-only transaction.
-- It answers: do the existing site codes and counties fit the frozen county → prefix table in 0062?
-- Anything it lists is reported, never rewritten, and never makes the migration fail.
--   psql "$DATABASE_URL" -f supabase/maintenance/site_code_prefix_audit.sql
-- ============================================================================
begin read only;

-- (each query below carries the mapping 0062 freezes — identical to the app's old "first six letters" rule — in its own
-- WITH clause, because a read-only transaction cannot create even a temporary view)

\echo '== 1. Distinct code prefixes in use (prefix, sites, highest number) — each becomes a counter row'
select coalesce((regexp_match(code, '^MGL-([A-Z]+)-([0-9]+)$'))[1], '(not MGL-<LETTERS>-<digits>)') as prefix,
       count(*) as sites,
       max(((regexp_match(code, '^MGL-([A-Z]+)-([0-9]+)$'))[2])::bigint) as highest_number
  from public.sites group by 1 order by 1;

\echo '== 2. Counties as typed in existing sites, and whether the lookup resolves them (county_key = letters only, lowercase)'
with _map(county_key, prefix) as (values
  ('bomi','BOMI'),('bong','BONG'),('gbarpolu','GBARPO'),('grandbassa','GRANDB'),('grandcapemount','GRANDC'),
  ('grandgedeh','GRANDG'),('grandkru','GRANDK'),('lofa','LOFA'),('margibi','MARGIB'),('maryland','MARYLA'),
  ('montserrado','MONTSE'),('nimba','NIMBA'),('rivercess','RIVERC'),('rivergee','RIVERG'),('sinoe','SINOE'))
select s.county as county_as_typed,
       lower(regexp_replace(coalesce(s.county,''), '[^A-Za-z]', '', 'g')) as county_key,
       m.prefix as resolves_to_prefix,
       count(*) as sites
  from public.sites s
  left join _map m on m.county_key = lower(regexp_replace(coalesce(s.county,''), '[^A-Za-z]', '', 'g'))
 group by 1, 2, 3 order by (m.prefix is null) desc, 1;

\echo '== 3. UNRESOLVED counties (must be empty; if not, these rows keep working but cannot change county until corrected by the Ministry)'
with _map(county_key, prefix) as (values
  ('bomi','BOMI'),('bong','BONG'),('gbarpolu','GBARPO'),('grandbassa','GRANDB'),('grandcapemount','GRANDC'),
  ('grandgedeh','GRANDG'),('grandkru','GRANDK'),('lofa','LOFA'),('margibi','MARGIB'),('maryland','MARYLA'),
  ('montserrado','MONTSE'),('nimba','NIMBA'),('rivercess','RIVERC'),('rivergee','RIVERG'),('sinoe','SINOE'))
select s.id, s.code, s.county from public.sites s
 where not exists (select 1 from _map m where m.county_key = lower(regexp_replace(coalesce(s.county,''), '[^A-Za-z]', '', 'g')))
 order by s.county, s.code;

\echo '== 4. Codes whose prefix differs from their county''s prefix (informational: a site that moved county keeps its code)'
with _map(county_key, prefix) as (values
  ('bomi','BOMI'),('bong','BONG'),('gbarpolu','GBARPO'),('grandbassa','GRANDB'),('grandcapemount','GRANDC'),
  ('grandgedeh','GRANDG'),('grandkru','GRANDK'),('lofa','LOFA'),('margibi','MARGIB'),('maryland','MARYLA'),
  ('montserrado','MONTSE'),('nimba','NIMBA'),('rivercess','RIVERC'),('rivergee','RIVERG'),('sinoe','SINOE'))
select s.id, s.code, s.county, m.prefix as county_prefix
  from public.sites s
  join _map m on m.county_key = lower(regexp_replace(coalesce(s.county,''), '[^A-Za-z]', '', 'g'))
 where (regexp_match(s.code, '^MGL-([A-Z]+)-'))[1] is distinct from m.prefix
 order by s.code;

\echo '== 5. Codes that do not match MGL-<LETTERS>-<4+ digits> (must be empty before any strict format check is considered)'
select id, code, county from public.sites where code !~ '^MGL-[A-Z]+-[0-9]{4,}$' order by code;

\echo '== 6. Companies that already collide on normalised name (non-deactivated). If any: 0062 skips the name index with a WARNING, still blocks NEW duplicates'
select lower(regexp_replace(name, '[^[:alnum:]]', '', 'g')) as name_norm, count(*) as companies, array_agg(name order by name) as names
  from public.organizations where status <> 'deactivated'
 group by 1 having count(*) > 1;

\echo '== 7. Companies with no licence number (all of them before 0062): the registrar to-do list afterwards'
select status, count(*) from public.organizations where status <> 'deactivated' group by 1 order by 1;

rollback;
