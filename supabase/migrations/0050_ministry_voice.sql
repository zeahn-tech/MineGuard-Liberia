-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0050: Worker Voice → Ministry (confidential reporting to government)
--
-- WHAT THIS ADDS
--   Workers can flag bad labour practices, unsafe work practices and bad work habits carried out
--   by a company DIRECTLY to the Ministry, so government can make informed decisions and press
--   companies to do the right thing. It is a SECOND, SEPARATE channel next to the company one
--   (0046). The two never mix:
--
--     company channel (0046)   worker_voice_*   reviewed by the COMPANY's administrators (and the
--                                                site manager / safety officers assigned to the site)
--     Ministry channel (this)  ministry_voice_* reviewed by MINISTRY reviewers only
--
--   0046 is NOT changed. In particular the company channel keeps the company administrators as
--   its reviewers and the Ministry still has NO access to it (mg_wv_user_can_review needs an active
--   membership of the company, and government accounts hold no company — 0032). This migration
--   adds nothing that lets a Ministry account read a company-channel report, or lets a company
--   account read a Ministry-channel report. A company administrator is often the SUBJECT of a
--   Ministry report, so company accounts get no grant, no policy and no RPC here.
--
-- WHY SEPARATE TABLES AND NOT A "channel" COLUMN ON worker_voice_reports
--   A column would put both audiences' rows behind one policy; one wrong predicate would expose a
--   report about a company to that company. Separate tables make the separation structural:
--   different tables, different reviewer functions, different follow-up-code hash prefix ('mv1:'),
--   different rate-limit buckets ('mv:*'), different notification link.
--
-- ANONYMITY IS THE SAME DATA-ARCHITECTURE PROPERTY AS 0046
--   * ministry_voice_reports (content) has NO identity column of any kind.
--   * ministry_voice_identity (named + confidential only) is a SEPARATE closed table (no grant, no
--     policy). An anonymous report has no row there. Reachable only via mg_mv_identity.
--   * mg_mv_submit_anonymous never reads auth.uid().
--   * The generic audit trigger is NOT attached (it records the actor). The 'submitted' event never
--     records an actor. Confidential/anonymous received time is rounded down to the hour.
--   * Rate limiting keys on a salted SHA-256 of the connecting address, never the address.
--   * Follow-up: 96-bit device-generated code; the server stores sha256('mv1:' || code) only.
--   * Anonymous reports are routed by the site's posted code (worker_voice_site_codes, 0046), so
--     no public list of sites exists. The report therefore does name the company and site: a
--     report about "a company" is only useful to the Ministry if it says which one.
--
-- ACCESS
--   Reviewers = Ministry administrators, and national-scope Ministry supervisors.
--   Opening a CONFIDENTIAL identity = Ministry administrators only, with a stated purpose
--   (>= 10 characters), recorded; the reporter sees how many times it was opened.
--   No attachments (same reasons as 0046).
--
-- Idempotent. Not applied to production by anyone but the owner.
-- ROLLBACK: docs/23_MINISTRY_VOICE.MD (drop the three ministry_voice_* tables, the mg_mv_*
-- functions and the mv_forget_reporter trigger on profiles; delete 'worker_voice' notifications
-- whose link_to is '/portal/voice-ministry').
-- ===========================================================================

begin;

