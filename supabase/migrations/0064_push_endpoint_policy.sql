-- ============================================================================
-- MINEGUARD LIBERIA — migration 0064: push endpoint allow-list (forward-only)
--
-- RECONSTRUCTED from the live staging schema. The original file (4107 bytes, sha256 aa109e1e32010f72…) was applied through the
-- Supabase connector by the G1 staging rehearsal and was never committed. Its hash will differ from this reproduction.
--
-- WHAT. A subscription endpoint must be https and on a known browser push service (FCM, Mozilla autopush, Apple web push,
-- Windows WNS). Registration refuses anything else, so the server never sends to an arbitrary address a client supplied.
-- Existing rows are not rewritten.
-- ============================================================================

begin;

create or replace function public.mg_push_endpoint_allowed(p_endpoint text)
returns boolean language sql immutable parallel safe set search_path = public as $mg$
  select p_endpoint is not null
     and char_length(p_endpoint) between 1 and 2048
     and p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.push\.apple\.com|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.notify\.windows\.com)(:443)?([/?#][A-Za-z0-9._~:/?#@!$&''()*+,;=%-]*)?$'
$mg$;

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
  if not public.mg_push_endpoint_allowed(p_endpoint) then
    raise exception 'INVALID: this browser''s push service is not supported';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
     set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, last_seen_at = now(), expired_at = null, revoked_at = null;
end;
$mg$;

revoke all on function public.mg_push_endpoint_allowed(text) from public, anon, authenticated;
grant execute on function public.mg_push_endpoint_allowed(text) to service_role;
revoke all on function public.mg_register_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.mg_register_push_subscription(text, text, text, text) to authenticated;

commit;
