-- ============================================================================
-- MINEGUARD LIBERIA — migration 0065: site-code hardening + company identity
--
-- WHAT. (1) Site codes are allocated IN THE DATABASE: a per-county-prefix counter row is incremented atomically
-- (INSERT … ON CONFLICT DO UPDATE … RETURNING takes the row lock), so two simultaneous registrations can never receive the
-- same code. A BEFORE INSERT trigger on sites assigns the code; the app no longer computes one. Numbers are zero-padded to four
-- digits up to 9999 and written in full from 10000 on (MGL-SINOE-9999, MGL-SINOE-10000). (2) sites.code is immutable.
-- (3) A new site's county must be one of Liberia's 15 official counties and is STORED in its canonical spelling; the county →
-- code-prefix mapping is an explicit table (public.county_codes) frozen to the prefixes the app has always produced ("first 6
-- letters"), so every existing code stays valid and unchanged. An owner-run load that supplies its own code must supply the code
-- whose prefix belongs to the site's county. (4) Companies gain a Ministry licence number (mandatory for NEW companies, NULL
-- allowed for existing), validated by a guard on every write, changeable only through mg_set_company_licence with a reason, never
-- clearable; unique on a normalised form among every company except deactivated ones, plus a unique normalised name under the
-- same rule. A company auto-created by an owner-run site insert is never approved: it is created pending review for the registrar.
-- (5) Existing companies without a number may keep REQUESTING new sites only during a time-limited GRACE PERIOD, held in ONE named
-- setting (platform_settings.licence_grace_until_for_site_requests, a real date YYYY-MM-DD). The default (30 days) is written only
-- when the setting is first created; after that, change it with SQL (see docs/27), never by editing this file. Every change to
-- the setting is audited. NULL / blank / past = off. After the grace period they cannot request new sites until a number is added.
-- Their existing sites and operations are never affected.
--
-- NOT CHANGED. Worker Voice / Ministry Voice site codes (0047/0053) and community-report tracking codes (CR-…) are separate
-- and untouched. Existing sites.code and sites.county values are never rewritten.
--
-- DECISIONS: the code-format rule is enforced INSIDE the insert trigger (new rows only), not as a CHECK … NOT VALID: a NOT VALID
-- check still fires on every UPDATE of a legacy row, so one oddly formatted old code would block unrelated edits of that site.
-- "Rejected" companies do not exist in this schema; the retired state is 'deactivated', the only status excluded from the
-- duplicate rules (pending_review, approved and suspended all still count).
--
-- BREAK-GLASS. sites_code_guard (immutability) and organizations_licence_guard can only be bypassed by the table owner with
-- ALTER TABLE … DISABLE TRIGGER. The procedure, with its mandatory audit entry and the verification afterwards, is in docs/27.
--
-- Idempotent. One transaction. Existing data is not modified except: counter rows are created from the current maximum per
-- prefix, and if (and only if) existing companies already collide on normalised name the name index is skipped with a WARNING
-- (the trigger below still blocks new collisions) — the migration never fails on legacy data.
--
-- ROLLBACK: supabase/maintenance/rollback_0065_site_code_hardening.sql (restores the pre-0065 functions verbatim from 0010/0025/
-- 0033/0037; issued site codes stay valid; the licence numbers, counters and the grace setting are dropped with their tables/columns).
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

-- the county's canonical spelling ("bomi", "Bo-mi!!", " GRAND   bassa" -> "Bomi", "Bomi", "Grand Bassa"); raises INVALID_COUNTY
create or replace function public.mg_county_canonical(p_county text)
returns text
language plpgsql stable
security definer set search_path = public
as $mg$
declare
  v_name text;
begin
  select county into v_name from public.county_codes
   where county_key = lower(regexp_replace(coalesce(p_county, ''), '[^A-Za-z]', '', 'g'));
  if v_name is null then
    raise exception 'INVALID_COUNTY: "%" is not one of the 15 counties of Liberia', btrim(coalesce(p_county, ''))
      using errcode = '22023';
  end if;
  return v_name;
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
  v_max bigint;
