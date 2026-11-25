-- ============================================================================
-- MINEGUARD LIBERIA — migration 0062: push subscription lifecycle (forward-only)
--
-- RECONSTRUCTED from the live staging schema. The original file (6045 bytes, sha256 23458c8c3bdef1d4…) was applied through the
-- Supabase connector by the G1 staging rehearsal and was never committed. This file reproduces the resulting objects, not the
-- original text, so its hash will differ.
--
-- WHAT. A subscription belongs to a live, eligible account only:
--   * registering is refused for guest sessions and for restricted / deleted accounts;
--   * restricting or deleting an account revokes all of its subscriptions;
--   * deleting an account also scrubs the subscription secrets (rows still referenced by alert deliveries are kept, anonymised).
-- Nothing here changes the shape of public.push_subscriptions (created in 0040).
-- ============================================================================

begin;

create or replace function public.mg_push_revoke_user_subscriptions(p_user uuid)
returns integer language plpgsql security definer set search_path = public as $mg$
declare v_n integer;
begin
  update public.push_subscriptions set revoked_at = now()
   where user_id = p_user and revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$mg$;

create or replace function public.mg_profiles_revoke_push_on_lifecycle()
returns trigger language plpgsql security definer set search_path = public as $mg$
begin
  perform public.mg_push_revoke_user_subscriptions(new.id);
  return new;
end;
$mg$;

create or replace function public.mg_profiles_scrub_push_on_delete()
returns trigger language plpgsql security definer set search_path = public as $mg$
begin
  delete from public.push_subscriptions ps
   where ps.user_id = new.id
     and not exists (select 1 from public.emergency_alert_deliveries d where d.subscription_id = ps.id);
  update public.push_subscriptions
     set endpoint = 'https://deleted.invalid/' || id::text, p256dh = 'deleted', auth = 'deleted',
         user_agent = null, revoked_at = coalesce(revoked_at, now())
   where user_id = new.id;
  return new;
end;
$mg$;

drop trigger if exists mg_profiles_revoke_push on public.profiles;
create trigger mg_profiles_revoke_push
  after update of restricted_at, deleted_at on public.profiles
  for each row
  when ((new.restricted_at is not null and old.restricted_at is null)
     or (new.deleted_at is not null and old.deleted_at is null))
  execute function public.mg_profiles_revoke_push_on_lifecycle();

drop trigger if exists mg_profiles_scrub_push on public.profiles;
create trigger mg_profiles_scrub_push
  after update of deleted_at on public.profiles
  for each row
  when (new.deleted_at is not null and old.deleted_at is null)
  execute function public.mg_profiles_scrub_push_on_delete();

-- registration: guests and restricted / deleted accounts cannot subscribe
create or replace function public.mg_register_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  if public.mg_is_anonymous() then
    raise exception 'FORBIDDEN: guest sessions cannot register push subscriptions';
  end if;
  if exists (select 1 from public.profiles where id = auth.uid() and (restricted_at is not null or deleted_at is not null)) then
    raise exception 'FORBIDDEN: this account is restricted';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
     set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, last_seen_at = now(), expired_at = null, revoked_at = null;
end;
$mg$;

-- privileges: internal helpers are callable by the database owner (and triggers) only
revoke all on function public.mg_push_revoke_user_subscriptions(uuid) from public, anon, authenticated, service_role;
revoke all on function public.mg_profiles_revoke_push_on_lifecycle() from public, anon, authenticated, service_role;
revoke all on function public.mg_profiles_scrub_push_on_delete() from public, anon, authenticated, service_role;
revoke all on function public.mg_register_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.mg_register_push_subscription(text, text, text, text) to authenticated;

commit;
