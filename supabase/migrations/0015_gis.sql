-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0015: GIS (Session 6, GIS-1…5)
--
-- GIS-1 BOUNDARIES — validated GeoJSON (not PostGIS: the extension is not
--   available on every deploy target nor in the PGlite test harness, and the
--   scope allows either). Two tables:
--     admin_boundaries  one polygon per admin_areas row (county/district/…)
--     site_boundaries   one polygon per mining site
--   A CHECK constraint (mg_valid_geojson_polygon) rejects anything that is
--   not a closed, in-range Polygon/MultiPolygon inside Liberia's bounding
--   box. NO boundary data is seeded or fabricated — the tables ship empty
--   until an authoritative source is loaded (master directive).
--
-- GIS-3 PROVENANCE — every geolocated record carries geo_source,
--   geo_accuracy_m and geo_verified. Default is UNVERIFIED. A record can
--   only be marked verified with a non-empty source (CHECK), and only
--   through the geo.write permission (guard trigger) — a reporter, inspector
--   or the public RPC can never self-verify a position.
--
-- SCOPE — boundaries read through the same mg_can_access_site() matrix as
--   sites. Community reports (previously readable by ALL staff regardless of
--   county) are now scoped by the staff scope matrix on their county/district.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A. GeoJSON validator (immutable, no table access)
-- ---------------------------------------------------------------------------
create or replace function public.mg_valid_position(p jsonb)
returns boolean
language sql
immutable
as $mg$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) >= 2
     and jsonb_typeof(p -> 0) = 'number'
     and jsonb_typeof(p -> 1) = 'number'
     -- Liberia bounding box (sanity envelope, NOT a boundary): lon -11.6…-7.3,
     -- lat 4.3…8.6. Rejects swapped lat/lng and positions on another continent.
     and (p ->> 0)::double precision between -11.6 and -7.3
     and (p ->> 1)::double precision between 4.3 and 8.6
$mg$;

create or replace function public.mg_valid_ring(r jsonb)
returns boolean
language sql
immutable
as $mg$
  select jsonb_typeof(r) = 'array'
     and jsonb_array_length(r) >= 4
     and (r -> 0) = (r -> (jsonb_array_length(r) - 1))
     and not exists (
       select 1 from jsonb_array_elements(r) e
        where not public.mg_valid_position(e)
     )
$mg$;

create or replace function public.mg_valid_polygon_coords(c jsonb)
returns boolean
language sql
immutable
as $mg$
  select jsonb_typeof(c) = 'array'
     and jsonb_array_length(c) >= 1
     and not exists (
       select 1 from jsonb_array_elements(c) r
        where not public.mg_valid_ring(r)
     )
$mg$;

-- SECURITY DEFINER (pure — reads no table): CHECK constraints run this as the
-- writing role, so it is the ONE validator granted to `authenticated`; its
-- helpers above stay closed and are reached only through this definer body.
create or replace function public.mg_valid_geojson_polygon(g jsonb)
returns boolean
language sql
immutable
security definer set search_path = public
as $mg$
  select case
    when g is null or jsonb_typeof(g) <> 'object' then false
    when g ->> 'type' = 'Polygon'
      then public.mg_valid_polygon_coords(g -> 'coordinates')
    when g ->> 'type' = 'MultiPolygon'
      then jsonb_typeof(g -> 'coordinates') = 'array'
       and jsonb_array_length(g -> 'coordinates') >= 1
       and not exists (
         select 1 from jsonb_array_elements(g -> 'coordinates') p
          where not public.mg_valid_polygon_coords(p)
       )
    else false
  end
$mg$;

-- ---------------------------------------------------------------------------
-- B. Provenance columns on every geolocated record (GIS-3)
-- ---------------------------------------------------------------------------
alter table public.sites
  add column if not exists geo_source     text,
  add column if not exists geo_accuracy_m double precision,
  add column if not exists geo_verified   boolean not null default false;

alter table public.inspections
  add column if not exists geo_source   text,
  add column if not exists geo_verified boolean not null default false;

