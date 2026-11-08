-- ===========================================================================
-- EMERGENCY ROLLBACK of migration 0047.  *** THIS RE-OPENS THE SELF-SERVICE ADMIN BOOTSTRAP. ***
--
-- Use ONLY if 0047 breaks a production flow and the owner accepts that, until it is
-- re-applied, the first account to call complete_staff_profile() (or to update its own
-- profile role) while NO profile holds a role becomes administrator. Prefer fixing
-- forward. This file is deliberately NOT in supabase/migrations (the test suite and
-- fresh installs apply every file there).
--
-- Restores, verbatim: 0010's mg_guard_profile_update (with first-run bootstrap),
-- 0024's complete_staff_profile, 0026's mg_search_companies, and the API grant on
-- mg_any_profile_role. Drops the 0047 insert guard.
-- ===========================================================================
begin;

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
    if new.role = 'admin' and old.role is null
       and not public.mg_any_profile_role() then
      return new;
    end if;
    raise exception 'FORBIDDEN_ROLE_CHANGE';
  end if;
  return new;
end;
$mg$;

drop trigger if exists profiles_insert_guard on public.profiles;
drop function if exists public.mg_guard_profile_insert();

create or replace function public.complete_staff_profile(
  p_job_title     text,
  p_organization  text,
  p_scope         text default 'national',
  p_county        text default null,
  p_operator_name text default null
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

grant execute on function public.mg_any_profile_role() to anon, authenticated;

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

commit;
