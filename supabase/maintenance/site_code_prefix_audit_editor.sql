-- ============================================================================
-- READ-ONLY audit for the Supabase SQL editor (no psql commands). Run it BEFORE applying migration 0065.
-- One SELECT only: it cannot change anything. It returns one table: section | detail | result.
-- How to read it: see docs/27 ("Running the audit yourself"). Sections 3, 4, 5, 6 should return NO rows.
-- ============================================================================
with m(county_key, prefix) as (values
  ('bomi','BOMI'),('bong','BONG'),('gbarpolu','GBARPO'),('grandbassa','GRANDB'),('grandcapemount','GRANDC'),
  ('grandgedeh','GRANDG'),('grandkru','GRANDK'),('lofa','LOFA'),('margibi','MARGIB'),('maryland','MARYLA'),
  ('montserrado','MONTSE'),('nimba','NIMBA'),('rivercess','RIVERC'),('rivergee','RIVERG'),('sinoe','SINOE')),
s as (select code, county, lower(regexp_replace(coalesce(county,''), '[^A-Za-z]', '', 'g')) as k from public.sites)
select '0 overview' as section, 'sites / companies / latest applied migration' as detail,
       (select count(*) from public.sites) || ' / ' || (select count(*) from public.organizations) || ' / ' || (select max(version) from supabase_migrations.schema_migrations) as result
union all
select '0 overview', 'is 0065 already applied?',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '0065') then 'ALREADY APPLIED' else 'not applied (expected)' end
union all
select '1 prefixes in use', coalesce((regexp_match(code, '^MGL-([A-Z]+)-([0-9]+)$'))[1], '(not MGL-<LETTERS>-<digits>)'),
       count(*) || ' site(s), highest number ' || coalesce(max(((regexp_match(code, '^MGL-([A-Z]+)-([0-9]+)$'))[2])::bigint)::text, '-')
  from public.sites group by 2
union all
select '2 counties as typed', coalesce(s.county, '(empty)'), count(*) || ' site(s) -> ' || coalesce(m.prefix, 'UNRESOLVED')
  from s left join m on m.county_key = s.k group by s.county, m.prefix
union all
select '3 UNRESOLVED counties (expect none)', s.code, coalesce(s.county, '(empty)')
  from s where not exists (select 1 from m where m.county_key = s.k)
union all
select '4 code prefix differs from its county (informational)', s.code, s.county || ' (county prefix ' || m.prefix || ')'
  from s join m on m.county_key = s.k where (regexp_match(s.code, '^MGL-([A-Z]+)-'))[1] is distinct from m.prefix
union all
select '5 code not MGL-<LETTERS>-<at least 4 digits> (expect none)', code, coalesce(county, '(empty)')
  from public.sites where code !~ '^MGL-[A-Z]+-[0-9]{4,}$'
union all
select '6 company names that collide (expect none)', lower(regexp_replace(name, '[^[:alnum:]]', '', 'g')), string_agg(name, '  |  ' order by name)
  from public.organizations where status <> 'deactivated'
 group by 2 having count(*) > 1
union all
select '7 companies by status (none has a licence yet)', status::text, count(*)::text from public.organizations group by status
order by 1, 2;
