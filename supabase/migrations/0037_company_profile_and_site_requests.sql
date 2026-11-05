-- ============================================================================
-- MINEGUARD LIBERIA — migration 0037: company profile + site registration requests
--
-- COMPANY PROFILE. organizations gains contact_email, contact_phone, address, website,
-- description. A company administrator maintains THESE (mg_update_company_profile,
-- validated: email shape, https website, length caps). The registered NAME, kind and
-- STATUS stay Ministry-only: the name is the legal registration every site is
-- attached to, and status is regulatory.
--
-- SITE REGISTRATION REQUESTS. A company cannot create a site (the registry is the
-- Ministry's); it can ASK. A company administrator submits a request (details only),
-- the Ministry reviews it, and approval links the site the administrator then
-- registered through the existing, validated registration flow (code, coordinates,
-- provenance) — no second way to create a site exists. Every step is audit-trailed
-- (touch + audit triggers) and notifies the other side (company administrators /
-- Ministry administrators). Clients hold SELECT only; all writes are definer RPCs.
--
-- Idempotent. Rollback: drop the three RPCs, the request table and the five columns;
-- restore the 0034 notification kind CHECK.
-- ============================================================================

begin;

alter table public.organizations add column if not exists contact_email text;
alter table public.organizations add column if not exists contact_phone text;
alter table public.organizations add column if not exists address       text;
alter table public.organizations add column if not exists website       text;
alter table public.organizations add column if not exists description   text;

create or replace function public.mg_update_company_profile(
  p_org uuid, p_contact_email text, p_contact_phone text,
  p_address text, p_website text, p_description text)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  v_email text := nullif(btrim(coalesce(p_contact_email, '')), '');
  v_phone text := nullif(btrim(coalesce(p_contact_phone, '')), '');
  v_addr  text := nullif(btrim(coalesce(p_address, '')), '');
  v_web   text := nullif(btrim(coalesce(p_website, '')), '');
  v_desc  text := nullif(btrim(coalesce(p_description, '')), '');
begin
  if auth.uid() is null or not public.mg_can_manage_company(p_org) then
    raise exception 'FORBIDDEN: company administration required';
  end if;
  if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254) then
    raise exception 'INVALID_EMAIL';
  end if;
  if v_phone is not null and (v_phone !~ '^[0-9+()\-\s.]{5,40}$') then
    raise exception 'INVALID_PHONE: use digits, spaces and + ( ) - only';
  end if;
  if v_addr is not null and char_length(v_addr) > 300 then
    raise exception 'INVALID_ADDRESS: at most 300 characters';
  end if;
  if v_web is not null and (v_web !~* '^https://[^\s]+$' or char_length(v_web) > 200) then
    raise exception 'INVALID_WEBSITE: use a full https:// address';
  end if;
  if v_desc is not null and char_length(v_desc) > 1000 then
    raise exception 'INVALID_DESCRIPTION: at most 1000 characters';
  end if;
  update public.organizations
     set contact_email = v_email, contact_phone = v_phone, address = v_addr,
         website = v_web, description = v_desc
   where id = p_org;
  if not found then raise exception 'NOT_FOUND: company'; end if;
end;
$mg$;

-- notification kind for site requests --------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('ca_deadline','ca_decision','report_status',
                  'org_invitation','org_request','org_decision','org_role','org_status',
                  'org_site_request'));

-- the requests ------------------------------------------------------------------------------------------
create table if not exists public.site_registration_requests (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  requested_by    uuid not null references public.profiles(id),
  name            text not null check (char_length(name) between 2 and 120),
  county          text not null check (char_length(county) between 2 and 80),
  district        text check (district is null or char_length(district) <= 120),
  community       text check (community is null or char_length(community) <= 120),
  mineral_type    text check (mineral_type is null or char_length(mineral_type) <= 80),
  latitude        double precision check (latitude is null or latitude between -90 and 90),
  longitude       double precision check (longitude is null or longitude between -180 and 180),
  notes           text check (notes is null or char_length(notes) <= 1000),
  status          text not null default 'pending'
                  check (status in ('pending','approved','rejected','cancelled')),
  decided_by      uuid references public.profiles(id),
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or char_length(decision_note) <= 500),
  site_id         uuid references public.sites(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  updated_by      uuid,
  row_version     integer not null default 1,
  check ((latitude is null) = (longitude is null))
);
create index if not exists site_requests_org_idx on public.site_registration_requests (organization_id, status);
create unique index if not exists site_requests_one_site_each
  on public.site_registration_requests (site_id) where site_id is not null;

