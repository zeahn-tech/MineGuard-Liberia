-- ============================================================================
-- MINEGUARD LIBERIA — migration 0026: company workforce administration (Phase C)
--
-- Reuses 0025's organization_members (a membership REQUEST is simply a member
-- row with status 'pending') and organization_invitations (worker invitations
-- use the same table, edge function and email path). Adds:
--   * mg_can_manage_company(org): the Ministry (organizations.write) OR an ACTIVE
--     company_admin of an APPROVED company — the single authorization predicate.
--   * Invitations for site_manager / safety_officer / worker by a company admin;
--     company_admin invitations stay Ministry-only (explicitly authorized workflow).
--   * Membership requests: search approved companies (min 3 chars, 8 results),
--     request, cancel; approve/reject by a company admin; 24 h cooldown after a
--     rejection. Typing a name never grants anything.
--   * Role change and revocation by a company admin, never for company admins,
--     never for oneself. Revocation removes the profile role + company binding
--     in the same transaction (access ends immediately).
--   * RLS: company admins read their OWN company's members/invitations only.
--   * Backfill: existing operator profiles that already carry a company binding
--     get an ACTIVE 'worker' membership row (additive, idempotent, nothing
--     overwritten) so the workforce list matches real access.
--
-- Roles in this phase describe responsibility inside the company; per-site
-- restriction of site managers arrives in Phase D. A worker gains no admin
-- capability from registering, accepting or requesting.
--
-- Idempotent. Rollback: drop the new functions/policies, restore 0025's
-- definitions of mg_prepare_invitation_send / mg_revoke_invitation /
-- mg_accept_invitation / mg_create_company_admin_invitation and its two
-- read policies, and (optionally) delete backfilled rows created_by is null.
-- Deployment order: this migration BEFORE the updated edge function/frontend.
-- ============================================================================

begin;

alter table public.organization_members drop constraint if exists organization_members_status_check;
alter table public.organization_members
  add constraint organization_members_status_check
  check (status in ('pending','active','revoked','rejected'));

