-- ============================================================================
-- MINEGUARD LIBERIA — migration 0040: emergency command & response coordination
--
-- A SUPPLEMENTARY coordination aid. It does NOT replace the site's sirens, radios or
-- approved emergency procedures, and nothing here is certified for emergency use.
--
-- Tables (all client writes closed; every change goes through a self-authorizing RPC):
--   emergency_alerts            the alert (site-targeted; optional zone label; audience group)
--   emergency_alert_revisions   append-only history: created/activated/updated/cancelled/resolved
--   emergency_alert_acks        append-only worker acknowledgments (actor = session, never a param)
--   emergency_alert_views       append-only "the app reported displaying this" markers
--   emergency_alert_deliveries  server-written web-push outbox + provider outcome per subscription
--   push_subscriptions          browser push endpoints (secrets: never readable by clients)
--
-- Authorization is decided HERE (mg_can_manage_emergency), live, on every call:
--   * an ACTIVE member of the site's APPROVED company who is company_admin, or a
--     site_manager / safety_officer with a live assignment to THAT site.
-- Revoking a membership, assignment or permission takes effect on the next call.
-- Ministry admin/supervisor/inspector may READ (permission 'emergency.read'); admin has no
-- write authority over company sites' alerts (owner decision).
--
-- High-impact actions need a server-checked confirmation word (ACTIVATE / UPDATE /
-- CANCEL / RESOLVE) and an expected revision (stale or replayed requests are refused).
-- Activation/cancellation are deliberately NOT queueable offline.
--
-- Zones: the data model has no zone table. `zone_label` is a free-text label shown to
-- workers; it does NOT narrow the audience. Audience = people allowed at the site
-- (mg_operator_site_ok) filtered by target_group (org_role).
--
-- Idempotent. Rollback: see docs/21_EMERGENCY_ALERTS.MD §Rollback.
-- ============================================================================

begin;

-- permissions ---------------------------------------------------------------------------------
-- DECISION (owner-approved): Ministry roles do NOT create or activate alerts at company sites;
-- they read. No role is granted 'emergency.manage' — the hook stays in mg_can_manage_emergency
-- so a future, explicit grant is a data change, not a code change.
insert into public.permissions (role, permission) values
  ('admin',      'emergency.read'),
  ('supervisor', 'emergency.read'),
  ('inspector',  'emergency.read')
on conflict (role, permission) do nothing;

-- tables --------------------------------------------------------------------------------------
create table if not exists public.emergency_alerts (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references public.sites(id),
  zone_label      text check (zone_label is null or char_length(zone_label) <= 80),
  target_group    text not null default 'all'
                  check (target_group in ('all','workers','safety_officers','site_managers')),
  title           text not null check (char_length(title) between 3 and 120),
  severity        text not null check (severity in ('advisory','warning','critical')),
  instructions    text not null check (char_length(instructions) between 1 and 2000),
  assembly_point  text check (assembly_point is null or char_length(assembly_point) <= 300),
  procedure_ref   text check (procedure_ref is null or char_length(procedure_ref) <= 300),
  status          text not null default 'draft'
                  check (status in ('draft','active','cancelled','resolved')),
  revision        integer not null default 1,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 80),
  created_by      uuid not null references public.profiles(id),
  created_at      timestamptz not null default now(),
  activated_at    timestamptz,
  activated_by    uuid references public.profiles(id),
  closed_at       timestamptz,
  closed_by       uuid references public.profiles(id),
  close_reason    text,
  updated_at      timestamptz,
  updated_by      uuid,
  row_version     integer not null default 1,
  unique (created_by, idempotency_key)
);
create index if not exists emergency_alerts_site_status_idx on public.emergency_alerts (site_id, status);

create table if not exists public.emergency_alert_revisions (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,
  alert_id       uuid not null references public.emergency_alerts(id),
  revision       integer not null,
  change_type    text not null check (change_type in ('created','activated','updated','cancelled','resolved')),
  title          text not null,
  severity       text not null,
  instructions   text not null,
  assembly_point text,
  zone_label     text,
  procedure_ref  text,
  target_group   text,
  note           text,
  changed_by     uuid references public.profiles(id),
  changed_at     timestamptz not null default now()
);
create index if not exists emergency_revisions_alert_idx on public.emergency_alert_revisions (alert_id, seq);