begin
  loop
    -- the conflict clause row-locks the counter until this transaction ends: allocation is serialised per prefix
    insert into public.site_code_counters as c (prefix, last_number) values (v_prefix, 1)
    on conflict (prefix) do update set last_number = c.last_number + 1
    returning last_number into v_n;
    -- four digits up to 9999, the plain number from 10000 (lpad alone would TRUNCATE 10000 to "1000")
    v_code := 'MGL-' || v_prefix || '-' || case when v_n < 10000 then lpad(v_n::text, 4, '0') else v_n::text end;
    exit when not exists (select 1 from public.sites where code = v_code);
    -- a code that already exists (e.g. loaded by owner-run SQL beyond the counter): jump the counter past EVERY existing code
    -- of this prefix in one step instead of walking through them one by one (no statement-timeout loop)
    select coalesce(max(((regexp_match(s.code, '^MGL-' || v_prefix || '-([0-9]{1,9})$'))[1])::bigint), 0)
      into v_max from public.sites s where s.code like 'MGL-' || v_prefix || '-%';
    if v_max > v_n then
      update public.site_code_counters set last_number = least(v_max, 2000000000)::integer
       where prefix = v_prefix and last_number < v_max;
    end if;
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
  v_prefix text;
begin
  if tg_op = 'UPDATE' then
    if new.code is distinct from old.code then
      raise exception 'CODE_IMMUTABLE: a site code is permanent and cannot be changed';
    end if;
    if new.county is distinct from old.county then
      new.county := public.mg_county_canonical(new.county);   -- raises INVALID_COUNTY; the code itself never changes
    end if;
    return new;
  end if;

  -- INSERT: the county must be official, and is stored in its canonical spelling
  new.county := public.mg_county_canonical(new.county);
  v_prefix := public.mg_county_prefix(new.county);

  if auth.uid() is not null or nullif(btrim(coalesce(new.code, '')), '') is null then
    -- every signed-in session gets a database-allocated code (a client-supplied one is ignored)
    new.code := public.mg_allocate_site_code(new.county);
  else
    -- owner-run SQL (loads, seeds, restores) may supply a code, but it must be well-formed AND carry the prefix of the site's
    -- own county; nothing is written to the counters unless both hold
    m := regexp_match(new.code, '^MGL-([A-Z]+)-([0-9]{4,9})$');
    if m is null then
      raise exception 'INVALID_CODE_FORMAT: site codes look like MGL-BOMI-0001' using errcode = '22023';
    end if;
    if m[1] <> v_prefix then
      raise exception 'CODE_PREFIX_MISMATCH: the code % does not belong to a site in % (its prefix is %)', new.code, new.county, v_prefix
        using errcode = '22023';
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
set search_path = public   -- pure: no table access, and no helper calls, so any role (the invoker-rights guard below) can run it
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
  v_norm := nullif(upper(regexp_replace(v_raw, '[[:space:]-]', '', 'g')), '');   -- same as mg_norm_licence, inlined
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
-- who set / changed the licence number, when, and why (organizations_audit records these columns like any others)
alter table public.organizations add column if not exists licence_change_reason text;
alter table public.organizations add column if not exists licence_changed_at timestamptz;
alter table public.organizations add column if not exists licence_changed_by uuid;
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


-- Licence guard (every write). SECURITY INVOKER on purpose: current_user is then the real caller role, so a direct client UPDATE
-- (role authenticated / anon) can be told apart from mg_set_company_licence (a definer function, running as the owner).
--   * a licence number is validated exactly like mg_validate_licence on every insert and every change (APL-/CLC-, length, charset, a digit);
--   * a client role can never change licence_number by direct UPDATE: only mg_set_company_licence may;
--   * an existing number can change only with a reason (the function passes it through a transaction-local setting);
--   * a number can never be cleared back to NULL (that would re-enter the grace period).
create or replace function public.mg_organizations_licence_guard()
returns trigger
language plpgsql
set search_path = public
as $mg$
declare
  v_reason text := nullif(btrim(coalesce(current_setting('mg.licence_change_reason', true), '')), '');
