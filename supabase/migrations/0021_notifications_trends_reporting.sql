-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0021: persisted notifications, command-center
-- trends, summary reporting
-- (Session 9: NTF-1 notifications, §19 command-center trends, §1 reporting)
--
-- A. public.notifications — PERSISTED, PER-USER in-app notifications with
--    read / dismiss state. v1 (docs/01) derived notifications at request time
--    and so could not remember that a user had seen or dismissed one.
--
--    The CONTENT is still derived by the application from records the caller
--    can already read (same rules as v1: deadlines, reviewer decisions,
--    community-report triage). What is new is that each derived item is
--    stored once per (user, source_key) so state survives reloads and devices.
--
--      * private to the recipient — RLS: user_id = auth.uid() for SELECT,
--        INSERT and UPDATE. Not even administrators read another account's
--        inbox (there is deliberately no admin policy);
--      * user_id is server-assigned from the session (a client cannot write
--        into someone else's inbox);
--      * content is immutable once stored; only read_at / dismissed_at /
--        resolved_at can change, each ONE-WAY (set once, never cleared);
--      * no client DELETE (docs/15 retention for delivery records is an open
--        owner decision — PROPOSED, REQUIRES OWNER CONFIRMATION); the migration
--        owner / service role (auth.uid() is null) can purge;
--      * link_to must be an in-app path (/portal… or /operate…) — a stored
--        notification can never carry an external URL;
--      * the table holds titles/bodies copied from records the caller could
--        already read; it holds no contact data, device token or address.
--        Delivery channels (email / push / SMS) remain NOT IMPLEMENTED.
--
--    public.mg_notifications_sync(p_items jsonb) — SECURITY INVOKER. Stores
--    the caller's derived items (insert-if-new; existing rows keep their
--    read/dismiss state) and marks deadline notifications that are no longer
--    true (corrective action closed, or moved from due-soon to overdue) as
--    resolved. Max 500 items per call.
--
-- B. Trends — SECURITY INVOKER (RLS IS the authorization; same posture as
--    0012/0014/0019 — a caller can only ever count rows they can read):
--      mg_trend_events(metric)                 the one event source
--      mg_trend_series(metric, bucket, from, to)   zero-filled time series
--      mg_trend_geo(metric, from, to)          per-county totals for the period
--                                              vs the immediately preceding
--                                              period of equal length
--    The metric is a fixed ALLOWLIST (no dynamic SQL, no caller-supplied
--    identifiers). Buckets are day / week / month in UTC; a request is bounded
--    to 400 buckets / 800 days.
--
-- C. mg_summary_report(from, to) — the numbers behind the printable
--    government-style summary: period activity, current open position,
--    per-county breakdown and the highest-risk sites (from mg_risk_scores, so
--    the same configurable risk model and version as the rest of the app).
--    SECURITY INVOKER: scope-limited by RLS like every other read. The
--    "not an official document" footer is rendered by the application and
--    pinned by tests; the RPC returns data, not a document.
--
-- Idempotent: safe to re-run. 0011's allowlist carries the new signatures.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- A. notifications
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id),
  source_key   text not null check (length(source_key) between 1 and 160),
  kind         text not null check (kind in ('ca_deadline', 'ca_decision', 'report_status')),
  severity     text not null check (severity in ('info', 'warning', 'urgent')),
  title        text not null check (length(title) between 1 and 300),
  body         text not null default '' check (length(body) <= 1000),
  link_to      text not null check (link_to ~ '^/(portal|operate)(/[A-Za-z0-9._~:@!$&()*+,;=%-]*)*$'),
  event_at     timestamptz not null,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  dismissed_at timestamptz,
  resolved_at  timestamptz,
  unique (user_id, source_key)
);

create index if not exists notifications_user_active_idx
  on public.notifications (user_id, event_at desc)
  where dismissed_at is null and resolved_at is null;

