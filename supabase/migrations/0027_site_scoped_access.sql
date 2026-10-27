-- ============================================================================
-- MINEGUARD LIBERIA — migration 0027: site-scoped company access (Phase D)
--
-- Reuses site_assignments (0010) for company personnel; adds soft revocation so
-- every assignment change stays audit-trailed (the 0009 trail records INSERT and
-- UPDATE, never DELETE).
--
-- ACCESS RULE (operators; the ONLY change to the access matrix besides 0025's
-- "approved company" condition). An operator reaches a site of THEIR company when
-- they hold an ACTIVE membership in it AND:
--   company_admin            -> every site of the company
--   site_manager             -> only sites they are actively assigned to
--                               (no assignment = no site; never "all sites")
--   worker / safety_officer  -> sites they are assigned to; if they hold NO active
--                               assignment in the company they keep company-wide
--                               access (preserves today's worker experience until
--                               an administrator scopes them)
-- Government branches are unchanged (revoked assignments no longer count).
-- Site status (e.g. 'suspended') remains an operational status and does NOT hide
-- records from the company: operators must still file corrective actions.
--
-- INVARIANT (trigger): an operator profile bound to a company always has an
-- active membership row — Ministry provisioning (provision_user_by_email) keeps
-- working and cannot create a membership-less operator. A rebinding to another
-- company retires the old membership.
--
-- RPCs (SECURITY DEFINER, self-authorizing, audited by triggers):
--   mg_assign_member_site / mg_unassign_member_site   company admin, Ministry, or
--       an assigned site manager for worker/safety_officer on THEIR site only
--   mg_site_roster                                    same audience; the site's people
--   mg_revoke_member (replaced)                       also ends the person's assignments
--
-- Idempotent. Rollback: restore 0025's mg_can_access_site_row and 0026's
-- mg_revoke_member, drop the new functions/trigger/policy, and (optionally)
-- drop site_assignments.revoked_at/revoked_by.
-- Deployment order: after 0026; before the frontend that shows site rosters.
-- ============================================================================

begin;

alter table public.site_assignments add column if not exists revoked_at timestamptz;
alter table public.site_assignments add column if not exists revoked_by uuid;

-- Membership invariant -----------------------------------------------------------------------
create or replace function public.mg_ensure_operator_membership()
returns trigger
language plpgsql security definer set search_path = public
as $mg$
begin
  if new.role = 'operator' and new.organization_id is not null then
    -- retire a membership in a DIFFERENT company (Ministry rebinding) and any pending request
    update public.organization_members
       set status = 'revoked'
     where user_id = new.id
       and ((status = 'active' and organization_id <> new.organization_id) or status = 'pending');
    if not exists (select 1 from public.organization_members m
                    where m.user_id = new.id and m.status = 'active'
                      and m.organization_id = new.organization_id) then
      insert into public.organization_members (organization_id, user_id, org_role, status, created_by)
      values (new.organization_id, new.id, 'worker', 'active', auth.uid());
    end if;
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_ensure_operator_membership() from public, anon, authenticated;

drop trigger if exists profiles_ensure_membership on public.profiles;
create trigger profiles_ensure_membership
  after insert or update of role, organization_id on public.profiles
  for each row execute function public.mg_ensure_operator_membership();

-- Backfill any operator bound to a company that still has no active membership
insert into public.organization_members (organization_id, user_id, org_role, status)
select p.organization_id, p.id, 'worker', 'active'
  from public.profiles p
 where p.role = 'operator' and p.organization_id is not null
   and not exists (select 1 from public.organization_members m
                    where m.user_id = p.id and m.status = 'active'
                      and m.organization_id = p.organization_id)
   and not exists (select 1 from public.organization_members m
                    where m.user_id = p.id and m.status in ('pending','active'));

-- The per-site rule (internal; reached only through the definer access helper) ------------------
create or replace function public.mg_operator_site_ok(p_user uuid, p_site_id uuid, p_org uuid)
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select exists (
    select 1
      from public.organization_members m
     where m.user_id = p_user
       and m.organization_id = p_org
       and m.status = 'active'
       and (
            m.org_role = 'company_admin'
         or (m.org_role = 'site_manager'
             and exists (select 1 from public.site_assignments sa
                          where sa.user_id = p_user and sa.site_id = p_site_id
                            and sa.revoked_at is null))
         or (m.org_role in ('worker','safety_officer')
             and (exists (select 1 from public.site_assignments sa
                           where sa.user_id = p_user and sa.site_id = p_site_id
                             and sa.revoked_at is null)
                  or not exists (select 1
                                   from public.site_assignments sa
                                   join public.sites s on s.id = sa.site_id
                                  where sa.user_id = p_user
                                    and sa.revoked_at is null
                                    and s.organization_id = p_org)))
       )
  )
