-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0046: Worker Voice (named, confidential, anonymous reporting)
--                                      Implementation Phase 4
--
-- WHY A NEW (NARROW) STORE AND NOT public.incidents.
--   incidents.reported_by_id is NOT NULL and the "incidents read" policy shows every row to
--   everyone who can see the site, Ministry staff included. An anonymous or confidential report
--   put there would either need a fake reporter or would expose the real one. So Worker Voice
--   is an INTAKE + TRIAGE store, and a reviewer promotes a report into the existing incident
--   workflow (mg_wv_create_incident) with a description THEY write. Investigation, corrective
--   actions and closure of incidents stay in the existing system. This is not a second
--   incident-management system.
--
-- ANONYMITY IS A DATA-ARCHITECTURE PROPERTY, NOT A HIDDEN FIELD.
--   * worker_voice_reports (the content) has NO identity column of any kind: no user id, no
--     email, no employee number, no membership id, no updated_by. Nothing to join on.
--   * worker_voice_identity (named + confidential only) is a SEPARATE closed table. An
--     anonymous report has no row there at all.
--   * Anonymous submission is an RPC that never reads auth.uid(); the app calls it from a client
--     that carries no session. Even if a session token is attached by mistake, nothing is read.
--   * The generic audit trigger is NOT attached to these tables (it records the actor). Reviewer
--     actions go to worker_voice_events, whose 'submitted' event never records who submitted.
--   * Received time is rounded down to the hour for confidential/anonymous reports, so a
--     report cannot be matched to a person's session by its exact timestamp.
--   * Rate limiting keys on a salted SHA-256 of the connecting address (like 0005); the raw
--     address is never stored and the bucket is never linked to a report.
--   * No attachments in this phase (see docs/15_WORKER_VOICE.MD for why).
--   Limits that remain (infrastructure logs, connection metadata, small sites, writing style)
--   are listed honestly in docs/15_WORKER_VOICE.MD and in the app.
--
-- FOLLOW-UP. The reporter holds a 96-bit random code generated on their device. The server
-- stores only SHA-256('wv1:' || code). The public status RPC shows a coarse stage and a
-- reviewer-written update; never notes, assignees, severity, category or identity.
--
-- ACCESS. Reviewers = company administrator (all of the company) and site manager / safety
-- officer assigned to the site (route 'site' only). A report marked as concerning the usual
-- reviewers is routed to company administrators only. The Ministry has NO access: no regulator
-- channel is implied. A reporter cannot review their own report.
--
-- Idempotent. Not applied to production by anyone but the owner.
-- ROLLBACK: docs/15_WORKER_VOICE.MD (drop the four worker_voice_* tables and the mg_wv_*
-- functions; restore notifications_kind_check from 0037).
-- ===========================================================================

begin;

-- notifications may carry the generic worker_voice kind --------------------------------------------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('ca_deadline','ca_decision','report_status',
                  'org_invitation','org_request','org_decision','org_role','org_status',
                  'org_site_request','worker_voice'));

-- tables ---------------------------------------------------------------------------------------------
create table if not exists public.worker_voice_site_codes (
  site_id    uuid primary key references public.sites(id),
  code       text not null unique check (code ~ '^[0-9A-F]{10}$'),
  rotated_at timestamptz not null default now()
);

