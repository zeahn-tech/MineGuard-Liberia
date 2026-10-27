-- ============================================================================
-- MINEGUARD LIBERIA — migration 0025: company lifecycle, membership and
-- company-administrator invitations (Phase B)
--
-- Reuses: organizations (tenant key), profiles.organization_id (derived access
-- key), permissions('organizations.write'), mg_touch_row / mg_audit_row triggers
-- (every change is audit-trailed with the SESSION actor), site/org RLS helpers.
-- Adds only what did not exist:
--   A organizations.status      pending_review | approved | suspended | deactivated
--                               (existing rows -> 'approved': behaviour unchanged)
--   B organization_members      one live membership per user (ONE company per user)
--                               with an org_role. Client roles hold SELECT only.
--   C organization_invitations  pending/accepted/revoked/expired, expiring, no
--                               secret stored: the credential is the invitee's own
--                               VERIFIED Supabase login (invite email), matched to
--                               the invited address server-side.
--   D RPCs (SECURITY DEFINER, narrow, explicit grants): register company, create /
--     prepare-send / revoke invitation, list my invitations, accept invitation,
--     set company status.
--   E mg_can_access_site_row: an operator's company must be 'approved'.
--     This is the ONLY change to the access matrix: suspended / deactivated
--     companies lose operator access (reads and writes, because every site-scoped
--     policy routes through this helper) and regain it on reactivation. Records
--     are never deleted; the Ministry (admin/staff branches) is unaffected.
--   F profile tenant guard accepts the assignment made by mg_accept_invitation
--     (transaction-local flag set only inside that definer function).
--
-- Policy (company status):  pending_review/suspended/deactivated -> company users
-- cannot read or write site-scoped records; the Ministry keeps full oversight;
-- only an administrator holding organizations.write may change status, and
-- suspension/deactivation requires a recorded reason.
--
-- Idempotent. Rollback: drop the RPCs, triggers and the three tables/column
-- (nothing else depends on them); re-apply 0010's mg_can_access_site_row.
-- Deployment order: this migration BEFORE the edge function / frontend.
-- ============================================================================

begin;

-- A. company status ---------------------------------------------------------
alter table public.organizations
  add column if not exists status text not null default 'approved'
    check (status in ('pending_review','approved','suspended','deactivated'));
alter table public.organizations add column if not exists status_reason text;
alter table public.organizations add column if not exists status_changed_at timestamptz;
alter table public.organizations add column if not exists status_changed_by uuid;

-- B. membership (one live membership per user) -------------------------------
create table if not exists public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  user_id         uuid not null references public.profiles(id),
  org_role        text not null
                  check (org_role in ('company_admin','site_manager','safety_officer','worker')),
  status          text not null default 'active'
                  check (status in ('pending','active','revoked')),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  updated_by      uuid,
  row_version     integer not null default 1
);
create unique index if not exists organization_members_one_live_per_user
  on public.organization_members (user_id) where status in ('pending','active');
create index if not exists organization_members_org_idx
  on public.organization_members (organization_id);

-- C. invitations ---------------------------------------------------------------
create table if not exists public.organization_invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  email           text not null check (email = lower(email) and char_length(email) <= 254),
  org_role        text not null
                  check (org_role in ('company_admin','site_manager','safety_officer','worker')),
  status          text not null default 'pending'
                  check (status in ('pending','accepted','revoked','expired')),
  expires_at      timestamptz not null,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  accepted_by     uuid,
  accepted_at     timestamptz,
  revoked_by      uuid,
  revoked_at      timestamptz,
  last_sent_at    timestamptz,
  send_count      integer not null default 0,
  updated_at      timestamptz,
  updated_by      uuid,
  row_version     integer not null default 1
);
create unique index if not exists organization_invitations_one_pending
  on public.organization_invitations (organization_id, email, org_role)
  where status = 'pending';
create index if not exists organization_invitations_email_idx
  on public.organization_invitations (email) where status = 'pending';

alter table public.organization_members enable row level security;
alter table public.organization_invitations enable row level security;

drop policy if exists "org members read" on public.organization_members;
create policy "org members read" on public.organization_members
  for select to authenticated
  using (user_id = auth.uid() or public.mg_has_permission('users.manage'));

