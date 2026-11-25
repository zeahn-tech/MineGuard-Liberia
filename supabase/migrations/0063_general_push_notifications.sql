-- ============================================================================
-- MINEGUARD LIBERIA — migration 0063: general push notifications (forward-only)
--
-- RECONSTRUCTED from the live staging schema. The original file (23406 bytes, sha256 fd649c19c01b815e…) was applied through the
-- Supabase connector by the G1 staging rehearsal and was never committed. This file reproduces the resulting objects, not the
-- original text or comments, so its hash will differ.
--
-- WHAT. Opt-in push for nine notification categories (default OFF). A trigger on public.notifications queues a message
-- (general_push_outbox); the worker claims it through mg_push_claim, which re-checks eligibility at delivery time, applies a
-- per-user/per-category rate limit, expires anything older than 6 hours and fans out to live subscriptions
-- (general_push_deliveries, leased for 5 minutes). Outcomes are recorded under the current lease only.
-- Tables are reachable through the functions below only: RLS is on and no table privileges are granted to client roles.
-- ============================================================================

begin;

-- tables ---------------------------------------------------------------------------------------------------------------
create table if not exists public.push_preferences (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  category   text not null check (category = any (array['company_invitation','company_join_request','join_decision','membership_decision','role_change','company_status','site_status','ca_deadline','ca_decision'])),
  enabled    boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

create table if not exists public.general_push_outbox (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  notification_id     uuid not null unique references public.notifications(id) on delete cascade,
  category            text not null check (category = any (array['company_invitation','company_join_request','join_decision','membership_decision','role_change','company_status','site_status','ca_deadline','ca_decision'])),
  state               text not null default 'queued' check (state = any (array['queued','sending','completed','failed','skipped','expired'])),
  attempts            integer not null default 0,
  detail              text check (detail is null or char_length(detail) <= 200),
  released_at         timestamptz,
  rate_limited_at     timestamptz,
  rate_limit_deferrals integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.general_push_deliveries (
  id              uuid primary key default gen_random_uuid(),
  outbox_id       uuid not null references public.general_push_outbox(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  state           text not null default 'queued' check (state = any (array['queued','sending','service_accepted','service_rejected','subscription_expired','not_configured','failed'])),
  attempts        integer not null default 0,
  detail          text check (detail is null or char_length(detail) <= 200),
  lease_id        uuid,
  lease_until     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (outbox_id, subscription_id)
);

create index if not exists general_push_outbox_pending_idx on public.general_push_outbox (created_at)
  where state = any (array['queued','sending']);
create index if not exists general_push_outbox_user_cat_idx on public.general_push_outbox (user_id, category, created_at desc);
create index if not exists general_push_outbox_released_idx on public.general_push_outbox (user_id, category, released_at)
  where released_at is not null;
create index if not exists general_push_outbox_retention_idx on public.general_push_outbox (updated_at)
  where state = any (array['completed','failed','skipped','expired']);
create index if not exists general_push_deliveries_pending_idx on public.general_push_deliveries (created_at)
  where state = any (array['queued','sending']);

alter table public.push_preferences enable row level security;
alter table public.general_push_outbox enable row level security;
alter table public.general_push_deliveries enable row level security;
revoke all on public.push_preferences, public.general_push_outbox, public.general_push_deliveries from public, anon, authenticated, service_role;

-- reference data -------------------------------------------------------------------------------------------------------
create or replace function public.mg_push_categories()
returns text[] language sql immutable set search_path = public as $mg$
  select array['company_invitation','company_join_request','join_decision','membership_decision','role_change',
               'company_status','site_status','ca_deadline','ca_decision']
$mg$;

create or replace function public.mg_push_category_for(p_kind text, p_key text)
returns text language sql immutable set search_path = public as $mg$
  select case
    when p_kind = 'org_invitation' then 'company_invitation'
    when p_kind = 'org_request'    then 'company_join_request'
    when p_kind = 'org_decision'   then 'join_decision'
    when p_kind = 'org_role' and p_key ~ '^role:'          then 'role_change'
    when p_kind = 'org_role' and p_key ~ '^(sus|rein|rm):' then 'membership_decision'
    when p_kind = 'org_status' and p_key ~ '^orgst:'       then 'company_status'
    when p_kind = 'org_status' and p_key ~ '^sitest:'      then 'site_status'
    when p_kind = 'ca_deadline' then 'ca_deadline'
    when p_kind = 'ca_decision' then 'ca_decision'
    else null end
$mg$;

create or replace function public.mg_push_rate_config()
returns jsonb language sql stable set search_path = public as $mg$
  select jsonb_build_object('max_per_window', 5, 'window_minutes', 60)
$mg$;

-- queueing -------------------------------------------------------------------------------------------------------------
create or replace function public.mg_push_enqueue(p_notification uuid)
returns uuid language plpgsql security definer set search_path = public as $mg$
declare n record; v_cat text; v_id uuid;
begin
  select id, user_id, kind, source_key into n from public.notifications where id = p_notification;
  if not found then return null; end if;
  v_cat := public.mg_push_category_for(n.kind, n.source_key);
  if v_cat is null then return null; end if;
  if not exists (select 1 from public.profiles p where p.id = n.user_id and p.deleted_at is null and p.restricted_at is null) then return null; end if;
  if not exists (select 1 from public.push_preferences pp where pp.user_id = n.user_id and pp.category = v_cat and pp.enabled) then return null; end if;
  insert into public.general_push_outbox (user_id, notification_id, category)
  values (n.user_id, n.id, v_cat)
  on conflict (notification_id) do nothing
  returning id into v_id;
  return v_id;
end;
$mg$;

create or replace function public.mg_notifications_enqueue_push()
returns trigger language plpgsql security definer set search_path = public as $mg$
begin
  begin
    perform public.mg_push_enqueue(new.id);
  exception when others then
    raise warning 'general push enqueue failed (%): %', new.kind, sqlerrm;   -- never block the real action
  end;
  return new;
end;
$mg$;

drop trigger if exists mg_notifications_enqueue_push on public.notifications;
create trigger mg_notifications_enqueue_push
  after insert on public.notifications
  for each row
  when (new.kind = any (array['org_invitation','org_request','org_decision','org_role','org_status','ca_deadline','ca_decision']))
  execute function public.mg_notifications_enqueue_push();

-- delivery -------------------------------------------------------------------------------------------------------------
create or replace function public.mg_push_finalize_outbox(p_outbox uuid)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  if exists (select 1 from public.general_push_deliveries d where d.outbox_id = p_outbox and d.state in ('queued','sending')) then return; end if;
  update public.general_push_outbox o
     set state = case when exists (select 1 from public.general_push_deliveries d where d.outbox_id = o.id and d.state = 'service_accepted')
                      then 'completed' else 'failed' end,
         detail = case when exists (select 1 from public.general_push_deliveries d where d.outbox_id = o.id and d.state = 'service_accepted')
                       then o.detail else coalesce(o.detail, 'no push service accepted the message') end,
         updated_at = now()
   where o.id = p_outbox and o.state in ('queued','sending');
end;
$mg$;

create or replace function public.mg_push_claim(p_limit integer default 100)
returns table(delivery_id uuid, category text, endpoint text, p256dh text, auth text, lease_id uuid)
language plpgsql security definer set search_path = public as $mg$
#variable_conflict use_column
declare o record; v_reason text; v_limit integer := greatest(1, least(coalesce(p_limit, 100), 500));
  v_cfg jsonb := public.mg_push_rate_config(); v_max integer; v_window interval; v_recent integer;
begin
  -- stale messages are closed out, never pushed late
  update public.general_push_outbox set state = 'expired', detail = 'not sent: older than 6 hours', updated_at = now()
   where state in ('queued','sending') and created_at < now() - interval '6 hours';
  update public.general_push_deliveries d set state = 'failed', detail = 'not sent: older than 6 hours', updated_at = now()
    from public.general_push_outbox ob
   where d.outbox_id = ob.id and ob.state = 'expired' and d.state in ('queued','sending');

  v_max := (v_cfg ->> 'max_per_window')::integer;
  v_window := make_interval(mins => (v_cfg ->> 'window_minutes')::integer);

  -- fresh messages first; ones the rate limit already deferred go behind them so they cannot starve others
  for o in select ob.* from public.general_push_outbox ob
            where ob.state in ('queued','sending')
            order by (ob.rate_limited_at is not null and ob.released_at is null), ob.created_at
            limit v_limit for update skip locked
  loop
    -- re-check eligibility at delivery time
    v_reason := case
      when not exists (select 1 from public.profiles p where p.id = o.user_id and p.deleted_at is null and p.restricted_at is null)
        then 'account not eligible'
      when not exists (select 1 from public.push_preferences pp where pp.user_id = o.user_id and pp.category = o.category and pp.enabled)
        then 'category switched off'
      when not exists (select 1 from public.notifications n where n.id = o.notification_id and n.user_id = o.user_id
                          and n.read_at is null and n.dismissed_at is null and n.resolved_at is null)
        then 'notification no longer pending'
      when not exists (select 1 from public.push_subscriptions ps where ps.user_id = o.user_id and ps.expired_at is null and ps.revoked_at is null)
        then 'no live subscription'
      else null end;
    if v_reason is not null then
      update public.general_push_deliveries set state = 'failed', detail = v_reason, updated_at = now()
       where outbox_id = o.id and state in ('queued','sending');
      update public.general_push_outbox ob
         set state = case when exists (select 1 from public.general_push_deliveries d where d.outbox_id = ob.id and d.state = 'service_accepted')
                          then 'completed' else 'skipped' end,
             detail = v_reason, updated_at = now()
       where ob.id = o.id;
      continue;
    end if;
    -- rate limit: only for a message not yet released; retries of a released message do not count again
    if o.released_at is null then
      select count(*) into v_recent from public.general_push_outbox r
       where r.user_id = o.user_id and r.category = o.category and r.released_at > now() - v_window;
      if v_recent >= v_max then
        update public.general_push_outbox
           set rate_limited_at = coalesce(rate_limited_at, now()), rate_limit_deferrals = rate_limit_deferrals + 1,
               detail = 'deferred: rate limit', updated_at = now()
         where id = o.id;
        continue;
      end if;
      update public.general_push_outbox set released_at = now(), detail = null where id = o.id;
    end if;
    insert into public.general_push_deliveries (outbox_id, subscription_id)
      select o.id, ps.id from public.push_subscriptions ps
       where ps.user_id = o.user_id and ps.expired_at is null and ps.revoked_at is null
      on conflict (outbox_id, subscription_id) do nothing;
    update public.general_push_deliveries d set state = 'subscription_expired', detail = 'subscription no longer live', updated_at = now()
     where d.outbox_id = o.id and d.state in ('queued','sending')
       and not exists (select 1 from public.push_subscriptions ps where ps.id = d.subscription_id and ps.expired_at is null and ps.revoked_at is null);
    update public.general_push_outbox set state = 'sending', attempts = attempts + 1, updated_at = now() where id = o.id;
    perform public.mg_push_finalize_outbox(o.id);
  end loop;

  return query
  with c as (
    select d.id from public.general_push_deliveries d
      join public.general_push_outbox ob on ob.id = d.outbox_id and ob.state = 'sending'
      join public.push_subscriptions ps on ps.id = d.subscription_id and ps.expired_at is null and ps.revoked_at is null
     where (d.state = 'queued' or (d.state = 'sending' and d.lease_until < now())) and d.attempts < 5
     order by d.created_at limit v_limit
       for update of d skip locked)
  update public.general_push_deliveries d
     set state = 'sending', attempts = d.attempts + 1, updated_at = now(),
         lease_id = gen_random_uuid(), lease_until = now() + interval '5 minutes'
    from c, public.general_push_outbox ob, public.push_subscriptions ps
   where d.id = c.id and ob.id = d.outbox_id and ps.id = d.subscription_id
  returning d.id, ob.category, ps.endpoint, ps.p256dh, ps.auth, d.lease_id;
end;
$mg$;

create or replace function public.mg_push_record(p_delivery uuid, p_state text, p_detail text, p_lease uuid)
returns void language plpgsql security definer set search_path = public as $mg$
declare d record;
begin
  if p_state is null or p_state not in ('service_accepted','service_rejected','subscription_expired','not_configured','retry','release') then
    raise exception 'INVALID: unknown delivery outcome';
  end if;
  select * into d from public.general_push_deliveries where id = p_delivery for update;
  -- only the CURRENT lease holder may record; replays, late reports and workers that lost their lease change nothing
  if not found or d.state <> 'sending' or p_lease is null or d.lease_id is distinct from p_lease then return; end if;
  if p_state = 'release' then
    -- the worker ran out of time before sending: hand it back without using up an attempt
    update public.general_push_deliveries
       set state = 'queued', attempts = greatest(d.attempts - 1, 0), lease_id = null, lease_until = null,
           detail = left(p_detail, 200), updated_at = now()
     where id = p_delivery;
    return;
  end if;
  update public.general_push_deliveries
     set state = case when p_state = 'retry' then (case when d.attempts >= 5 then 'failed' else 'queued' end) else p_state end,
         detail = left(p_detail, 200), lease_id = null, lease_until = null, updated_at = now()
   where id = p_delivery;
  if p_state = 'subscription_expired' then
    update public.push_subscriptions set expired_at = now() where id = d.subscription_id and expired_at is null;
  end if;
  perform public.mg_push_finalize_outbox(d.outbox_id);
end;
$mg$;

create or replace function public.mg_push_prune(p_days integer default 30)
returns integer language plpgsql security definer set search_path = public as $mg$
declare v_n integer;
begin
  delete from public.general_push_outbox
   where state in ('completed','failed','skipped','expired') and updated_at < now() - make_interval(days => greatest(coalesce(p_days, 30), 7));
  get diagnostics v_n = row_count;
  return v_n;
end;
$mg$;

create or replace function public.mg_push_queue_stats()
returns jsonb language sql stable security definer set search_path = public as $mg$
  select jsonb_build_object(
    'outbox', coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from public.general_push_outbox group by state) s), '{}'::jsonb),
    'deliveries', coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from public.general_push_deliveries group by state) s), '{}'::jsonb),
    'oldest_pending_seconds', (select extract(epoch from now() - min(created_at))::bigint from public.general_push_outbox where state in ('queued','sending')),
    'rate_limited_pending', (select count(*) from public.general_push_outbox where state in ('queued','sending') and released_at is null and rate_limited_at is not null),
    'rate_limited_total', (select count(*) from public.general_push_outbox where rate_limited_at is not null),
    'failed_last_24h', (select count(*) from public.general_push_outbox where state = 'failed' and updated_at > now() - interval '24 hours'),
    'failed_by_category_24h', coalesce((select jsonb_object_agg(category, n) from
        (select category, count(*) n from public.general_push_outbox where state = 'failed' and updated_at > now() - interval '24 hours' group by category) s), '{}'::jsonb))