create or replace function public.mg_notifications_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $mg$
begin
  if tg_op = 'DELETE' then
    if auth.uid() is not null then
      raise exception 'IMMUTABLE: notifications cannot be deleted by a client';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.user_id := auth.uid();
    end if;
    new.id           := coalesce(new.id, gen_random_uuid());
    new.created_at   := now();
    new.read_at      := null;
    new.dismissed_at := null;
    new.resolved_at  := null;
    return new;
  end if;

  -- UPDATE: content is immutable; the three state stamps are one-way.
  if auth.uid() is not null then
    if new.id is distinct from old.id
       or new.user_id is distinct from old.user_id
       or new.source_key is distinct from old.source_key
       or new.kind is distinct from old.kind
       or new.severity is distinct from old.severity
       or new.title is distinct from old.title
       or new.body is distinct from old.body
       or new.link_to is distinct from old.link_to
       or new.event_at is distinct from old.event_at
       or new.created_at is distinct from old.created_at then
      raise exception 'IMMUTABLE: only read, dismissed and resolved state can change';
    end if;
    new.read_at      := coalesce(old.read_at, new.read_at);
    new.dismissed_at := coalesce(old.dismissed_at, new.dismissed_at);
    new.resolved_at  := coalesce(old.resolved_at, new.resolved_at);
  end if;
  return new;
end
$mg$;

drop trigger if exists notifications_guard on public.notifications;
create trigger notifications_guard
  before insert or update or delete on public.notifications
  for each row execute function public.mg_notifications_guard();

alter table public.notifications enable row level security;

drop policy if exists "notifications read own" on public.notifications;
create policy "notifications read own" on public.notifications
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "notifications insert own" on public.notifications;
create policy "notifications insert own" on public.notifications
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "notifications update own" on public.notifications;
create policy "notifications update own" on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.notifications from anon, authenticated, public;
grant select, insert on public.notifications to authenticated;
grant update (read_at, dismissed_at, resolved_at) on public.notifications to authenticated;

revoke execute on function public.mg_notifications_guard() from public, anon, authenticated;

