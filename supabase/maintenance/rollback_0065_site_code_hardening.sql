-- ===========================================================================
-- ROLLBACK of migration 0065 (site-code hardening + company licence numbers).
-- Not in supabase/migrations. Takes a backup first (see docs/27). Data-safe for sites: issued site codes are NOT touched
-- and stay valid. LOSES: the licence_number column (all licence numbers entered by registrars) and the counters.
-- Export first if the licence numbers matter:
--   select id, name, licence_number from public.organizations where licence_number is not null;
-- After this script the app version that sends only the company name (the pre-0065 release) works again; the 0065 release
-- must be rolled back at the same time (it sends licence numbers and no site code).
-- ===========================================================================
begin;

drop trigger if exists sites_code_guard on public.sites;
drop trigger if exists organizations_identity_guard on public.organizations;

drop index if exists public.organizations_licence_norm_uq;
drop index if exists public.organizations_name_norm_uq;

-- restore the pre-0065 functions (verbatim from 0025 / 0037) before dropping what they replaced
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

drop function if exists public.mg_company_registration_check(text, text);
drop function if exists public.mg_set_company_licence(uuid, text);
drop function if exists public.mg_sites_code_guard();
drop function if exists public.mg_organizations_identity_guard();
drop function if exists public.mg_allocate_site_code(text);
drop function if exists public.mg_county_prefix(text);
drop function if exists public.mg_validate_licence(text);
drop function if exists public.mg_licence_format_recognised(text);
drop function if exists public.mg_norm_licence(text);
drop function if exists public.mg_norm_name(text);

alter table public.organizations drop column if exists licence_number_norm;
alter table public.organizations drop column if exists name_norm;
alter table public.organizations drop column if exists licence_number;

drop table if exists public.site_code_counters;
drop table if exists public.county_codes;

commit;