-- tables ---------------------------------------------------------------------------------------------
create table if not exists public.ministry_voice_reports (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id),
  site_id            uuid not null references public.sites(id),
  mode               text not null check (mode in ('named','confidential','anonymous')),
  category           text not null check (category in (
                       'wages_or_benefits','working_hours','harassment_or_discrimination','retaliation',
                       'child_or_forced_labour','contract_or_dismissal',
                       'unsafe_practice','missing_ppe_or_training','hazard_ignored','falsified_records',
                       'bad_work_habit','other')),
  urgency            text not null check (urgency in ('low','medium','high','critical')),
  description        text not null check (char_length(description) between 10 and 4000),
  occurred_at        timestamptz,
  previously_reported text not null check (previously_reported in ('no','yes','unsure')),
  status             text not null default 'received'
                     check (status in ('received','triage','investigating','action_taken','closed')),
  triage_severity    text check (triage_severity in ('low','medium','high','critical')),
  assigned_to        uuid references public.profiles(id) on delete set null,
  duplicate_of       uuid references public.ministry_voice_reports(id),
  fingerprint        text not null,
  closure_reason     text check (closure_reason is null or char_length(closure_reason) <= 1000),
  reporter_update    text check (reporter_update is null or char_length(reporter_update) <= 500),
  reporter_update_at timestamptz,
  code_hash          text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz,
  row_version        integer not null default 1
);
create index if not exists mv_reports_status_idx on public.ministry_voice_reports (status, created_at desc);
create index if not exists mv_reports_org_idx on public.ministry_voice_reports (organization_id, created_at desc);
create index if not exists mv_reports_fp_idx on public.ministry_voice_reports (site_id, fingerprint, created_at desc);

-- identity: SEPARATE, closed; absent entirely for anonymous reports. Deleting the account removes it.
create table if not exists public.ministry_voice_identity (
  report_id   uuid primary key references public.ministry_voice_reports(id),
  reporter_id uuid not null references public.profiles(id) on delete cascade
);
create index if not exists mv_identity_reporter_idx on public.ministry_voice_identity (reporter_id);

-- reviewer-side history. actor_id is NULL for 'submitted'; it is a plain uuid (no FK).
create table if not exists public.ministry_voice_events (
  id        uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.ministry_voice_reports(id),
  event     text not null check (event in ('submitted','triaged','assigned','status_changed','update_posted','identity_viewed','identity_revealed')),
  actor_id  uuid,
  detail    text check (detail is null or char_length(detail) <= 400),
  at        timestamptz not null default now()
);
create index if not exists mv_events_report_idx on public.ministry_voice_events (report_id, at);

alter table public.ministry_voice_reports  enable row level security;
alter table public.ministry_voice_identity enable row level security;
alter table public.ministry_voice_events   enable row level security;
revoke all on public.ministry_voice_reports, public.ministry_voice_identity, public.ministry_voice_events from anon, authenticated;

-- helpers --------------------------------------------------------------------------------------------
-- A different prefix from 0046 ('wv1:'): a company-channel code can never open a Ministry report.
create or replace function public.mg_mv_hash(p_code text)
returns text language sql immutable as $mg$
  select encode(sha256(convert_to('mv1:' || coalesce(p_code, ''), 'UTF8')), 'hex')
$mg$;

create or replace function public.mg_mv_src(p_prefix text)
returns text language sql stable set search_path = public as $mg$
  select p_prefix || ':' || case when coalesce(public.mg_client_ip(), '') = '' then 'unknown'
    else encode(sha256(convert_to('mgliberia-mv-v1:' || public.mg_client_ip(), 'UTF8')), 'hex') end
$mg$;

