-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0048: public-user identity and authorization
--                                     (Public User programme, Phase B)
--
-- GOAL. Formalize, in the database, who a "public user" is — without adding a role
-- value (profiles.role stays NULL for the public) — and keep anonymous guests and
-- registered public users apart. Later phases (reporting, feedback, dashboard) build
-- their RLS on the helpers defined here; the frontend never decides this.
--
-- A PUBLIC USER, as decided by the server (mg_is_public_user):
--   - is authenticated (auth.uid() present),
--   - is NOT an anonymous Supabase guest (JWT is_anonymous claim false AND the auth
--     account has an e-mail address),
--   - has an undeleted profile with NO platform role (staff / company role),
--   - has NO active company membership (a pending request does not count),
--   - has NOT been restricted by the Ministry (profiles.restricted_at is null).
-- mg_is_verified_public_user additionally requires a confirmed e-mail address; it is the
-- gate for account-based features (reporting with ownership, feedback, tracking).
--
-- WHAT THIS ADDS
--   A. profiles.restricted_at (+ account_restriction_events): an administrator can restrict
--      an abusive PUBLIC account. Reasons/history live in an admin-only table, never on
--      the profile row the account holder can read. The guard makes restricted_at
--      administrator-only. Staff and company accounts are not restricted this way (they
--      are managed through role and membership removal).
--   B. mg_is_anonymous(), mg_is_public_user(), mg_is_verified_public_user() — stable
--      SECURITY DEFINER helpers for policies (call as `(select public.mg_is_public_user())`
--      so Postgres evaluates them once per statement). Execute: authenticated only.
--   C. mg_my_access_class() — what the SERVER thinks this session is (anonymous_guest,
--      public_user, public_user_unverified, restricted, staff, company_member,
--      unregistered, none). Used by the UI for routing/copy only; every protected action
--      is enforced separately by RLS/RPC checks.
--   D. mg_set_account_restriction(user, restricted, reason) — administrator-only, audited.
--   E. Guest tightening on existing writes: anonymous guest sessions can no longer register
--      push subscriptions or edit a profile (neither has a purpose for a guest); restricted
--      accounts cannot register push subscriptions.
--
-- Idempotent. ROLLBACK: supabase/maintenance/rollback_0048_public_user_identity.sql
-- (drops the new objects and restores the two functions in E verbatim; no data loss
-- beyond the restriction records).
-- ===========================================================================

begin;

-- A. Restriction flag + admin-only history ---------------------------------------------
alter table public.profiles add column if not exists restricted_at timestamptz;

create table if not exists public.account_restriction_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id),
  action     text not null check (action in ('restrict', 'release')),
  reason     text not null check (char_length(reason) between 10 and 500),
  actor_id   uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists account_restriction_events_user_idx
  on public.account_restriction_events (user_id, created_at desc);

alter table public.account_restriction_events enable row level security;
revoke all on public.account_restriction_events from public, anon, authenticated;
grant select on public.account_restriction_events to authenticated;
drop policy if exists "restriction events admin read" on public.account_restriction_events;
create policy "restriction events admin read" on public.account_restriction_events
  for select to authenticated using (public.mg_is_admin());

-- Guards: restricted_at is administrator-only, like role/scope/company (0047 bodies + 1 field)
create or replace function public.mg_guard_profile_update()
returns trigger
language plpgsql security invoker set search_path = public
as $mg$
begin
  if current_user <> 'authenticated' then
    return new; -- security-definer RPCs / direct database maintenance
  end if;

  if auth.uid() is null or auth.uid() <> new.id then
    if not public.mg_is_admin() then
      raise exception 'FORBIDDEN';
    end if;
    return new; -- admin provisioning another account
  end if;

  if new.role is distinct from old.role
     or new.scope is distinct from old.scope
     or new.county is distinct from old.county
     or new.operator_name is distinct from old.operator_name
     or new.organization_id is distinct from old.organization_id
     or new.scope_area_id is distinct from old.scope_area_id
     or new.restricted_at is distinct from old.restricted_at
     or new.email is distinct from old.email then
    raise exception 'FORBIDDEN_ROLE_CHANGE';
  end if;
  return new;
end;
$mg$;

create or replace function public.mg_guard_profile_insert()
returns trigger
language plpgsql security invoker set search_path = public
as $mg$
begin
  if current_user = 'authenticated'
     and (new.role is not null
          or new.scope is not null
          or new.county is not null
          or new.operator_name is not null
          or new.organization_id is not null
          or new.scope_area_id is not null
          or new.restricted_at is not null) then
    raise exception 'FORBIDDEN_ROLE_CHANGE: a new profile cannot carry a role, scope, company or restriction';
  end if;
  return new;
end;
$mg$;

-- B. Identity helpers ------------------------------------------------------------------
create or replace function public.mg_is_anonymous()
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$mg$;

