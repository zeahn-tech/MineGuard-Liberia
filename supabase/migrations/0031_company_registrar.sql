-- ============================================================================
-- MINEGUARD LIBERIA — migration 0031: the dedicated Ministry "Company registrar" role
--
-- Needs 0030 (the enum value) committed first.
--
-- WHAT A REGISTRAR IS: a government role for the licensing / authorization office.
--   CAN    register + approve a company; nominate its FIRST administrator and
--          resend / revoke those administrator invitations; suspend, deactivate or
--          reactivate a company (reason required); see the company directory
--          (status, site COUNT, administrators, invitation state, member COUNTS)
--   CANNOT read any site, incident, inspection, corrective action or audit record;
--          read other profiles; manage accounts, roles, boundaries or templates;
--          see or change any company's workforce (names, roles, requests, imports,
--          site people) — those stay with the company and the full `admin`.
-- It is assigned only by a full `admin` (provision_user_by_email) or by the
-- owner-run script supabase/maintenance/assign_company_registrar.sql.
--
-- HOW: the role holds exactly one permission, organizations.write (what every
-- company-authority RPC already checks). Workforce oversight, which `admin` always
-- had implicitly through organizations.write, becomes its OWN permission
-- (workforce.oversee, held by admin only) so the registrar does not inherit it:
-- mg_can_manage_company now tests that permission. Admin behaviour is unchanged.
-- Administrator invitations (company_admin) are the one workforce-adjacent thing a
-- registrar handles, so the invitation functions accept organizations.write for
-- THAT role only.
--
-- Idempotent. Rollback: restore the 0026 mg_can_manage_company and the 0029
-- invitation functions, drop mg_company_directory, delete the two permission rows.
-- ============================================================================

begin;

insert into public.permissions (role, permission) values
  ('admin',     'workforce.oversee'),
  ('registrar', 'organizations.write')
on conflict (role, permission) do nothing;

-- Company management authority: the full admin's oversight OR an active company administrator
create or replace function public.mg_can_manage_company(p_org uuid)
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select auth.uid() is not null
     and (
          public.mg_has_permission('workforce.oversee')
          or exists (
               select 1
                 from public.organization_members m
                 join public.organizations o on o.id = m.organization_id
                where m.user_id = auth.uid()
                  and m.organization_id = p_org
                  and m.org_role = 'company_admin'
                  and m.status = 'active'
                  and o.status = 'approved')
        )
$mg$;
revoke all on function public.mg_can_manage_company(uuid) from public, anon;
grant execute on function public.mg_can_manage_company(uuid) to authenticated;