create table if not exists public.emergency_alert_acks (
  id               uuid primary key default gen_random_uuid(),
  alert_id         uuid not null references public.emergency_alerts(id),
  user_id          uuid not null references public.profiles(id),
  revision         integer not null,
  acked_at         timestamptz not null default now(),   -- SERVER time
  client_seen_at   timestamptz,                          -- device-claimed; unverified
  client_ref       text,
  alert_status_at_ack text not null,                     -- active / cancelled / resolved
  unique (alert_id, user_id, revision)
);

create table if not exists public.emergency_alert_views (
  id          uuid primary key default gen_random_uuid(),
  alert_id    uuid not null references public.emergency_alerts(id),
  user_id     uuid not null references public.profiles(id),
  revision    integer not null,
  reported_at timestamptz not null default now(),
  unique (alert_id, user_id, revision)
);

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id),
  endpoint    text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 2048),
  p256dh      text not null check (char_length(p256dh) between 1 and 256),
  auth        text not null check (char_length(auth) between 1 and 128),
  user_agent  text check (user_agent is null or char_length(user_agent) <= 300),
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expired_at  timestamptz,
  revoked_at  timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table if not exists public.emergency_alert_deliveries (
  id              uuid primary key default gen_random_uuid(),
  alert_id        uuid not null references public.emergency_alerts(id),
  user_id         uuid not null references public.profiles(id),
  subscription_id uuid not null references public.push_subscriptions(id),
  revision        integer not null,
  event           text not null check (event in ('activated','updated','cancelled','resolved')),
  state           text not null default 'queued'
                  check (state in ('queued','sending','service_accepted','service_rejected',
                                   'subscription_expired','not_configured')),
  attempts        integer not null default 0,
  detail          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (alert_id, revision, event, subscription_id)
);
create index if not exists emergency_deliveries_state_idx on public.emergency_alert_deliveries (state, created_at);