begin
  if tg_op = 'INSERT' then
    if new.licence_number is not null then
      new.licence_number := public.mg_validate_licence(new.licence_number);
      new.licence_change_reason := coalesce(v_reason, 'initial entry');
      new.licence_changed_at := now();
      new.licence_changed_by := auth.uid();
    end if;
    return new;
  end if;

  if new.licence_number is not distinct from old.licence_number then
    -- the licence is untouched: nobody may forge its bookkeeping columns either
    new.licence_change_reason := old.licence_change_reason;
    new.licence_changed_at := old.licence_changed_at;
    new.licence_changed_by := old.licence_changed_by;
    return new;
  end if;

  if new.licence_number is null then
    raise exception 'LICENCE_CLEAR_BLOCKED: a Ministry licence number cannot be removed; correct it with a reason instead'
      using errcode = '22023';
  end if;
  if current_user in ('authenticated', 'anon') then
    raise exception 'LICENCE_VIA_FUNCTION_ONLY: change a licence number with the registrar function (it records who and why)'
      using errcode = '42501';
  end if;
  new.licence_number := public.mg_validate_licence(new.licence_number);   -- same rules, whoever writes
  if old.licence_number is not null and v_reason is null then
    raise exception 'REASON_REQUIRED: changing an existing licence number needs a reason'
      using errcode = '22023';
  end if;
  new.licence_change_reason := coalesce(v_reason, 'initial entry');
  new.licence_changed_at := now();
  new.licence_changed_by := auth.uid();
  return new;
end;
$mg$;

drop trigger if exists organizations_licence_guard on public.organizations;
create trigger organizations_licence_guard before insert or update on public.organizations
  for each row execute function public.mg_organizations_licence_guard();


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

