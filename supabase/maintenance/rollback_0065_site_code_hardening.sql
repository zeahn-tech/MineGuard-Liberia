-- ===========================================================================
-- ROLLBACK of migration 0065 (site-code hardening, company licence numbers, grace period).
-- Not in supabase/migrations. Take a backup first (see docs/27). Data-safe for sites: issued site codes (and the canonical county
-- spellings written since 0065) are NOT touched and stay valid. LOSES: every licence number and its change history columns, the
-- counters and the grace setting. Export first if they matter:
--   select id, name, licence_number, licence_change_reason, licence_changed_at from public.organizations where licence_number is not null;
--   select * from public.platform_settings;
-- audit_log rows written by 0065 (organizations / platform_settings changes) are append-only and are left in place.
-- Roll the app back at the same time (the 0065 app sends licence numbers and no site code).
-- ===========================================================================
begin;

drop trigger if exists sites_code_guard on public.sites;
drop trigger if exists organizations_identity_guard on public.organizations;
drop trigger if exists organizations_licence_guard on public.organizations;
drop trigger if exists platform_settings_guard on public.platform_settings;
drop trigger if exists platform_settings_changelog on public.platform_settings;

drop index if exists public.organizations_licence_norm_uq;
drop index if exists public.organizations_name_norm_uq;

-- restore the pre-0065 functions (verbatim from 0025 / 0033 / 0037) before dropping what replaced them
drop function if exists public.mg_register_company(text, text);
create or replace function public.mg_register_company(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_id uuid;
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 200 then
    raise exception 'INVALID_NAME: company name must be 2-200 characters';
  end if;
  if exists (select 1 from public.organizations where lower(name) = lower(v_name)) then
    raise exception 'DUPLICATE_ORGANIZATION: a company with this name already exists';
  end if;
  insert into public.organizations (name, kind, status, status_changed_at, status_changed_by)
  values (v_name, 'operator', 'approved', now(), auth.uid())
  returning id into v_id;
  return v_id;
end;
$mg$;
revoke all on function public.mg_register_company(text) from public, anon;
grant execute on function public.mg_register_company(text) to authenticated;

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
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'INVALID_NAME: site name must be 2 to 120 characters';
  end if;
  if char_length(v_county) < 2 or char_length(v_county) > 80 then
    raise exception 'INVALID_COUNTY: choose the county';
  end if;
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

create or replace function public.mg_resolve_organization(p_name text)
returns uuid
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_id uuid;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
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
    insert into public.organizations (name, kind)
    values (v_name, 'operator')
    returning id into v_id;
  end if;
  return v_id;
end;
$mg$;

drop function if exists public.mg_company_registration_check(text, text);
drop function if exists public.mg_set_company_licence(uuid, text, text);
drop function if exists public.mg_set_company_licence(uuid, text);
drop function if exists public.mg_licence_grace_until();
drop function if exists public.mg_platform_settings_guard();
drop function if exists public.mg_platform_settings_changelog();
drop function if exists public.mg_sites_code_guard();
drop function if exists public.mg_organizations_identity_guard();
drop function if exists public.mg_organizations_licence_guard();
drop function if exists public.mg_allocate_site_code(text);
drop function if exists public.mg_county_canonical(text);
drop function if exists public.mg_county_prefix(text);
drop function if exists public.mg_validate_licence(text);
drop function if exists public.mg_licence_format_recognised(text);
drop function if exists public.mg_norm_licence(text);
drop function if exists public.mg_norm_name(text);

alter table public.organizations drop column if exists licence_number_norm;
alter table public.organizations drop column if exists name_norm;
alter table public.organizations drop column if exists licence_change_reason;
alter table public.organizations drop column if exists licence_changed_at;
alter table public.organizations drop column if exists licence_changed_by;
alter table public.organizations drop column if exists licence_number;

drop table if exists public.platform_settings;
drop table if exists public.site_code_counters;
drop table if exists public.county_codes;

commit;
