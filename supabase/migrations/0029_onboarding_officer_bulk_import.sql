-- ============================================================================
-- MINEGUARD LIBERIA — migration 0029: onboarding officer + bulk workforce import (Phase E)
--
-- A DEDICATED company role, `onboarding_officer`, exists only to bring people in:
--   CAN    run bulk imports; invite workers / safety officers and resend or revoke
--          THOSE invitations; read the company workforce list
--   CANNOT approve join requests, change roles, remove people, assign sites, invite
--          site managers / officers / administrators, or read any site or safety
--          record (the per-site rule gives that role no site at all).
-- Appointed only by a company administrator or the Ministry (invitation).
--
-- BULK IMPORT creates PENDING INVITATIONS only — never accounts, never memberships,
-- never an administrative role. Only `worker` and `safety_officer` rows are accepted;
-- every other role in a file is a row error. The file's person must still sign in
-- with a VERIFIED email and accept (identity verification and approval are not bypassed).
-- Server-side limits: <= 100 rows per call, <= 2000 rows per import. Retry-safe: an
-- import is keyed by (company, idempotency_key); a row number is processed at most once;
-- the unique pending-invitation index prevents duplicates. Rows that cannot be invited
-- for reasons that would reveal another company's data (member elsewhere, government
-- account) all read "This address cannot be invited".
-- Optional `site_code` column: the invitation remembers the site and acceptance assigns
-- the person to it (validated against the company's own sites).
--
-- Reuses: organization_invitations + mg_prepare_invitation_send + the email edge
-- function (extended with an import mode), mg_touch_row / mg_audit_row triggers.
-- Idempotent. Rollback: drop the new functions/tables/policies/column, restore the
-- 0026/0027/0028 definitions of the replaced functions and re-add the role CHECKs
-- without onboarding_officer (only after removing officers).
-- Deployment order: after 0028; before the frontend import page.
-- ============================================================================

begin;

-- Role CHECKs ---------------------------------------------------------------------------------
alter table public.organization_members drop constraint if exists organization_members_org_role_check;
alter table public.organization_members add constraint organization_members_org_role_check
  check (org_role in ('company_admin','site_manager','safety_officer','worker','onboarding_officer'));
alter table public.organization_invitations drop constraint if exists organization_invitations_org_role_check;
alter table public.organization_invitations add constraint organization_invitations_org_role_check
  check (org_role in ('company_admin','site_manager','safety_officer','worker','onboarding_officer'));

alter table public.organization_invitations
  add column if not exists site_id uuid references public.sites(id);

-- Authorization predicate for onboarding ---------------------------------------------------------
create or replace function public.mg_can_onboard_company(p_org uuid)
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select auth.uid() is not null
     and (
          public.mg_can_manage_company(p_org)
          or exists (
               select 1
                 from public.organization_members m
                 join public.organizations o on o.id = m.organization_id
                where m.user_id = auth.uid()
                  and m.organization_id = p_org
                  and m.org_role = 'onboarding_officer'
                  and m.status = 'active'
                  and o.status = 'approved')
        )
$mg$;
revoke all on function public.mg_can_onboard_company(uuid) from public, anon;
grant execute on function public.mg_can_onboard_company(uuid) to authenticated;

drop policy if exists "org invitations read" on public.organization_invitations;
create policy "org invitations read" on public.organization_invitations
  for select to authenticated
  using (public.mg_has_permission('users.manage')
         or public.mg_can_onboard_company(organization_id));

-- Invitations: one core, role matrix enforced in ONE place -------------------------------------------
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
  if auth.uid() is null or not public.mg_can_onboard_company(p_org) then
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
    (organization_id, email, org_role, expires_at, created_by, site_id)
  values (p_org, v_email, p_role, now() + interval '7 days', auth.uid(), p_site)
  on conflict (organization_id, email, org_role) where status = 'pending' do nothing;

  select id into v_id from public.organization_invitations
   where organization_id = p_org and email = v_email and org_role = p_role and status = 'pending';
  return v_id;
end;
$mg$;
revoke all on function public.mg_create_org_invitation_core(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.mg_create_org_invitation(p_org uuid, p_email text, p_role text)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  return public.mg_create_org_invitation_core(p_org, p_email, p_role, null);
end;
$mg$;

-- Resend / revoke: officers may handle worker + safety_officer invitations only ----------------------------
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
          or (public.mg_can_onboard_company(v.organization_id) and v.org_role in ('worker','safety_officer')))
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
          or (public.mg_can_onboard_company(v.organization_id) and v.org_role in ('worker','safety_officer')))
     or (v.org_role = 'company_admin' and not v_ministry) then
    raise exception 'FORBIDDEN';
  end if;
  if v.status <> 'pending' then raise exception 'INVITATION_NOT_PENDING'; end if;
  update public.organization_invitations
     set status = 'revoked', revoked_by = auth.uid(), revoked_at = now()
   where id = p_id;