-- Authorization predicate ---------------------------------------------------------------
create or replace function public.mg_can_manage_company(p_org uuid)
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select auth.uid() is not null
     and (
          public.mg_has_permission('organizations.write')
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

-- RLS: company admins read their own company's rows ------------------------------------------
drop policy if exists "org members read" on public.organization_members;
create policy "org members read" on public.organization_members
  for select to authenticated
  using (user_id = auth.uid()
         or public.mg_has_permission('users.manage')
         or public.mg_can_manage_company(organization_id));

drop policy if exists "org invitations read" on public.organization_invitations;
create policy "org invitations read" on public.organization_invitations
  for select to authenticated
  using (public.mg_has_permission('users.manage')
         or public.mg_can_manage_company(organization_id));

-- Backfill (additive) ---------------------------------------------------------------------------
insert into public.organization_members (organization_id, user_id, org_role, status)
select p.organization_id, p.id, 'worker', 'active'
  from public.profiles p
 where p.role = 'operator'
   and p.organization_id is not null
   and not exists (select 1 from public.organization_members m
                    where m.user_id = p.id and m.status in ('pending','active'));

-- Invitations: any company role ----------------------------------------------------------------
create or replace function public.mg_create_org_invitation(p_org uuid, p_email text, p_role text)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_org public.organizations;
  v_id uuid;
  v_existing public.profiles;
begin
  if auth.uid() is null or not public.mg_can_manage_company(p_org) then
    raise exception 'FORBIDDEN: company administration required';
  end if;
  if p_role not in ('company_admin','site_manager','safety_officer','worker') then
    raise exception 'INVALID_ROLE';
  end if;
  if p_role = 'company_admin' and not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: only the Ministry can appoint a company administrator';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'INVALID_EMAIL';
  end if;
  select * into v_org from public.organizations where id = p_org;
  if not found then raise exception 'NOT_FOUND: company'; end if;
  if v_org.status <> 'approved' then
    raise exception 'ORG_NOT_APPROVED: the company is not approved';
  end if;

  select * into v_existing from public.profiles where lower(email) = v_email limit 1;
  if found then
    if v_existing.role in ('admin','supervisor','inspector') then
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
    (organization_id, email, org_role, expires_at, created_by)
  values (p_org, v_email, p_role, now() + interval '7 days', auth.uid())
  on conflict (organization_id, email, org_role) where status = 'pending' do nothing;

  select id into v_id from public.organization_invitations
   where organization_id = p_org and email = v_email and org_role = p_role and status = 'pending';
  return v_id;
end;
$mg$;

create or replace function public.mg_create_company_admin_invitation(p_org uuid, p_email text)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  return public.mg_create_org_invitation(p_org, p_email, 'company_admin');
end;
$mg$;

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
  if not public.mg_can_manage_company(v.organization_id)
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
  if not public.mg_can_manage_company(v.organization_id)
     or (v.org_role = 'company_admin' and not v_ministry) then
    raise exception 'FORBIDDEN';
  end if;
  if v.status <> 'pending' then raise exception 'INVITATION_NOT_PENDING'; end if;
  update public.organization_invitations
     set status = 'revoked', revoked_by = auth.uid(), revoked_at = now()
   where id = p_id;
end;
$mg$;

-- Accept: only an ACTIVE membership elsewhere blocks; own pending request elsewhere is withdrawn
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
  if v_profile.role in ('admin','supervisor','inspector') then
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

-- Membership requests -----------------------------------------------------------------------------
create or replace function public.mg_search_companies(p_query text)
returns table (id uuid, name text)
language sql stable security definer set search_path = public
as $mg$
  select o.id, o.name
    from public.organizations o
   where auth.uid() is not null
     and char_length(btrim(coalesce(p_query, ''))) >= 3
     and o.status = 'approved'
     and position(lower(btrim(p_query)) in lower(o.name)) > 0
   order by o.name
   limit 8
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
  if v_profile.role in ('admin','supervisor','inspector') then
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

create or replace function public.mg_cancel_membership_request()
returns void
language plpgsql security definer set search_path = public
as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  update public.organization_members set status = 'revoked'
   where user_id = auth.uid() and status = 'pending';
end;
$mg$;

create or replace function public.mg_my_membership()
returns table (member_id uuid, organization_id uuid, organization_name text,
               org_role text, member_status text, company_status text)
language sql stable security definer set search_path = public
as $mg$
  select m.id, m.organization_id, o.name, m.org_role, m.status, o.status
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
   where auth.uid() is not null
     and m.user_id = auth.uid()
     and m.status in ('pending','active')
$mg$;

-- Workforce administration ---------------------------------------------------------------------------
create or replace function public.mg_company_workforce(p_org uuid)
returns table (member_id uuid, user_id uuid, email text, name text,
               org_role text, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_can_manage_company(p_org) then
    raise exception 'FORBIDDEN';
  end if;
  return query
    select m.id, m.user_id, p.email, p.name, m.org_role, m.status, m.created_at
      from public.organization_members m
      join public.profiles p on p.id = m.user_id
     where m.organization_id = p_org and m.status in ('pending','active')
     order by m.status, p.name nulls last, p.email;
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
  if not found or v_profile.role in ('admin','supervisor','inspector') then
    raise exception 'INELIGIBLE_ACCOUNT';
  end if;
  if exists (select 1 from public.organization_members x
              where x.user_id = m.user_id and x.status = 'active') then
    raise exception 'ALREADY_MEMBER_OTHER_ORG';
  end if;

  update public.organization_members set status = 'active', org_role = p_role where id = m.id;
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
  if not found or not public.mg_can_manage_company(m.organization_id) then
    raise exception 'FORBIDDEN';
  end if;
  if m.status <> 'active' then raise exception 'MEMBERSHIP_NOT_ACTIVE'; end if;
  if m.user_id = auth.uid() then raise exception 'FORBIDDEN: you cannot change your own role'; end if;
  if m.org_role = 'company_admin' and not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: only the Ministry manages company administrators';
  end if;
  if p_role not in ('site_manager','safety_officer','worker') then
    raise exception 'INVALID_ROLE: a company administrator is appointed by the Ministry';
  end if;
  update public.organization_members set org_role = p_role where id = m.id;
end;
$mg$;

create or replace function public.mg_revoke_member(p_member_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare m public.organization_members;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into m from public.organization_members where id = p_member_id for update;
  if not found or not public.mg_can_manage_company(m.organization_id) then
    raise exception 'FORBIDDEN';
  end if;
  if m.status <> 'active' then raise exception 'MEMBERSHIP_NOT_ACTIVE'; end if;
  if m.user_id = auth.uid() then raise exception 'FORBIDDEN: you cannot remove yourself'; end if;
  if m.org_role = 'company_admin' and not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: only the Ministry manages company administrators';
  end if;

  update public.organization_members set status = 'revoked' where id = m.id;
  -- Access ends in the same transaction: no role, no company binding.
  perform set_config('mg.org_assign', '1', true);
  update public.profiles
     set role = null, organization_id = null, operator_name = null
   where id = m.user_id and organization_id = m.organization_id and role = 'operator';
  perform set_config('mg.org_assign', '0', true);
end;
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_create_org_invitation(uuid, text, text)',
    'mg_search_companies(text)',
    'mg_request_membership(uuid)',
    'mg_cancel_membership_request()',
    'mg_my_membership()',
    'mg_company_workforce(uuid)',
    'mg_decide_membership_request(uuid, boolean, text)',
    'mg_set_member_role(uuid, text)',
    'mg_revoke_member(uuid)',
    'mg_create_company_admin_invitation(uuid, text)',
    'mg_prepare_invitation_send(uuid)',
    'mg_revoke_invitation(uuid)',
    'mg_accept_invitation(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