create table if not exists public.worker_voice_reports (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id),
  site_id            uuid not null references public.sites(id),
  mode               text not null check (mode in ('named','confidential','anonymous')),
  category           text not null check (category in ('unsafe_condition','near_miss','equipment_hazard','unsafe_procedure','repeated_concern','unresolved_action','other')),
  urgency            text not null check (urgency in ('low','medium','high','critical')),
  description        text not null check (char_length(description) between 10 and 4000),
  occurred_at        timestamptz,
  previously_reported text not null check (previously_reported in ('no','yes','unsure')),
  route              text not null default 'site' check (route in ('site','company_admin')),
  status             text not null default 'received'
                     check (status in ('received','triage','investigating','action_assigned','follow_up','closed')),
  triage_severity    text check (triage_severity in ('low','medium','high','critical')),
  assigned_to        uuid references public.profiles(id) on delete set null,
  escalated_at       timestamptz,
  linked_incident_id uuid references public.incidents(id),
  duplicate_of       uuid references public.worker_voice_reports(id),
  fingerprint        text not null,
  closure_reason     text check (closure_reason is null or char_length(closure_reason) <= 1000),
  reporter_update    text check (reporter_update is null or char_length(reporter_update) <= 500),
  reporter_update_at timestamptz,
  code_hash          text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz,
  row_version        integer not null default 1
);
create index if not exists wv_reports_org_status_idx on public.worker_voice_reports (organization_id, status, created_at desc);
create index if not exists wv_reports_fp_idx on public.worker_voice_reports (site_id, fingerprint, created_at desc);

-- identity: SEPARATE, closed; absent entirely for anonymous reports. Deleting the account removes it.
create table if not exists public.worker_voice_identity (
  report_id   uuid primary key references public.worker_voice_reports(id),
  reporter_id uuid not null references public.profiles(id) on delete cascade
);
create index if not exists wv_identity_reporter_idx on public.worker_voice_identity (reporter_id);

-- reviewer-side history. actor_id is NULL for 'submitted'; it is a plain uuid (no FK).
create table if not exists public.worker_voice_events (
  id        uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.worker_voice_reports(id),
  event     text not null check (event in ('submitted','triaged','assigned','status_changed','update_posted','escalated','incident_created','identity_viewed','identity_revealed')),
  actor_id  uuid,
  detail    text check (detail is null or char_length(detail) <= 400),
  at        timestamptz not null default now()
);
create index if not exists wv_events_report_idx on public.worker_voice_events (report_id, at);

alter table public.worker_voice_site_codes enable row level security;
alter table public.worker_voice_reports    enable row level security;
alter table public.worker_voice_identity   enable row level security;
alter table public.worker_voice_events     enable row level security;
revoke all on public.worker_voice_site_codes, public.worker_voice_reports,
              public.worker_voice_identity, public.worker_voice_events from anon, authenticated;

-- helpers --------------------------------------------------------------------------------------------
create or replace function public.mg_wv_hash(p_code text)
returns text language sql immutable as $mg$
  select encode(sha256(convert_to('wv1:' || coalesce(p_code, ''), 'UTF8')), 'hex')
$mg$;

-- Rate limiting that never keeps an address: bucket = prefix + salted digest. Returns true while
-- under the limit. Does NOT raise (a raise would roll back the increment and defeat the limit).
create or replace function public.mg_wv_rate(p_bucket text, p_limit integer, p_window interval)
returns boolean language plpgsql security definer set search_path = public as $mg$
declare v_count integer;
begin
  insert into public.rate_limits (bucket, count, window_start) values (p_bucket, 1, now())
  on conflict (bucket) do update
    set count = case when public.rate_limits.window_start < now() - p_window then 1 else public.rate_limits.count + 1 end,
        window_start = case when public.rate_limits.window_start < now() - p_window then now() else public.rate_limits.window_start end
  returning count into v_count;
  return v_count <= p_limit;
end;
$mg$;

create or replace function public.mg_wv_src(p_prefix text)
returns text language sql stable set search_path = public as $mg$
  select p_prefix || ':' || case when coalesce(public.mg_client_ip(), '') = '' then 'unknown'
    else encode(sha256(convert_to('mgliberia-wv-v1:' || public.mg_client_ip(), 'UTF8')), 'hex') end
$mg$;

-- who may review ---------------------------------------------------------------------------------
create or replace function public.mg_wv_user_can_review(p_user uuid, p_org uuid, p_site uuid, p_route text)
returns boolean language sql stable security definer set search_path = public as $mg$
  select p_user is not null and exists (
    select 1 from public.organization_members m
      join public.organizations o on o.id = m.organization_id
     where m.user_id = p_user and m.organization_id = p_org and m.status = 'active' and o.status = 'approved'
       and (m.org_role = 'company_admin'
            or (p_route = 'site' and m.org_role in ('site_manager','safety_officer')
                and exists (select 1 from public.site_assignments sa
                             where sa.user_id = m.user_id and sa.site_id = p_site and sa.revoked_at is null))))