-- Invitation core: a registrar may create ONLY company_admin invitations
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
  if p_role in ('site_manager','onboarding_officer') and not public.mg_can_manage_company(p_org) then
    raise exception 'FORBIDDEN: only a company administrator can appoint this role';
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
revoke all on function public.mg_create_org_invitation_core(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.mg_prepare_invitation_send(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $mg$
declare
  v public.organization_invitations;
  v_org text;
  v_ministry boolean := public.mg_has_permission('organizations.write');
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into v from public.organization_invitations where id = p_id for update;
  if not found then
    raise exception '%', case when v_ministry then 'INVITATION_NOT_PENDING' else 'FORBIDDEN' end;
  end if;
  if not (public.mg_can_manage_company(v.organization_id)
          or (public.mg_can_onboard_company(v.organization_id) and v.org_role in ('worker','safety_officer'))
          or (v.org_role = 'company_admin' and v_ministry))
     or (v.org_role = 'company_admin' and not v_ministry) then
    raise exception 'FORBIDDEN';
  end if;
  if v.status <> 'pending' then raise exception 'INVITATION_NOT_PENDING'; end if;
  if v.expires_at <= now() then raise exception 'INVITATION_EXPIRED'; end if;
  if v.last_sent_at is not null and v.last_sent_at > now() - interval '60 seconds' then
    raise exception 'RESEND_TOO_SOON: wait a minute before resending';
  end if;
  if v.send_count >= 10 then
    raise exception 'SEND_LIMIT: revoke and create a new invitation';
  end if;
  update public.organization_invitations
     set last_sent_at = now(), send_count = send_count + 1
   where id = p_id;
  select name into v_org from public.organizations where id = v.organization_id;
  return jsonb_build_object('email', v.email, 'organizationName', v_org);
end;
$mg$;

create or replace function public.mg_revoke_invitation(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  v public.organization_invitations;
  v_ministry boolean := public.mg_has_permission('organizations.write');
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into v from public.organization_invitations where id = p_id for update;
  if not found then
    raise exception '%', case when v_ministry then 'INVITATION_NOT_PENDING' else 'FORBIDDEN' end;
  end if;
  if not (public.mg_can_manage_company(v.organization_id)
          or (public.mg_can_onboard_company(v.organization_id) and v.org_role in ('worker','safety_officer'))
          or (v.org_role = 'company_admin' and v_ministry))
     or (v.org_role = 'company_admin' and not v_ministry) then
    raise exception 'FORBIDDEN';
  end if;
  if v.status <> 'pending' then raise exception 'INVITATION_NOT_PENDING'; end if;
  update public.organization_invitations
     set status = 'revoked', revoked_by = auth.uid(), revoked_at = now()
   where id = p_id;
end;
$mg$;

create or replace function public.mg_release_invitation_send(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare v public.organization_invitations;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into v from public.organization_invitations where id = p_id for update;
  if not found
     or not (public.mg_can_manage_company(v.organization_id)
             or (public.mg_can_onboard_company(v.organization_id) and v.org_role in ('worker','safety_officer'))
             or (v.org_role = 'company_admin' and public.mg_has_permission('organizations.write'))) then
    raise exception 'FORBIDDEN';
  end if;
  update public.organization_invitations
     set send_count = greatest(send_count - 1, 0), last_sent_at = null
   where id = p_id and status = 'pending';
end;
$mg$;

-- Company directory: everything the registry screen needs, and no more ------------------------------
-- Company administrators + their invitations are listed individually; everyone else
-- is only COUNTED (no worker names, emails or requests leave the company).
create or replace function public.mg_company_directory()
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'name', o.name,
      'status', o.status,
      'statusReason', o.status_reason,
      'siteCount', (select count(*) from public.sites s where s.organization_id = o.id),
      'activeMembers', (select count(*) from public.organization_members m
                         where m.organization_id = o.id and m.status = 'active'),
      'pendingRequests', (select count(*) from public.organization_members m
                           where m.organization_id = o.id and m.status = 'pending'),
      'admins', coalesce((
        select jsonb_agg(jsonb_build_object('userId', m.user_id, 'email', p.email, 'name', p.name)
                         order by m.created_at)
          from public.organization_members m
          join public.profiles p on p.id = m.user_id
         where m.organization_id = o.id and m.status = 'active' and m.org_role = 'company_admin'), '[]'::jsonb),
      'invitations', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', i.id, 'email', i.email, 'orgRole', i.org_role, 'status', i.status,
                 'expiresAt', i.expires_at, 'lastSentAt', i.last_sent_at,
                 'sendCount', i.send_count, 'createdAt', i.created_at)
               order by i.created_at desc)
          from (select * from public.organization_invitations x
                 where x.organization_id = o.id and x.org_role = 'company_admin'
                 order by x.created_at desc limit 10) i), '[]'::jsonb)
    ) order by o.name)
    from public.organizations o), '[]'::jsonb);
end;
$mg$;