end;
$mg$;

-- Accept: also applies the invitation's site (validated again) --------------------------------------------
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

-- Workforce list: readable by onboarding officers (names + emails, no actions) -----------------------------------
create or replace function public.mg_company_workforce(p_org uuid)
returns table (member_id uuid, user_id uuid, email text, name text,
               org_role text, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_can_onboard_company(p_org) then
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

-- Role change may appoint an onboarding officer (company admin / Ministry only) -------------------------------------
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
  if p_role not in ('site_manager','safety_officer','worker','onboarding_officer') then
    raise exception 'INVALID_ROLE: a company administrator is appointed by the Ministry';
  end if;
  update public.organization_members set org_role = p_role where id = m.id;
end;
$mg$;

-- Site people: an onboarding officer is neither assignable nor listed -------------------------------------------------
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
    if m.org_role not in ('worker','safety_officer') then
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
            or m.org_role in ('worker','safety_officer')
            or exists (select 1 from public.site_assignments sa
                        where sa.user_id = m.user_id and sa.site_id = s.id and sa.revoked_at is null))
     order by m.org_role, p.name nulls last, p.email;
end;
$mg$;

-- BULK IMPORT ------------------------------------------------------------------------------------------------------------
create table if not exists public.organization_imports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  idempotency_key uuid not null,
  filename        text,
  total_rows      integer not null check (total_rows between 1 and 2000),
  status          text not null default 'processing'
                  check (status in ('processing','completed','completed_with_errors')),
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  updated_by      uuid,
  row_version     integer not null default 1,
  unique (organization_id, idempotency_key)
);

create table if not exists public.organization_import_rows (
  import_id     uuid not null references public.organization_imports(id),
  row_number    integer not null check (row_number >= 1),
  email         text,
  org_role      text,
  full_name     text,
  site_code     text,
  outcome       text not null
                check (outcome in ('invited','already_invited','already_member','duplicate_in_file','error')),
  message       text,
  invitation_id uuid references public.organization_invitations(id),
  created_at    timestamptz not null default now(),
  primary key (import_id, row_number)
);

alter table public.organization_imports enable row level security;
alter table public.organization_import_rows enable row level security;

drop policy if exists "org imports read" on public.organization_imports;
create policy "org imports read" on public.organization_imports
  for select to authenticated
  using (public.mg_can_onboard_company(organization_id));

drop policy if exists "org import rows read" on public.organization_import_rows;
create policy "org import rows read" on public.organization_import_rows
  for select to authenticated
  using (exists (select 1 from public.organization_imports i
                  where i.id = organization_import_rows.import_id
                    and public.mg_can_onboard_company(i.organization_id)));

revoke all on public.organization_imports, public.organization_import_rows from public, anon, authenticated;
grant select on public.organization_imports, public.organization_import_rows to authenticated;

drop trigger if exists organization_imports_touch on public.organization_imports;
create trigger organization_imports_touch before insert or update on public.organization_imports
  for each row execute function public.mg_touch_row();
drop trigger if exists organization_imports_audit on public.organization_imports;
create trigger organization_imports_audit after insert or update on public.organization_imports
  for each row execute function public.mg_audit_row();

-- Row evaluation (no writes). Returns {outcome: ok|error|already_invited|already_member, message, ...} --------------------
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
    if v_prof.role in ('admin','supervisor','inspector')
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

