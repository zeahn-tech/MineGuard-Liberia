-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0047: close the self-service administrator
--                                     bootstrap (Public User programme, Phase A)
--
-- WHY. With open public registration, any account must be assumed hostile. Three
-- independent database paths let a self-registered account (including an anonymous
-- guest session) become the platform administrator whenever no profile held a role
-- (fresh install, restored backup, all admins removed):
--   1. complete_staff_profile()  — "first administrator" branch (0010/0024).
--   2. mg_guard_profile_update() — direct `update profiles set role='admin'` was
--      allowed while mg_any_profile_role() was false (0004/0010).
--   3. the profiles INSERT policy checks only id = auth.uid(); a self-inserted row
--      (possible if the auto-created row is ever absent) could carry any role/scope.
-- A fourth, smaller gap: complete_staff_profile() stored a client-chosen scope and
-- county on role-less accounts, and mg_search_companies() answered any session
-- (including anonymous guests) with no rate limit.
--
-- WHAT THIS DOES
--   A. mg_guard_profile_update(): the first-run branch is DELETED. An API caller can
--      never change role / scope / county / operator_name / organization_id /
--      scope_area_id / email on their own profile; administrators still can (for
--      other accounts) and database maintenance (non-API roles) still can.
--   B. mg_guard_profile_insert() + trigger: an API caller's INSERT into profiles may
--      not carry role, scope, county, operator_name, organization_id or scope_area_id.
--   C. complete_staff_profile(): same signature (no client or grant churn), but it
--      never assigns a role, never reads p_scope / p_county / p_operator_name, and
--      REJECTS accounts that hold no platform role. It records only job title and
--      organization text and marks the profile complete. Staff first receive a role
--      from an administrator (provision_user_by_email), then complete their profile.
--   D. mg_any_profile_role(): EXECUTE revoked from API roles (nothing calls it now).
--   E. mg_search_companies(): returns rows only to a signed-in, email-VERIFIED,
--      non-anonymous account, with a per-user rate limit (20 per minute). Still
--      returns only id and name of approved companies.
--
-- FIRST ADMINISTRATOR / RECOVERY. There is no self-service path any more. A legitimate
-- administrator is created by the project owner running
-- supabase/maintenance/promote_to_admin.sql (SQL editor or service role). That runs
-- as a non-API role, so the guard permits it, and the profiles audit trigger records
-- it. Procedure and the zero-administrator check: docs/14_DEPLOYMENT_OPERATIONS.MD
-- and supabase/checks/admin_present.sql. A restored database with zero administrators
-- therefore stays inert (nobody can claim admin) until the owner runs the script.
--
-- Idempotent. ROLLBACK (emergency only — it RE-OPENS the bootstrap):
-- supabase/maintenance/rollback_0047_reopens_admin_bootstrap.sql
-- ===========================================================================

begin;

-- A. Profile update guard — 0010's body without the first-run bootstrap ---------------
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
     or new.email is distinct from old.email then
    raise exception 'FORBIDDEN_ROLE_CHANGE';
  end if;
  return new;
end;
$mg$;

-- B. Profile insert guard ------------------------------------------------------------
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
          or new.scope_area_id is not null) then
    raise exception 'FORBIDDEN_ROLE_CHANGE: a new profile cannot carry a role, scope or company';
  end if;
  return new;
end;
$mg$;

revoke all on function public.mg_guard_profile_insert() from public, anon, authenticated;

drop trigger if exists profiles_insert_guard on public.profiles;
create trigger profiles_insert_guard
  before insert on public.profiles
  for each row execute function public.mg_guard_profile_insert();

-- C. Staff profile completion: role holders only, no privilege fields ----------------
create or replace function public.complete_staff_profile(
  p_job_title     text,
  p_organization  text,
  p_scope         text default 'national',   -- accepted for client compatibility; IGNORED
  p_county        text default null,         -- accepted for client compatibility; IGNORED
  p_operator_name text default null          -- accepted for client compatibility; IGNORED
)
returns void
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_role public.user_role;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select role into v_role
    from public.profiles
   where id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'UNREGISTERED_USER';
  end if;

  if v_role is null then
    raise exception 'FORBIDDEN: staff profile completion requires a platform role assigned by an administrator';
  end if;

  update public.profiles
     set job_title        = p_job_title,
         organization     = p_organization,
         profile_complete = true
   where id = auth.uid();
end;
$mg$;

-- D. The bootstrap probe is no longer reachable from the API --------------------------
revoke execute on function public.mg_any_profile_role() from public, anon, authenticated;

-- E. Company search: verified, non-anonymous, rate-limited ----------------------------
create or replace function public.mg_search_companies(p_query text)
returns table (id uuid, name text)
language plpgsql security definer set search_path = public
as $mg$
#variable_conflict use_column
declare
  v_q     text := btrim(coalesce(p_query, ''));
  v_count integer;
begin
  -- Anonymous guests have no email; unconfirmed accounts have no verified email.
  if auth.uid() is null or public.mg_caller_email() is null then
    return;
  end if;
  if char_length(v_q) < 3 then
    return;
  end if;

  insert into public.rate_limits (bucket, count, window_start)
  values ('company-search:' || auth.uid()::text, 1, now())
  on conflict (bucket) do update
    set count = case
          when public.rate_limits.window_start < now() - interval '60 seconds'
          then 1 else public.rate_limits.count + 1 end,
        window_start = case
          when public.rate_limits.window_start < now() - interval '60 seconds'
          then now() else public.rate_limits.window_start end
  returning count into v_count;

  if v_count > 20 then
    raise exception 'RATE_LIMITED: too many company searches right now; try again in a minute';
  end if;

  return query
    select o.id, o.name
      from public.organizations o
     where o.status = 'approved'
       and position(lower(v_q) in lower(o.name)) > 0
     order by o.name
     limit 8;
end;
$mg$;

revoke all on function public.mg_search_companies(text) from public, anon;
grant execute on function public.mg_search_companies(text) to authenticated;

commit;