alter table public.environmental_observations
  add column if not exists geo_source     text,
  add column if not exists geo_accuracy_m double precision,
  add column if not exists geo_verified   boolean not null default false;

alter table public.community_reports
  add column if not exists geo_source     text,
  add column if not exists geo_accuracy_m double precision,
  add column if not exists geo_verified   boolean not null default false;

do $do$
declare t text;
begin
  foreach t in array array['sites','inspections','environmental_observations','community_reports']
  loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_geo_verified_needs_source');
    execute format(
      'alter table public.%I add constraint %I check (not geo_verified or (geo_source is not null and length(btrim(geo_source)) > 0))',
      t, t || '_geo_verified_needs_source');
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_geo_accuracy_nonneg');
  end loop;
end $do$;

alter table public.sites
  add constraint sites_geo_accuracy_nonneg check (geo_accuracy_m is null or geo_accuracy_m >= 0);
alter table public.environmental_observations
  add constraint environmental_observations_geo_accuracy_nonneg check (geo_accuracy_m is null or geo_accuracy_m >= 0);
alter table public.community_reports
  add constraint community_reports_geo_accuracy_nonneg check (geo_accuracy_m is null or geo_accuracy_m >= 0);

-- Backfill honest provenance for rows that already carry coordinates. They
-- stay UNVERIFIED: nothing in the data proves an authoritative source.
update public.sites set geo_source = 'registry_entry'
 where geo_source is null and latitude is not null and longitude is not null;
update public.inspections set geo_source = 'device_gps'
 where geo_source is null and latitude is not null and longitude is not null;
update public.environmental_observations set geo_source = 'device_gps_or_manual'
 where geo_source is null and latitude is not null and longitude is not null;
update public.community_reports set geo_source = 'public_report'
 where geo_source is null and latitude is not null and longitude is not null;

-- Only geo.write holders may set/alter verification or provenance of an
-- EXISTING position, and nobody may insert a pre-verified row from the client
-- roles. System roles (service_role, postgres, definer RPCs) pass through.
create or replace function public.mg_guard_geo_verification()
returns trigger
language plpgsql
security invoker set search_path = public
as $mg$
begin
  -- Honest default provenance for any position written without one (also
  -- covers the definer RPC that stores public community reports).
  if new.geo_source is null and new.latitude is not null and new.longitude is not null then
    new.geo_source := case tg_table_name
      when 'sites' then 'registry_entry'
      when 'inspections' then 'device_gps'
      when 'environmental_observations' then 'device_gps_or_manual'
      else 'public_report' end;
  end if;
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.geo_verified and not public.mg_has_permission('geo.write') then
      raise exception 'FORBIDDEN: geo.write required to verify a position';
    end if;
  elsif tg_op = 'UPDATE' then
    if (new.geo_verified is distinct from old.geo_verified
        or (new.geo_verified and new.geo_source is distinct from old.geo_source))
       and not public.mg_has_permission('geo.write') then
      raise exception 'FORBIDDEN: geo.write required to verify a position';
    end if;
    -- Moving a verified point invalidates its verification.
    if old.geo_verified and new.geo_verified
       and (new.latitude is distinct from old.latitude
            or new.longitude is distinct from old.longitude) then
      new.geo_verified := false;
    end if;
  end if;
  return new;
end;
$mg$;

do $do$
declare t text;
begin
  foreach t in array array['sites','inspections','environmental_observations','community_reports']
  loop
    execute format('drop trigger if exists mg_geo_verification_guard on public.%I', t);
    execute format(
      'create trigger mg_geo_verification_guard before insert or update on public.%I for each row execute function public.mg_guard_geo_verification()',
      t);
  end loop;
end $do$;

-- ---------------------------------------------------------------------------
-- C. Boundary tables (GIS-1)
-- ---------------------------------------------------------------------------
create table if not exists public.admin_boundaries (
  id               uuid primary key default gen_random_uuid(),
  admin_area_id    uuid references public.admin_areas(id),
  name             text not null,
  level            text not null
                   check (level in ('national','region','county','district','community')),
  parent_id        uuid references public.admin_boundaries(id),
  geometry_geojson jsonb not null
                   check (public.mg_valid_geojson_polygon(geometry_geojson)),
  source           text not null check (length(btrim(source)) > 0),
  accuracy_m       double precision check (accuracy_m is null or accuracy_m >= 0),
  geo_verified     boolean not null default false,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now()
);
create unique index if not exists admin_boundaries_area_key
  on public.admin_boundaries (admin_area_id) where admin_area_id is not null;