-- registrar: add the licence number of an existing company, or correct it WITH A REASON (the guard above enforces both)
drop function if exists public.mg_set_company_licence(uuid, text);
create or replace function public.mg_set_company_licence(p_org uuid, p_licence text, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  v_lic text;
  v_old text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  v_lic := public.mg_validate_licence(p_licence);
  select licence_number into v_old from public.organizations where id = p_org;
  if not found then raise exception 'NOT_FOUND: company'; end if;
  if v_old is not null and v_old is distinct from v_lic and (v_reason is null or char_length(v_reason) < 5) then
    raise exception 'REASON_REQUIRED: changing an existing licence number needs a reason of at least 5 characters'
      using errcode = '22023';
  end if;
  perform set_config('mg.licence_change_reason', coalesce(v_reason, ''), true);
  begin
    update public.organizations set licence_number = v_lic where id = p_org;
  exception when unique_violation then
    raise exception 'DUPLICATE_LICENCE: this licence number is already registered to another company';
  end;
  perform set_config('mg.licence_change_reason', '', true);
end;
$mg$;

-- E2. grace period for existing companies without a licence number ------------------------------------------------------
-- ONE named setting. Value = the last day (inclusive) on which a company with no licence number may still REQUEST a site.
-- After this migration has run, change it ONLY with SQL (the change is audited):
--   switch off:  update public.platform_settings set value = null where key = 'licence_grace_until_for_site_requests';
--   set/extend:  update public.platform_settings set value = '2027-01-31' where key = 'licence_grace_until_for_site_requests';
-- The default (30 days) is written ONLY when the table is first created. If the row is later deleted, re-applying this file
-- does NOT bring the grace period back. A missing, blank, malformed or past value means OFF.
do $mg$
begin
  if to_regclass('public.platform_settings') is null then
    create table public.platform_settings (
      key        text primary key check (key ~ '^[a-z0-9_]+$'),
      value      text,
      updated_by uuid,
      updated_at timestamptz not null default now()
    );
    insert into public.platform_settings (key, value)
    values ('licence_grace_until_for_site_requests', to_char(current_date + 30, 'YYYY-MM-DD'));
  end if;
end
$mg$;
alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from public, anon, authenticated;

-- writes: a real calendar date (or empty = off) is the only accepted value, with a clear message; every change is audited
create or replace function public.mg_platform_settings_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_ok boolean := false;
  v_actor uuid := auth.uid();
  v_label text;
  v_old text;
  v_new text;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    if new.key = 'licence_grace_until_for_site_requests' then
      if nullif(btrim(coalesce(new.value, '')), '') is null then
        new.value := null;
      else
        begin
          new.value := btrim(new.value);
          v_ok := new.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and to_char(new.value::date, 'YYYY-MM-DD') = new.value;
        exception when others then
          v_ok := false;
        end;
        if not v_ok then
          raise exception 'INVALID_SETTING: licence_grace_until_for_site_requests must be a real calendar date written YYYY-MM-DD (for example 2027-01-31), or empty to switch the grace period off; got "%"', new.value
            using errcode = '22023';
        end if;
      end if;
    end if;
    new.updated_at := now();
    new.updated_by := v_actor;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$mg$;

create or replace function public.mg_platform_settings_changelog()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_actor uuid := auth.uid();
  v_label text;
  v_key text := case when tg_op = 'DELETE' then old.key else new.key end;
  v_old text := case when tg_op = 'INSERT' then null else old.value end;
  v_new text := case when tg_op = 'DELETE' then null else new.value end;
begin
  if tg_op = 'UPDATE' and v_old is not distinct from v_new then
    return null;
  end if;
  select coalesce(p.email, p.name) into v_label from public.profiles p where p.id = v_actor;
  v_label := coalesce(v_label, case when v_actor is null then 'database:' || session_user else 'unregistered:' || v_actor::text end);
  insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary, details)
  values ((select p.id from public.profiles p where p.id = v_actor), v_label, 'platform_settings.' || lower(tg_op), 'platform_settings', v_key,
          'Setting ' || v_key || ' ' || case tg_op when 'INSERT' then 'created as ' when 'DELETE' then 'deleted (was ' else 'changed from ' || coalesce(v_old, 'NULL (off)') || ' to ' end
            || case tg_op when 'DELETE' then coalesce(v_old, 'NULL (off)') || ')' else coalesce(v_new, 'NULL (off)') end,
          jsonb_build_object('before', v_old, 'after', v_new, 'database_user', session_user));
  return null;
end;
$mg$;

drop trigger if exists platform_settings_guard on public.platform_settings;
create trigger platform_settings_guard before insert or update or delete on public.platform_settings
  for each row execute function public.mg_platform_settings_guard();
drop trigger if exists platform_settings_changelog on public.platform_settings;
create trigger platform_settings_changelog after insert or update or delete on public.platform_settings
  for each row execute function public.mg_platform_settings_changelog();

-- the date the grace period ends, or NULL when it is off (or the stored value is unusable); signed-in callers only
create or replace function public.mg_licence_grace_until()
returns date
language plpgsql stable
security definer set search_path = public
as $mg$
declare
  v text;
begin
  if auth.uid() is null then return null; end if;
  select value into v from public.platform_settings where key = 'licence_grace_until_for_site_requests';
  if v is null or v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  begin
    return v::date;
  exception when others then
    return null;     -- an impossible date (e.g. 2027-13-45) fails closed: grace is off, no raw database error
  end;
end;
$mg$;

