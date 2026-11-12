-- ============================================================================
-- 0053 — Company role "supervisor"
--
-- A supervisor leads a crew on site: below a site manager, above a worker. It is a
-- COMPANY role (organization_members.org_role), not the government 'supervisor'
-- platform role. Access is deliberately the same as a safety officer's SITE
-- SCOPING and nothing more:
--   * sees the sites they are assigned to (and, like worker/safety officer, every
--     site of their company only while they hold no assignment yet);
--   * can be assigned to / removed from a site by a site manager or company admin;
--   * is appointed ONLY by a company administrator (like site manager / safety
--     officer), never by an onboarding officer or the Ministry;
--   * gets NO corrective-action, JSA-approval, Worker Voice or management rights.
--   * is part of the 'workers' emergency-alert audience (they lead the crew on site).
-- Every function below is the latest existing definition with 'supervisor' added to
-- the role lists, so nothing else changes. create or replace keeps existing grants.
-- ============================================================================

begin;

alter table public.organization_members drop constraint if exists organization_members_org_role_check;
alter table public.organization_members add constraint organization_members_org_role_check
  check (org_role in ('company_admin','site_manager','safety_officer','supervisor','worker','onboarding_officer'));
alter table public.organization_invitations drop constraint if exists organization_invitations_org_role_check;
alter table public.organization_invitations add constraint organization_invitations_org_role_check
  check (org_role in ('company_admin','site_manager','safety_officer','supervisor','worker','onboarding_officer'));

create or replace function public.mg_operator_site_ok(p_user uuid, p_site_id uuid, p_org uuid)
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select exists (
    select 1
      from public.organization_members m
     where m.user_id = p_user
       and m.organization_id = p_org
       and m.status = 'active'
       and (
            m.org_role = 'company_admin'
         or (m.org_role = 'site_manager'
             and exists (select 1 from public.site_assignments sa
                          where sa.user_id = p_user and sa.site_id = p_site_id
                            and sa.revoked_at is null))
         or (m.org_role in ('worker','safety_officer','supervisor')
             and (exists (select 1 from public.site_assignments sa
                           where sa.user_id = p_user and sa.site_id = p_site_id
                             and sa.revoked_at is null)
                  or not exists (select 1
                                   from public.site_assignments sa
                                   join public.sites s on s.id = sa.site_id
                                  where sa.user_id = p_user
                                    and sa.revoked_at is null
                                    and s.organization_id = p_org)))
       )
  )
$mg$;