$mg$;

create or replace function public.mg_wv_can_review(p_org uuid, p_site uuid, p_route text)
returns boolean language sql stable security definer set search_path = public as $mg$
  select public.mg_wv_user_can_review(auth.uid(), p_org, p_site, p_route)
$mg$;

drop policy if exists "wv reports read" on public.worker_voice_reports;
create policy "wv reports read" on public.worker_voice_reports for select to authenticated
  using (public.mg_wv_can_review(organization_id, site_id, route));
grant select on public.worker_voice_reports to authenticated;

drop policy if exists "wv events read" on public.worker_voice_events;
create policy "wv events read" on public.worker_voice_events for select to authenticated
  using (exists (select 1 from public.worker_voice_reports r
                  where r.id = report_id and public.mg_wv_can_review(r.organization_id, r.site_id, r.route)));
grant select on public.worker_voice_events to authenticated;
-- worker_voice_identity and worker_voice_site_codes have NO policy and NO grant: reachable only through RPCs.

-- When an account is deleted/anonymized (0035 sets profiles.deleted_at) the link between that person and any
-- report they sent is erased. The reports stay, de-identified. (The generic deletion routine treats cascade
-- links as not-owned-records, so without this the link would survive an anonymized profile.)
create or replace function public.mg_wv_forget_reporter()
returns trigger language plpgsql security definer set search_path = public as $mg$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from public.worker_voice_identity where reporter_id = new.id;
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_wv_forget_reporter() from public, anon, authenticated;
drop trigger if exists wv_forget_reporter on public.profiles;
create trigger wv_forget_reporter after update of deleted_at on public.profiles
  for each row execute function public.mg_wv_forget_reporter();

-- the report's lifecycle guard ---------------------------------------------------------------------
create or replace function public.mg_wv_report_guard()
returns trigger language plpgsql as $mg$
declare
  v_order text[] := array['received','triage','investigating','action_assigned','follow_up','closed'];
begin
  if tg_op = 'DELETE' then raise exception 'IMMUTABLE: reports are never deleted'; end if;
  if old.status = 'closed' then raise exception 'IMMUTABLE: a closed report cannot be changed'; end if;
  if new.organization_id is distinct from old.organization_id or new.site_id is distinct from old.site_id
     or new.mode is distinct from old.mode or new.category is distinct from old.category
     or new.urgency is distinct from old.urgency or new.description is distinct from old.description
     or new.occurred_at is distinct from old.occurred_at or new.previously_reported is distinct from old.previously_reported
     or new.code_hash is distinct from old.code_hash or new.fingerprint is distinct from old.fingerprint
     or new.created_at is distinct from old.created_at then
    raise exception 'IMMUTABLE: a submitted report''s content cannot be edited';
  end if;
  if array_position(v_order, new.status) < array_position(v_order, old.status) then
    raise exception 'CONFLICT: a report cannot move backwards (% -> %)', old.status, new.status;
  end if;
  if new.status = 'closed' and coalesce(char_length(btrim(new.closure_reason)), 0) < 10 then
    raise exception 'CLOSURE_REASON_REQUIRED: say why the report is being closed';
  end if;
  if old.route = 'company_admin' and new.route = 'site' then
    raise exception 'CONFLICT: an escalated report cannot be routed back down';
  end if;
  new.updated_at := now();
  new.row_version := old.row_version + 1;
  return new;
end;
$mg$;
revoke all on function public.mg_wv_report_guard() from public, anon, authenticated;
drop trigger if exists wv_reports_guard on public.worker_voice_reports;
create trigger wv_reports_guard before update or delete on public.worker_voice_reports
  for each row execute function public.mg_wv_report_guard();