-- F. company site requests: a licence number is required (or the grace period is on), and the county must be official ---------
-- (body of 0037's mg_request_site plus the checks marked NEW)
create or replace function public.mg_request_site(
  p_org uuid, p_name text, p_county text, p_district text, p_community text,
  p_mineral text, p_lat double precision, p_lng double precision, p_notes text)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_county text;
  v_id uuid;
  v_org public.organizations;
  v_bad_setting boolean;
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
  -- NEW: a company without a licence number may request a site only while the grace period is on
  if v_org.licence_number is null and not coalesce(public.mg_licence_grace_until() >= current_date, false) then
    v_bad_setting := exists (select 1 from public.platform_settings
                              where key = 'licence_grace_until_for_site_requests'
                                and nullif(btrim(coalesce(value, '')), '') is not null
                                and public.mg_licence_grace_until() is null);
    raise exception 'LICENCE_REQUIRED: the Ministry has not recorded a licence number for this company yet. Ask the Ministry registrar to add it before requesting new sites%',
      case when v_bad_setting then ' (the grace-period setting holds an unusable date and is treated as off: tell the administrator)' else '' end;
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'INVALID_NAME: site name must be 2 to 120 characters';
  end if;
  -- NEW: official county list, stored in its canonical spelling (raises INVALID_COUNTY)
  v_county := public.mg_county_canonical(p_county);
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

-- F2. owner-run site inserts (auth.uid() is null: SQL loads, seeds, restores, service role) used to AUTO-CREATE an APPROVED company
-- with no licence number for any unknown operator name. They now create it PENDING REVIEW, flagged in status_reason, so it appears on
-- the registrar's to-do list and never counts as an approved operator. Signed-in sessions still get UNKNOWN_COMPANY (unchanged).
-- Explicit seed path: an owner-run seed that really wants approved demo companies sets, in its own transaction,
--   select set_config('mg.seed_mode', 'on', true);
create or replace function public.mg_resolve_organization(p_name text)
returns uuid
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_id uuid;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_seed boolean := coalesce(current_setting('mg.seed_mode', true), '') = 'on';
begin
  if v_name is null then
    return null;
  end if;
  select id into v_id
    from public.organizations
   where lower(name) = lower(v_name)
   order by created_at, id
   limit 1;
  if v_id is null then
    if auth.uid() is not null then
      raise exception 'UNKNOWN_COMPANY: "%" is not a registered company. Register it in Companies first.', v_name;
    end if;
    insert into public.organizations (name, kind, status, status_reason, status_changed_at)
    values (v_name, 'operator',
            case when v_seed then 'approved' else 'pending_review' end,
            case when v_seed then 'Demonstration company created by an explicit seed run'
                 else 'Created automatically from an owner-run site insert: the Ministry registrar must review it and record its licence number' end,
            now())
    returning id into v_id;
  end if;
  return v_id;
end;
$mg$;

-- G. grants -------------------------------------------------------------------------------------------------------------
-- internal helpers: reachable only through triggers / other definer functions, never by a client role
do $mg$
declare f text;
begin
  foreach f in array array[
    'mg_county_prefix(text)',
    'mg_county_canonical(text)',
    'mg_allocate_site_code(text)',
    'mg_sites_code_guard()',
    'mg_organizations_identity_guard()',
    'mg_organizations_licence_guard()',
    'mg_platform_settings_guard()',
    'mg_platform_settings_changelog()',
    'mg_norm_name(text)',
    'mg_norm_licence(text)',
    'mg_licence_format_recognised(text)',
    'mg_resolve_organization(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- client-callable: signed-in only. mg_validate_licence is a pure INVOKER function (no table access) used by the invoker-rights licence guard.
  foreach f in array array[
    'mg_company_registration_check(text, text)',
    'mg_licence_grace_until()',
    'mg_register_company(text, text)',
    'mg_set_company_licence(uuid, text, text)',
    'mg_validate_licence(text)',
    'mg_request_site(uuid, text, text, text, text, text, double precision, double precision, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end
$mg$;

commit;
