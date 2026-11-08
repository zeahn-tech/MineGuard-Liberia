-- ===========================================================================
-- ROLLBACK of migration 0048 (public-user identity helpers, account restriction).
-- Drops the helpers, the restriction RPC/table and the profiles.restricted_at column, and
-- restores the Phase A guards and the two functions changed in section E verbatim.
-- LOSES the account restriction records. Not in supabase/migrations (the suite and fresh
-- installs apply everything there). Run before rolling back 0047, never after.
-- ===========================================================================
begin;

-- Only reference the helpers while they exist: clear restrictions first.
update public.profiles set restricted_at = null where restricted_at is not null;

create or replace function public.mg_guard_profile_update()
returns trigger
language plpgsql security invoker set search_path = public
as $mg$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if auth.uid() is null or auth.uid() <> new.id then
    if not public.mg_is_admin() then
      raise exception 'FORBIDDEN';
    end if;
    return new;
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

create or replace function public.mg_register_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
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

drop function if exists public.mg_set_account_restriction(uuid, boolean, text);
drop function if exists public.mg_my_access_class();
drop function if exists public.mg_is_verified_public_user();
drop function if exists public.mg_is_public_user();
drop function if exists public.mg_is_anonymous();
drop table if exists public.account_restriction_events;
alter table public.profiles drop column if exists restricted_at;

commit;