$mg$;

-- user settings --------------------------------------------------------------------------------------------------------
create or replace function public.mg_push_prefs_get()
returns jsonb language plpgsql stable security definer set search_path = public as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  if public.mg_is_anonymous() then raise exception 'FORBIDDEN: guest sessions have no notification settings'; end if;
  -- one object {category: true|false}; a category with no stored choice is false (default off)
  return (select jsonb_object_agg(c.category, coalesce(pp.enabled, false))
            from unnest(public.mg_push_categories()) as c(category)
            left join public.push_preferences pp on pp.user_id = auth.uid() and pp.category = c.category);
end;
$mg$;

create or replace function public.mg_push_prefs_set(p_prefs jsonb)
returns void language plpgsql security definer set search_path = public as $mg$
declare k text; v jsonb;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  if public.mg_is_anonymous() then raise exception 'FORBIDDEN: guest sessions have no notification settings'; end if;
  if exists (select 1 from public.profiles where id = auth.uid() and (restricted_at is not null or deleted_at is not null)) then
    raise exception 'FORBIDDEN: this account is restricted';
  end if;
  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object' or (select count(*) from jsonb_object_keys(p_prefs)) not between 1 and 9 then
    raise exception 'INVALID: send an object of category: true/false (1 to 9 categories)';
  end if;
  for k, v in select * from jsonb_each(p_prefs) loop
    if not (k = any (public.mg_push_categories())) then raise exception 'INVALID: unknown notification category'; end if;
    if jsonb_typeof(v) <> 'boolean' then raise exception 'INVALID: each category must be true or false'; end if;
  end loop;
  for k, v in select * from jsonb_each(p_prefs) loop
    insert into public.push_preferences (user_id, category, enabled) values (auth.uid(), k, (v)::boolean)
    on conflict (user_id, category) do update set enabled = excluded.enabled, updated_at = now();
  end loop;
end;
$mg$;

-- privileges -----------------------------------------------------------------------------------------------------------
revoke all on function
  public.mg_push_categories(), public.mg_push_category_for(text, text), public.mg_push_rate_config(),
  public.mg_push_enqueue(uuid), public.mg_notifications_enqueue_push(), public.mg_push_finalize_outbox(uuid),
  public.mg_push_claim(integer), public.mg_push_record(uuid, text, text, uuid), public.mg_push_prune(integer),
  public.mg_push_queue_stats(), public.mg_push_prefs_get(), public.mg_push_prefs_set(jsonb)
  from public, anon, authenticated, service_role;
-- the delivery worker (service role)
grant execute on function
  public.mg_push_enqueue(uuid), public.mg_push_claim(integer), public.mg_push_record(uuid, text, text, uuid),
  public.mg_push_prune(integer), public.mg_push_queue_stats(), public.mg_push_rate_config()
  to service_role;
-- signed-in users manage their own settings
grant execute on function public.mg_push_prefs_get(), public.mg_push_prefs_set(jsonb) to authenticated;

commit;
