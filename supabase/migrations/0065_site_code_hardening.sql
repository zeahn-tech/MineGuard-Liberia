-- ============================================================================
-- MINEGUARD LIBERIA — migration 0065: site-code hardening + company identity
--
-- WHAT. (1) Site codes are allocated IN THE DATABASE: a per-county-prefix counter row is incremented atomically
-- (INSERT … ON CONFLICT DO UPDATE … RETURNING takes the row lock), so two simultaneous registrations can never receive the
-- same code. A BEFORE INSERT trigger on sites assigns the code; the app no longer computes one. (2) sites.code is immutable.
-- (3) A new site's county must be one of Liberia's 15 official counties; the county → code-prefix mapping is an explicit table
-- (public.county_codes) frozen to the prefixes the app has always produced ("first 6 letters"), so every existing code stays
-- valid and unchanged. (4) Companies gain a Ministry licence number (mandatory for NEW companies, NULL allowed for existing),
-- unique on a normalised form among every company except deactivated ones, plus a unique normalised name under the same rule.
-- Existing companies without a number cannot REQUEST new sites until one is added (their sites and operations are untouched).
--
-- NOT CHANGED. Worker Voice / Ministry Voice site codes (0047/0053) and community-report tracking codes (CR-…) are separate
-- and untouched. Existing sites.code values are never rewritten. No existing site's county is rewritten or validated.
--
-- DECISIONS (see docs): the code-format rule is enforced INSIDE the insert trigger (new rows only), not as a CHECK … NOT VALID:
-- a NOT VALID check still fires on every UPDATE of a legacy row, so one oddly formatted old code would block unrelated edits
-- (status changes) of that site. The trigger gives the same guarantee for new inserts with no such hazard.
-- "Rejected" companies do not exist in this schema; the retired state is 'deactivated', which is the only status excluded
-- from the duplicate rules (pending_review, approved and suspended all still count).
--
-- Idempotent. One transaction. Existing data is not modified except: counter rows are created from the current maximum per
-- prefix, and if (and only if) existing companies already collide on normalised name the name index is skipped with a WARNING
-- (the trigger below still blocks new collisions) — the migration never fails on legacy data.
--
-- ROLLBACK (data-safe; nothing user-visible is lost):
--   drop trigger if exists sites_code_guard on public.sites;
--   drop trigger if exists organizations_identity_guard on public.organizations;
--   drop function public.mg_sites_code_guard(), public.mg_organizations_identity_guard(),
--     public.mg_allocate_site_code(text), public.mg_county_prefix(text), public.mg_norm_name(text),
--     public.mg_norm_licence(text), public.mg_validate_licence(text), public.mg_licence_format_recognised(text),
--     public.mg_company_registration_check(text, text), public.mg_set_company_licence(uuid, text);
--   drop index if exists public.organizations_licence_norm_uq, public.organizations_name_norm_uq;
--   alter table public.organizations drop column licence_number_norm, drop column name_norm, drop column licence_number;
--   drop table public.site_code_counters, public.county_codes;
--   then restore mg_register_company(text) from 0025 and mg_request_site from 0037, and re-grant as those migrations did
--   (drop function public.mg_register_company(text, text) first). Codes already issued stay valid in every case.
-- ============================================================================

begin;

-- A. county → code prefix (explicit, frozen) ------------------------------------------------------
create table if not exists public.county_codes (
  county     text primary key,
  prefix     text not null unique check (prefix ~ '^[A-Z]{3,8}$'),
  county_key text not null unique check (county_key ~ '^[a-z]+$')
);

insert into public.county_codes (county, prefix, county_key) values
  ('Bomi',             'BOMI',   'bomi'),
  ('Bong',             'BONG',   'bong'),
  ('Gbarpolu',         'GBARPO', 'gbarpolu'),
  ('Grand Bassa',      'GRANDB', 'grandbassa'),
  ('Grand Cape Mount', 'GRANDC', 'grandcapemount'),
  ('Grand Gedeh',      'GRANDG', 'grandgedeh'),
  ('Grand Kru',        'GRANDK', 'grandkru'),
  ('Lofa',             'LOFA',   'lofa'),
  ('Margibi',          'MARGIB', 'margibi'),
  ('Maryland',         'MARYLA', 'maryland'),
  ('Montserrado',      'MONTSE', 'montserrado'),
  ('Nimba',            'NIMBA',  'nimba'),
  ('River Cess',       'RIVERC', 'rivercess'),
  ('River Gee',        'RIVERG', 'rivergee'),
  ('Sinoe',            'SINOE',  'sinoe')
