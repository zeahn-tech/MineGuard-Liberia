-- ============================================================================
-- MINEGUARD LIBERIA — migration 0024: self-service tenant lockdown (Phase B0)
--
-- FINDING (reproduced against the PGlite harness, see tests/tenant-binding.test.ts)
--   complete_staff_profile() is SECURITY DEFINER and callable by every signed-in
--   user. It wrote profiles.operator_name, and the profiles_org trigger binds
--   profiles.organization_id BY NAME. The profile guard (mg_guard_profile_update)
--   deliberately skips definer RPCs, so:
--     * an operator of company A could call it with company B's name and
--       immediately gain access to company B's sites (cross-tenant takeover);
--     * a role-less user could bind themselves to any company by typing its name.
--
-- FIX (two independent layers)
--   1. complete_staff_profile keeps its exact signature (no overload, no grant
--      change) but NEVER writes operator_name / organization_id. Scope and county
--      are only honoured while the caller holds no role (an unreviewed account;
--      an administrator overwrites them on provisioning). The first-admin
--      bootstrap is unchanged and forces scope = 'national'.
--   2. profiles_self_tenant_guard (BEFORE UPDATE, runs after profiles_org):
--      a non-admin session can never change its OWN operator_name or
--      organization_id, through any code path, definer or not. Administrators,
--      direct database maintenance (auth.uid() is null) and updates to OTHER
--      users' rows are unaffected, so provisioning and the org-rename cascade
--      keep working.
--
-- No data is modified. Legacy self-claimed bindings on role-less accounts stay
-- inert (no role = no access) and are overwritten when an administrator assigns
-- a role; see supabase/maintenance/review_unreviewed_org_claims.sql to list them.
-- Idempotent; safe to re-run. Rollback: re-apply the 0010 definition of
-- complete_staff_profile and drop trigger profiles_self_tenant_guard.
-- ============================================================================

begin;

create or replace function public.complete_staff_profile(
  p_job_title     text,
  p_organization  text,
  p_scope         text default 'national',
  p_county        text default null,
  p_operator_name text default null   -- accepted for client compatibility; IGNORED
)
returns void
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_first_admin boolean;
  v_role public.user_role;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if not found then
    raise exception 'UNREGISTERED_USER';
  end if;

  select not exists (select 1 from public.profiles where role = 'admin')
    into v_first_admin;

  update public.profiles
     set job_title        = p_job_title,
         organization     = p_organization,
         scope            = case
                              when v_first_admin and v_role is null then 'national'::public.user_scope
                              when v_role is null then p_scope::public.user_scope
                              else scope
                            end,
         county           = case when v_role is null and not v_first_admin then p_county else county end,
         profile_complete = true,
         role             = case when v_first_admin and v_role is null then 'admin'::public.user_role else role end
   where id = auth.uid();
end;
$mg$;

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
     and not public.mg_is_admin() then
    raise exception 'FORBIDDEN_TENANT_CHANGE: company binding is assigned by an authorized administrator';
  end if;
  return new;
end;
$mg$;

revoke all on function public.mg_guard_profile_self_tenant() from public, anon, authenticated;

drop trigger if exists profiles_self_tenant_guard on public.profiles;
create trigger profiles_self_tenant_guard
  before update on public.profiles
  for each row execute function public.mg_guard_profile_self_tenant();

commit;