-- generic notification for reviewers: no reporter, no content, no mode, no category -----------------
create or replace function public.mg_wv_notify(p_report uuid, p_org uuid, p_site uuid, p_route text, p_urgent boolean, p_skip uuid)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  -- the notifications guard (0034/0035) re-points client inserts at the caller; this definer function
  -- legitimately writes OTHER people's inboxes, so it raises the same transaction-local flag 0035 uses
  perform set_config('mg.notify', '1', true);
  insert into public.notifications (user_id, source_key, kind, severity, title, body, link_to, event_at)
  select distinct m.user_id, 'wv:' || p_report::text || ':' || to_char(now(), 'YYYYMMDDHH24MISSMS'),
         'worker_voice', case when p_urgent then 'urgent' else 'info' end,
         'A safety report requires review',
         'MineGuard: A safety report requires review. Sign in with your authorized account to access it.',
         '/operate/voice-review', now()
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
   where m.organization_id = p_org and m.status = 'active' and o.status = 'approved'
     and (p_skip is null or m.user_id <> p_skip)
     and public.mg_wv_user_can_review(m.user_id, p_org, p_site, p_route)
  on conflict (user_id, source_key) do nothing;
  perform set_config('mg.notify', '0', true);
end;
$mg$;
revoke all on function public.mg_wv_notify(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;

-- the one place a report is written ------------------------------------------------------------------
create or replace function public.mg_wv_insert(
  p_mode text, p_site uuid, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_concerns boolean, p_code text, p_reporter uuid)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare
  v_org uuid; v_route text; v_fp text; v_dup uuid; v_id uuid; v_desc text := btrim(coalesce(p_description, ''));
  v_created timestamptz;
begin
  if p_mode not in ('named','confidential','anonymous') then return jsonb_build_object('status','invalid','message','Unknown reporting mode.'); end if;
  if (p_mode = 'anonymous') <> (p_reporter is null) then return jsonb_build_object('status','invalid','message','Mode and identity do not match.'); end if;
  if p_category is null or p_category not in ('unsafe_condition','near_miss','equipment_hazard','unsafe_procedure','repeated_concern','unresolved_action','other') then
    return jsonb_build_object('status','invalid','message','Choose a category.'); end if;
  if p_urgency is null or p_urgency not in ('low','medium','high','critical') then return jsonb_build_object('status','invalid','message','Choose an urgency.'); end if;
  if p_previously is null or p_previously not in ('no','yes','unsure') then return jsonb_build_object('status','invalid','message','Say whether this was reported before.'); end if;
  if char_length(v_desc) < 10 or char_length(v_desc) > 4000 then return jsonb_build_object('status','invalid','message','Describe the concern in 10 to 4000 characters.'); end if;
  if p_occurred is not null and p_occurred > now() + interval '1 day' then return jsonb_build_object('status','invalid','message','The date cannot be in the future.'); end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' or (select count(distinct c) from regexp_split_to_table(p_code, '') c) < 8 then
    return jsonb_build_object('status','invalid','message','The follow-up code is not valid.'); end if;
  select s.organization_id into v_org from public.sites s where s.id = p_site;
  if v_org is null then return jsonb_build_object('status','invalid','message','Unknown site.'); end if;

  v_route := case when coalesce(p_concerns, false) then 'company_admin' else 'site' end;
  v_fp := encode(sha256(convert_to(lower(regexp_replace(v_desc, '\s+', ' ', 'g')) || '|' || p_category, 'UTF8')), 'hex');
  select r.id into v_dup from public.worker_voice_reports r
   where r.site_id = p_site and r.fingerprint = v_fp and r.created_at > now() - interval '14 days'
   order by r.created_at limit 1;
  -- confidential/anonymous reports carry no precise timestamp (cannot be matched to a session by time)
  v_created := case when p_mode = 'named' then now() else date_trunc('hour', now()) end;

  insert into public.worker_voice_reports (organization_id, site_id, mode, category, urgency, description, occurred_at,
                                           previously_reported, route, fingerprint, duplicate_of, code_hash, created_at)
  values (v_org, p_site, p_mode, p_category, p_urgency, v_desc, p_occurred, p_previously, v_route, v_fp, v_dup,
          public.mg_wv_hash(p_code), v_created)
  on conflict (code_hash) do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('status','duplicate'); end if;

  if p_reporter is not null then
    insert into public.worker_voice_identity (report_id, reporter_id) values (v_id, p_reporter);
  end if;
  insert into public.worker_voice_events (report_id, event, actor_id) values (v_id, 'submitted', null);
  perform public.mg_wv_notify(v_id, v_org, p_site, v_route, p_urgency in ('high','critical'), p_reporter);
  return jsonb_build_object('status','received', 'possibleDuplicate', v_dup is not null);
end;
$mg$;
revoke all on function public.mg_wv_insert(text, uuid, text, text, text, timestamptz, text, boolean, text, uuid) from public, anon, authenticated;

-- submit: named / confidential (signed in) ---------------------------------------------------------------
create or replace function public.mg_wv_submit(
  p_mode text, p_site uuid, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_concerns boolean, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in to send a named or confidential report'; end if;
  if p_mode not in ('named','confidential') then raise exception 'INVALID: use the anonymous route for anonymous reports'; end if;
  if not public.mg_can_prepare_jsa(p_site) then raise exception 'FORBIDDEN: you are not a member allowed at this site'; end if;
  if not public.mg_wv_rate('wv:u:' || encode(sha256(convert_to('wv-user:' || auth.uid()::text, 'UTF8')), 'hex'), 10, interval '1 hour') then
    return jsonb_build_object('status','rate_limited');
  end if;
  return public.mg_wv_insert(p_mode, p_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_concerns, p_code, auth.uid());
end;
$mg$;

-- submit: anonymous. NEVER reads auth.uid(). Anticipated failures are RETURNED, not raised, so the
-- rate-limit counters they increment are kept. -----------------------------------------------------------
create or replace function public.mg_wv_submit_anonymous(
  p_site_code text, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_concerns boolean, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_site uuid; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  delete from public.rate_limits where bucket like 'wv:%' and window_start < now() - interval '1 day';
  if not public.mg_wv_rate(public.mg_wv_src('wv:a'), case when v_known then 10 else 200 end, interval '1 hour') then
    return jsonb_build_object('status','rate_limited');
  end if;
  select c.site_id into v_site from public.worker_voice_site_codes c
   where c.code = upper(regexp_replace(coalesce(p_site_code, ''), '[^0-9A-Za-z]', '', 'g'));
  if v_site is null then
    -- wrong guesses are limited per source so a site code cannot be brute-forced
    if not public.mg_wv_rate(public.mg_wv_src('wv:f'), case when v_known then 10 else 100 end, interval '1 hour') then
      return jsonb_build_object('status','rate_limited');
    end if;
    return jsonb_build_object('status','invalid_site_code');
  end if;
  if not public.mg_wv_rate('wv:s:' || v_site::text, 60, interval '1 hour') then
    return jsonb_build_object('status','rate_limited');
  end if;
  return public.mg_wv_insert('anonymous', v_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_concerns, p_code, null);
end;
$mg$;

-- public status: coarse stage + reviewer-written update only ----------------------------------------
create or replace function public.mg_wv_status(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  if not public.mg_wv_rate(public.mg_wv_src('wv:l'), case when v_known then 60 else 600 end, interval '1 hour') then
    return jsonb_build_object('found', false, 'status', 'rate_limited');
  end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' then
    return jsonb_build_object('found', false);
  end if;
  select * into r from public.worker_voice_reports where code_hash = public.mg_wv_hash(p_code);
  if not found then
    if not public.mg_wv_rate(public.mg_wv_src('wv:lf'), case when v_known then 10 else 100 end, interval '1 hour') then
      return jsonb_build_object('found', false, 'status', 'rate_limited');
    end if;
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'stage', case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed'
                           when 'investigating' then 'Under investigation' when 'action_assigned' then 'Action in progress'
                           when 'follow_up' then 'Action in progress' else 'Closed' end,
    'closed', r.status = 'closed',
    'lastChange', (coalesce(r.updated_at, r.created_at))::date,
    'update', r.reporter_update,
    'updateOn', r.reporter_update_at::date);
end;
$mg$;

-- reporter: own named/confidential reports and how often the identity was opened -------------------------
create or replace function public.mg_wv_my_reports()
returns table (id uuid, received_on date, mode text, category text, stage text, reporter_update text, reporter_update_on date, identity_opened integer)
language sql stable security definer set search_path = public as $mg$
  select r.id, r.created_at::date, r.mode, r.category,
         case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed'
                       when 'investigating' then 'Under investigation' when 'action_assigned' then 'Action in progress'
                       when 'follow_up' then 'Action in progress' else 'Closed' end,
         r.reporter_update, r.reporter_update_at::date,
         (select count(*)::int from public.worker_voice_events e where e.report_id = r.id and e.event = 'identity_revealed')
    from public.worker_voice_identity i join public.worker_voice_reports r on r.id = i.report_id
   where i.reporter_id = auth.uid()
   order by r.created_at desc limit 50
$mg$;

-- site code: members read it (to send anonymously without typing); reviewers rotate it ---------------------
create or replace function public.mg_wv_site_code(p_site uuid)
returns text language plpgsql security definer set search_path = public as $mg$
declare v_org uuid; v_code text;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select organization_id into v_org from public.sites where id = p_site;
  if v_org is null or not (public.mg_can_prepare_jsa(p_site) or public.mg_wv_can_review(v_org, p_site, 'site')) then
    raise exception 'FORBIDDEN: you cannot see this site''s code';
  end if;
  select code into v_code from public.worker_voice_site_codes where site_id = p_site;
  if v_code is null then
    insert into public.worker_voice_site_codes (site_id, code)
    values (p_site, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)))
    on conflict (site_id) do nothing;
    select code into v_code from public.worker_voice_site_codes where site_id = p_site;
  end if;
  return v_code;
end;
$mg$;

create or replace function public.mg_wv_rotate_code(p_site uuid)
returns text language plpgsql security definer set search_path = public as $mg$
declare v_org uuid; v_code text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
begin
  select organization_id into v_org from public.sites where id = p_site;
  if v_org is null or not public.mg_wv_can_review(v_org, p_site, 'site') then
    raise exception 'FORBIDDEN: only the company administrator or the site''s manager or safety officer can change the code';
  end if;
  insert into public.worker_voice_site_codes (site_id, code) values (p_site, v_code)
  on conflict (site_id) do update set code = excluded.code, rotated_at = now();
  return v_code;
end;
$mg$;

-- reviewer actions ----------------------------------------------------------------------------------------
create or replace function public.mg_wv_load(p_id uuid)
returns public.worker_voice_reports language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  select * into r from public.worker_voice_reports where id = p_id for update;
  if not found or not public.mg_wv_can_review(r.organization_id, r.site_id, r.route) then
    raise exception 'FORBIDDEN: you are not authorized to review this report';
  end if;
  if exists (select 1 from public.worker_voice_identity i where i.report_id = r.id and i.reporter_id = auth.uid()) then
    raise exception 'FORBIDDEN: you cannot review a report you sent';
  end if;
  return r;
end;
$mg$;
revoke all on function public.mg_wv_load(uuid) from public, anon, authenticated;

create or replace function public.mg_wv_triage(p_id uuid, p_severity text, p_assignee uuid default null)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  r := public.mg_wv_load(p_id);
  if p_severity not in ('low','medium','high','critical') then raise exception 'INVALID: choose a severity'; end if;
  if p_assignee is not null and not public.mg_wv_user_can_review(p_assignee, r.organization_id, r.site_id, r.route) then
    raise exception 'INVALID: that person is not an authorized reviewer for this report';
  end if;
  if p_assignee is not null and exists (select 1 from public.worker_voice_identity i where i.report_id = r.id and i.reporter_id = p_assignee) then
    raise exception 'INVALID: the reporter cannot be assigned their own report';
  end if;
  update public.worker_voice_reports set triage_severity = p_severity, assigned_to = coalesce(p_assignee, assigned_to),
         status = case when status = 'received' then 'triage' else status end where id = p_id;
  insert into public.worker_voice_events (report_id, event, actor_id, detail) values (p_id, 'triaged', auth.uid(), 'severity ' || p_severity);
  if p_assignee is not null then
    insert into public.worker_voice_events (report_id, event, actor_id, detail) values (p_id, 'assigned', auth.uid(), null);
  end if;
end;
$mg$;

create or replace function public.mg_wv_set_status(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  r := public.mg_wv_load(p_id);
  if p_status not in ('triage','investigating','action_assigned','follow_up','closed') then raise exception 'INVALID: unknown status'; end if;
  update public.worker_voice_reports set status = p_status,
         closure_reason = case when p_status = 'closed' then btrim(p_note) else closure_reason end where id = p_id;
  insert into public.worker_voice_events (report_id, event, actor_id, detail)
  values (p_id, 'status_changed', auth.uid(), p_status || case when p_status = 'closed' then ': ' || left(btrim(coalesce(p_note,'')), 300) else '' end);
end;
$mg$;

create or replace function public.mg_wv_post_update(p_id uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  r := public.mg_wv_load(p_id);
  if coalesce(char_length(btrim(p_text)), 0) not between 1 and 500 then raise exception 'INVALID: write 1 to 500 characters for the reporter'; end if;
  update public.worker_voice_reports set reporter_update = btrim(p_text), reporter_update_at = now() where id = p_id;
  insert into public.worker_voice_events (report_id, event, actor_id) values (p_id, 'update_posted', auth.uid());
end;
$mg$;

create or replace function public.mg_wv_escalate(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  r := public.mg_wv_load(p_id);
  if r.route = 'company_admin' then
    raise exception 'ALREADY_ESCALATED: no higher route exists in MineGuard; use your company procedure or legal channels';
  end if;
  if coalesce(char_length(btrim(p_reason)), 0) < 10 then raise exception 'INVALID: give a reason of at least 10 characters'; end if;
  update public.worker_voice_reports set route = 'company_admin', escalated_at = now(), assigned_to = null where id = p_id;
  insert into public.worker_voice_events (report_id, event, actor_id, detail) values (p_id, 'escalated', auth.uid(), left(btrim(p_reason), 300));
  perform public.mg_wv_notify(p_id, r.organization_id, r.site_id, 'company_admin', true, auth.uid());
end;
$mg$;

create or replace function public.mg_wv_create_incident(p_id uuid, p_type text, p_description text, p_occurred timestamptz)
returns uuid language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports; v_inc uuid;
begin
  r := public.mg_wv_load(p_id);
  if r.linked_incident_id is not null then raise exception 'CONFLICT: an incident record already exists for this report'; end if;
  if coalesce(char_length(btrim(p_description)), 0) < 20 then
    raise exception 'INVALID: write the incident description yourself (at least 20 characters); the report text is not copied across';
  end if;
  insert into public.incidents (site_id, type, severity, description, occurred_at, client_ref, reported_by_id, report_source)
  values (r.site_id, p_type::incident_type, coalesce(r.triage_severity, r.urgency)::finding_severity, btrim(p_description),
          coalesce(p_occurred, r.occurred_at, now()), 'wv-' || r.id::text, auth.uid(), 'operator')
  returning id into v_inc;
  update public.worker_voice_reports set linked_incident_id = v_inc,
         status = case when status in ('received','triage') then 'investigating' else status end where id = p_id;
  insert into public.worker_voice_events (report_id, event, actor_id) values (p_id, 'incident_created', auth.uid());
  return v_inc;
end;
$mg$;

-- identity: named -> the report's reviewers; confidential -> company administrators only, with a purpose,
-- recorded and visible to the reporter as a count; anonymous -> there is nothing to reveal -------------
create or replace function public.mg_wv_identity(p_id uuid, p_purpose text default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports; v_rep uuid; v_name text; v_title text;
begin
  r := public.mg_wv_load(p_id);
  if r.mode = 'anonymous' then raise exception 'NOT_AVAILABLE: this report is anonymous; no identity is held'; end if;
  select reporter_id into v_rep from public.worker_voice_identity where report_id = r.id;
  if v_rep is null then return jsonb_build_object('available', false); end if;
  if r.mode = 'confidential' then
    if not exists (select 1 from public.organization_members m where m.user_id = auth.uid() and m.organization_id = r.organization_id
                     and m.status = 'active' and m.org_role = 'company_admin') then
      raise exception 'FORBIDDEN: only a company administrator can open a confidential identity';
    end if;
    if coalesce(char_length(btrim(p_purpose)), 0) < 10 then
      raise exception 'PURPOSE_REQUIRED: state why the identity is needed (at least 10 characters)';
    end if;
  end if;
  select p.name, p.job_title into v_name, v_title from public.profiles p where p.id = v_rep;
  insert into public.worker_voice_events (report_id, event, actor_id, detail)
  values (p_id, case when r.mode = 'confidential' then 'identity_revealed' else 'identity_viewed' end, auth.uid(), left(btrim(coalesce(p_purpose, '')), 300));
  return jsonb_build_object('available', true, 'name', v_name, 'jobTitle', v_title);
end;
$mg$;

create or replace function public.mg_wv_reviewers(p_id uuid)
returns table (user_id uuid, name text)
language plpgsql stable security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  select * into r from public.worker_voice_reports where id = p_id;
  if not found or not public.mg_wv_can_review(r.organization_id, r.site_id, r.route) then raise exception 'FORBIDDEN'; end if;
  return query
    select m.user_id, p.name from public.organization_members m join public.profiles p on p.id = m.user_id
     where m.organization_id = r.organization_id and m.status = 'active'
       and public.mg_wv_user_can_review(m.user_id, r.organization_id, r.site_id, r.route)
       and not exists (select 1 from public.worker_voice_identity i where i.report_id = r.id and i.reporter_id = m.user_id)
     order by p.name;
end;
$mg$;

-- sites the caller reviews (drives the reviewer page; the RPCs above re-check every call)
create or replace function public.mg_wv_reviewer_sites()
returns table (id uuid, name text)
language sql stable security definer set search_path = public as $mg$
  select s.id, s.name from public.sites s
   where public.mg_wv_can_review(s.organization_id, s.id, 'site')
   order by s.name
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_wv_reviewer_sites()', 'mg_wv_submit(text,uuid,text,text,text,timestamptz,text,boolean,text)', 'mg_wv_my_reports()',
    'mg_wv_site_code(uuid)', 'mg_wv_rotate_code(uuid)', 'mg_wv_triage(uuid,text,uuid)',
    'mg_wv_set_status(uuid,text,text)', 'mg_wv_post_update(uuid,text)', 'mg_wv_escalate(uuid,text)',
    'mg_wv_create_incident(uuid,text,text,timestamptz)', 'mg_wv_identity(uuid,text)', 'mg_wv_reviewers(uuid)',
    'mg_wv_can_review(uuid,uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- the two public entry points: callable without a session
  foreach f in array array[
    'mg_wv_submit_anonymous(text,text,text,text,timestamptz,text,boolean,text)', 'mg_wv_status(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  revoke all on function public.mg_wv_hash(text), public.mg_wv_rate(text,integer,interval), public.mg_wv_src(text),
    public.mg_wv_user_can_review(uuid,uuid,uuid,text) from public, anon, authenticated;
end $$;

commit;