on conflict (county) do nothing;

-- definer-only reference data: RLS on, no policy, no client grant (the app's county list is src/lib/counties.ts)
alter table public.county_codes enable row level security;
revoke all on public.county_codes from public, anon, authenticated;

-- B. per-prefix counters (touched only by the definer allocator) ------------------------------
create table if not exists public.site_code_counters (
  prefix      text primary key check (prefix ~ '^[A-Z]+$'),
  last_number integer not null check (last_number >= 0)
);
alter table public.site_code_counters enable row level security;
revoke all on public.site_code_counters from public, anon, authenticated;

-- initialised from the CURRENT maximum per prefix; codes that are not MGL-<LETTERS>-<digits> are ignored (never rewritten)
insert into public.site_code_counters (prefix, last_number)
select m[1], max(m[2]::integer)
  from (select regexp_match(code, '^MGL-([A-Z]+)-([0-9]{1,9})$') as m from public.sites) s
 where m is not null
 group by m[1]
on conflict (prefix) do update
  set last_number = greatest(public.site_code_counters.last_number, excluded.last_number);

-- C. allocator -----------------------------------------------------------------------------------------
create or replace function public.mg_county_prefix(p_county text)
returns text
language plpgsql stable
security definer set search_path = public
as $mg$
declare
  v_key text := lower(regexp_replace(coalesce(p_county, ''), '[^A-Za-z]', '', 'g'));
  v_prefix text;
begin
  select prefix into v_prefix from public.county_codes where county_key = v_key;
  if v_prefix is null then
    -- SQLSTATE 22023 (invalid_parameter_value). NOTE: the pre-0065 app does not surface this text — backendError drops the
    -- SQLSTATE and the user sees its generic "We couldn't register the site" message (documented in docs/27, deploy window).
    raise exception 'INVALID_COUNTY: "%" is not one of the 15 counties of Liberia', btrim(coalesce(p_county, ''))
      using errcode = '22023';
  end if;
  return v_prefix;
end;
$mg$;

create or replace function public.mg_allocate_site_code(p_county text)
returns text
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_prefix text := public.mg_county_prefix(p_county);
  v_n integer;
  v_code text;
begin
  loop
    -- the conflict clause row-locks the counter until this transaction ends: allocation is serialised per prefix
    insert into public.site_code_counters as c (prefix, last_number) values (v_prefix, 1)
    on conflict (prefix) do update set last_number = c.last_number + 1
    returning last_number into v_n;
    v_code := 'MGL-' || v_prefix || '-' || lpad(v_n::text, 4, '0');
    -- defence in depth: never hand out a code that already exists (e.g. loaded by owner-run SQL beyond the counter)
    exit when not exists (select 1 from public.sites where code = v_code);
  end loop;
  return v_code;
end;
$mg$;

create or replace function public.mg_sites_code_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
declare
  m text[];
begin
  if tg_op = 'UPDATE' then
    if new.code is distinct from old.code then
      raise exception 'CODE_IMMUTABLE: a site code is permanent and cannot be changed';
    end if;
    if new.county is distinct from old.county then
      perform public.mg_county_prefix(new.county);   -- raises INVALID_COUNTY; the code itself never changes
    end if;
    return new;
  end if;

  -- INSERT: the county must be official
  perform public.mg_county_prefix(new.county);

  if auth.uid() is not null or nullif(btrim(coalesce(new.code, '')), '') is null then
    -- every signed-in session gets a database-allocated code (a client-supplied one is ignored)
    new.code := public.mg_allocate_site_code(new.county);
  else
    -- owner-run SQL (loads, seeds, restores) may supply a code, but it must be well-formed, and the counter is kept ahead of it
    m := regexp_match(new.code, '^MGL-([A-Z]+)-([0-9]{4,9})$');
    if m is null then
      raise exception 'INVALID_CODE_FORMAT: site codes look like MGL-BOMI-0001' using errcode = '22023';
    end if;
    insert into public.site_code_counters as c (prefix, last_number) values (m[1], m[2]::integer)
    on conflict (prefix) do update set last_number = greatest(c.last_number, excluded.last_number);
  end if;
  return new;
end;
$mg$;

drop trigger if exists sites_code_guard on public.sites;
create trigger sites_code_guard before insert or update on public.sites
  for each row execute function public.mg_sites_code_guard();

-- D. company identity: licence number + normalised name ------------------------------------------------------
-- (the generated columns below inline the same expressions as these helpers: a generated column is evaluated with the
-- CALLER's privileges, and the helpers are deliberately not executable by client roles)
create or replace function public.mg_norm_name(p_name text)
returns text language sql immutable
as $mg$ select lower(regexp_replace(coalesce(p_name, ''), '[^[:alnum:]]', '', 'g')) $mg$;

-- uppercase, spaces and hyphens removed, "/" kept
create or replace function public.mg_norm_licence(p_licence text)
returns text language sql immutable
as $mg$ select nullif(upper(regexp_replace(coalesce(p_licence, ''), '[[:space:]-]', '', 'g')), '') $mg$;

create or replace function public.mg_licence_format_recognised(p_licence text)
returns boolean language sql immutable
as $mg$
  select coalesce(public.mg_norm_licence(p_licence) ~ '^[A-Z]{3}[0-9]{4}/[0-9]{2}$'
               or public.mg_norm_licence(p_licence) ~ '^MEL[0-9]{7}$', false)
$mg$;

-- hard validation; returns the trimmed value as typed
create or replace function public.mg_validate_licence(p_licence text)
returns text
language plpgsql immutable
as $mg$
declare
  v_raw  text := nullif(btrim(coalesce(p_licence, '')), '');
  v_norm text;
begin
  if v_raw is null then
    raise exception 'LICENCE_REQUIRED: enter the Ministry licence number';
  end if;
  if upper(v_raw) ~ '^APL[[:space:]]*-' then
    raise exception 'INVALID_LICENCE: "APL-…" is a cadastre application number, not a licence number. Enter the licence number issued by the Ministry';
  end if;
  if upper(v_raw) ~ '^CLC[[:space:]]*-' then
    raise exception 'INVALID_LICENCE: "CLC-…" is a licence category code, not a licence number. Enter the licence number issued by the Ministry';
  end if;
  v_norm := public.mg_norm_licence(v_raw);
  if v_norm is null or char_length(v_norm) < 5 or char_length(v_norm) > 30 then
    raise exception 'INVALID_LICENCE: the licence number must be 5 to 30 characters (spaces and hyphens are ignored)';
  end if;
  if v_norm !~ '^[A-Z0-9/]+$' then
    raise exception 'INVALID_LICENCE: use letters, digits and "/" only';
  end if;
  if v_norm !~ '[0-9]' then
    raise exception 'INVALID_LICENCE: the licence number must contain at least one digit';
  end if;
  return v_raw;
end;
$mg$;

alter table public.organizations add column if not exists licence_number text;
alter table public.organizations add column if not exists licence_number_norm text
  generated always as (nullif(upper(regexp_replace(coalesce(licence_number, ''), '[[:space:]-]', '', 'g')), '')) stored;
alter table public.organizations add column if not exists name_norm text
  generated always as (lower(regexp_replace(coalesce(name, ''), '[^[:alnum:]]', '', 'g'))) stored;

-- licence: no legacy values exist, so this cannot fail
create unique index if not exists organizations_licence_norm_uq
  on public.organizations (licence_number_norm)
  where licence_number_norm is not null and status <> 'deactivated';

-- name: created only when no existing companies already collide (never fails the migration); the trigger below guards either way
do $mg$
begin
  if exists (select 1 from public.organizations where status <> 'deactivated'
              group by name_norm having count(*) > 1) then
    raise warning 'organizations_name_norm_uq NOT created: existing companies share a normalised name. Resolve them (see the 0065 notes) and re-run this migration; new duplicates are still blocked by the trigger.';
  else
    create unique index if not exists organizations_name_norm_uq
      on public.organizations (name_norm) where status <> 'deactivated';
  end if;
end
$mg$;

-- friendly, race-safe errors (the unique indexes are the final arbiter; this adds a lock + readable messages
-- and covers the case where the name index had to be skipped)
create or replace function public.mg_organizations_identity_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_name_norm text := public.mg_norm_name(new.name);
  v_lic_norm  text := public.mg_norm_licence(new.licence_number);
  v_other     text;
begin
  if new.status = 'deactivated' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'deactivated'
     and v_name_norm is not distinct from public.mg_norm_name(old.name)
     and v_lic_norm is not distinct from public.mg_norm_licence(old.licence_number) then
    return new;   -- nothing identity-related changed (e.g. suspend / approve): never block on legacy data
  end if;
  perform pg_advisory_xact_lock(hashtext('mg_org_identity'));
  select o.name into v_other from public.organizations o
   where o.id <> new.id and o.status <> 'deactivated' and public.mg_norm_name(o.name) = v_name_norm limit 1;
  if v_other is not null then
    raise exception 'DUPLICATE_ORGANIZATION: a company named "%" is already registered (names are compared ignoring case, spaces and punctuation)', v_other;
  end if;
  if v_lic_norm is not null then
    select o.name into v_other from public.organizations o
     where o.id <> new.id and o.status <> 'deactivated' and public.mg_norm_licence(o.licence_number) = v_lic_norm limit 1;
    if v_other is not null then
      raise exception 'DUPLICATE_LICENCE: this licence number is already registered to "%"', v_other;
    end if;
  end if;
  return new;
end;
$mg$;

drop trigger if exists organizations_identity_guard on public.organizations;
create trigger organizations_identity_guard before insert or update on public.organizations
  for each row execute function public.mg_organizations_identity_guard();

-- E. registrar RPCs ---------------------------------------------------------------------------------------------------
-- preview for the registrar: hard errors, the soft format warning and near-match duplicates (never blocks by itself)
create or replace function public.mg_company_registration_check(p_name text, p_licence text default null)
returns jsonb
language plpgsql stable
security definer set search_path = public
as $mg$
declare
  v_nn text := public.mg_norm_name(p_name);
  v_ln text := public.mg_norm_licence(p_licence);
  v_err text := null;
  v_dups jsonb;
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  if nullif(btrim(coalesce(p_licence, '')), '') is not null then
    begin
      perform public.mg_validate_licence(p_licence);
    exception when others then
      v_err := sqlerrm;
    end;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'name', o.name, 'status', o.status, 'licenceNumber', o.licence_number,
           'reason', case when o.licence_number_norm is not null and o.licence_number_norm = v_ln then 'same_licence'
                          when o.name_norm = v_nn then 'same_name'
                          else 'similar_name' end)
         order by o.name), '[]'::jsonb)
    into v_dups
    from public.organizations o
   where (v_ln is not null and o.licence_number_norm = v_ln)
      or (char_length(v_nn) >= 4 and o.name_norm <> '' and
          (o.name_norm = v_nn
           or (char_length(o.name_norm) >= 4 and (o.name_norm like '%' || v_nn || '%' or v_nn like '%' || o.name_norm || '%'))));
  return jsonb_build_object(
    'licenceError', v_err,
    'formatRecognised', case when v_err is null and v_ln is not null then public.mg_licence_format_recognised(p_licence) else null end,
    'duplicates', v_dups);
