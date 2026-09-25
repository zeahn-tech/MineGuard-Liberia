-- ============================================================================
-- MINEGUARD LIBERIA — migration 0004: profile guard parity + bootstrap fix
--
-- Found by the new clean-apply test suite (tests/migration-apply.test.ts):
-- on the repository lineage, mg_guard_profile_update() rejected EVERY
-- role/scope/county/operator transition made by a non-admin — including the
-- documented first-admin bootstrap performed through complete_staff_profile()
-- and the direct "first account claims admin" path. A fresh 0001 install
-- therefore could never create an administrator: onboarding dead-ends at
-- FORBIDDEN_ROLE_CHANGE.
--
-- The live deployment converged on a different, correct guard design:
--   * SECURITY INVOKER, so `current_user <> 'authenticated'` genuinely
--     distinguishes direct row updates (role = 'authenticated') from updates
--     executed inside security-definer RPCs such as complete_staff_profile()
--     or provision_user_by_email() (current_user = the definer);
--   * a first-run bootstrap allowance: while no profile holds a role, the
--     first signed-in account may claim admin.
--
-- This migration brings the repository lineage to that exact behaviour.
-- Two parts:
--
-- 1. mg_any_profile_role() — a SECURITY DEFINER probe for the first-admin
--    check. Under an INVOKER guard the caller reads public.profiles through
--    RLS (self-or-admin), so a plain `not exists (select 1 from profiles
--    where role is not null)` would evaluate over the caller's own single
--    role-less row and wrongly permit escalation. The definer helper reads
--    the table unfiltered instead.
--
-- 2. mg_guard_profile_update() — recreated as SECURITY INVOKER with the
--    live-proven body (an equivalent hotfix was applied ad hoc to the
--    divergent live deployment via the Management API SQL endpoint on
--    2026-09-25 and verified there — see docs/11 forensic audit; no patch
--    file was kept in the repository).
--
-- SECURITY NOTE: the pre-fix live guard was SECURITY DEFINER *with* the
-- current_user check — inside a security-definer function current_user is
-- always the owner (postgres), so the check bypassed itself and the guard
-- never fired. That made self-escalation to admin possible for any signed-in
-- account on the live project (verified by probe, rolled back; exploit and
-- fix documented in docs/11_IMPLEMENTATION_STATUS.MD). Do NOT reintroduce
-- `security definer` on any guard that inspects current_user.
-- ============================================================================

begin;

-- 1. RLS-immune first-admin probe.
create or replace function public.mg_any_profile_role()
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.profiles where role is not null) $$;

grant execute on function public.mg_any_profile_role() to anon, authenticated;

-- 2. The guard itself, invoker-scoped.
create or replace function public.mg_guard_profile_update()
returns trigger
language plpgsql security invoker set search_path = public
as $$
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
     or new.email is distinct from old.email then
    -- First-run bootstrap: while NO profile holds a role, the first
    -- signed-in account may claim admin (documented onboarding flow).
    if new.role = 'admin' and old.role is null
       and not public.mg_any_profile_role() then
      return new;
    end if;
    raise exception 'FORBIDDEN_ROLE_CHANGE';
  end if;
  return new;
end;
$$;

commit;
