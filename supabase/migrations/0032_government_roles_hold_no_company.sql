-- ============================================================================
-- MINEGUARD LIBERIA — migration 0032: government roles never hold a company
--
-- GAP CLOSED. provision_user_by_email (the admin "Assign platform role" dialog),
-- a direct admin update, or the owner-run maintenance scripts could turn an
-- existing company member into a government account (admin / supervisor /
-- inspector / registrar) while their company membership stayed ACTIVE — a
-- company administrator made registrar would have kept company powers, defeating
-- the separation between Ministry and company authority.
--
-- Enforced in the DATABASE, on every route, by two triggers on profiles:
--   * BEFORE: whenever a profile becomes a government role, its company binding
--     (organization_id / operator_name) is cleared; a REGISTRAR is additionally
--     always national scope, with no county or area (its powers are national by
--     nature; the dialog shows the scope locked).
--   * AFTER: when the role CHANGES to a government role, that person's pending /
--     active company memberships are revoked and their site assignments in those
--     companies ended (soft revocation, audit-trailed). A role that merely stays
--     the same (re-provisioning an inspector) touches nothing, so staff site
--     assignments survive.
-- Nothing is deleted; the company keeps its history. Idempotent.
-- Rollback: drop the two triggers and functions.
-- ============================================================================

begin;

create or replace function public.mg_gov_role_clear_company_binding()
returns trigger
language plpgsql security invoker set search_path = public
as $mg$
begin
  if new.role in ('admin','supervisor','inspector','registrar') then
    new.organization_id := null;
    new.operator_name   := null;
    if new.role = 'registrar' then
      new.scope         := 'national';
      new.county        := null;
      new.scope_area_id := null;
    end if;
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_gov_role_clear_company_binding() from public, anon, authenticated;

-- runs AFTER profiles_org (alphabetical), so the cleared binding is not re-derived
drop trigger if exists profiles_tenant_clear_on_gov_role on public.profiles;
create trigger profiles_tenant_clear_on_gov_role
  before insert or update on public.profiles
  for each row execute function public.mg_gov_role_clear_company_binding();

create or replace function public.mg_gov_role_revoke_memberships()
returns trigger
language plpgsql security definer set search_path = public
as $mg$
begin
  if new.role in ('admin','supervisor','inspector','registrar')
     and new.role is distinct from old.role then
    update public.organization_members
       set status = 'revoked'
     where user_id = new.id and status in ('pending','active');
    if found then
      update public.site_assignments sa
         set revoked_at = now(), revoked_by = auth.uid()
        from public.sites s
       where sa.site_id = s.id
         and sa.user_id = new.id
         and sa.revoked_at is null
         and exists (select 1 from public.organization_members m
                      where m.user_id = new.id and m.organization_id = s.organization_id);
    end if;
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_gov_role_revoke_memberships() from public, anon, authenticated;

drop trigger if exists profiles_gov_role_revoke_memberships on public.profiles;
create trigger profiles_gov_role_revoke_memberships
  after update of role on public.profiles
  for each row execute function public.mg_gov_role_revoke_memberships();

commit;