end;
$mg$;

-- the one-argument form of 0025 is replaced: a licence number is mandatory for a NEW company. The default keeps an
-- old client (still sending only p_name) from hitting "function not found": it gets LICENCE_REQUIRED instead.
drop function if exists public.mg_register_company(text);
create or replace function public.mg_register_company(p_name text, p_licence text default null)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_lic  text;
  v_id   uuid;
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 200 then
    raise exception 'INVALID_NAME: company name must be 2-200 characters';
  end if;
  v_lic := public.mg_validate_licence(p_licence);
  begin
    insert into public.organizations (name, kind, status, status_changed_at, status_changed_by, licence_number)
    values (v_name, 'operator', 'approved', now(), auth.uid(), v_lic)
    returning id into v_id;
  exception when unique_violation then
    -- lost a race against another registrar: report it in the same terms as the trigger
    if exists (select 1 from public.organizations where status <> 'deactivated' and public.mg_norm_licence(licence_number) = public.mg_norm_licence(v_lic)) then
      raise exception 'DUPLICATE_LICENCE: this licence number is already registered to another company';
    end if;
    raise exception 'DUPLICATE_ORGANIZATION: a company with this name already exists';
  end;
  return v_id;
end;
$mg$;

-- registrar: add (or correct) the licence number of an existing company
create or replace function public.mg_set_company_licence(p_org uuid, p_licence text)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  v_lic text;
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  v_lic := public.mg_validate_licence(p_licence);
  begin
    update public.organizations set licence_number = v_lic where id = p_org;
  exception when unique_violation then
    raise exception 'DUPLICATE_LICENCE: this licence number is already registered to another company';
  end;
  if not found then raise exception 'NOT_FOUND: company'; end if;