drop policy if exists "org invitations read" on public.organization_invitations;
create policy "org invitations read" on public.organization_invitations
  for select to authenticated
  using (public.mg_has_permission('users.manage'));

-- Clients: SELECT only. No INSERT/UPDATE/DELETE policy exists either — all
-- writes go through the definer RPCs below.
revoke all on public.organization_members, public.organization_invitations
  from public, anon, authenticated;
grant select on public.organization_members, public.organization_invitations to authenticated;

do $$
declare t text;
begin
  foreach t in array array['organization_members','organization_invitations'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before insert or update on public.%I
                    for each row execute function public.mg_touch_row()', t || '_touch', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update on public.%I
                    for each row execute function public.mg_audit_row()', t || '_audit', t);
  end loop;
end $$;

-- D. internal helper: the caller's VERIFIED email -----------------------------------
create or replace function public.mg_caller_email()
returns text
language sql stable security definer set search_path = public
as $mg$
  select lower(u.email)
    from auth.users u
   where u.id = auth.uid()
     and u.email_confirmed_at is not null
$mg$;
revoke all on function public.mg_caller_email() from public, anon, authenticated;

-- D1. Ministry: register + authorize a company ---------------------------------------
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

-- D2. Ministry: nominate the initial company administrator ---------------------------------
create or replace function public.mg_create_company_admin_invitation(p_org uuid, p_email text)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_org public.organizations;
  v_id uuid;
  v_existing public.profiles;
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'INVALID_EMAIL';
  end if;
  select * into v_org from public.organizations where id = p_org;
  if not found then raise exception 'NOT_FOUND: company'; end if;
  if v_org.status <> 'approved' then
    raise exception 'ORG_NOT_APPROVED: only an approved company can receive an administrator';
  end if;

  select * into v_existing from public.profiles where lower(email) = v_email limit 1;
  if found then
    if v_existing.role in ('admin','supervisor','inspector') then
      raise exception 'INELIGIBLE_ACCOUNT: government accounts cannot be company administrators';
    end if;
    if exists (select 1 from public.organization_members m
                where m.user_id = v_existing.id and m.status in ('pending','active')
                  and m.organization_id <> p_org) then
      raise exception 'ALREADY_MEMBER_OTHER_ORG: this account already belongs to another company';
    end if;
  end if;

  -- retire stale pending invitations for the same target, then create-or-reuse
  update public.organization_invitations
     set status = 'expired'
   where organization_id = p_org and email = v_email and org_role = 'company_admin'
     and status = 'pending' and expires_at <= now();

  insert into public.organization_invitations
    (organization_id, email, org_role, expires_at, created_by)
  values (p_org, v_email, 'company_admin', now() + interval '7 days', auth.uid())
  on conflict (organization_id, email, org_role) where status = 'pending' do nothing;

  select id into v_id from public.organization_invitations
   where organization_id = p_org and email = v_email and org_role = 'company_admin'
     and status = 'pending';
  return v_id;
end;
$mg$;

-- D3. Reserve an email send (throttled) — used by the edge function ---------------------
create or replace function public.mg_prepare_invitation_send(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $mg$
declare
  v public.organization_invitations;
  v_org text;
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  select * into v from public.organization_invitations where id = p_id for update;
  if not found or v.status <> 'pending' then
    raise exception 'INVITATION_NOT_PENDING';
  end if;
  if v.expires_at <= now() then
    raise exception 'INVITATION_EXPIRED';
  end if;
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

-- D4. Revoke ------------------------------------------------------------------------------
create or replace function public.mg_revoke_invitation(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  update public.organization_invitations
     set status = 'revoked', revoked_by = auth.uid(), revoked_at = now()
   where id = p_id and status = 'pending';
  if not found then raise exception 'INVITATION_NOT_PENDING'; end if;
end;
$mg$;

-- D5. Invitee: list my own pending invitations (verified email only) ----------------------------
create or replace function public.mg_my_pending_invitations()
returns table (id uuid, organization_id uuid, organization_name text, org_role text, expires_at timestamptz)
language sql stable security definer set search_path = public
as $mg$
  select i.id, i.organization_id, o.name, i.org_role, i.expires_at
    from public.organization_invitations i
    join public.organizations o on o.id = i.organization_id
   where auth.uid() is not null
     and i.status = 'pending'
     and i.expires_at > now()
     and o.status = 'approved'
     and i.email = public.mg_caller_email()
   order by i.created_at desc
$mg$;

-- D6. Invitee: accept ----------------------------------------------------------------------------
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
  -- one indistinguishable error for unknown id, someone else's invitation, and
  -- already-used / revoked invitations: nothing to enumerate or replay
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
              where m.user_id = auth.uid() and m.status in ('pending','active')
                and m.organization_id <> v.organization_id) then
    raise exception 'ALREADY_MEMBER_OTHER_ORG';
  end if;

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

-- D7. Ministry: company lifecycle -------------------------------------------------------------------
create or replace function public.mg_set_company_status(p_org uuid, p_status text, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: organizations.write required';
  end if;
  if p_status not in ('pending_review','approved','suspended','deactivated') then
    raise exception 'INVALID_STATUS';
  end if;
  if p_status in ('suspended','deactivated')
     and char_length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'REASON_REQUIRED: record why the company is %', p_status;
  end if;
  update public.organizations
     set status = p_status,
         status_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         status_changed_at = now(), status_changed_by = auth.uid()
   where id = p_org;
  if not found then raise exception 'NOT_FOUND: company'; end if;
end;
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_register_company(text)',
    'mg_create_company_admin_invitation(uuid, text)',
    'mg_prepare_invitation_send(uuid)',
    'mg_revoke_invitation(uuid)',
    'mg_my_pending_invitations()',
    'mg_accept_invitation(uuid)',
    'mg_set_company_status(uuid, text, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- E. access matrix: operators need an APPROVED company --------------------------------------------
create or replace function public.mg_can_access_site_row(
  p_site_id       uuid,
  p_county        text,
  p_district      text,
  p_operator_name text,
  p_org_id        uuid
)
returns boolean
language sql
stable
security definer set search_path = public
as $mg$
  select coalesce(
    (
      select public.mg_is_admin()
        or exists (
          select 1
            from public.mg_profile() p
           where p.role in ('admin','supervisor','inspector')
             and (
                   p.scope = 'national'
                or (p.scope = 'county' and p.county = p_county)
                or (p.scope = 'regional' and exists (
                      select 1
                        from public.admin_areas c
                        join public.admin_areas r on r.id = c.parent_id
                       where c.level = 'county'
                         and c.name = p_county
                         and r.id = p.scope_area_id))
                or (p.scope = 'district' and exists (
                      select 1
                        from public.admin_areas d
                       where d.level = 'district'
                         and d.id = p.scope_area_id
                         and d.name = p_district
                         and d.parent_id = (select a.id
                                              from public.admin_areas a
                                             where a.level = 'county'
                                               and a.name = p_county)))
                or exists (
                      select 1
                        from public.site_assignments sa
                       where sa.user_id = p.id
                         and sa.site_id = p_site_id)
             )
        )
        or exists (
          select 1
            from public.mg_profile() p
           where p.role = 'operator'
             and (
                   (p.organization_id is not null
                    and p.organization_id = p_org_id
                    -- 0025: suspended / deactivated / unreviewed companies are locked out
                    and exists (select 1 from public.organizations o
                                 where o.id = p.organization_id and o.status = 'approved'))
                or (p.organization_id is null and p.operator_name = p_operator_name)
             )
        )
    ),
    false)
$mg$;

-- F. profile tenant guard honours the invitation-acceptance assignment ---------------------------------
create or replace function public.mg_guard_profile_self_tenant()
returns trigger
language plpgsql
security invoker set search_path = public
as $mg$
begin
  if auth.uid() is not null
     and auth.uid() = new.id
     and (new.operator_name   is distinct from old.operator_name
          or new.organization_id is distinct from old.organization_id)
     and coalesce(current_setting('mg.org_assign', true), '') <> '1'
     and not public.mg_is_admin() then
    raise exception 'FORBIDDEN_TENANT_CHANGE: company binding is assigned by an authorized administrator';
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_guard_profile_self_tenant() from public, anon, authenticated;

-- G. Realtime: lists refresh live for the Ministry. Added only when missing and only
-- where a Realtime publication exists (same pattern as 0018).
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['organizations', 'organization_invitations', 'organization_members'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

commit;
