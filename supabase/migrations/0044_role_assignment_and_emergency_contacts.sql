-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0044: role assignment is a company-administrator act;
--                                      database-backed emergency contacts
--
-- 1. ROLE ASSIGNMENT. Appointing or changing a company role is done ONLY by an active
--    administrator of that company (mg_is_company_admin). Before this migration the Ministry's
--    full admin (workforce.oversee) also passed mg_can_manage_company, and an onboarding
--    officer could appoint safety officers — a role that now carries JSA approval authority.
--      * site_manager / safety_officer / onboarding_officer: company administrator only.
--      * worker: company administrator or onboarding officer (the lowest role; holds no approval
--        authority, so bulk import of workers keeps working).
--      * company_admin: unchanged — only the Ministry registrar appoints one (bootstrap).
--      * mg_set_member_role: company administrator only, never on yourself, never on a company
--        administrator (those are managed by the Ministry through revoke/appointment).
--      * mg_decide_membership_request: approving (which sets a role) is company-admin only;
--        rejecting a request is unchanged.
--    Site assignment (mg_assign_member_site) is NOT a role change and is unchanged.
--
-- 2. EMERGENCY CONTACTS in the database, replacing the numbers that were hard-coded in the app
--    bundle. Company-wide or per-site; managed by the company administrator (any) and by an
--    assigned site manager / safety officer (their own site only). Readable by the company's
--    members (company-wide + their sites) and by Ministry staff holding emergency.read.
--    Nothing is seeded: an empty list is shown as empty, never invented.
--
-- Idempotent. ROLLBACK: restore the 0031 core + decide_membership_request and 0029
-- mg_set_member_role (verbatim in those files), drop the emergency_contacts table and the
-- mg_emergency_contact_* / mg_is_company_admin / mg_is_onboarding_officer functions.
-- ===========================================================================

begin;

create or replace function public.mg_is_company_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null and exists (
    select 1 from public.organization_members m
      join public.organizations o on o.id = m.organization_id
     where m.user_id = auth.uid() and m.organization_id = p_org
       and m.org_role = 'company_admin' and m.status = 'active' and o.status = 'approved')
$mg$;