-- A registrar is a GOVERNMENT account: every place that refuses admin/supervisor/inspector
-- joining a company refuses registrar too (exact copies of the earlier functions, one list widened).
create or replace function public.mg_accept_invitation(p_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_email text := public.mg_caller_email();
  v public.organization_invitations;
  v_org public.organizations;
  v_profile public.profiles;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if v_email is null then raise exception 'EMAIL_NOT_VERIFIED'; end if;

  select * into v from public.organization_invitations where id = p_id for update;
  if not found or v.email <> v_email or v.status <> 'pending' then
    raise exception 'INVITATION_INVALID';
  end if;
  if v.expires_at <= now() then raise exception 'INVITATION_EXPIRED'; end if;

  select * into v_org from public.organizations where id = v.organization_id;
  if v_org.status <> 'approved' then raise exception 'ORG_NOT_APPROVED'; end if;

  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'UNREGISTERED_USER'; end if;
  if v_profile.role in ('admin','supervisor','inspector','registrar') then
    raise exception 'INELIGIBLE_ACCOUNT';
  end if;
  if exists (select 1 from public.organization_members m
              where m.user_id = auth.uid() and m.status = 'active'
                and m.organization_id <> v.organization_id) then
    raise exception 'ALREADY_MEMBER_OTHER_ORG';
  end if;

  update public.organization_members
     set status = 'revoked'
   where user_id = auth.uid() and status = 'pending'
     and organization_id <> v.organization_id;

  update public.organization_members
     set org_role = v.org_role, status = 'active'
   where user_id = auth.uid() and organization_id = v.organization_id
     and status in ('pending','active');
  if not found then
    insert into public.organization_members (organization_id, user_id, org_role, status, created_by)
    values (v.organization_id, auth.uid(), v.org_role, 'active', v.created_by);
  end if;

  if v.site_id is not null and v.org_role in ('worker','safety_officer','site_manager')
     and exists (select 1 from public.sites s where s.id = v.site_id and s.organization_id = v.organization_id) then
    insert into public.site_assignments (user_id, site_id, assigned_by)
    values (auth.uid(), v.site_id, v.created_by)
    on conflict (user_id, site_id)
    do update set revoked_at = null, revoked_by = null, assigned_by = excluded.assigned_by;
  end if;

  perform set_config('mg.org_assign', '1', true);
  update public.profiles
     set role = 'operator', scope = 'operator',
         organization_id = v.organization_id, profile_complete = true
   where id = auth.uid();
  perform set_config('mg.org_assign', '0', true);

  update public.organization_invitations
     set status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
   where id = v.id;
  return v.organization_id;
end;
$mg$;

create or replace function public.mg_request_membership(p_org uuid)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_profile public.profiles;
  v_org public.organizations;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if public.mg_caller_email() is null then raise exception 'EMAIL_NOT_VERIFIED'; end if;
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'UNREGISTERED_USER'; end if;
  if v_profile.role in ('admin','supervisor','inspector','registrar') then
    raise exception 'INELIGIBLE_ACCOUNT';
  end if;
  select * into v_org from public.organizations where id = p_org;
  if not found or v_org.status <> 'approved' then raise exception 'ORG_NOT_APPROVED'; end if;

  if exists (select 1 from public.organization_members
              where user_id = auth.uid() and status = 'active') then
    raise exception 'ALREADY_MEMBER_OTHER_ORG';
  end if;
  select id into v_id from public.organization_members
   where user_id = auth.uid() and organization_id = p_org and status = 'pending';
  if found then return v_id; end if;           -- retry-safe
  if exists (select 1 from public.organization_members
              where user_id = auth.uid() and status = 'pending') then
    raise exception 'PENDING_REQUEST_EXISTS: cancel your other request first';
  end if;
  if exists (select 1 from public.organization_members
              where user_id = auth.uid() and organization_id = p_org
                and status = 'rejected' and updated_at > now() - interval '24 hours') then
    raise exception 'REQUEST_COOLDOWN: you can ask again 24 hours after a decision';
  end if;

  insert into public.organization_members (organization_id, user_id, org_role, status, created_by)
  values (p_org, auth.uid(), 'worker', 'pending', auth.uid())
  returning id into v_id;
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

create or replace function public.mg_import_eval(p_org uuid, p_row jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
declare
  v_email text := lower(btrim(coalesce(p_row->>'email', '')));
  v_role  text := lower(regexp_replace(btrim(coalesce(nullif(p_row->>'role', ''), 'worker')), '[\s-]+', '_', 'g'));
  v_name  text := btrim(coalesce(p_row->>'full_name', ''));
  v_code  text := btrim(coalesce(p_row->>'site_code', ''));
  v_site  uuid;
  v_prof  public.profiles;
begin
  if v_email = '' then
    return jsonb_build_object('outcome','error','message','Email is required');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    return jsonb_build_object('outcome','error','message','Invalid email address');
  end if;
  if v_role not in ('worker','safety_officer') then
    return jsonb_build_object('outcome','error',
      'message','Role must be worker or safety_officer (administrative roles cannot be imported)');
  end if;
  if char_length(v_name) > 120 then
    return jsonb_build_object('outcome','error','message','Name is too long (120 characters maximum)');
  end if;
  if char_length(v_code) > 60 then
    return jsonb_build_object('outcome','error','message','Site code is too long');
  end if;
  if v_code <> '' then
    select s.id into v_site from public.sites s
     where s.organization_id = p_org and lower(s.code) = lower(v_code);
    if v_site is null then
      return jsonb_build_object('outcome','error','message','Unknown site code for this company');
    end if;
  end if;

  select * into v_prof from public.profiles where lower(email) = v_email limit 1;
  if found then
    if v_prof.role in ('admin','supervisor','inspector','registrar')
       or exists (select 1 from public.organization_members m
                   where m.user_id = v_prof.id and m.status = 'active' and m.organization_id <> p_org) then
      return jsonb_build_object('outcome','error','message','This address cannot be invited');
    end if;
    if exists (select 1 from public.organization_members m
                where m.user_id = v_prof.id and m.status = 'active' and m.organization_id = p_org) then
      return jsonb_build_object('outcome','already_member','message','Already a member of this company',
                                'email', v_email, 'role', v_role);
    end if;
  end if;
  if exists (select 1 from public.organization_invitations i
              where i.organization_id = p_org and i.email = v_email and i.status = 'pending'
                and i.expires_at > now()) then
    return jsonb_build_object('outcome','already_invited','message','An invitation is already pending',
                              'email', v_email, 'role', v_role);
  end if;
  return jsonb_build_object('outcome','ok','message','Ready to invite','email', v_email,
                            'role', v_role, 'full_name', v_name, 'site_code', v_code,
                            'site_id', v_site);
end;
$mg$;

revoke all on function public.mg_import_eval(uuid, jsonb) from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_prepare_invitation_send(uuid)',
    'mg_revoke_invitation(uuid)',
    'mg_release_invitation_send(uuid)',
    'mg_company_directory()',
    'mg_accept_invitation(uuid)',
    'mg_request_membership(uuid)',
    'mg_decide_membership_request(uuid, boolean, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