-- closed client surface -------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['emergency_alerts','emergency_alert_revisions','emergency_alert_acks',
                           'emergency_alert_views','push_subscriptions','emergency_alert_deliveries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- append-only guard (revisions, acks, views): nobody edits history through SQL either ------------
create or replace function public.mg_emergency_append_only()
returns trigger language plpgsql as $mg$
begin
  raise exception 'IMMUTABLE: emergency history is append-only';
end;
$mg$;
revoke all on function public.mg_emergency_append_only() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['emergency_alert_revisions','emergency_alert_acks','emergency_alert_views'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on public.%I
                    for each row execute function public.mg_emergency_append_only()', t || '_append_only', t);
  end loop;
end $$;

-- stamping + audit (mg_touch_row / mg_audit_row). push_subscriptions is deliberately NOT
-- audited by row: its endpoint/keys are secrets and must not be copied into audit_log. -----------
alter table public.emergency_alert_deliveries add column if not exists updated_by uuid;
alter table public.emergency_alert_deliveries add column if not exists row_version integer not null default 1;
alter table public.emergency_alert_revisions add column if not exists updated_at timestamptz;
alter table public.emergency_alert_revisions add column if not exists updated_by uuid;
alter table public.emergency_alert_revisions add column if not exists row_version integer not null default 1;
alter table public.emergency_alert_acks add column if not exists updated_at timestamptz;
alter table public.emergency_alert_acks add column if not exists updated_by uuid;
alter table public.emergency_alert_acks add column if not exists row_version integer not null default 1;
alter table public.emergency_alert_views add column if not exists updated_at timestamptz;
alter table public.emergency_alert_views add column if not exists updated_by uuid;
alter table public.emergency_alert_views add column if not exists row_version integer not null default 1;

do $$
declare t text;
begin
  foreach t in array array['emergency_alerts','emergency_alert_revisions','emergency_alert_acks',
                           'emergency_alert_views','emergency_alert_deliveries'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before insert or update on public.%I
                    for each row execute function public.mg_touch_row()', t || '_touch', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update on public.%I
                    for each row execute function public.mg_audit_row()', t || '_audit', t);
  end loop;
end $$;

-- authorization predicates --------------------------------------------------------------------------
create or replace function public.mg_can_manage_emergency(p_site_id uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null
     and exists (
       select 1 from public.sites s
        where s.id = p_site_id
          and (
               public.mg_has_permission('emergency.manage')
            or (s.organization_id is not null and exists (
                  select 1
                    from public.organization_members m
                    join public.organizations o on o.id = m.organization_id
                   where m.user_id = auth.uid()
                     and m.organization_id = s.organization_id
                     and m.status = 'active'
                     and o.status = 'approved'
                     and (m.org_role = 'company_admin'
                          or (m.org_role in ('site_manager','safety_officer')
                              and exists (select 1 from public.site_assignments sa
                                           where sa.user_id = m.user_id and sa.site_id = s.id
                                             and sa.revoked_at is null)))))
          ))
$mg$;

-- is p_user in the alert's audience RIGHT NOW (live membership; no snapshot)
create or replace function public.mg_emergency_in_audience(p_alert uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select exists (
    select 1
      from public.emergency_alerts a
      join public.sites s on s.id = a.site_id
      join public.organization_members m
        on m.organization_id = s.organization_id and m.user_id = p_user and m.status = 'active'
      join public.organizations o on o.id = m.organization_id and o.status = 'approved'
     where a.id = p_alert
       and public.mg_operator_site_ok(p_user, s.id, s.organization_id)
       and case a.target_group
             when 'all'             then true
             when 'workers'         then m.org_role = 'worker'
             when 'safety_officers' then m.org_role = 'safety_officer'
             when 'site_managers'   then m.org_role in ('site_manager','company_admin')
             else false end)
$mg$;

create or replace function public.mg_emergency_audience(p_alert uuid)
returns table (user_id uuid, org_role text)
language sql stable security definer set search_path = public as $mg$
  select m.user_id, m.org_role
    from public.emergency_alerts a
    join public.sites s on s.id = a.site_id
    join public.organization_members m
      on m.organization_id = s.organization_id and m.status = 'active'
    join public.organizations o on o.id = m.organization_id and o.status = 'approved'
   where a.id = p_alert
     and public.mg_operator_site_ok(m.user_id, s.id, s.organization_id)
     and case a.target_group
           when 'all'             then true
           when 'workers'         then m.org_role = 'worker'
           when 'safety_officers' then m.org_role = 'safety_officer'
           when 'site_managers'   then m.org_role in ('site_manager','company_admin')
           else false end
$mg$;

-- may this caller READ the alert (managers, in-scope Ministry staff, live audience once active)
create or replace function public.mg_can_view_emergency(p_alert uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null
     and exists (
       select 1
         from public.emergency_alerts a
         join public.sites s on s.id = a.site_id
        where a.id = p_alert
          and (
               public.mg_can_manage_emergency(a.site_id)
            or (public.mg_has_permission('emergency.read')
                and public.mg_can_access_site_row(s.id, s.county, s.district, s.operator_name, s.organization_id))
            or (a.status <> 'draft' and public.mg_emergency_in_audience(a.id, auth.uid()))
          ))
$mg$;

drop policy if exists "emergency alerts read" on public.emergency_alerts;
create policy "emergency alerts read" on public.emergency_alerts
  for select to authenticated using (public.mg_can_view_emergency(id));
grant select on public.emergency_alerts to authenticated;

-- history append helper ------------------------------------------------------------------------------
create or replace function public.mg_emergency_log(p_alert public.emergency_alerts, p_type text, p_note text)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  insert into public.emergency_alert_revisions
    (alert_id, revision, change_type, title, severity, instructions, assembly_point,
     zone_label, procedure_ref, target_group, note, changed_by)
  values (p_alert.id, p_alert.revision, p_type, p_alert.title, p_alert.severity, p_alert.instructions,
          p_alert.assembly_point, p_alert.zone_label, p_alert.procedure_ref, p_alert.target_group,
          p_note, auth.uid());
end;
$mg$;

-- push outbox: one row per live subscription of each audience member (server-side only) ---------------
create or replace function public.mg_emergency_enqueue_push(p_alert uuid, p_event text)
returns integer language plpgsql security definer set search_path = public as $mg$
declare v_rev integer; v_n integer;
begin
  select revision into v_rev from public.emergency_alerts where id = p_alert;
  insert into public.emergency_alert_deliveries (alert_id, user_id, subscription_id, revision, event)
  select p_alert, au.user_id, ps.id, v_rev, p_event
    from public.mg_emergency_audience(p_alert) au
    join public.push_subscriptions ps
      on ps.user_id = au.user_id and ps.expired_at is null and ps.revoked_at is null
  on conflict (alert_id, revision, event, subscription_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$mg$;
revoke all on function public.mg_emergency_enqueue_push(uuid, text) from public, anon, authenticated;

-- RPC: create (draft) ----------------------------------------------------------------------------------
create or replace function public.mg_emergency_create(
  p_site_id uuid, p_title text, p_severity text, p_instructions text,
  p_idempotency_key text,
  p_target_group text default 'all', p_zone_label text default null,
  p_assembly_point text default null, p_procedure_ref text default null)
returns uuid language plpgsql security definer set search_path = public as $mg$
declare v_id uuid; v_a public.emergency_alerts;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  if not public.mg_can_manage_emergency(p_site_id) then
    raise exception 'FORBIDDEN: you are not authorized to create emergency alerts for this site';
  end if;
  select id into v_id from public.emergency_alerts
   where created_by = auth.uid() and idempotency_key = p_idempotency_key;
  if v_id is not null then return v_id; end if;           -- duplicate request: same alert
  insert into public.emergency_alerts
    (site_id, title, severity, instructions, target_group, zone_label, assembly_point,
     procedure_ref, idempotency_key, created_by)
  values (p_site_id, btrim(p_title), p_severity, btrim(p_instructions), coalesce(p_target_group,'all'),
          nullif(btrim(p_zone_label),''), nullif(btrim(p_assembly_point),''),
          nullif(btrim(p_procedure_ref),''), p_idempotency_key, auth.uid())
  returning * into v_a;
  perform public.mg_emergency_log(v_a, 'created', null);
  return v_a.id;
end;
$mg$;

-- RPC: activate -----------------------------------------------------------------------------------------
create or replace function public.mg_emergency_activate(p_id uuid, p_confirm text, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_a public.emergency_alerts; v_queued integer;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  select * into v_a from public.emergency_alerts where id = p_id for update;
  if not found or not public.mg_can_manage_emergency(v_a.site_id) then
    raise exception 'FORBIDDEN: you are not authorized to activate this alert';
  end if;
  if p_confirm is distinct from 'ACTIVATE' then
    raise exception 'CONFIRMATION_REQUIRED: type ACTIVATE to confirm';
  end if;
  if v_a.status = 'active' then raise exception 'CONFLICT: ALREADY_ACTIVE'; end if;
  if v_a.status <> 'draft' then raise exception 'CONFLICT: ALERT_CLOSED'; end if;
  if v_a.revision is distinct from p_expected_revision then
    raise exception 'CONFLICT: STALE_REVISION (current %)', v_a.revision;
  end if;
  if exists (select 1 from public.emergency_alerts o
              where o.site_id = v_a.site_id and o.status = 'active' and o.id <> v_a.id
                and o.severity = v_a.severity and o.target_group = v_a.target_group
                and lower(o.title) = lower(v_a.title)) then
    raise exception 'CONFLICT: DUPLICATE_ACTIVE (an identical alert is already active for this site)';
  end if;
  update public.emergency_alerts
     set status = 'active', activated_at = now(), activated_by = auth.uid()
   where id = p_id returning * into v_a;
  perform public.mg_emergency_log(v_a, 'activated', null);
  v_queued := public.mg_emergency_enqueue_push(p_id, 'activated');
  return jsonb_build_object('id', v_a.id, 'status', v_a.status, 'revision', v_a.revision, 'push_queued', v_queued);
end;
$mg$;

-- RPC: update (draft or active) --------------------------------------------------------------------------
create or replace function public.mg_emergency_update(
  p_id uuid, p_expected_revision integer, p_confirm text, p_note text,
  p_title text default null, p_severity text default null, p_instructions text default null,
  p_assembly_point text default null, p_zone_label text default null, p_procedure_ref text default null,
  p_target_group text default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_a public.emergency_alerts; v_queued integer := 0;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  select * into v_a from public.emergency_alerts where id = p_id for update;
  if not found or not public.mg_can_manage_emergency(v_a.site_id) then
    raise exception 'FORBIDDEN: you are not authorized to update this alert';
  end if;
  if v_a.status in ('cancelled','resolved') then raise exception 'CONFLICT: ALERT_CLOSED'; end if;
  if v_a.revision is distinct from p_expected_revision then
    raise exception 'CONFLICT: STALE_REVISION (current %)', v_a.revision;
  end if;
  if v_a.status = 'active' then
    if p_confirm is distinct from 'UPDATE' then
      raise exception 'CONFIRMATION_REQUIRED: type UPDATE to confirm';
    end if;
    if nullif(btrim(p_note),'') is null then
      raise exception 'NOTE_REQUIRED: say what changed so workers can see it';
    end if;
    if p_target_group is not null and p_target_group <> v_a.target_group then
      raise exception 'INVALID: the audience of an active alert cannot change; cancel and create a new one';
    end if;
  end if;
  update public.emergency_alerts set
      title          = coalesce(btrim(p_title), title),
      severity       = coalesce(p_severity, severity),
      instructions   = coalesce(btrim(p_instructions), instructions),
      assembly_point = case when p_assembly_point is null then assembly_point else nullif(btrim(p_assembly_point),'') end,
      zone_label     = case when p_zone_label is null then zone_label else nullif(btrim(p_zone_label),'') end,
      procedure_ref  = case when p_procedure_ref is null then procedure_ref else nullif(btrim(p_procedure_ref),'') end,
      target_group   = coalesce(p_target_group, target_group),
      revision       = revision + 1
   where id = p_id returning * into v_a;
  perform public.mg_emergency_log(v_a, 'updated', nullif(btrim(p_note),''));
  if v_a.status = 'active' then v_queued := public.mg_emergency_enqueue_push(p_id, 'updated'); end if;
  return jsonb_build_object('id', v_a.id, 'status', v_a.status, 'revision', v_a.revision, 'push_queued', v_queued);
end;
$mg$;

-- RPC: cancel / resolve ---------------------------------------------------------------------------------------
create or replace function public.mg_emergency_close(
  p_id uuid, p_outcome text, p_reason text, p_confirm text, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_a public.emergency_alerts; v_queued integer := 0; v_was text; v_word text;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  if p_outcome not in ('cancelled','resolved') then raise exception 'INVALID: outcome'; end if;
  select * into v_a from public.emergency_alerts where id = p_id for update;
  if not found or not public.mg_can_manage_emergency(v_a.site_id) then
    raise exception 'FORBIDDEN: you are not authorized to close this alert';
  end if;
  v_word := upper(case when p_outcome = 'cancelled' then 'cancel' else 'resolve' end);
  if p_confirm is distinct from v_word then
    raise exception 'CONFIRMATION_REQUIRED: type % to confirm', v_word;
  end if;
  if v_a.status in ('cancelled','resolved') then raise exception 'CONFLICT: ALREADY_CLOSED'; end if;
  if p_outcome = 'resolved' and v_a.status <> 'active' then
    raise exception 'INVALID: only an active alert can be resolved';
  end if;
  if v_a.revision is distinct from p_expected_revision then
    raise exception 'CONFLICT: STALE_REVISION (current %)', v_a.revision;
  end if;
  if nullif(btrim(p_reason),'') is null then raise exception 'NOTE_REQUIRED: a reason is required'; end if;
  v_was := v_a.status;
  update public.emergency_alerts
     set status = p_outcome, closed_at = now(), closed_by = auth.uid(), close_reason = btrim(p_reason)
   where id = p_id returning * into v_a;
  perform public.mg_emergency_log(v_a, p_outcome, btrim(p_reason));
  if v_was = 'active' then v_queued := public.mg_emergency_enqueue_push(p_id, p_outcome); end if;
  return jsonb_build_object('id', v_a.id, 'status', v_a.status, 'revision', v_a.revision, 'push_queued', v_queued);
end;
$mg$;

-- RPC: worker acknowledgment (actor is ALWAYS the session user) -------------------------------------------
create or replace function public.mg_emergency_ack(
  p_alert_id uuid, p_revision integer, p_client_ref text default null, p_seen_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_a public.emergency_alerts; v_row public.emergency_alert_acks;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  select * into v_a from public.emergency_alerts where id = p_alert_id;
  if not found or v_a.status = 'draft' or not public.mg_emergency_in_audience(p_alert_id, auth.uid()) then
    raise exception 'FORBIDDEN: this alert is not addressed to you';
  end if;
  if p_revision is null or p_revision < 1 or p_revision > v_a.revision then
    raise exception 'INVALID: revision';
  end if;
  insert into public.emergency_alert_acks
    (alert_id, user_id, revision, client_seen_at, client_ref, alert_status_at_ack)
  values (p_alert_id, auth.uid(), p_revision,
          case when p_seen_at is not null and p_seen_at <= now() + interval '5 minutes' then p_seen_at end,
          left(p_client_ref, 80), v_a.status)
  on conflict (alert_id, user_id, revision) do nothing;
  select * into v_row from public.emergency_alert_acks
   where alert_id = p_alert_id and user_id = auth.uid() and revision = p_revision;
  return jsonb_build_object('acked_at', v_row.acked_at, 'revision', v_row.revision,
                            'current_revision', v_a.revision, 'alert_status', v_a.status,
                            'acknowledged_after_close', v_row.alert_status_at_ack <> 'active');
end;
$mg$;

create or replace function public.mg_emergency_mark_displayed(p_alert_id uuid, p_revision integer)
returns void language plpgsql security definer set search_path = public as $mg$
declare v_a public.emergency_alerts;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  select * into v_a from public.emergency_alerts where id = p_alert_id;
  if not found or v_a.status = 'draft' or not public.mg_emergency_in_audience(p_alert_id, auth.uid())
     or p_revision is null or p_revision < 1 or p_revision > v_a.revision then
    raise exception 'FORBIDDEN: this alert is not addressed to you';
  end if;
  insert into public.emergency_alert_views (alert_id, user_id, revision, reported_at)
  values (p_alert_id, auth.uid(), p_revision, now())
  on conflict (alert_id, user_id, revision) do nothing;
end;
$mg$;

-- RPC: what should MY device show (active + recently closed so an offline device learns of cancellation) --
create or replace function public.mg_my_emergency_alerts()
returns jsonb language sql stable security definer set search_path = public as $mg$
  select jsonb_build_object(
    'api_version', 1,
    'server_time', now(),
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', a.id, 'site_id', a.site_id, 'site_name', s.name, 'site_code', s.code,
          'zone_label', a.zone_label, 'title', a.title, 'severity', a.severity,
          'instructions', a.instructions, 'assembly_point', a.assembly_point,
          'procedure_ref', a.procedure_ref, 'status', a.status, 'revision', a.revision,
          'activated_at', a.activated_at, 'closed_at', a.closed_at, 'close_reason', a.close_reason,
          'initiated_by', (select coalesce(p.name, 'Authorized site personnel') from public.profiles p where p.id = coalesce(a.activated_by, a.created_by)),
          'source_org', (select o.name from public.organizations o where o.id = s.organization_id),
          'my_ack_revision', (select max(k.revision) from public.emergency_alert_acks k where k.alert_id = a.id and k.user_id = auth.uid()),
          'updates', coalesce((select jsonb_agg(jsonb_build_object('type', r.change_type, 'revision', r.revision, 'at', r.changed_at, 'note', r.note) order by r.seq)
                                 from public.emergency_alert_revisions r
                                where r.alert_id = a.id and r.change_type in ('updated','cancelled','resolved')), '[]'::jsonb)
        ) order by a.activated_at desc)
        from public.emergency_alerts a
        join public.sites s on s.id = a.site_id
       where auth.uid() is not null
         and a.status <> 'draft'
         and (a.status = 'active' or a.closed_at > now() - interval '24 hours')
         and public.mg_emergency_in_audience(a.id, auth.uid())
    ), '[]'::jsonb))
$mg$;

-- RPC: manager/reader detail with delivery + acknowledgment status and explicit limits -------------------------
create or replace function public.mg_emergency_dashboard(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $mg$
declare v_a public.emergency_alerts; v_people jsonb; v_counts jsonb; v_hist jsonb;
begin
  if auth.uid() is null or not public.mg_can_view_emergency(p_id) then
    raise exception 'FORBIDDEN: not authorized to view this alert';
  end if;
  select * into v_a from public.emergency_alerts where id = p_id;
  if not (public.mg_can_manage_emergency(v_a.site_id) or public.mg_has_permission('emergency.read')) then
    raise exception 'FORBIDDEN: delivery status is for authorized managers';
  end if;

  with aud as (
    select au.user_id, au.org_role from public.mg_emergency_audience(p_id) au
  ), everyone as (
    select user_id, org_role, true as in_audience from aud
    union all
    select k.user_id, null, false from public.emergency_alert_acks k
     where k.alert_id = p_id and k.user_id not in (select user_id from aud)
     group by k.user_id
  ), per as (
    select e.user_id, e.org_role, e.in_audience,
           (select p.name from public.profiles p where p.id = e.user_id) as name,
           (select max(k.revision) from public.emergency_alert_acks k where k.alert_id = p_id and k.user_id = e.user_id) as ack_rev,
           (select max(k.acked_at) from public.emergency_alert_acks k where k.alert_id = p_id and k.user_id = e.user_id) as ack_at,
           (select max(w.revision) from public.emergency_alert_views w where w.alert_id = p_id and w.user_id = e.user_id) as viewed_rev,
           exists (select 1 from public.push_subscriptions ps where ps.user_id = e.user_id and ps.expired_at is null and ps.revoked_at is null) as has_push,
           coalesce((select jsonb_agg(distinct d.state) from public.emergency_alert_deliveries d
                      where d.alert_id = p_id and d.user_id = e.user_id and d.revision = v_a.revision), '[]'::jsonb) as push_states
      from everyone e
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', user_id, 'name', coalesce(name, 'Unnamed user'), 'org_role', org_role,
           'in_audience', in_audience, 'ack_revision', ack_rev, 'ack_at', ack_at,
           'displayed_revision_reported', viewed_rev, 'has_push_subscription', has_push,
           'push_states', push_states) order by name), '[]'::jsonb),
         jsonb_build_object(
           'audience', count(*) filter (where in_audience),
           'acknowledged_current', count(*) filter (where in_audience and ack_rev = v_a.revision),
           'acknowledged_earlier_revision', count(*) filter (where in_audience and ack_rev < v_a.revision),
           'displayed_reported_current', count(*) filter (where in_audience and viewed_rev = v_a.revision),
           'no_push_subscription', count(*) filter (where in_audience and not has_push),
           'push_service_accepted', count(*) filter (where in_audience and push_states ? 'service_accepted'),
           'push_queued', count(*) filter (where in_audience and (push_states ? 'queued' or push_states ? 'sending')),
           'push_failed_or_expired', count(*) filter (where in_audience and (push_states ? 'service_rejected' or push_states ? 'subscription_expired')),
           'push_not_configured', count(*) filter (where in_audience and push_states ? 'not_configured'))
    into v_people, v_counts
    from per;

  select coalesce(jsonb_agg(jsonb_build_object(
           'type', r.change_type, 'revision', r.revision, 'at', r.changed_at, 'note', r.note,
           'title', r.title, 'severity', r.severity, 'instructions', r.instructions,
           'by', (select p.name from public.profiles p where p.id = r.changed_by)) order by r.seq), '[]'::jsonb)
    into v_hist from public.emergency_alert_revisions r where r.alert_id = p_id;

  return jsonb_build_object(
    'alert', to_jsonb(v_a) - 'idempotency_key',
    'site_name', (select s.name from public.sites s where s.id = v_a.site_id),
    'can_manage', public.mg_can_manage_emergency(v_a.site_id),
    'counts', v_counts, 'people', v_people, 'history', v_hist,
    'limits', jsonb_build_array(
      'Push "service accepted" means the browser vendor''s push service took the message. It does not mean the device received it or that anyone saw it.',
      '"Displayed" is reported by the MineGuard app on the worker''s device and cannot be independently verified.',
      'No acknowledgment does not mean a worker is safe, unaware, or has not evacuated. Confirm by radio, roll call and the site''s own procedure.',
      'Workers without a push subscription, without a connection, or with notifications blocked cannot be reached by this channel.',
      'The audience is computed from current site membership; people added or removed after activation change this list.'));
end;
$mg$;

-- RPC: push subscription registration (secrets never come back out) -----------------------------------------------
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

create or replace function public.mg_unregister_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = public as $mg$
  update public.push_subscriptions set revoked_at = now()
   where endpoint = p_endpoint and user_id = auth.uid() and revoked_at is null
$mg$;

create or replace function public.mg_my_push_status()
returns jsonb language sql stable security definer set search_path = public as $mg$
  select jsonb_build_object('active_subscriptions',
    (select count(*) from public.push_subscriptions ps
      where ps.user_id = auth.uid() and ps.expired_at is null and ps.revoked_at is null))
$mg$;

-- dispatcher surface (service_role ONLY) -----------------------------------------------------------------------------
create or replace function public.mg_emergency_dispatch_allowed(p_alert uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null
     and exists (select 1 from public.emergency_alerts a
                  where a.id = p_alert and public.mg_can_manage_emergency(a.site_id))
$mg$;

create or replace function public.mg_emergency_claim_push(p_alert uuid, p_limit integer default 100)
returns table (delivery_id uuid, alert_id uuid, event text, revision integer, title text, severity text,
               endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = public as $mg$
begin
  -- Never push an alert hours late as if it were current: stale rows are closed out honestly.
  update public.emergency_alert_deliveries as x
     set state = 'service_rejected', detail = 'not sent: older than 6 hours', updated_at = now()
   where x.alert_id = p_alert and x.state in ('queued','sending') and x.created_at < now() - interval '6 hours';
  return query
  with c as (
    select d.id from public.emergency_alert_deliveries d
     where d.alert_id = p_alert
       and (d.state = 'queued' or (d.state = 'sending' and d.updated_at < now() - interval '2 minutes'))
       and d.attempts < 5
     order by d.created_at limit greatest(1, least(p_limit, 500))
       for update skip locked
  ), u as (
    update public.emergency_alert_deliveries d
       set state = 'sending', attempts = d.attempts + 1, updated_at = now()
      from c where d.id = c.id
    returning d.*
  )
  select u.id, u.alert_id, u.event, u.revision, a.title, a.severity, ps.endpoint, ps.p256dh, ps.auth
    from u
    join public.emergency_alerts a on a.id = u.alert_id
    join public.push_subscriptions ps on ps.id = u.subscription_id
   where ps.expired_at is null and ps.revoked_at is null;
end;
$mg$;

-- scheduled sweep (service_role only): alerts that still have undelivered push rows
create or replace function public.mg_emergency_pending_alerts(p_limit integer default 50)
returns table (alert_id uuid)
language sql stable security definer set search_path = public as $mg$
  select distinct d.alert_id
    from public.emergency_alert_deliveries d
   where d.attempts < 5
     and d.created_at > now() - interval '6 hours'
     and (d.state = 'queued' or (d.state = 'sending' and d.updated_at < now() - interval '2 minutes'))
   limit greatest(1, least(p_limit, 200))
$mg$;

create or replace function public.mg_emergency_record_push(p_delivery uuid, p_outcome text, p_detail text default null)
returns void language plpgsql security definer set search_path = public as $mg$
declare v_d public.emergency_alert_deliveries;
begin
  select * into v_d from public.emergency_alert_deliveries where id = p_delivery for update;
  if not found then return; end if;
  update public.emergency_alert_deliveries set
      state = case p_outcome
                when 'accepted'       then 'service_accepted'
                when 'rejected'       then 'service_rejected'
                when 'expired'        then 'subscription_expired'
                when 'not_configured' then 'not_configured'
                when 'retry'          then case when v_d.attempts >= 5 then 'service_rejected' else 'queued' end
                else 'service_rejected' end,
      detail = left(p_detail, 200), updated_at = now()
   where id = p_delivery;
  if p_outcome = 'expired' then
    update public.push_subscriptions set expired_at = now() where id = v_d.subscription_id;
  end if;
end;
$mg$;

-- execute surface ------------------------------------------------------------------------------------------------------
revoke all on function public.mg_can_manage_emergency(uuid), public.mg_emergency_in_audience(uuid, uuid),
  public.mg_emergency_audience(uuid), public.mg_can_view_emergency(uuid),
  public.mg_emergency_log(public.emergency_alerts, text, text) from public, anon, authenticated;
grant execute on function public.mg_can_manage_emergency(uuid), public.mg_can_view_emergency(uuid) to authenticated;

revoke all on function
  public.mg_emergency_create(uuid, text, text, text, text, text, text, text, text),
  public.mg_emergency_activate(uuid, text, integer),
  public.mg_emergency_update(uuid, integer, text, text, text, text, text, text, text, text, text),
  public.mg_emergency_close(uuid, text, text, text, integer),
  public.mg_emergency_ack(uuid, integer, text, timestamptz),
  public.mg_emergency_mark_displayed(uuid, integer),
  public.mg_my_emergency_alerts(), public.mg_emergency_dashboard(uuid),
  public.mg_register_push_subscription(text, text, text, text),
  public.mg_unregister_push_subscription(text), public.mg_my_push_status(),
  public.mg_emergency_dispatch_allowed(uuid)
  from public, anon;
grant execute on function
  public.mg_emergency_create(uuid, text, text, text, text, text, text, text, text),
  public.mg_emergency_activate(uuid, text, integer),
  public.mg_emergency_update(uuid, integer, text, text, text, text, text, text, text, text, text),
  public.mg_emergency_close(uuid, text, text, text, integer),
  public.mg_emergency_ack(uuid, integer, text, timestamptz),
  public.mg_emergency_mark_displayed(uuid, integer),
  public.mg_my_emergency_alerts(), public.mg_emergency_dashboard(uuid),
  public.mg_register_push_subscription(text, text, text, text),
  public.mg_unregister_push_subscription(text), public.mg_my_push_status(),
  public.mg_emergency_dispatch_allowed(uuid)
  to authenticated;

revoke all on function public.mg_emergency_claim_push(uuid, integer),
  public.mg_emergency_record_push(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mg_emergency_claim_push(uuid, integer),
  public.mg_emergency_record_push(uuid, text, text) to service_role;
revoke all on function public.mg_emergency_pending_alerts(integer) from public, anon, authenticated;
grant execute on function public.mg_emergency_pending_alerts(integer) to service_role;

-- Realtime (a convenience channel only; the app also polls) -----------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'emergency_alerts') then
    alter publication supabase_realtime add table public.emergency_alerts;
  end if;
end $$;

commit;