create or replace function public.mg_is_onboarding_officer(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null and exists (
    select 1 from public.organization_members m
      join public.organizations o on o.id = m.organization_id
     where m.user_id = auth.uid() and m.organization_id = p_org
       and m.org_role = 'onboarding_officer' and m.status = 'active' and o.status = 'approved')
$mg$;

create or replace function public.mg_create_org_invitation_core(
  p_org uuid, p_email text, p_role text, p_site uuid)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_org public.organizations;
  v_id uuid;
  v_existing public.profiles;
begin
  if auth.uid() is null
     or not (public.mg_can_onboard_company(p_org)
             or (p_role = 'company_admin' and public.mg_has_permission('organizations.write'))) then
    raise exception 'FORBIDDEN: company onboarding access required';
  end if;
  if p_role not in ('company_admin','site_manager','safety_officer','worker','onboarding_officer') then
    raise exception 'INVALID_ROLE';
  end if;
  if p_role = 'company_admin' and not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: only the Ministry can appoint a company administrator';
  end if;
  -- Role assignment is a company-administrator act. Safety officers and site managers carry JSA
  -- approval authority, so they are never appointed by an onboarding officer or the Ministry.
  if p_role in ('site_manager','safety_officer','onboarding_officer') and not public.mg_is_company_admin(p_org) then
    raise exception 'FORBIDDEN: only a company administrator can appoint this role';
  end if;
  if p_role = 'worker' and not (public.mg_is_company_admin(p_org) or public.mg_is_onboarding_officer(p_org)) then
    raise exception 'FORBIDDEN: only a company administrator or onboarding officer can add a worker';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'INVALID_EMAIL';
  end if;
  select * into v_org from public.organizations where id = p_org;
  if not found then raise exception 'NOT_FOUND: company'; end if;
  if v_org.status <> 'approved' then
    raise exception 'ORG_NOT_APPROVED: the company is not approved';
  end if;
  if p_site is not null then
    if p_role not in ('worker','safety_officer','site_manager') then
      raise exception 'INVALID_SITE: this role is not assigned to a site';
    end if;
    if not exists (select 1 from public.sites s where s.id = p_site and s.organization_id = p_org) then
      raise exception 'INVALID_SITE: unknown site for this company';
    end if;
  end if;

  select * into v_existing from public.profiles where lower(email) = v_email limit 1;
  if found then
    if v_existing.role in ('admin','supervisor','inspector','registrar') then
      raise exception 'INELIGIBLE_ACCOUNT: government accounts cannot join a company';
    end if;
    if exists (select 1 from public.organization_members m
                where m.user_id = v_existing.id and m.status = 'active'
                  and m.organization_id <> p_org) then
      raise exception 'ALREADY_MEMBER_OTHER_ORG: this account already belongs to another company';
    end if;
  end if;

  update public.organization_invitations
     set status = 'expired'
   where organization_id = p_org and email = v_email and org_role = p_role
     and status = 'pending' and expires_at <= now();

  insert into public.organization_invitations
    (organization_id, email, org_role, expires_at, created_by, site_id)
  values (p_org, v_email, p_role, now() + interval '7 days', auth.uid(), p_site)
  on conflict (organization_id, email, org_role) where status = 'pending' do nothing;

  select id into v_id from public.organization_invitations
   where organization_id = p_org and email = v_email and org_role = p_role and status = 'pending';
  return v_id;
end;
$mg$;

create or replace function public.mg_decide_membership_request(
  p_member_id uuid, p_approve boolean, p_role text default 'worker')
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  m public.organization_members;
  v_profile public.profiles;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into m from public.organization_members where id = p_member_id for update;
  if not found or not public.mg_can_manage_company(m.organization_id) then
    raise exception 'FORBIDDEN';
  end if;
  if m.status <> 'pending' then raise exception 'MEMBERSHIP_NOT_PENDING'; end if;

  if not p_approve then
    update public.organization_members set status = 'rejected' where id = m.id;
    return;
  end if;
  if not public.mg_is_company_admin(m.organization_id) then
    raise exception 'FORBIDDEN: only a company administrator can assign a role';
  end if;

  if p_role not in ('site_manager','safety_officer','worker') then
    raise exception 'INVALID_ROLE: a company administrator is appointed by the Ministry';
  end if;
  select * into v_profile from public.profiles where id = m.user_id;
  if not found or v_profile.role in ('admin','supervisor','inspector','registrar') then
    raise exception 'INELIGIBLE_ACCOUNT';
  end if;
  if exists (select 1 from public.organization_members x
              where x.user_id = m.user_id and x.status = 'active') then
    raise exception 'ALREADY_MEMBER_OTHER_ORG';
  end if;

  update public.organization_members set status = 'active', org_role = p_role where id = m.id;
  -- the request is answered: a still-pending invitation to the same address is now redundant
  update public.organization_invitations
     set status = 'revoked', revoked_by = auth.uid(), revoked_at = now()
   where organization_id = m.organization_id and status = 'pending'
     and email = lower(coalesce(v_profile.email, ''));
  perform set_config('mg.org_assign', '1', true);
  update public.profiles
     set role = 'operator', scope = 'operator',
         organization_id = m.organization_id, profile_complete = true
   where id = m.user_id;
  perform set_config('mg.org_assign', '0', true);
end;
$mg$;

create or replace function public.mg_set_member_role(p_member_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare m public.organization_members;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into m from public.organization_members where id = p_member_id for update;
  if not found or not public.mg_is_company_admin(m.organization_id) then
    raise exception 'FORBIDDEN: only a company administrator can change a role';
  end if;
  if m.status <> 'active' then raise exception 'MEMBERSHIP_NOT_ACTIVE'; end if;
  if m.user_id = auth.uid() then raise exception 'FORBIDDEN: you cannot change your own role'; end if;
  if m.org_role = 'company_admin' then
    raise exception 'FORBIDDEN: a company administrator is managed by the Ministry';
  end if;
  if p_role not in ('site_manager','safety_officer','worker','onboarding_officer') then
    raise exception 'INVALID_ROLE: a company administrator is appointed by the Ministry';
  end if;
  update public.organization_members set org_role = p_role where id = m.id;
end;
$mg$;


-- ===========================================================================
-- Emergency contacts
-- ===========================================================================
create table if not exists public.emergency_contacts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  site_id         uuid references public.sites(id),          -- null = company-wide
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  phone           text not null check (phone ~ '^[+]?[0-9 ()\-]{3,24}$'),
  role_label      text check (role_label is null or char_length(role_label) <= 60),
  sort_order      integer not null default 100 check (sort_order between 0 and 10000),
  active          boolean not null default true,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  updated_by      uuid,
  row_version     integer not null default 1
);
create index if not exists emergency_contacts_org_site_idx on public.emergency_contacts (organization_id, site_id) where active;

alter table public.emergency_contacts enable row level security;
revoke all on public.emergency_contacts from anon, authenticated;

-- A contact's site must belong to the contact's company.
create or replace function public.mg_emergency_contact_guard()
returns trigger language plpgsql as $mg$
begin
  if new.site_id is not null and not exists (
       select 1 from public.sites s where s.id = new.site_id and s.organization_id = new.organization_id) then
    raise exception 'INVALID_SITE: the site does not belong to this company';
  end if;
  if tg_op = 'UPDATE' and (new.organization_id is distinct from old.organization_id) then
    raise exception 'IMMUTABLE: a contact cannot move to another company';
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_emergency_contact_guard() from public, anon, authenticated;
drop trigger if exists emergency_contacts_guard on public.emergency_contacts;
create trigger emergency_contacts_guard before insert or update on public.emergency_contacts
  for each row execute function public.mg_emergency_contact_guard();
drop trigger if exists emergency_contacts_touch on public.emergency_contacts;
create trigger emergency_contacts_touch before insert or update on public.emergency_contacts
  for each row execute function public.mg_touch_row();
drop trigger if exists emergency_contacts_audit on public.emergency_contacts;
create trigger emergency_contacts_audit after insert or update on public.emergency_contacts
  for each row execute function public.mg_audit_row();

-- Who may maintain a contact: the company administrator (company-wide or any site), or a site
-- manager / safety officer assigned to that site (that site's contacts only). Same site-scoped
-- safety authority that reviews JSAs.
create or replace function public.mg_can_manage_emergency_contacts(p_org uuid, p_site uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null and (
    (public.mg_is_company_admin(p_org)
       and (p_site is null or exists (select 1 from public.sites s where s.id = p_site and s.organization_id = p_org)))
    or (p_site is not null
        and exists (select 1 from public.sites s where s.id = p_site and s.organization_id = p_org)
        and public.mg_can_review_jsa(p_site)))
$mg$;

-- Who may read: company members see company-wide contacts and the contacts of sites they are
-- assigned to (a company administrator sees all of the company's); Ministry staff with
-- emergency.read see all.
create or replace function public.mg_can_read_emergency_contact(p_org uuid, p_site uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null and (
    public.mg_has_permission('emergency.read')
    or public.mg_is_company_admin(p_org)
    or (exists (select 1 from public.organization_members m
                 join public.organizations o on o.id = m.organization_id
                where m.user_id = auth.uid() and m.organization_id = p_org
                  and m.status = 'active' and o.status = 'approved')
        and (p_site is null
             or exists (select 1 from public.site_assignments sa
                         where sa.user_id = auth.uid() and sa.site_id = p_site and sa.revoked_at is null))))
$mg$;

drop policy if exists "emergency contacts read" on public.emergency_contacts;
create policy "emergency contacts read" on public.emergency_contacts for select to authenticated
  using (public.mg_can_read_emergency_contact(organization_id, site_id)
         and (active or public.mg_can_manage_emergency_contacts(organization_id, site_id)));
grant select on public.emergency_contacts to authenticated;

-- Save (create or edit). Editing keeps the contact where it is: scope cannot be changed.
create or replace function public.mg_emergency_contact_save(
  p_org uuid, p_site uuid, p_name text, p_phone text,
  p_role_label text default null, p_sort integer default 100, p_active boolean default true,
  p_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $mg$
declare v_id uuid; v_row public.emergency_contacts;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  if p_id is null then
    if not public.mg_can_manage_emergency_contacts(p_org, p_site) then
      raise exception 'FORBIDDEN: you cannot add emergency contacts here';
    end if;
    insert into public.emergency_contacts (organization_id, site_id, name, phone, role_label, sort_order, active, created_by)
    values (p_org, p_site, btrim(p_name), btrim(p_phone), nullif(btrim(p_role_label), ''), coalesce(p_sort, 100), coalesce(p_active, true), auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  select * into v_row from public.emergency_contacts where id = p_id for update;
  if not found or not public.mg_can_manage_emergency_contacts(v_row.organization_id, v_row.site_id) then
    raise exception 'FORBIDDEN: you cannot edit this contact';
  end if;
  update public.emergency_contacts set
      name = btrim(p_name), phone = btrim(p_phone), role_label = nullif(btrim(p_role_label), ''),
      sort_order = coalesce(p_sort, sort_order), active = coalesce(p_active, active)
   where id = p_id;
  return p_id;
end;
$mg$;

create or replace function public.mg_emergency_contact_remove(p_id uuid)
returns void language plpgsql security definer set search_path = public as $mg$
declare v_row public.emergency_contacts;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  select * into v_row from public.emergency_contacts where id = p_id for update;
  if not found or not public.mg_can_manage_emergency_contacts(v_row.organization_id, v_row.site_id) then
    raise exception 'FORBIDDEN: you cannot remove this contact';
  end if;
  -- Archived, not deleted: the contact stops appearing for everyone but managers, and the audit
  -- trail keeps who removed it and when.
  update public.emergency_contacts set active = false where id = p_id;
end;
$mg$;

-- What the caller may maintain (for the app's pickers; the RPCs above re-check).
create or replace function public.mg_emergency_contact_scopes()
returns table (organization_id uuid, organization_name text, site_id uuid, site_name text)
language sql stable security definer set search_path = public as $mg$
  select o.id, o.name, null::uuid, null::text
    from public.organizations o
   where o.status = 'approved' and public.mg_is_company_admin(o.id)
  union all
  select s.organization_id, o.name, s.id, s.name
    from public.sites s join public.organizations o on o.id = s.organization_id
   where public.mg_can_manage_emergency_contacts(s.organization_id, s.id)
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_is_company_admin(uuid)', 'mg_is_onboarding_officer(uuid)',
    'mg_can_manage_emergency_contacts(uuid,uuid)', 'mg_can_read_emergency_contact(uuid,uuid)',
    'mg_emergency_contact_save(uuid,uuid,text,text,text,integer,boolean,uuid)',
    'mg_emergency_contact_remove(uuid)', 'mg_emergency_contact_scopes()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