$mg$;
revoke all on function public.mg_operator_site_ok(uuid, uuid, uuid) from public, anon, authenticated;

-- Access matrix (0025's version + per-site rule + revoked assignments ignored) ---------------------
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
                         and sa.site_id = p_site_id
                         and sa.revoked_at is null)
             )
        )
        or exists (
          select 1
            from public.mg_profile() p
           where p.role = 'operator'
             and (
                   (p.organization_id is not null
                    and p.organization_id = p_org_id
                    and exists (select 1 from public.organizations o
                                 where o.id = p.organization_id and o.status = 'approved')
                    and public.mg_operator_site_ok(p.id, p_site_id, p.organization_id))
                or (p.organization_id is null and p.operator_name = p_operator_name)
             )
        )
    ),
    false)
$mg$;

-- RLS: company managers can read their company's assignments -------------------------------------------
drop policy if exists "site_assignments company read" on public.site_assignments;
create policy "site_assignments company read" on public.site_assignments
  for select to authenticated
  using (exists (select 1 from public.sites s
                  where s.id = site_assignments.site_id
                    and public.mg_can_manage_company(s.organization_id)));

-- Shared authorization for site-personnel changes ---------------------------------------------------------
create or replace function public.mg_can_manage_site_people(p_site_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select auth.uid() is not null
     and exists (
          select 1 from public.sites s
           where s.id = p_site_id
             and s.organization_id is not null
             and (
                  public.mg_can_manage_company(s.organization_id)
               or exists (
                    select 1
                      from public.organization_members m
                      join public.organizations o on o.id = m.organization_id
                      join public.site_assignments sa
                        on sa.user_id = m.user_id and sa.site_id = s.id and sa.revoked_at is null
                     where m.user_id = auth.uid()
                       and m.organization_id = s.organization_id
                       and m.org_role = 'site_manager'
                       and m.status = 'active'
                       and o.status = 'approved')
             ))
$mg$;
revoke all on function public.mg_can_manage_site_people(uuid) from public, anon, authenticated;

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
  if m.org_role = 'company_admin' then
    raise exception 'INVALID_TARGET: company administrators already reach every site';
  end if;
  if not v_company_level then
    -- an assigned site manager: workers and safety officers of THIS site only
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

create or replace function public.mg_unassign_member_site(p_member_id uuid, p_site_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  m public.organization_members;
  s public.sites;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into m from public.organization_members where id = p_member_id;
  select * into s from public.sites where id = p_site_id;
  if m.id is null or s.id is null
     or m.organization_id is distinct from s.organization_id
     or not public.mg_can_manage_site_people(p_site_id) then
    raise exception 'FORBIDDEN';
  end if;
  if not public.mg_can_manage_company(s.organization_id)
     and m.org_role not in ('worker','safety_officer') then
    raise exception 'FORBIDDEN: site managers are assigned by a company administrator';
  end if;
  update public.site_assignments
     set revoked_at = now(), revoked_by = auth.uid()
   where user_id = m.user_id and site_id = s.id and revoked_at is null;
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
       and m.org_role <> 'company_admin'
       and (v_company_level
            or m.org_role in ('worker','safety_officer')
            or exists (select 1 from public.site_assignments sa
                        where sa.user_id = m.user_id and sa.site_id = s.id and sa.revoked_at is null))
     order by m.org_role, p.name nulls last, p.email;
end;
$mg$;

-- Removing a member also ends their site assignments (no resurrection on re-add) ---------------------------
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
  update public.site_assignments sa
     set revoked_at = now(), revoked_by = auth.uid()
    from public.sites s
   where sa.site_id = s.id and s.organization_id = m.organization_id
     and sa.user_id = m.user_id and sa.revoked_at is null;
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
    'mg_assign_member_site(uuid, uuid)',
    'mg_unassign_member_site(uuid, uuid)',
    'mg_site_roster(uuid)',
    'mg_revoke_member(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