-- Preview: server-side dry run for <= 100 rows; writes nothing ---------------------------------------------------------------
create or replace function public.mg_import_check(p_org uuid, p_rows jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
declare
  r jsonb;
  out jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or not public.mg_can_onboard_company(p_org) then
    raise exception 'FORBIDDEN';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'INVALID_IMPORT: send at most 100 rows per request';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    out := out || jsonb_build_array(
      public.mg_import_eval(p_org, r) || jsonb_build_object('row', (r->>'row')::int));
  end loop;
  return out;
end;
$mg$;

-- Start (idempotent on the client's key) ------------------------------------------------------------------------------------------
create or replace function public.mg_import_start(p_org uuid, p_key uuid, p_filename text, p_total_rows integer)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_id uuid;
  v_by uuid;
  v_org public.organizations;
begin
  if auth.uid() is null or not public.mg_can_onboard_company(p_org) then
    raise exception 'FORBIDDEN';
  end if;
  if p_key is null or p_total_rows is null or p_total_rows < 1 or p_total_rows > 2000 then
    raise exception 'INVALID_IMPORT: between 1 and 2000 rows';
  end if;
  select * into v_org from public.organizations where id = p_org;
  if not found or v_org.status <> 'approved' then raise exception 'ORG_NOT_APPROVED'; end if;

  select id, created_by into v_id, v_by from public.organization_imports
   where organization_id = p_org and idempotency_key = p_key;
  if found then
    if v_by <> auth.uid() then raise exception 'FORBIDDEN'; end if;
    return v_id;                                   -- retry of the same import
  end if;
  insert into public.organization_imports (organization_id, idempotency_key, filename, total_rows, created_by)
  values (p_org, p_key, left(regexp_replace(coalesce(p_filename, ''), '[[:cntrl:]]', '', 'g'), 200),
          p_total_rows, auth.uid())
  returning id into v_id;
  return v_id;
end;
$mg$;

-- Apply a batch (<= 100 rows). Each row number is processed at most once. -------------------------------------------------------------
create or replace function public.mg_import_apply(p_import uuid, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $mg$
declare
  imp public.organization_imports;
  r jsonb;
  n int;
  ev jsonb;
  prev public.organization_import_rows;
  v_inv uuid;
  v_outcome text;
  v_msg text;
  v_processed int;
  v_errors int;
  out jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into imp from public.organization_imports where id = p_import for update;
  if not found or not public.mg_can_onboard_company(imp.organization_id)
     or (imp.created_by <> auth.uid() and not public.mg_can_manage_company(imp.organization_id)) then
    raise exception 'FORBIDDEN';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'INVALID_IMPORT: send at most 100 rows per request';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    n := (r->>'row')::int;
    if n is null or n < 1 or n > imp.total_rows then
      raise exception 'INVALID_IMPORT: row number out of range';
    end if;
    select * into prev from public.organization_import_rows where import_id = imp.id and row_number = n;
    if found then                                   -- retry: report the recorded outcome, do nothing
      out := out || jsonb_build_array(jsonb_build_object('row', n, 'outcome', prev.outcome, 'message', prev.message));
      continue;
    end if;

    ev := public.mg_import_eval(imp.organization_id, r);
    v_outcome := ev->>'outcome';
    v_msg := ev->>'message';
    v_inv := null;

    -- an address already handled EARLIER IN THIS FILE is a duplicate, whatever the
    -- database now says about it (row 1's invitation makes row 5 look "already invited")
    if btrim(coalesce(r->>'email', '')) <> ''
       and exists (select 1 from public.organization_import_rows x
                    where x.import_id = imp.id and x.email = lower(btrim(r->>'email'))
                      and x.outcome in ('invited','already_invited','already_member')) then
      v_outcome := 'duplicate_in_file';
      v_msg := 'Duplicate email in this file';
      ev := ev || jsonb_build_object('email', lower(btrim(r->>'email')));
    elsif v_outcome = 'ok' then
      begin
        v_inv := public.mg_create_org_invitation_core(
          imp.organization_id, ev->>'email', ev->>'role', nullif(ev->>'site_id','')::uuid);
        v_outcome := 'invited';
        v_msg := 'Invitation created';
      exception when others then
        v_outcome := 'error';
        v_msg := 'This address cannot be invited';   -- never echo database details
        v_inv := null;
      end;
    end if;

    insert into public.organization_import_rows
      (import_id, row_number, email, org_role, full_name, site_code, outcome, message, invitation_id)
    values (imp.id, n, nullif(ev->>'email',''), nullif(ev->>'role',''),
            left(nullif(btrim(coalesce(r->>'full_name','')), ''), 120),
            left(nullif(btrim(coalesce(r->>'site_code','')), ''), 60),
            v_outcome, v_msg, v_inv);
    out := out || jsonb_build_array(jsonb_build_object('row', n, 'outcome', v_outcome, 'message', v_msg));
  end loop;

  select count(*), count(*) filter (where outcome in ('error','duplicate_in_file'))
    into v_processed, v_errors
    from public.organization_import_rows where import_id = imp.id;
  if v_processed >= imp.total_rows then
    update public.organization_imports
       set status = case when v_errors > 0 then 'completed_with_errors' else 'completed' end
     where id = imp.id and status = 'processing';
  end if;
  return out;
end;
$mg$;

-- Status + the unsent-email queue ---------------------------------------------------------------------------------------------------------
create or replace function public.mg_import_status(p_import uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
declare imp public.organization_imports;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into imp from public.organization_imports where id = p_import;
  if not found or not public.mg_can_onboard_company(imp.organization_id) then
    raise exception 'FORBIDDEN';
  end if;
  return jsonb_build_object(
    'status', imp.status,
    'total', imp.total_rows,
    'processed', (select count(*) from public.organization_import_rows where import_id = imp.id),
    'invited', (select count(*) from public.organization_import_rows where import_id = imp.id and outcome = 'invited'),
    'alreadyInvited', (select count(*) from public.organization_import_rows where import_id = imp.id and outcome = 'already_invited'),
    'alreadyMember', (select count(*) from public.organization_import_rows where import_id = imp.id and outcome = 'already_member'),
    'duplicates', (select count(*) from public.organization_import_rows where import_id = imp.id and outcome = 'duplicate_in_file'),
    'errors', (select count(*) from public.organization_import_rows where import_id = imp.id and outcome = 'error'),
    'unsent', (select count(*) from public.organization_import_rows x
                 join public.organization_invitations i on i.id = x.invitation_id
                where x.import_id = imp.id and x.outcome = 'invited'
                  and i.status = 'pending' and i.send_count = 0)
  );
end;
$mg$;

create or replace function public.mg_import_unsent(p_import uuid, p_limit integer default 20)
returns table (invitation_id uuid)
language plpgsql stable security definer set search_path = public
as $mg$
declare imp public.organization_imports;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into imp from public.organization_imports where id = p_import;
  if not found or not public.mg_can_onboard_company(imp.organization_id) then
    raise exception 'FORBIDDEN';
  end if;
  return query
    select x.invitation_id
      from public.organization_import_rows x
      join public.organization_invitations i on i.id = x.invitation_id
     where x.import_id = imp.id and x.outcome = 'invited'
       and i.status = 'pending' and i.send_count = 0 and i.expires_at > now()
     order by x.row_number
     limit greatest(1, least(coalesce(p_limit, 20), 25));
end;
$mg$;

-- A failed email must not consume the send: put the invitation back in the queue ---------------------------------------
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
             or (public.mg_can_onboard_company(v.organization_id) and v.org_role in ('worker','safety_officer'))) then
    raise exception 'FORBIDDEN';
  end if;
  update public.organization_invitations
     set send_count = greatest(send_count - 1, 0), last_sent_at = null
   where id = p_id and status = 'pending';
end;
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_create_org_invitation(uuid, text, text)',
    'mg_prepare_invitation_send(uuid)',
    'mg_revoke_invitation(uuid)',
    'mg_accept_invitation(uuid)',
    'mg_company_workforce(uuid)',
    'mg_set_member_role(uuid, text)',
    'mg_assign_member_site(uuid, uuid)',
    'mg_site_roster(uuid)',
    'mg_import_check(uuid, jsonb)',
    'mg_import_start(uuid, uuid, text, integer)',
    'mg_import_apply(uuid, jsonb)',
    'mg_import_status(uuid)',
    'mg_import_unsent(uuid, integer)',
    'mg_release_invitation_send(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