alter table public.site_registration_requests enable row level security;
drop policy if exists "site requests read" on public.site_registration_requests;
create policy "site requests read" on public.site_registration_requests
  for select to authenticated
  using (public.mg_has_permission('sites.insert') or public.mg_can_manage_company(organization_id));

revoke all on public.site_registration_requests from public, anon, authenticated;
grant select on public.site_registration_requests to authenticated;

drop trigger if exists site_registration_requests_touch on public.site_registration_requests;
create trigger site_registration_requests_touch before insert or update on public.site_registration_requests
  for each row execute function public.mg_touch_row();
drop trigger if exists site_registration_requests_audit on public.site_registration_requests;
create trigger site_registration_requests_audit after insert or update on public.site_registration_requests
  for each row execute function public.mg_audit_row();

-- company administrator asks ---------------------------------------------------------------------------------
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

create or replace function public.mg_cancel_site_request(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare q public.site_registration_requests;
begin
  select * into q from public.site_registration_requests where id = p_id for update;
  if not found or auth.uid() is null
     or not exists (select 1 from public.organization_members m
                     where m.user_id = auth.uid() and m.organization_id = q.organization_id
                       and m.org_role = 'company_admin' and m.status = 'active') then
    raise exception 'FORBIDDEN';
  end if;
  if q.status <> 'pending' then raise exception 'REQUEST_NOT_PENDING'; end if;
  update public.site_registration_requests set status = 'cancelled' where id = p_id;
end;
$mg$;

-- the Ministry decides ----------------------------------------------------------------------------------------------
create or replace function public.mg_decide_site_request(
  p_id uuid, p_decision text, p_note text default null, p_site uuid default null)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  q public.site_registration_requests;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_org text;
  r record;
begin
  if auth.uid() is null or not public.mg_has_permission('sites.insert') then
    raise exception 'FORBIDDEN: site registration authority required';
  end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'INVALID_DECISION'; end if;
  select * into q from public.site_registration_requests where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if q.status <> 'pending' then raise exception 'REQUEST_NOT_PENDING'; end if;

  if p_decision = 'approved' then
    if p_site is null or not exists (select 1 from public.sites s
                                      where s.id = p_site and s.organization_id = q.organization_id) then
      raise exception 'INVALID_SITE: register the site for this company first, then approve';
    end if;
  elsif v_note is null or char_length(v_note) < 5 then
    raise exception 'REASON_REQUIRED: say why the request is declined';
  end if;

  update public.site_registration_requests
     set status = p_decision, decided_by = auth.uid(), decided_at = now(),
         decision_note = v_note, site_id = case when p_decision = 'approved' then p_site end
   where id = p_id;

  select name into v_org from public.organizations where id = q.organization_id;
  for r in select m.user_id from public.organization_members m
            where m.organization_id = q.organization_id and m.org_role = 'company_admin' and m.status = 'active' loop
    perform public.mg_notify(r.user_id, 'sdec:' || p_id, 'org_site_request',
      case when p_decision = 'approved' then 'info' else 'warning' end,
      case when p_decision = 'approved' then 'Site request approved' else 'Site request declined' end,
      case when p_decision = 'approved'
           then '"' || q.name || '" was registered for ' || v_org || '.'
           else '"' || q.name || '" was declined: ' || coalesce(v_note, '') end,
      '/operate/site-requests');
  end loop;
end;
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_update_company_profile(uuid, text, text, text, text, text)',
    'mg_request_site(uuid, text, text, text, text, text, double precision, double precision, text)',
    'mg_cancel_site_request(uuid)',
    'mg_decide_site_request(uuid, text, text, uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