-- mg_notifications_sync -----------------------------------------------------
create or replace function public.mg_notifications_sync(p_items jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $mg$
declare
  uid       uuid := auth.uid();
  n_in      integer;
  n_new     integer := 0;
  n_resolve integer := 0;
begin
  if uid is null then
    raise exception 'UNAUTHENTICATED: sign in to sync notifications';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_INPUT: p_items must be a JSON array';
  end if;
  n_in := jsonb_array_length(p_items);
  if n_in > 500 then
    raise exception 'INVALID_INPUT: at most 500 notifications per sync';
  end if;

  with ins as (
    insert into public.notifications
      (user_id, source_key, kind, severity, title, body, link_to, event_at)
    select uid, i.source_key, i.kind, i.severity, i.title,
           coalesce(i.body, ''), i.link_to, i.event_at
      from jsonb_to_recordset(p_items) as i(
             source_key text, kind text, severity text, title text,
             body text, link_to text, event_at timestamptz)
    on conflict (user_id, source_key) do nothing
    returning 1
  )
  select count(*) into n_new from ins;

  -- Deadline notifications are STATE ("this is due soon"), not events: once
  -- the condition is no longer derived they are resolved, not left stale.
  with upd as (
    update public.notifications n
       set resolved_at = now()
     where n.user_id = uid
       and n.kind = 'ca_deadline'
       and n.resolved_at is null
       and not exists (
             select 1
               from jsonb_to_recordset(p_items) as i(source_key text)
              where i.source_key = n.source_key)
    returning 1
  )
  select count(*) into n_resolve from upd;

  return jsonb_build_object('received', n_in, 'inserted', n_new, 'resolved', n_resolve);
end
$mg$;

revoke execute on function public.mg_notifications_sync(jsonb) from public, anon;
grant execute on function public.mg_notifications_sync(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- B. Trends
-- ---------------------------------------------------------------------------

-- The single event source. One arm per allowlisted metric; every arm reads
-- through RLS (security invoker), joins sites only to attach the county.
create or replace function public.mg_trend_events(p_metric text)
returns table (ts timestamptz, v numeric, county text)
language sql
stable
security invoker
set search_path = public
as $mg$
  select i.occurred_at, 1::numeric, s.county
    from public.incidents i join public.sites s on s.id = i.site_id
   where p_metric = 'incidents'
  union all
  select i.occurred_at, coalesce(i.fatalities, 1)::numeric, s.county
    from public.incidents i join public.sites s on s.id = i.site_id
   where p_metric = 'fatalities' and i.type = 'fatality'
  union all
  select i.submitted_at, 1::numeric, s.county
    from public.inspections i join public.sites s on s.id = i.site_id
   where p_metric = 'inspections' and i.submitted_at is not null
  union all
  select f.created_at, 1::numeric, s.county
    from public.findings f join public.sites s on s.id = f.site_id
   where p_metric = 'findings'
  union all
  select f.created_at, 1::numeric, s.county
    from public.findings f join public.sites s on s.id = f.site_id
   where p_metric = 'critical_findings' and f.severity = 'critical'
  union all
  select o.observed_at, 1::numeric, s.county
    from public.environmental_observations o join public.sites s on s.id = o.site_id
   where p_metric = 'observations'
  union all
  select r.created_at, 1::numeric, r.county
    from public.community_reports r
   where p_metric = 'community_reports'
$mg$;

revoke execute on function public.mg_trend_events(text) from public, anon;
grant execute on function public.mg_trend_events(text) to authenticated;

create or replace function public.mg_trend_series(
  p_metric text,
  p_bucket text default 'month',
  p_from   date default null,
  p_to     date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $mg$
declare
  v_to    date;
  v_from  date;
  v_step  interval;
  v_first timestamp;
  v_last  timestamp;
  v_n     integer;
  v_pts   jsonb;
  v_total numeric;
begin
  if p_metric is null or p_metric not in (
       'incidents', 'fatalities', 'inspections', 'findings',
       'critical_findings', 'observations', 'community_reports') then
    raise exception 'INVALID_INPUT: unknown trend metric %', coalesce(p_metric, '<null>');
  end if;
  if p_bucket is null or p_bucket not in ('day', 'week', 'month') then
    raise exception 'INVALID_INPUT: bucket must be day, week or month';
  end if;

  v_to := coalesce(p_to, (now() at time zone 'UTC')::date);
  v_from := coalesce(p_from, case p_bucket
              when 'day'   then v_to - 29
              when 'week'  then v_to - 83
              else (v_to - interval '11 months')::date end);
  if v_from > v_to then
    raise exception 'INVALID_INPUT: from must not be after to';
  end if;

  v_step  := case p_bucket when 'day' then interval '1 day'
                           when 'week' then interval '1 week'
                           else interval '1 month' end;
  v_first := date_trunc(p_bucket, v_from::timestamp);
  v_last  := date_trunc(p_bucket, v_to::timestamp);
  v_n := case p_bucket
           when 'day'   then (v_last::date - v_first::date) + 1
           when 'week'  then ((v_last::date - v_first::date) / 7) + 1
           else (extract(year from age(v_last, v_first))::int * 12
                 + extract(month from age(v_last, v_first))::int) + 1 end;
  if v_n > 400 then
    raise exception 'INVALID_INPUT: range too large (% buckets, max 400)', v_n;
  end if;

  with b as (
    select g::date as bucket
      from generate_series(v_first, v_last, v_step) g
  ), ev as (
    select date_trunc(p_bucket, e.ts at time zone 'UTC')::date as bucket, e.v
      from public.mg_trend_events(p_metric) e
     where e.ts >= (v_from::timestamp at time zone 'UTC')
       and e.ts <  ((v_to + 1)::timestamp at time zone 'UTC')
  ), agg as (
    select b.bucket, coalesce(sum(ev.v), 0) as value
      from b left join ev on ev.bucket = b.bucket
     group by b.bucket
  )
  select jsonb_agg(jsonb_build_object('bucket', a.bucket, 'value', a.value) order by a.bucket),
         coalesce(sum(a.value), 0)
    into v_pts, v_total
    from agg a;

  return jsonb_build_object(
    'metric', p_metric, 'bucket', p_bucket,
    'from', v_from, 'to', v_to,
    'total', v_total, 'points', coalesce(v_pts, '[]'::jsonb));
end
$mg$;

revoke execute on function public.mg_trend_series(text, text, date, date) from public, anon;
grant execute on function public.mg_trend_series(text, text, date, date) to authenticated;

create or replace function public.mg_trend_geo(
  p_metric text,
  p_from   date default null,
  p_to     date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $mg$
declare
  v_to    date;
  v_from  date;
  v_days  integer;
  v_pfrom date;
  v_rows  jsonb;
begin
  if p_metric is null or p_metric not in (
       'incidents', 'fatalities', 'inspections', 'findings',
       'critical_findings', 'observations', 'community_reports') then
    raise exception 'INVALID_INPUT: unknown trend metric %', coalesce(p_metric, '<null>');
  end if;
  v_to   := coalesce(p_to, (now() at time zone 'UTC')::date);
  v_from := coalesce(p_from, v_to - 89);
  if v_from > v_to then
    raise exception 'INVALID_INPUT: from must not be after to';
  end if;
  v_days := (v_to - v_from) + 1;
  if v_days > 800 then
    raise exception 'INVALID_INPUT: range too large (% days, max 800)', v_days;
  end if;
  v_pfrom := v_from - v_days;

  with ev as (
    select coalesce(nullif(btrim(e.county), ''), 'Unspecified') as county,
           e.v,
           (e.ts >= (v_from::timestamp at time zone 'UTC')) as in_current
      from public.mg_trend_events(p_metric) e
     where e.ts >= (v_pfrom::timestamp at time zone 'UTC')
       and e.ts <  ((v_to + 1)::timestamp at time zone 'UTC')
  ), agg as (
    select county,
           coalesce(sum(v) filter (where in_current), 0)     as value,
           coalesce(sum(v) filter (where not in_current), 0) as previous
      from ev
     group by county
  )
  select jsonb_agg(jsonb_build_object(
           'county', a.county,
           'value', a.value,
           'previous', a.previous,
           'delta', a.value - a.previous,
           'changePct', case when a.previous = 0 then null
                             else round(100.0 * (a.value - a.previous) / a.previous) end)
         order by a.value desc, a.county)
    into v_rows
    from agg a
   where a.value > 0 or a.previous > 0;

  return jsonb_build_object(
    'metric', p_metric, 'from', v_from, 'to', v_to,
    'previousFrom', v_pfrom, 'previousTo', v_from - 1,
    'rows', coalesce(v_rows, '[]'::jsonb));
end
$mg$;

revoke execute on function public.mg_trend_geo(text, date, date) from public, anon;
grant execute on function public.mg_trend_geo(text, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- C. Summary report
-- ---------------------------------------------------------------------------
create or replace function public.mg_summary_report(
  p_from date default null,
  p_to   date default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $mg$
declare
  v_to     date;
  v_from   date;
  v_lo     timestamptz;
  v_hi     timestamptz;
  v_scope  text;
  v_out    jsonb;
begin
  v_to   := coalesce(p_to, (now() at time zone 'UTC')::date);
  v_from := coalesce(p_from, v_to - 89);
  if v_from > v_to then
    raise exception 'INVALID_INPUT: from must not be after to';
  end if;
  if (v_to - v_from) > 800 then
    raise exception 'INVALID_INPUT: range too large (max 800 days)';
  end if;
  v_lo := (v_from::timestamp at time zone 'UTC');
  v_hi := ((v_to + 1)::timestamp at time zone 'UTC');
  v_scope := coalesce((select p.scope::text from public.mg_profile() p), 'national');

  select jsonb_build_object(
    'generatedAt', now(),
    'scope', v_scope,
    'period', jsonb_build_object('from', v_from, 'to', v_to),
    'activity', jsonb_build_object(
      'incidents',
        (select count(*) from public.incidents
          where occurred_at >= v_lo and occurred_at < v_hi),
      'fatalities',
        (select coalesce(sum(coalesce(fatalities, 1)), 0) from public.incidents
          where type = 'fatality' and occurred_at >= v_lo and occurred_at < v_hi),
      'inspectionsSubmitted',
        (select count(*) from public.inspections
          where submitted_at >= v_lo and submitted_at < v_hi),
      'findings',
        (select count(*) from public.findings
          where created_at >= v_lo and created_at < v_hi),
      'criticalFindings',
        (select count(*) from public.findings
          where severity = 'critical' and created_at >= v_lo and created_at < v_hi),
      'observations',
        (select count(*) from public.environmental_observations
          where observed_at >= v_lo and observed_at < v_hi),
      'communityReports',
        (select count(*) from public.community_reports
          where created_at >= v_lo and created_at < v_hi)),
    'position', jsonb_build_object(
      'sites', (select count(*) from public.sites),
      'activeSites', (select count(*) from public.sites where status = 'active'),
      'openCorrectiveActions',
        (select count(*) from public.corrective_actions
          where status not in ('closed', 'verified')),
      'overdueCorrectiveActions',
        (select count(*) from public.corrective_actions
          where status not in ('closed', 'verified') and due_at < now()),
      'openCriticalFindings',
        (select count(*) from public.findings
          where severity = 'critical' and status in ('open', 'acknowledged')),
      'unresolvedVerifiedEnvAlerts',
        (select count(*) from public.environmental_observations
          where status <> 'resolved' and verification in ('measured', 'verified')),
      'reportsAwaitingTriage',
        (select count(*) from public.community_reports where status = 'submitted')),
    'byCounty',
      (select coalesce(jsonb_agg(c order by (c->>'county')), '[]'::jsonb)
         from (
           select jsonb_build_object(
                    'county', s.county,
                    'sites', count(*),
                    'incidents', coalesce(sum(x.inc), 0),
                    'fatalities', coalesce(sum(x.fat), 0),
                    'criticalFindings', coalesce(sum(x.crit), 0),
                    'overdueCorrectiveActions', coalesce(sum(x.od), 0)) as c
             from public.sites s
             left join lateral (
               select
                 (select count(*) from public.incidents i
                   where i.site_id = s.id
                     and i.occurred_at >= v_lo and i.occurred_at < v_hi) as inc,
                 (select coalesce(sum(coalesce(i.fatalities, 1)), 0) from public.incidents i
                   where i.site_id = s.id and i.type = 'fatality'
                     and i.occurred_at >= v_lo and i.occurred_at < v_hi) as fat,
                 (select count(*) from public.findings f
                   where f.site_id = s.id and f.severity = 'critical'
                     and f.created_at >= v_lo and f.created_at < v_hi) as crit,
                 (select count(*) from public.corrective_actions ca
                   where ca.site_id = s.id
                     and ca.status not in ('closed', 'verified')
                     and ca.due_at < now()) as od
             ) x on true
            group by s.county
         ) t),
    'topRiskSites',
      (select coalesce(jsonb_agg(r order by (r->>'score')::numeric desc, r->>'code'), '[]'::jsonb)
         from (
           select jsonb_build_object(
                    'siteId', s.id, 'code', s.code, 'name', s.name,
                    'county', s.county,
                    'score', rs->'score',
                    'configVersion', rs->'configVersion') as r
             from public.mg_risk_scores() rs
             join public.sites s on s.id = (rs->>'siteId')::uuid
            order by (rs->>'score')::numeric desc, s.code
            limit 10
         ) t)
  ) into v_out;

  return v_out;
end
$mg$;

revoke execute on function public.mg_summary_report(date, date) from public, anon;
grant execute on function public.mg_summary_report(date, date) to authenticated;

commit;