-- who reviews: Ministry administrators and national-scope Ministry supervisors. Never a company account
-- (government roles hold no company, and no company role appears in this predicate).
create or replace function public.mg_mv_user_is_reviewer(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select p_user is not null and exists (
    select 1 from public.profiles p
     where p.id = p_user and p.deleted_at is null
       and (p.role = 'admin' or (p.role = 'supervisor' and p.scope = 'national')))
$mg$;

create or replace function public.mg_mv_is_reviewer()
returns boolean language sql stable security definer set search_path = public as $mg$
  select public.mg_mv_user_is_reviewer(auth.uid())
$mg$;

-- only a Ministry ADMINISTRATOR may open a confidential identity
create or replace function public.mg_mv_user_is_custodian(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select p_user is not null and exists (
    select 1 from public.profiles p where p.id = p_user and p.deleted_at is null and p.role = 'admin')
$mg$;

drop policy if exists "mv reports read" on public.ministry_voice_reports;
create policy "mv reports read" on public.ministry_voice_reports for select to authenticated
  using (public.mg_mv_is_reviewer());
grant select on public.ministry_voice_reports to authenticated;

drop policy if exists "mv events read" on public.ministry_voice_events;
create policy "mv events read" on public.ministry_voice_events for select to authenticated
  using (public.mg_mv_is_reviewer());
grant select on public.ministry_voice_events to authenticated;
-- ministry_voice_identity has NO policy and NO grant: reachable only through RPCs.

-- When an account is deleted/anonymized (0035 sets profiles.deleted_at) the link between that person and any
-- report they sent is erased. The reports stay, de-identified.
create or replace function public.mg_mv_forget_reporter()
returns trigger language plpgsql security definer set search_path = public as $mg$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    delete from public.ministry_voice_identity where reporter_id = new.id;
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_mv_forget_reporter() from public, anon, authenticated;
drop trigger if exists mv_forget_reporter on public.profiles;
create trigger mv_forget_reporter after update of deleted_at on public.profiles
  for each row execute function public.mg_mv_forget_reporter();

-- the report's lifecycle guard ---------------------------------------------------------------------
create or replace function public.mg_mv_report_guard()
returns trigger language plpgsql as $mg$
declare
  v_order text[] := array['received','triage','investigating','action_taken','closed'];
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
  new.updated_at := now();
  new.row_version := old.row_version + 1;
  return new;
end;
$mg$;
revoke all on function public.mg_mv_report_guard() from public, anon, authenticated;
drop trigger if exists mv_reports_guard on public.ministry_voice_reports;
create trigger mv_reports_guard before update or delete on public.ministry_voice_reports
  for each row execute function public.mg_mv_report_guard();

-- generic notification for Ministry reviewers: no reporter, no company, no content, no mode, no category
create or replace function public.mg_mv_notify(p_report uuid, p_urgent boolean, p_skip uuid)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  perform set_config('mg.notify', '1', true);
  insert into public.notifications (user_id, source_key, kind, severity, title, body, link_to, event_at)
  select p.id, 'mv:' || p_report::text || ':' || to_char(now(), 'YYYYMMDDHH24MISSMS'),
         'worker_voice', case when p_urgent then 'urgent' else 'info' end,
         'A worker report requires review',
         'MineGuard: A worker report requires review. Sign in with your authorized account to access it.',
         '/portal/voice-ministry', now()
    from public.profiles p
   where public.mg_mv_user_is_reviewer(p.id)
     and (p_skip is null or p.id <> p_skip)
  on conflict (user_id, source_key) do nothing;
  perform set_config('mg.notify', '0', true);
end;
$mg$;
revoke all on function public.mg_mv_notify(uuid, boolean, uuid) from public, anon, authenticated;

-- the one place a Ministry report is written ---------------------------------------------------------
create or replace function public.mg_mv_insert(
  p_mode text, p_site uuid, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_code text, p_reporter uuid)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare
  v_org uuid; v_fp text; v_dup uuid; v_id uuid; v_desc text := btrim(coalesce(p_description, ''));
  v_created timestamptz;
begin
  if p_mode not in ('named','confidential','anonymous') then return jsonb_build_object('status','invalid','message','Unknown reporting mode.'); end if;
  if (p_mode = 'anonymous') <> (p_reporter is null) then return jsonb_build_object('status','invalid','message','Mode and identity do not match.'); end if;
  if p_category is null or p_category not in ('wages_or_benefits','working_hours','harassment_or_discrimination','retaliation',
       'child_or_forced_labour','contract_or_dismissal','unsafe_practice','missing_ppe_or_training','hazard_ignored',
       'falsified_records','bad_work_habit','other') then
    return jsonb_build_object('status','invalid','message','Choose a category.'); end if;
  if p_urgency is null or p_urgency not in ('low','medium','high','critical') then return jsonb_build_object('status','invalid','message','Choose an urgency.'); end if;
  if p_previously is null or p_previously not in ('no','yes','unsure') then return jsonb_build_object('status','invalid','message','Say whether this was reported before.'); end if;
  if char_length(v_desc) < 10 or char_length(v_desc) > 4000 then return jsonb_build_object('status','invalid','message','Describe the concern in 10 to 4000 characters.'); end if;
  if p_occurred is not null and p_occurred > now() + interval '1 day' then return jsonb_build_object('status','invalid','message','The date cannot be in the future.'); end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' or (select count(distinct c) from regexp_split_to_table(p_code, '') c) < 8 then
    return jsonb_build_object('status','invalid','message','The follow-up code is not valid.'); end if;
  select s.organization_id into v_org from public.sites s where s.id = p_site;
  if v_org is null then return jsonb_build_object('status','invalid','message','Unknown site.'); end if;

  v_fp := encode(sha256(convert_to(lower(regexp_replace(v_desc, '\s+', ' ', 'g')) || '|' || p_category, 'UTF8')), 'hex');
  select r.id into v_dup from public.ministry_voice_reports r
   where r.site_id = p_site and r.fingerprint = v_fp and r.created_at > now() - interval '14 days'
   order by r.created_at limit 1;
  v_created := case when p_mode = 'named' then now() else date_trunc('hour', now()) end;

  insert into public.ministry_voice_reports (organization_id, site_id, mode, category, urgency, description, occurred_at,
                                             previously_reported, fingerprint, duplicate_of, code_hash, created_at)
  values (v_org, p_site, p_mode, p_category, p_urgency, v_desc, p_occurred, p_previously, v_fp, v_dup,
          public.mg_mv_hash(p_code), v_created)
  on conflict (code_hash) do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('status','duplicate'); end if;

  if p_reporter is not null then
    insert into public.ministry_voice_identity (report_id, reporter_id) values (v_id, p_reporter);
  end if;
  insert into public.ministry_voice_events (report_id, event, actor_id) values (v_id, 'submitted', null);
  perform public.mg_mv_notify(v_id, p_urgency in ('high','critical'), p_reporter);
  return jsonb_build_object('status','received', 'possibleDuplicate', v_dup is not null);
end;
$mg$;
revoke all on function public.mg_mv_insert(text, uuid, text, text, text, timestamptz, text, text, uuid) from public, anon, authenticated;

-- submit: named / confidential (signed in, a member allowed at the site) ----------------------------------
create or replace function public.mg_mv_submit(
  p_mode text, p_site uuid, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in to send a named or confidential report'; end if;
  if p_mode not in ('named','confidential') then raise exception 'INVALID: use the anonymous route for anonymous reports'; end if;
  if not public.mg_can_prepare_jsa(p_site) then raise exception 'FORBIDDEN: you are not a member allowed at this site'; end if;
  if not public.mg_wv_rate('mv:u:' || encode(sha256(convert_to('mv-user:' || auth.uid()::text, 'UTF8')), 'hex'), 10, interval '1 hour') then
    return jsonb_build_object('status','rate_limited');
  end if;
  return public.mg_mv_insert(p_mode, p_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_code, auth.uid());
end;
$mg$;

-- submit: anonymous. NEVER reads auth.uid(). Anticipated failures are RETURNED, not raised, so the
-- rate-limit counters they increment are kept. ----------------------------------------------------------
create or replace function public.mg_mv_submit_anonymous(
  p_site_code text, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_site uuid; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  delete from public.rate_limits where bucket like 'mv:%' and window_start < now() - interval '1 day';
  if not public.mg_wv_rate(public.mg_mv_src('mv:a'), case when v_known then 10 else 200 end, interval '1 hour') then
    return jsonb_build_object('status','rate_limited');
  end if;
  select c.site_id into v_site from public.worker_voice_site_codes c
   where c.code = upper(regexp_replace(coalesce(p_site_code, ''), '[^0-9A-Za-z]', '', 'g'));
  if v_site is null then
    if not public.mg_wv_rate(public.mg_mv_src('mv:f'), case when v_known then 10 else 100 end, interval '1 hour') then
      return jsonb_build_object('status','rate_limited');
    end if;
    return jsonb_build_object('status','invalid_site_code');
  end if;
  if not public.mg_wv_rate('mv:s:' || v_site::text, 60, interval '1 hour') then
    return jsonb_build_object('status','rate_limited');
  end if;
  return public.mg_mv_insert('anonymous', v_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_code, null);
end;
$mg$;

-- public status: coarse stage + reviewer-written update only ----------------------------------------
create or replace function public.mg_mv_status(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  if not public.mg_wv_rate(public.mg_mv_src('mv:l'), case when v_known then 60 else 600 end, interval '1 hour') then
    return jsonb_build_object('found', false, 'status', 'rate_limited');
  end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' then
    return jsonb_build_object('found', false);
  end if;
  select * into r from public.ministry_voice_reports where code_hash = public.mg_mv_hash(p_code);
  if not found then
    if not public.mg_wv_rate(public.mg_mv_src('mv:lf'), case when v_known then 10 else 100 end, interval '1 hour') then
      return jsonb_build_object('found', false, 'status', 'rate_limited');
    end if;
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'stage', case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed'
                           when 'investigating' then 'Under review by the Ministry' when 'action_taken' then 'Action taken' else 'Closed' end,
    'closed', r.status = 'closed',
    'lastChange', (coalesce(r.updated_at, r.created_at))::date,
    'update', r.reporter_update,
    'updateOn', r.reporter_update_at::date);
end;
$mg$;

-- reporter: own named/confidential Ministry reports and how often the identity was opened ------------------
create or replace function public.mg_mv_my_reports()
returns table (id uuid, received_on date, mode text, category text, stage text, reporter_update text, reporter_update_on date, identity_opened integer)
language sql stable security definer set search_path = public as $mg$
  select r.id, r.created_at::date, r.mode, r.category,
         case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed'
                       when 'investigating' then 'Under review by the Ministry' when 'action_taken' then 'Action taken' else 'Closed' end,
         r.reporter_update, r.reporter_update_at::date,
         (select count(*)::int from public.ministry_voice_events e where e.report_id = r.id and e.event = 'identity_revealed')
    from public.ministry_voice_identity i join public.ministry_voice_reports r on r.id = i.report_id
   where i.reporter_id = auth.uid()
   order by r.created_at desc limit 50
$mg$;

-- reviewer: the queue, with company and site names -------------------------------------------------------
create or replace function public.mg_mv_list(p_limit integer default 300)
returns table (id uuid, organization_id uuid, organization_name text, site_id uuid, site_name text, mode text, category text,
               urgency text, description text, occurred_at timestamptz, previously_reported text, status text,
               triage_severity text, assigned_to uuid, assigned_name text, duplicate_of uuid, closure_reason text,
               reporter_update text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $mg$
begin
  if not public.mg_mv_is_reviewer() then raise exception 'FORBIDDEN: you are not authorized to review worker reports'; end if;
  return query
    select r.id, r.organization_id, o.name::text, r.site_id, s.name::text, r.mode, r.category, r.urgency, r.description,
           r.occurred_at, r.previously_reported, r.status, r.triage_severity, r.assigned_to, a.name::text, r.duplicate_of,
           r.closure_reason, r.reporter_update, r.created_at
      from public.ministry_voice_reports r
      join public.organizations o on o.id = r.organization_id
      join public.sites s on s.id = r.site_id
      left join public.profiles a on a.id = r.assigned_to
     order by r.created_at desc
     limit least(greatest(coalesce(p_limit, 300), 1), 500);
end;
$mg$;

-- reviewer: counts for informed decisions (no report text, no identity) ----------------------------------
create or replace function public.mg_mv_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $mg$
declare v jsonb;
begin
  if not public.mg_mv_is_reviewer() then raise exception 'FORBIDDEN: you are not authorized to review worker reports'; end if;
  select jsonb_build_object(
    'total', (select count(*) from public.ministry_voice_reports),
    'open', (select count(*) from public.ministry_voice_reports where status <> 'closed'),
    'critical_open', (select count(*) from public.ministry_voice_reports where status <> 'closed' and coalesce(triage_severity, urgency) in ('high','critical')),
    'by_group', coalesce((select jsonb_object_agg(g, n) from (
        select case when category in ('unsafe_practice','missing_ppe_or_training','hazard_ignored','falsified_records') then 'safety'
                    when category = 'bad_work_habit' then 'conduct'
                    when category = 'other' then 'other' else 'labour' end as g, count(*) as n
          from public.ministry_voice_reports group by 1) x), '{}'::jsonb),
    'by_category', coalesce((select jsonb_object_agg(category, n) from (
        select category, count(*) as n from public.ministry_voice_reports group by 1) x), '{}'::jsonb),
    'by_company', coalesce((select jsonb_agg(jsonb_build_object('organization_id', organization_id, 'name', name, 'total', total,
                                                                'open', open_n, 'serious_open', serious_n) order by total desc, name)
        from (select o.id as organization_id, o.name, count(*) as total,
                     count(*) filter (where r.status <> 'closed') as open_n,
                     count(*) filter (where r.status <> 'closed' and coalesce(r.triage_severity, r.urgency) in ('high','critical')) as serious_n
                from public.ministry_voice_reports r join public.organizations o on o.id = r.organization_id
               group by o.id, o.name) c), '[]'::jsonb)
  ) into v;
  return v;
end;
$mg$;

-- reviewer actions ----------------------------------------------------------------------------------------
create or replace function public.mg_mv_load(p_id uuid)
returns public.ministry_voice_reports language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  if not public.mg_mv_is_reviewer() then raise exception 'FORBIDDEN: you are not authorized to review worker reports'; end if;
  select * into r from public.ministry_voice_reports where id = p_id for update;
  if not found then raise exception 'FORBIDDEN: you are not authorized to review this report'; end if;
  if exists (select 1 from public.ministry_voice_identity i where i.report_id = r.id and i.reporter_id = auth.uid()) then
    raise exception 'FORBIDDEN: you cannot review a report you sent';
  end if;
  return r;
end;
$mg$;
revoke all on function public.mg_mv_load(uuid) from public, anon, authenticated;

create or replace function public.mg_mv_triage(p_id uuid, p_severity text, p_assignee uuid default null)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports;
begin
  r := public.mg_mv_load(p_id);
  if p_severity not in ('low','medium','high','critical') then raise exception 'INVALID: choose a severity'; end if;
  if p_assignee is not null and not public.mg_mv_user_is_reviewer(p_assignee) then
    raise exception 'INVALID: that person is not an authorized reviewer for this report';
  end if;
  update public.ministry_voice_reports set triage_severity = p_severity, assigned_to = coalesce(p_assignee, assigned_to),
         status = case when status = 'received' then 'triage' else status end where id = p_id;
  insert into public.ministry_voice_events (report_id, event, actor_id, detail) values (p_id, 'triaged', auth.uid(), 'severity ' || p_severity);
  if p_assignee is not null then
    insert into public.ministry_voice_events (report_id, event, actor_id, detail) values (p_id, 'assigned', auth.uid(), null);
  end if;
end;
$mg$;

create or replace function public.mg_mv_set_status(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports;
begin
  r := public.mg_mv_load(p_id);
  if p_status not in ('triage','investigating','action_taken','closed') then raise exception 'INVALID: unknown status'; end if;
  update public.ministry_voice_reports set status = p_status,
         closure_reason = case when p_status = 'closed' then btrim(p_note) else closure_reason end where id = p_id;
  insert into public.ministry_voice_events (report_id, event, actor_id, detail)
  values (p_id, 'status_changed', auth.uid(), p_status || case when p_status = 'closed' then ': ' || left(btrim(coalesce(p_note,'')), 300) else '' end);
end;
$mg$;

create or replace function public.mg_mv_post_update(p_id uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports;
begin
  r := public.mg_mv_load(p_id);
  if coalesce(char_length(btrim(p_text)), 0) not between 1 and 500 then raise exception 'INVALID: write 1 to 500 characters for the reporter'; end if;
  update public.ministry_voice_reports set reporter_update = btrim(p_text), reporter_update_at = now() where id = p_id;
  insert into public.ministry_voice_events (report_id, event, actor_id) values (p_id, 'update_posted', auth.uid());
end;
$mg$;

-- identity: named -> Ministry reviewers; confidential -> Ministry administrators only, with a purpose,
-- recorded and visible to the reporter as a count; anonymous -> there is nothing to reveal ----------------
create or replace function public.mg_mv_identity(p_id uuid, p_purpose text default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports; v_rep uuid; v_name text; v_title text;
begin
  r := public.mg_mv_load(p_id);
  if r.mode = 'anonymous' then raise exception 'NOT_AVAILABLE: this report is anonymous; no identity is held'; end if;
  select reporter_id into v_rep from public.ministry_voice_identity where report_id = r.id;
  if v_rep is null then return jsonb_build_object('available', false); end if;
  if r.mode = 'confidential' then
    if not public.mg_mv_user_is_custodian(auth.uid()) then
      raise exception 'FORBIDDEN: only a Ministry administrator can open a confidential identity';
    end if;
    if coalesce(char_length(btrim(p_purpose)), 0) < 10 then
      raise exception 'PURPOSE_REQUIRED: state why the identity is needed (at least 10 characters)';
    end if;
  end if;
  select p.name, p.job_title into v_name, v_title from public.profiles p where p.id = v_rep;
  insert into public.ministry_voice_events (report_id, event, actor_id, detail)
  values (p_id, case when r.mode = 'confidential' then 'identity_revealed' else 'identity_viewed' end, auth.uid(), left(btrim(coalesce(p_purpose, '')), 300));
  return jsonb_build_object('available', true, 'name', v_name, 'jobTitle', v_title);
end;
$mg$;

create or replace function public.mg_mv_reviewers()
returns table (user_id uuid, name text)
language plpgsql stable security definer set search_path = public as $mg$
begin
  if not public.mg_mv_is_reviewer() then raise exception 'FORBIDDEN'; end if;
  return query
    select p.id, p.name::text from public.profiles p where public.mg_mv_user_is_reviewer(p.id) order by p.name;
end;
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_mv_submit(text,uuid,text,text,text,timestamptz,text,text)', 'mg_mv_my_reports()',
    'mg_mv_list(integer)', 'mg_mv_summary()', 'mg_mv_triage(uuid,text,uuid)',
    'mg_mv_set_status(uuid,text,text)', 'mg_mv_post_update(uuid,text)', 'mg_mv_identity(uuid,text)',
    'mg_mv_reviewers()', 'mg_mv_is_reviewer()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- the two public entry points: callable without a session
  foreach f in array array[
    'mg_mv_submit_anonymous(text,text,text,text,timestamptz,text,text)', 'mg_mv_status(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  revoke all on function public.mg_mv_hash(text), public.mg_mv_src(text), public.mg_mv_user_is_reviewer(uuid),
    public.mg_mv_user_is_custodian(uuid) from public, anon, authenticated;
end $$;

commit;