create table if not exists public.site_boundaries (
  id               uuid primary key default gen_random_uuid(),
  site_id          uuid not null unique references public.sites(id),
  geometry_geojson jsonb not null
                   check (public.mg_valid_geojson_polygon(geometry_geojson)),
  source           text not null check (length(btrim(source)) > 0),
  accuracy_m       double precision check (accuracy_m is null or accuracy_m >= 0),
  geo_verified     boolean not null default false,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now()
);

alter table public.admin_boundaries enable row level security;
alter table public.site_boundaries  enable row level security;

-- Administrative geography is reference data: every signed-in, non-guest
-- account may read it (operators need county context for their own sites).
drop policy if exists "admin_boundaries read" on public.admin_boundaries;
create policy "admin_boundaries read" on public.admin_boundaries
  for select to authenticated
  using (public.mg_is_staff() or (select role from public.mg_profile()) = 'operator');

drop policy if exists "admin_boundaries write" on public.admin_boundaries;
create policy "admin_boundaries write" on public.admin_boundaries
  for all to authenticated
  using (public.mg_has_permission('geo.write'))
  with check (public.mg_has_permission('geo.write'));

-- Site outlines follow the SITE visibility matrix exactly.
drop policy if exists "site_boundaries read" on public.site_boundaries;
create policy "site_boundaries read" on public.site_boundaries
  for select to authenticated
  using (public.mg_can_access_site(site_id));

drop policy if exists "site_boundaries write" on public.site_boundaries;
create policy "site_boundaries write" on public.site_boundaries
  for all to authenticated
  using (public.mg_has_permission('geo.write'))
  with check (public.mg_has_permission('geo.write'));

-- Verification of a boundary is itself a geo.write act (the write policy
-- requires it). Every boundary write is audited server-side in the same
-- transaction (SEC-1 pattern: mg_audit_row derives the actor from the session).
drop trigger if exists admin_boundaries_audit on public.admin_boundaries;
create trigger admin_boundaries_audit after insert or update on public.admin_boundaries
  for each row execute function public.mg_audit_row();
drop trigger if exists site_boundaries_audit on public.site_boundaries;
create trigger site_boundaries_audit after insert or update on public.site_boundaries
  for each row execute function public.mg_audit_row();

grant select, insert, update, delete on public.admin_boundaries to authenticated;
grant select, insert, update, delete on public.site_boundaries  to authenticated;

-- ---------------------------------------------------------------------------
-- D. Scope-filter community reports (previously: every staff account read
--    every report nationally). Same matrix as sites, on county/district.
-- ---------------------------------------------------------------------------
drop policy if exists "reports staff read" on public.community_reports;
create policy "reports staff read" on public.community_reports
  for select using (
    public.mg_is_staff()
    and public.mg_can_access_site_row(null, county, district, null, null)
  );

drop policy if exists "reports staff update" on public.community_reports;
create policy "reports staff update" on public.community_reports
  for update using (
    public.mg_is_staff()
    and public.mg_can_access_site_row(null, county, district, null, null)
  );

-- Execute surface (0011 pin): helpers + trigger fn closed to client roles;
-- only the definer validator is granted to authenticated (CHECK evaluation).
revoke execute on function public.mg_valid_position(jsonb) from public, anon, authenticated;
revoke execute on function public.mg_valid_ring(jsonb) from public, anon, authenticated;
revoke execute on function public.mg_valid_polygon_coords(jsonb) from public, anon, authenticated;
revoke execute on function public.mg_valid_geojson_polygon(jsonb) from public, anon;
grant execute on function public.mg_valid_geojson_polygon(jsonb) to authenticated;
revoke execute on function public.mg_guard_geo_verification() from public, anon, authenticated;
