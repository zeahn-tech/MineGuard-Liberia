-- ============================================================================
-- MINEGUARD LIBERIA — migration 0028: account names + invitation cleanup
--
-- 1. handle_new_user: the profile name now falls back across the metadata keys
--    Supabase clients use (name, full_name, display_name). Invited accounts have
--    no name yet; the invitation page collects it.
-- 2. Backfill (additive): profiles with NO name receive the name already held in
--    their auth metadata. Existing names are never overwritten.
-- 3. mg_my_pending_invitations: invitations for a DIFFERENT company are hidden
--    once the person already has an active membership (they could never accept
--    them — one company per user).
-- 4. mg_decide_membership_request: approving a request supersedes any still-
--    pending invitation to the same address for that company (no stale duplicate).
-- Idempotent. Rollback: restore the 0001 handle_new_user, the 0025 list function
-- and the 0026 decide function.
-- ============================================================================

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    new.email,
    nullif(btrim(coalesce(
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'display_name',
      ''
    )), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$mg$;

update public.profiles p
   set name = nullif(btrim(coalesce(
                u.raw_user_meta_data->>'name',
                u.raw_user_meta_data->>'full_name',
                u.raw_user_meta_data->>'display_name', '')), '')
  from auth.users u
 where u.id = p.id
   and (p.name is null or btrim(p.name) = '')
   and nullif(btrim(coalesce(
         u.raw_user_meta_data->>'name',
         u.raw_user_meta_data->>'full_name',
         u.raw_user_meta_data->>'display_name', '')), '') is not null;

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
     and not exists (select 1 from public.organization_members m
                      where m.user_id = auth.uid() and m.status = 'active'
                        and m.organization_id <> i.organization_id)
   order by i.created_at desc
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

do $$
declare f text;
begin
  foreach f in array array['mg_my_pending_invitations()', 'mg_decide_membership_request(uuid, boolean, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