end;
$mg$;

-- F. company site requests: a licence number is required, and the county must be official ----------------------------
-- (body of 0037's mg_request_site plus the two checks marked NEW)
create or replace function public.mg_request_site(
  p_org uuid, p_name text, p_county text, p_district text, p_community text,
  p_mineral text, p_lat double precision, p_lng double precision, p_notes text)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_county text := btrim(coalesce(p_county, ''));
  v_id uuid;
  v_org public.organizations;
  r record;
begin
  if auth.uid() is null
     or not exists (select 1 from public.organization_members m
                     where m.user_id = auth.uid() and m.organization_id = p_org
                       and m.org_role = 'company_admin' and m.status = 'active') then
    raise exception 'FORBIDDEN: only a company administrator can request a site';
  end if;
  select * into v_org from public.organizations where id = p_org;
  if not found or v_org.status <> 'approved' then raise exception 'ORG_NOT_APPROVED'; end if;
  -- NEW: legacy companies must have a Ministry licence number before asking for another site
  if v_org.licence_number is null then
    raise exception 'LICENCE_REQUIRED: the Ministry has not recorded a licence number for this company yet. Ask the Ministry registrar to add it before requesting new sites';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'INVALID_NAME: site name must be 2 to 120 characters';
  end if;
  -- NEW: official county list (raises INVALID_COUNTY)
  perform public.mg_county_prefix(v_county);
  if (p_lat is null) <> (p_lng is null) or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'INVALID_POSITION: give both latitude and longitude, within range';
  end if;

  -- retry-safe: the same pending request is returned, never duplicated
  select id into v_id from public.site_registration_requests
   where organization_id = p_org and status = 'pending' and lower(name) = lower(v_name);
  if found then return v_id; end if;
  if (select count(*) from public.site_registration_requests
       where organization_id = p_org and status = 'pending') >= 20 then
    raise exception 'TOO_MANY_PENDING: wait for the Ministry to review the open requests';
  end if;

  insert into public.site_registration_requests
    (organization_id, requested_by, name, county, district, community, mineral_type, latitude, longitude, notes)
  values (p_org, auth.uid(), v_name, v_county,
          nullif(btrim(coalesce(p_district, '')), ''), nullif(btrim(coalesce(p_community, '')), ''),
          nullif(btrim(coalesce(p_mineral, '')), ''), p_lat, p_lng, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_id;

  for r in select id from public.profiles where role = 'admin' and deleted_at is null loop
    perform public.mg_notify(r.id, 'sreq:' || v_id, 'org_site_request', 'info',
      'New site registration request', v_org.name || ' asked to register a site. Review it in Site requests.',
      '/portal/site-requests');
  end loop;
  return v_id;
end;
$mg$;

-- G. grants -------------------------------------------------------------------------------------------------------------
-- internal helpers: reachable only through the trigger / other definer functions, never by a client role
do $mg$
declare f text;
begin
  foreach f in array array[
    'mg_county_prefix(text)',
    'mg_allocate_site_code(text)',
    'mg_sites_code_guard()',
    'mg_organizations_identity_guard()',
    'mg_norm_name(text)',
    'mg_norm_licence(text)',
    'mg_licence_format_recognised(text)',
    'mg_validate_licence(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- client RPCs: signed-in only, each self-authorizes
  foreach f in array array[
    'mg_company_registration_check(text, text)',
    'mg_register_company(text, text)',
    'mg_set_company_licence(uuid, text)',
    'mg_request_site(uuid, text, text, text, text, text, double precision, double precision, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end
$mg$;

commit;