create or replace function public.mg_is_public_user()
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select auth.uid() is not null
     and not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
     and exists (select 1 from auth.users u
                  where u.id = auth.uid() and u.email is not null)
     and exists (select 1 from public.profiles p
                  where p.id = auth.uid()
                    and p.role is null
                    and p.deleted_at is null
                    and p.restricted_at is null)
     and not exists (select 1 from public.organization_members m
                      where m.user_id = auth.uid() and m.status = 'active')
$mg$;

create or replace function public.mg_is_verified_public_user()
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select public.mg_is_public_user()
     and exists (select 1 from auth.users u
                  where u.id = auth.uid() and u.email_confirmed_at is not null)
$mg$;

revoke all on function public.mg_is_anonymous() from public, anon;
revoke all on function public.mg_is_public_user() from public, anon;
revoke all on function public.mg_is_verified_public_user() from public, anon;
grant execute on function public.mg_is_anonymous() to authenticated;
grant execute on function public.mg_is_public_user() to authenticated;
grant execute on function public.mg_is_verified_public_user() to authenticated;

-- C. What the server thinks this session is (routing/copy only) -------------------------
create or replace function public.mg_my_access_class()
returns text
language plpgsql stable security definer set search_path = public
as $mg$
declare
  v_p record;
begin
  if auth.uid() is null then
    return 'none';
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return 'anonymous_guest';
  end if;

  select role, deleted_at, restricted_at into v_p
    from public.profiles where id = auth.uid();
  if not found or v_p.deleted_at is not null then
    return 'unregistered';
  end if;
  if v_p.role is not null then
    return case when v_p.role = 'operator' then 'company_member' else 'staff' end;
  end if;
  if exists (select 1 from public.organization_members m
              where m.user_id = auth.uid() and m.status = 'active') then
    return 'company_member';
  end if;
  if v_p.restricted_at is not null then
    return 'restricted';
  end if;
  if public.mg_is_verified_public_user() then
    return 'public_user';
  end if;
  if public.mg_is_public_user() then
    return 'public_user_unverified';
  end if;
  return 'unregistered';
end;
$mg$;

revoke all on function public.mg_my_access_class() from public, anon;
grant execute on function public.mg_my_access_class() to authenticated;

-- D. Administrator restriction of an abusive PUBLIC account ------------------------------
create or replace function public.mg_set_account_restriction(
  p_user       uuid,
  p_restricted boolean,
  p_reason     text
)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_p      record;
begin
  if auth.uid() is null or not public.mg_is_admin() then
    raise exception 'FORBIDDEN';
  end if;
  if p_user is null or p_restricted is null then
    raise exception 'INVALID: user and restricted flag are required';
  end if;
  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'INVALID: give a reason of 10 to 500 characters';
  end if;
  if p_user = auth.uid() then
    raise exception 'INVALID: you cannot restrict your own account';
  end if;

  select role, deleted_at into v_p from public.profiles where id = p_user;
  if not found or v_p.deleted_at is not null then
    raise exception 'NOT_FOUND: no such account';
  end if;
  if v_p.role is not null
     or exists (select 1 from public.organization_members m
                 where m.user_id = p_user and m.status = 'active') then
    raise exception 'INVALID: restriction applies to public accounts; staff and company accounts are managed through role and membership removal';
  end if;

  update public.profiles
     set restricted_at = case when p_restricted then now() else null end
   where id = p_user;

  insert into public.account_restriction_events (user_id, action, reason, actor_id)
  values (p_user, case when p_restricted then 'restrict' else 'release' end, v_reason, auth.uid());
end;
$mg$;

revoke all on function public.mg_set_account_restriction(uuid, boolean, text) from public, anon;
grant execute on function public.mg_set_account_restriction(uuid, boolean, text) to authenticated;

-- E. Guest tightening on existing writes (bodies verbatim + one guard each) ---------------
create or replace function public.mg_register_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  if public.mg_is_anonymous() then
    raise exception 'FORBIDDEN: guest sessions cannot register push subscriptions';
  end if;
  if exists (select 1 from public.profiles where id = auth.uid() and restricted_at is not null) then
    raise exception 'FORBIDDEN: this account is restricted';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
     set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, last_seen_at = now(), expired_at = null, revoked_at = null;
end;
$mg$;

create or replace function public.mg_update_my_profile(p_name text, p_job_title text default null)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_title text := nullif(btrim(coalesce(p_job_title, '')), '');
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if public.mg_is_anonymous() then
    raise exception 'FORBIDDEN: guest sessions have no profile to edit; create an account';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'INVALID_NAME: enter your full name (2 to 120 characters)';
  end if;
  if v_title is not null and char_length(v_title) > 120 then
    raise exception 'INVALID_JOB_TITLE: at most 120 characters';
  end if;
  update public.profiles
     set name = v_name, job_title = v_title
   where id = auth.uid() and deleted_at is null;
  if not found then raise exception 'UNREGISTERED_USER'; end if;
end;
$mg$;

commit;