create or replace function public.mg_unassign_member_site(p_member_id uuid, p_site_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  m public.organization_members;
  s public.sites;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into m from public.organization_members where id = p_member_id;
  select * into s from public.sites where id = p_site_id;
  if m.id is null or s.id is null
     or m.organization_id is distinct from s.organization_id
     or not public.mg_can_manage_site_people(p_site_id) then
    raise exception 'FORBIDDEN';
  end if;
  if not public.mg_can_manage_company(s.organization_id)
     and m.org_role not in ('worker','safety_officer','supervisor') then
    raise exception 'FORBIDDEN: site managers are assigned by a company administrator';
  end if;
  update public.site_assignments
     set revoked_at = now(), revoked_by = auth.uid()
   where user_id = m.user_id and site_id = s.id and revoked_at is null;
end;
$mg$;

create or replace function public.mg_assign_member_site(p_member_id uuid, p_site_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  m public.organization_members;
  s public.sites;
  v_company_level boolean;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into m from public.organization_members where id = p_member_id;
  select * into s from public.sites where id = p_site_id;
  if m.id is null or s.id is null
     or m.organization_id is distinct from s.organization_id
     or not public.mg_can_manage_site_people(p_site_id) then
    raise exception 'FORBIDDEN';
  end if;
  if m.status <> 'active' then raise exception 'MEMBERSHIP_NOT_ACTIVE'; end if;
  v_company_level := public.mg_can_manage_company(s.organization_id);
  if m.org_role in ('company_admin','onboarding_officer') then
    raise exception 'INVALID_TARGET: this role does not work on sites';
  end if;
  if not v_company_level then
    if m.org_role not in ('worker','safety_officer','supervisor') then
      raise exception 'FORBIDDEN: site managers are assigned by a company administrator';
    end if;
  end if;

  insert into public.site_assignments (user_id, site_id, assigned_by)
  values (m.user_id, s.id, auth.uid())
  on conflict (user_id, site_id)
  do update set revoked_at = null, revoked_by = null, assigned_by = auth.uid();
end;
$mg$;

create or replace function public.mg_site_roster(p_site_id uuid)
returns table (member_id uuid, user_id uuid, email text, name text, org_role text, assigned boolean)
language plpgsql stable security definer set search_path = public
as $mg$
declare
  s public.sites;
  v_company_level boolean;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into s from public.sites where id = p_site_id;
  if s.id is null or not public.mg_can_manage_site_people(p_site_id) then
    raise exception 'FORBIDDEN';
  end if;
  v_company_level := public.mg_can_manage_company(s.organization_id);
  return query
    select m.id, m.user_id, p.email, p.name, m.org_role,
           exists (select 1 from public.site_assignments sa
                    where sa.user_id = m.user_id and sa.site_id = s.id and sa.revoked_at is null)
      from public.organization_members m
      join public.profiles p on p.id = m.user_id
     where m.organization_id = s.organization_id
       and m.status = 'active'
       and m.org_role not in ('company_admin','onboarding_officer')
       and (v_company_level
            or m.org_role in ('worker','safety_officer','supervisor')
            or exists (select 1 from public.site_assignments sa
                        where sa.user_id = m.user_id and sa.site_id = s.id and sa.revoked_at is null))
     order by m.org_role, p.name nulls last, p.email;
end;
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
  if p_role not in ('company_admin','site_manager','safety_officer','supervisor','worker','onboarding_officer') then
    raise exception 'INVALID_ROLE';
  end if;
  if p_role = 'company_admin' and not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: only the Ministry can appoint a company administrator';
  end if;
  -- Role assignment is a company-administrator act. Safety officers and site managers carry JSA
  -- approval authority, so they are never appointed by an onboarding officer or the Ministry.
  if p_role in ('site_manager','safety_officer','supervisor','onboarding_officer') and not public.mg_is_company_admin(p_org) then
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
    if p_role not in ('worker','safety_officer','supervisor','site_manager') then
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
  if p_role not in ('site_manager','safety_officer','supervisor','worker','onboarding_officer') then
    raise exception 'INVALID_ROLE: a company administrator is appointed by the Ministry';
  end if;
  update public.organization_members set org_role = p_role where id = m.id;
end;
$mg$;

create or replace function public.mg_org_role_label(p_role text)
returns text
language sql immutable
as $mg$
  select case p_role
           when 'company_admin'       then 'Company administrator'
           when 'site_manager'        then 'Site manager'
           when 'safety_officer'      then 'Safety officer'
           when 'supervisor'          then 'Supervisor'
           when 'onboarding_officer'  then 'Onboarding officer'
           else 'Worker' end
$mg$;

create or replace function public.mg_emergency_in_audience(p_alert uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select exists (
    select 1
      from public.emergency_alerts a
      join public.sites s on s.id = a.site_id
      join public.organization_members m
        on m.organization_id = s.organization_id and m.user_id = p_user and m.status = 'active'
      join public.organizations o on o.id = m.organization_id and o.status = 'approved'
     where a.id = p_alert
       and public.mg_operator_site_ok(p_user, s.id, s.organization_id)
       and case a.target_group
             when 'all'             then true
             when 'workers'         then m.org_role in ('worker','supervisor')
             when 'safety_officers' then m.org_role = 'safety_officer'
             when 'site_managers'   then m.org_role in ('site_manager','company_admin')
             else false end)
$mg$;

create or replace function public.mg_emergency_audience(p_alert uuid)
returns table (user_id uuid, org_role text)
language sql stable security definer set search_path = public as $mg$
  select m.user_id, m.org_role
    from public.emergency_alerts a
    join public.sites s on s.id = a.site_id
    join public.organization_members m
      on m.organization_id = s.organization_id and m.status = 'active'
    join public.organizations o on o.id = m.organization_id and o.status = 'approved'
   where a.id = p_alert
     and public.mg_operator_site_ok(m.user_id, s.id, s.organization_id)
     and case a.target_group
           when 'all'             then true
           when 'workers'         then m.org_role in ('worker','supervisor')
           when 'safety_officers' then m.org_role = 'safety_officer'
           when 'site_managers'   then m.org_role in ('site_manager','company_admin')
           else false end
$mg$;

commit;
