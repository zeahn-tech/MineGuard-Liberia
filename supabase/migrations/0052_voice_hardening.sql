-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0052: Worker Voice hardening (both channels)
--
-- Builds on 0046 (company channel) and 0050 (Ministry channel). The two-channel design is KEPT:
--   * company administrators review company reports and are the only ones who can open a company
--     CONFIDENTIAL identity (0046, unchanged);
--   * Ministry administrators open Ministry confidential identities (0050, unchanged);
--   * the Ministry still has NO access to the company channel, and a company still has NO access to
--     the Ministry channel. Nothing here adds a cross-channel grant.
--
-- FIXES
--   F1  The Ministry channel no longer uses the company's site code. Under 0050 a company's site
--       manager could rotate the code and silently cut off anonymous reports ABOUT that company to the
--       Ministry. The Ministry now has its OWN intake code per site, which only Ministry administrators
--       can rotate or pause (ministry_voice_site_codes).
--   F2  "This concerns the people who would normally review it" no longer implies a dead end. The
--       company route for administrators-only stays for site-level conflicts; for a company
--       administrator or management the app directs the reporter to the Ministry channel, and the
--       server's message says so.
--
-- ADDITIONS (both channels unless stated)
--   A1  Two-way messaging by follow-up code (and from "my reports" for named/confidential).
--   A2  Ageing: reminders for reports nobody has acknowledged; company reports unacknowledged for 7 days
--       auto-escalate to company administrators; Ministry list of reports open too long. The reporter of
--       an unresolved or closed company report is shown the Ministry channel as an option.
--   A3  Reviewer PUSH with a fixed generic payload (outbox says WHO to wake, never why).
--   A4  Photos: JPEG only, 3 per report, structurally validated and REFUSED if they carry hidden data.
--   A5  Site-code controls: pause switch and unusual-volume signal on both; 90-day expiry on the company
--       code (the Ministry code does not auto-expire: it is distributed by the Ministry, not by a lazy
--       request from a member).
--   A6  Small sites (< 10 assigned): reporter warning, DAY-level time coarsening, reviewer flag.
--   A7  Ministry trends: monthly counts, companies for attention (deterministic, evidence + limits, never
--       a prediction), ageing.
--   A8  Retention: a policy per channel (floor 12 months), legal hold, and a dry-run-first disposal that
--       writes a counts-only log. Nothing is deleted unless a custodian types DISPOSE.
--   A9  Ministry → company REQUESTS: template topics, no link to any report, only when at least three
--       Ministry reports exist for the matching topic in 180 days, day-level dates, generic notification.
--
-- Anonymity rules from 0046/0050 are unchanged: no identity column is added, the anonymous functions never
-- read auth.uid(), no address is stored, the generic audit trigger stays off these tables.
-- Idempotent. Not applied to production by anyone but the owner.
-- ROLLBACK: docs/22_WORKER_VOICE.MD and docs/23_MINISTRY_VOICE.MD (section "Hardening").
-- ===========================================================================

begin;

-- event vocabularies ------------------------------------------------------------------------------------
alter table public.worker_voice_events drop constraint if exists worker_voice_events_event_check;
alter table public.worker_voice_events add constraint worker_voice_events_event_check
  check (event in ('submitted','triaged','assigned','status_changed','update_posted','escalated','incident_created',
                   'identity_viewed','identity_revealed','hold_set','hold_cleared','auto_escalated'));
alter table public.ministry_voice_events drop constraint if exists ministry_voice_events_event_check;
alter table public.ministry_voice_events add constraint ministry_voice_events_event_check
  check (event in ('submitted','triaged','assigned','status_changed','update_posted','identity_viewed','identity_revealed',
                   'hold_set','hold_cleared'));

-- columns ---------------------------------------------------------------------------------------------------
alter table public.worker_voice_reports add column if not exists small_site boolean not null default false;
alter table public.worker_voice_reports add column if not exists legal_hold boolean not null default false;
alter table public.worker_voice_reports add column if not exists legal_hold_reason text check (legal_hold_reason is null or char_length(legal_hold_reason) <= 500);
alter table public.worker_voice_reports add column if not exists closed_at timestamptz;
alter table public.ministry_voice_reports add column if not exists small_site boolean not null default false;
alter table public.ministry_voice_reports add column if not exists legal_hold boolean not null default false;
alter table public.ministry_voice_reports add column if not exists legal_hold_reason text check (legal_hold_reason is null or char_length(legal_hold_reason) <= 500);
alter table public.ministry_voice_reports add column if not exists closed_at timestamptz;
alter table public.worker_voice_site_codes add column if not exists anonymous_enabled boolean not null default true;
alter table public.worker_voice_site_codes add column if not exists expires_at timestamptz not null default (now() + interval '90 days');

-- new tables ------------------------------------------------------------------------------------------------
create table if not exists public.worker_voice_messages (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
  report_id uuid not null references public.worker_voice_reports(id),
  from_reporter boolean not null, body text not null check (char_length(body) between 1 and 1000), at timestamptz not null default now());
create index if not exists wv_messages_report_idx on public.worker_voice_messages (report_id, seq);
create table if not exists public.ministry_voice_messages (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
  report_id uuid not null references public.ministry_voice_reports(id),
  from_reporter boolean not null, body text not null check (char_length(body) between 1 and 1000), at timestamptz not null default now());
create index if not exists mv_messages_report_idx on public.ministry_voice_messages (report_id, seq);

create table if not exists public.worker_voice_attachments (
  id uuid primary key default gen_random_uuid(), report_id uuid not null references public.worker_voice_reports(id),
  content bytea not null check (length(content) between 100 and 1000000), mime text not null default 'image/jpeg' check (mime = 'image/jpeg'),
  bytes integer not null, sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), created_at timestamptz not null default now());
create index if not exists wv_attachments_report_idx on public.worker_voice_attachments (report_id);
create table if not exists public.ministry_voice_attachments (
  id uuid primary key default gen_random_uuid(), report_id uuid not null references public.ministry_voice_reports(id),
  content bytea not null check (length(content) between 100 and 1000000), mime text not null default 'image/jpeg' check (mime = 'image/jpeg'),
  bytes integer not null, sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), created_at timestamptz not null default now());
create index if not exists mv_attachments_report_idx on public.ministry_voice_attachments (report_id);

-- intake volume per site per day (NOT linked to any report)
create table if not exists public.worker_voice_code_usage (site_id uuid not null references public.sites(id), day date not null, n integer not null default 0, primary key (site_id, day));
create table if not exists public.ministry_voice_code_usage (site_id uuid not null references public.sites(id), day date not null, n integer not null default 0, primary key (site_id, day));

-- F1: the Ministry's OWN intake code, never visible to or controllable by the company ---------------------------
create table if not exists public.ministry_voice_site_codes (
  site_id uuid primary key references public.sites(id),
  code text not null unique check (code ~ '^[0-9A-F]{10}$'),
  rotated_at timestamptz not null default now(),
  anonymous_enabled boolean not null default true);

-- reviewer push: who to wake, nothing about why. kind picks one of three fixed generic payloads.
create table if not exists public.voice_push_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('company','ministry','request')),
  state text not null default 'queued' check (state in ('queued','sending','sent','expired','failed')),
  attempts integer not null default 0, detail text check (detail is null or char_length(detail) <= 200),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists voice_push_state_idx on public.voice_push_outbox (state, created_at);

-- A8: retention, disposal log ---------------------------------------------------------------------------------
create table if not exists public.voice_retention_policy (
  channel text primary key check (channel in ('company','ministry')),
  retention_months integer not null check (retention_months between 12 and 120),
  updated_by uuid, updated_at timestamptz not null default now());
insert into public.voice_retention_policy (channel, retention_months) values ('company', 36), ('ministry', 60) on conflict (channel) do nothing;
create table if not exists public.voice_disposal_log (   -- counts only: never a report, never content
  id uuid primary key default gen_random_uuid(), channel text not null check (channel in ('company','ministry')),
  organization_id uuid, actor_id uuid, deleted_reports integer not null, retention_months integer not null, at timestamptz not null default now());

-- A9: Ministry → company requests (no report id anywhere) -------------------------------------------------------
create table if not exists public.ministry_company_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  topic text not null check (topic in ('working_hours_and_rest','wages_and_benefits_records','safety_training_and_ppe',
        'hazard_controls_and_maintenance','workplace_conduct_and_discrimination','contracts_and_dismissals')),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid not null, created_on date not null default current_date,
  status text not null default 'open' check (status in ('open','answered','closed')));
create table if not exists public.ministry_company_responses (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
  request_id uuid not null references public.ministry_company_requests(id),
  body text not null check (char_length(body) between 1 and 1500), by_user uuid not null, by_ministry boolean not null default false, on_date date not null default current_date);
create index if not exists mcr_org_idx on public.ministry_company_requests (organization_id, created_on desc);

do $$
declare t text;
begin
  foreach t in array array['worker_voice_messages','ministry_voice_messages','worker_voice_attachments','ministry_voice_attachments',
    'worker_voice_code_usage','ministry_voice_code_usage','ministry_voice_site_codes','voice_push_outbox','voice_retention_policy',
    'voice_disposal_log','ministry_company_requests','ministry_company_responses'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
revoke all on public.worker_voice_messages, public.ministry_voice_messages, public.worker_voice_attachments, public.ministry_voice_attachments,
  public.worker_voice_code_usage, public.ministry_voice_code_usage, public.ministry_voice_site_codes, public.voice_push_outbox,
  public.voice_retention_policy, public.voice_disposal_log, public.ministry_company_requests, public.ministry_company_responses from anon, authenticated;

-- messages/attachments are never edited; they are removed only by an authorised disposal run ---------------------
create or replace function public.mg_voice_immutable()
returns trigger language plpgsql as $mg$
begin
  if tg_op = 'DELETE' and current_setting('mg.voice_disposal', true) = '1' then return old; end if;
  raise exception 'IMMUTABLE: this record is never edited or deleted';
end;
$mg$;
revoke all on function public.mg_voice_immutable() from public, anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['worker_voice_messages','ministry_voice_messages','worker_voice_attachments','ministry_voice_attachments'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_immutable', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.mg_voice_immutable()', t || '_immutable', t);
  end loop;
end $$;

-- shared: who is a Ministry administrator ----------------------------------------------------------------------------
create or replace function public.mg_voice_is_ministry_admin()
returns boolean language sql stable security definer set search_path = public as $mg$
  select public.mg_mv_user_is_custodian(auth.uid())
$mg$;

-- A4: JPEG structure check ---------------------------------------------------------------------------------------------
create or replace function public.mg_wv_jpeg_problem(p bytea)
returns text language plpgsql immutable as $mg$
declare n integer := length(p); i integer := 2; m integer; len integer; w integer; h integer; seen_sof boolean := false; k integer;
begin
  if n < 100 then return 'The photo is too small to be valid.'; end if;
  if n > 1000000 then return 'Each photo must be under 1 MB.'; end if;
  if get_byte(p, 0) <> 255 or get_byte(p, 1) <> 216 or get_byte(p, 2) <> 255 then return 'Only JPEG photos can be attached.'; end if;
  if get_byte(p, n - 2) <> 255 or get_byte(p, n - 1) <> 217 then return 'The photo is incomplete.'; end if;
  loop
    if i + 4 > n or get_byte(p, i) <> 255 then return 'The photo is not a valid JPEG.'; end if;
    m := get_byte(p, i + 1);
    len := get_byte(p, i + 2) * 256 + get_byte(p, i + 3);
    if len < 2 or i + 2 + len > n then return 'The photo is not a valid JPEG.'; end if;
    if m = 224 then
      if len <> 16 or encode(substring(p from i + 5 for 4), 'escape') <> 'JFIF' or get_byte(p, i + 16) <> 0 or get_byte(p, i + 17) <> 0 then
        return 'The photo carries extra data (such as an embedded thumbnail).'; end if;
    elsif m in (219, 196, 221) then null;
    elsif m in (192, 193, 194) then
      h := get_byte(p, i + 5) * 256 + get_byte(p, i + 6); w := get_byte(p, i + 7) * 256 + get_byte(p, i + 8);
      if h < 1 or w < 1 or h > 4096 or w > 4096 then return 'The photo is too large (at most 4096 pixels on a side).'; end if;
      seen_sof := true;
    elsif m = 218 then
      if not seen_sof then return 'The photo is not a valid JPEG.'; end if;
      exit;
    else
      return 'The photo carries location, camera or other hidden data. Remove it and try again.';
    end if;
    i := i + 2 + len;
  end loop;
  for k in 224..239 loop
    if position(decode('ff' || lpad(to_hex(k), 2, '0'), 'hex') in substring(p from i + 2)) > 0 then
      return 'The photo carries location, camera or other hidden data. Remove it and try again.'; end if;
  end loop;
  if position('\xfffe'::bytea in substring(p from i + 2)) > 0 then
    return 'The photo carries location, camera or other hidden data. Remove it and try again.'; end if;
  return null;
end;
$mg$;

-- validates a jsonb array of base64 photos: returns an error message, or NULL and the decoded files -----------------
create or replace function public.mg_voice_photos(p_attachments jsonb, out v_error text, out v_files bytea[])
language plpgsql immutable as $mg$
declare v_item jsonb; v_bin bytea; v_problem text; v_total integer := 0;
begin
  v_files := '{}';
  if p_attachments is null or p_attachments = 'null'::jsonb then return; end if;
  if jsonb_typeof(p_attachments) <> 'array' or jsonb_array_length(p_attachments) > 3 then v_error := 'You can attach up to 3 photos.'; return; end if;
  for v_item in select * from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(v_item) <> 'string' or char_length(v_item #>> '{}') > 1400000 then v_error := 'A photo is too large or not valid.'; return; end if;
    begin v_bin := decode(v_item #>> '{}', 'base64'); exception when others then v_error := 'A photo could not be read.'; return; end;
    v_problem := public.mg_wv_jpeg_problem(v_bin);
    if v_problem is not null then v_error := v_problem; return; end if;
    v_total := v_total + length(v_bin); v_files := v_files || v_bin;
  end loop;
  if v_total > 2400000 then v_error := 'The photos together are too large.'; v_files := '{}'; end if;
end;
$mg$;

-- A6: small sites -------------------------------------------------------------------------------------------------------
create or replace function public.mg_wv_small_site_threshold() returns integer language sql immutable as $mg$ select 10 $mg$;
create or replace function public.mg_wv_small_site(p_site uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select (select count(distinct sa.user_id) from public.site_assignments sa
            join public.organization_members m on m.user_id = sa.user_id and m.status = 'active'
           where sa.site_id = p_site and sa.revoked_at is null) < public.mg_wv_small_site_threshold()
$mg$;

-- A3: one internal way to tell a person, in-app and (if subscribed) on their device ---------------------------------------
create or replace function public.mg_voice_notify_user(p_user uuid, p_key text, p_title text, p_body text, p_link text, p_urgent boolean, p_push_kind text)
returns void language plpgsql security definer set search_path = public as $mg$
declare v_n integer;
begin
  perform set_config('mg.notify', '1', true);
  insert into public.notifications (user_id, source_key, kind, severity, title, body, link_to, event_at)
  values (p_user, p_key, 'worker_voice', case when p_urgent then 'urgent' else 'info' end, p_title, p_body, p_link, now())
  on conflict (user_id, source_key) do nothing;
  get diagnostics v_n = row_count;
  perform set_config('mg.notify', '0', true);
  if v_n > 0 and p_push_kind is not null and exists (select 1 from public.push_subscriptions ps where ps.user_id = p_user and ps.expired_at is null and ps.revoked_at is null) then
    insert into public.voice_push_outbox (user_id, kind) values (p_user, p_push_kind);
  end if;
end;
$mg$;
revoke all on function public.mg_voice_notify_user(uuid, text, text, text, text, boolean, text) from public, anon, authenticated;

create or replace function public.mg_wv_notify(p_report uuid, p_org uuid, p_site uuid, p_route text, p_urgent boolean, p_skip uuid)
returns void language plpgsql security definer set search_path = public as $mg$
declare r record; v_key text := 'wv:' || p_report::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
begin
  for r in select distinct m.user_id from public.organization_members m join public.organizations o on o.id = m.organization_id
            where m.organization_id = p_org and m.status = 'active' and o.status = 'approved'
              and (p_skip is null or m.user_id <> p_skip) and public.mg_wv_user_can_review(m.user_id, p_org, p_site, p_route) loop
    perform public.mg_voice_notify_user(r.user_id, v_key, 'A safety report requires review',
      'MineGuard: A safety report requires review. Sign in with your authorized account to access it.', '/operate/voice-review', p_urgent, 'company');
  end loop;
end;
$mg$;
revoke all on function public.mg_wv_notify(uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated;

create or replace function public.mg_mv_notify(p_report uuid, p_urgent boolean, p_skip uuid)
returns void language plpgsql security definer set search_path = public as $mg$
declare r record; v_key text := 'mv:' || p_report::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
begin
  for r in select p.id from public.profiles p where public.mg_mv_user_is_reviewer(p.id) and (p_skip is null or p.id <> p_skip) loop
    perform public.mg_voice_notify_user(r.id, v_key, 'A worker report requires review',
      'MineGuard: A worker report requires review. Sign in with your authorized account to access it.', '/portal/voice-ministry', p_urgent, 'ministry');
  end loop;
end;
$mg$;
revoke all on function public.mg_mv_notify(uuid, boolean, uuid) from public, anon, authenticated;

-- A8: lifecycle guards (legal hold may change on a closed report; disposal may delete) --------------------------------
create or replace function public.mg_wv_report_guard()
returns trigger language plpgsql as $mg$
declare v_order text[] := array['received','triage','investigating','action_assigned','follow_up','closed'];
        v_strip text[] := array['legal_hold','legal_hold_reason','updated_at','row_version'];
begin
  if tg_op = 'DELETE' then
    if current_setting('mg.voice_disposal', true) = '1' then return old; end if;
    raise exception 'IMMUTABLE: reports are never deleted';
  end if;
  if old.status = 'closed' then
    if (to_jsonb(new) - v_strip) is distinct from (to_jsonb(old) - v_strip) then raise exception 'IMMUTABLE: a closed report cannot be changed'; end if;
    new.updated_at := now(); new.row_version := old.row_version + 1; return new;
  end if;
  if new.organization_id is distinct from old.organization_id or new.site_id is distinct from old.site_id
     or new.mode is distinct from old.mode or new.category is distinct from old.category
     or new.urgency is distinct from old.urgency or new.description is distinct from old.description
     or new.occurred_at is distinct from old.occurred_at or new.previously_reported is distinct from old.previously_reported
     or new.code_hash is distinct from old.code_hash or new.fingerprint is distinct from old.fingerprint
     or new.created_at is distinct from old.created_at or new.small_site is distinct from old.small_site then
    raise exception 'IMMUTABLE: a submitted report''s content cannot be edited';
  end if;
  if array_position(v_order, new.status) < array_position(v_order, old.status) then
    raise exception 'CONFLICT: a report cannot move backwards (% -> %)', old.status, new.status; end if;
  if new.status = 'closed' then
    if coalesce(char_length(btrim(new.closure_reason)), 0) < 10 then raise exception 'CLOSURE_REASON_REQUIRED: say why the report is being closed'; end if;
    new.closed_at := now();
  end if;
  if old.route = 'company_admin' and new.route = 'site' then raise exception 'CONFLICT: an escalated report cannot be routed back down'; end if;
  new.updated_at := now(); new.row_version := old.row_version + 1;
  return new;
end;
$mg$;

create or replace function public.mg_mv_report_guard()
returns trigger language plpgsql as $mg$
declare v_order text[] := array['received','triage','investigating','action_taken','closed'];
        v_strip text[] := array['legal_hold','legal_hold_reason','updated_at','row_version'];
begin
  if tg_op = 'DELETE' then
    if current_setting('mg.voice_disposal', true) = '1' then return old; end if;
    raise exception 'IMMUTABLE: reports are never deleted';
  end if;
  if old.status = 'closed' then
    if (to_jsonb(new) - v_strip) is distinct from (to_jsonb(old) - v_strip) then raise exception 'IMMUTABLE: a closed report cannot be changed'; end if;
    new.updated_at := now(); new.row_version := old.row_version + 1; return new;
  end if;
  if new.organization_id is distinct from old.organization_id or new.site_id is distinct from old.site_id
     or new.mode is distinct from old.mode or new.category is distinct from old.category
     or new.urgency is distinct from old.urgency or new.description is distinct from old.description
     or new.occurred_at is distinct from old.occurred_at or new.previously_reported is distinct from old.previously_reported
     or new.code_hash is distinct from old.code_hash or new.fingerprint is distinct from old.fingerprint
     or new.created_at is distinct from old.created_at or new.small_site is distinct from old.small_site then
    raise exception 'IMMUTABLE: a submitted report''s content cannot be edited';
  end if;
  if array_position(v_order, new.status) < array_position(v_order, old.status) then
    raise exception 'CONFLICT: a report cannot move backwards (% -> %)', old.status, new.status; end if;
  if new.status = 'closed' then
    if coalesce(char_length(btrim(new.closure_reason)), 0) < 10 then raise exception 'CLOSURE_REASON_REQUIRED: say why the report is being closed'; end if;
    new.closed_at := now();
  end if;
  new.updated_at := now(); new.row_version := old.row_version + 1;
  return new;
end;
$mg$;

-- ===========================================================================
-- COMPANY CHANNEL
-- ===========================================================================
drop policy if exists "wv messages read" on public.worker_voice_messages;
create policy "wv messages read" on public.worker_voice_messages for select to authenticated
  using (exists (select 1 from public.worker_voice_reports r where r.id = report_id and public.mg_wv_can_review(r.organization_id, r.site_id, r.route)));
grant select on public.worker_voice_messages to authenticated;

drop function if exists public.mg_wv_insert(text, uuid, text, text, text, timestamptz, text, boolean, text, uuid);
create or replace function public.mg_wv_insert(
  p_mode text, p_site uuid, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_concerns boolean, p_code text, p_reporter uuid, p_attachments jsonb)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare
  v_org uuid; v_route text; v_fp text; v_dup uuid; v_id uuid; v_desc text := btrim(coalesce(p_description, ''));
  v_created timestamptz; v_small boolean; v_occ timestamptz; v_files bytea[]; v_err text;
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
  select * into v_err, v_files from public.mg_voice_photos(p_attachments);
  if v_err is not null then return jsonb_build_object('status','invalid','message', v_err); end if;

  v_route := case when coalesce(p_concerns, false) then 'company_admin' else 'site' end;
  v_small := public.mg_wv_small_site(p_site);
  v_fp := encode(sha256(convert_to(lower(regexp_replace(v_desc, '\s+', ' ', 'g')) || '|' || p_category, 'UTF8')), 'hex');
  select r.id into v_dup from public.worker_voice_reports r
   where r.site_id = p_site and r.fingerprint = v_fp and r.created_at > now() - interval '14 days' order by r.created_at limit 1;
  v_created := case when p_mode = 'named' then now() when v_small then date_trunc('day', now()) else date_trunc('hour', now()) end;
  v_occ := case when p_mode <> 'named' and v_small and p_occurred is not null then date_trunc('day', p_occurred) else p_occurred end;

  insert into public.worker_voice_reports (organization_id, site_id, mode, category, urgency, description, occurred_at,
                                           previously_reported, route, fingerprint, duplicate_of, code_hash, created_at, small_site)
  values (v_org, p_site, p_mode, p_category, p_urgency, v_desc, v_occ, p_previously, v_route, v_fp, v_dup, public.mg_wv_hash(p_code), v_created, v_small)
  on conflict (code_hash) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('status','duplicate'); end if;

  for i in 1 .. coalesce(array_length(v_files, 1), 0) loop
    insert into public.worker_voice_attachments (report_id, content, bytes, sha256) values (v_id, v_files[i], length(v_files[i]), encode(sha256(v_files[i]), 'hex'));
  end loop;
  if p_reporter is not null then insert into public.worker_voice_identity (report_id, reporter_id) values (v_id, p_reporter); end if;
  if p_mode = 'anonymous' then
    insert into public.worker_voice_code_usage (site_id, day, n) values (p_site, current_date, 1)
    on conflict (site_id, day) do update set n = public.worker_voice_code_usage.n + 1;
  end if;
  insert into public.worker_voice_events (report_id, event, actor_id) values (v_id, 'submitted', null);
  perform public.mg_wv_notify(v_id, v_org, p_site, v_route, p_urgency in ('high','critical'), p_reporter);
  return jsonb_build_object('status','received', 'possibleDuplicate', v_dup is not null, 'smallSite', v_small);
end;
$mg$;
revoke all on function public.mg_wv_insert(text, uuid, text, text, text, timestamptz, text, boolean, text, uuid, jsonb) from public, anon, authenticated;

drop function if exists public.mg_wv_submit(text, uuid, text, text, text, timestamptz, text, boolean, text);
create or replace function public.mg_wv_submit(
  p_mode text, p_site uuid, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_concerns boolean, p_code text, p_attachments jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in to send a named or confidential report'; end if;
  if p_mode not in ('named','confidential') then raise exception 'INVALID: use the anonymous route for anonymous reports'; end if;
  if not public.mg_can_prepare_jsa(p_site) then raise exception 'FORBIDDEN: you are not a member allowed at this site'; end if;
  if not public.mg_wv_rate('wv:u:' || encode(sha256(convert_to('wv-user:' || auth.uid()::text, 'UTF8')), 'hex'), 10, interval '1 hour') then
    return jsonb_build_object('status','rate_limited'); end if;
  return public.mg_wv_insert(p_mode, p_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_concerns, p_code, auth.uid(), p_attachments);
end;
$mg$;

drop function if exists public.mg_wv_submit_anonymous(text, text, text, text, timestamptz, text, boolean, text);
create or replace function public.mg_wv_submit_anonymous(
  p_site_code text, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_concerns boolean, p_code text, p_attachments jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_site uuid; v_enabled boolean; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  delete from public.rate_limits where bucket like 'wv:%' and window_start < now() - interval '1 day';
  if not public.mg_wv_rate(public.mg_wv_src('wv:a'), case when v_known then 10 else 200 end, interval '1 hour') then return jsonb_build_object('status','rate_limited'); end if;
  select c.site_id, c.anonymous_enabled into v_site, v_enabled from public.worker_voice_site_codes c
   where c.code = upper(regexp_replace(coalesce(p_site_code, ''), '[^0-9A-Za-z]', '', 'g')) and c.expires_at > now();
  if v_site is null then
    if not public.mg_wv_rate(public.mg_wv_src('wv:f'), case when v_known then 10 else 100 end, interval '1 hour') then return jsonb_build_object('status','rate_limited'); end if;
    return jsonb_build_object('status','invalid_site_code');
  end if;
  if not v_enabled then return jsonb_build_object('status','anonymous_paused'); end if;
  if not public.mg_wv_rate('wv:s:' || v_site::text, 60, interval '1 hour') then return jsonb_build_object('status','rate_limited'); end if;
  return public.mg_wv_insert('anonymous', v_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_concerns, p_code, null, p_attachments);
end;
$mg$;

create or replace function public.mg_wv_site_info(p_site_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_site uuid; v_enabled boolean; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  if not public.mg_wv_rate(public.mg_wv_src('wv:i'), case when v_known then 60 else 600 end, interval '1 hour') then return jsonb_build_object('valid', false, 'status', 'rate_limited'); end if;
  select c.site_id, c.anonymous_enabled into v_site, v_enabled from public.worker_voice_site_codes c
   where c.code = upper(regexp_replace(coalesce(p_site_code, ''), '[^0-9A-Za-z]', '', 'g')) and c.expires_at > now();
  if v_site is null then
    if not public.mg_wv_rate(public.mg_wv_src('wv:f'), case when v_known then 10 else 100 end, interval '1 hour') then return jsonb_build_object('valid', false, 'status', 'rate_limited'); end if;
    return jsonb_build_object('valid', false);
  end if;
  return jsonb_build_object('valid', true, 'smallSite', public.mg_wv_small_site(v_site), 'paused', not v_enabled);
end;
$mg$;

create or replace function public.mg_wv_site_small(p_site uuid)
returns boolean language plpgsql stable security definer set search_path = public as $mg$
begin
  if auth.uid() is null or not public.mg_can_prepare_jsa(p_site) then raise exception 'FORBIDDEN'; end if;
  return public.mg_wv_small_site(p_site);
end;
$mg$;

-- company site code: members read it; it expires after 90 days (a member's next request issues a new one) ----------------
create or replace function public.mg_wv_site_code(p_site uuid)
returns text language plpgsql security definer set search_path = public as $mg$
declare v_org uuid; v_code text; v_exp timestamptz;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select organization_id into v_org from public.sites where id = p_site;
  if v_org is null or not (public.mg_can_prepare_jsa(p_site) or public.mg_wv_can_review(v_org, p_site, 'site')) then
    raise exception 'FORBIDDEN: you cannot see this site''s code'; end if;
  select code, expires_at into v_code, v_exp from public.worker_voice_site_codes where site_id = p_site;
  if v_code is null or v_exp <= now() then
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    insert into public.worker_voice_site_codes (site_id, code, expires_at) values (p_site, v_code, now() + interval '90 days')
    on conflict (site_id) do update set code = excluded.code, rotated_at = now(), expires_at = excluded.expires_at;
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
    raise exception 'FORBIDDEN: only the company administrator or the site''s manager or safety officer can change the code'; end if;
  insert into public.worker_voice_site_codes (site_id, code, expires_at) values (p_site, v_code, now() + interval '90 days')
  on conflict (site_id) do update set code = excluded.code, rotated_at = now(), expires_at = excluded.expires_at;
  return v_code;
end;
$mg$;

create or replace function public.mg_wv_set_anonymous(p_site uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $mg$
declare v_org uuid;
begin
  select organization_id into v_org from public.sites where id = p_site;
  if v_org is null or not public.mg_wv_can_review(v_org, p_site, 'site') then
    raise exception 'FORBIDDEN: only the company administrator or the site''s manager or safety officer can pause anonymous reporting'; end if;
  perform public.mg_wv_site_code(p_site);
  update public.worker_voice_site_codes set anonymous_enabled = coalesce(p_enabled, true) where site_id = p_site;
end;
$mg$;

create or replace function public.mg_wv_code_info(p_site uuid)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_org uuid; c public.worker_voice_site_codes; v_today integer; v_week integer; v_avg numeric;
begin
  select organization_id into v_org from public.sites where id = p_site;
  if v_org is null or not public.mg_wv_can_review(v_org, p_site, 'site') then raise exception 'FORBIDDEN: you cannot see this site''s code'; end if;
  perform public.mg_wv_site_code(p_site);
  select * into c from public.worker_voice_site_codes where site_id = p_site;
  select coalesce(sum(n) filter (where day = current_date), 0), coalesce(sum(n) filter (where day > current_date - 7), 0) into v_today, v_week
    from public.worker_voice_code_usage where site_id = p_site;
  v_avg := greatest((v_week - v_today) / 6.0, 1);
  return jsonb_build_object('code', c.code, 'expiresOn', c.expires_at::date, 'enabled', c.anonymous_enabled, 'today', v_today, 'week', v_week,
                            'unusual', v_today >= 20 and v_today > 4 * v_avg);
end;
$mg$;

-- messaging ------------------------------------------------------------------------------------------------------------------
create or replace function public.mg_wv_post_update(p_id uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  r := public.mg_wv_load(p_id);
  if coalesce(char_length(btrim(p_text)), 0) not between 1 and 500 then raise exception 'INVALID: write 1 to 500 characters for the reporter'; end if;
  update public.worker_voice_reports set reporter_update = btrim(p_text), reporter_update_at = now() where id = p_id;
  insert into public.worker_voice_messages (report_id, from_reporter, body) values (p_id, false, btrim(p_text));
  insert into public.worker_voice_events (report_id, event, actor_id) values (p_id, 'update_posted', auth.uid());
end;
$mg$;

drop function if exists public.mg_wv_status(text);
create or replace function public.mg_wv_status(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports; v_known boolean := coalesce(public.mg_client_ip(), '') <> ''; v_msgs jsonb;
begin
  if not public.mg_wv_rate(public.mg_wv_src('wv:l'), case when v_known then 60 else 600 end, interval '1 hour') then return jsonb_build_object('found', false, 'status', 'rate_limited'); end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' then return jsonb_build_object('found', false); end if;
  select * into r from public.worker_voice_reports where code_hash = public.mg_wv_hash(p_code);
  if not found then
    if not public.mg_wv_rate(public.mg_wv_src('wv:lf'), case when v_known then 10 else 100 end, interval '1 hour') then return jsonb_build_object('found', false, 'status', 'rate_limited'); end if;
    return jsonb_build_object('found', false);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('from', case when m.from_reporter then 'you' else 'reviewers' end, 'text', m.body, 'on', m.at::date) order by m.seq), '[]'::jsonb)
    into v_msgs from (select * from public.worker_voice_messages where report_id = r.id order by seq desc limit 30) m;
  return jsonb_build_object(
    'found', true,
    'stage', case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed' when 'investigating' then 'Under investigation'
                           when 'action_assigned' then 'Action in progress' when 'follow_up' then 'Action in progress' else 'Closed' end,
    'closed', r.status = 'closed', 'lastChange', (coalesce(r.updated_at, r.created_at))::date,
    'update', r.reporter_update, 'updateOn', r.reporter_update_at::date,
    'messages', v_msgs, 'canReply', r.status <> 'closed',
    -- unresolved for two weeks, or closed: the reporter is told the Ministry channel exists (no link is made between them)
    'ministryOption', r.status = 'closed' or r.created_at < now() - interval '14 days');
end;
$mg$;

create or replace function public.mg_wv_reply(p_code text, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports; v_known boolean := coalesce(public.mg_client_ip(), '') <> ''; v_body text := btrim(coalesce(p_text, ''));
begin
  if not public.mg_wv_rate(public.mg_wv_src('wv:r'), case when v_known then 20 else 200 end, interval '1 hour') then return jsonb_build_object('status', 'rate_limited'); end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1000 then return jsonb_build_object('status', 'invalid', 'message', 'Write 1 to 1000 characters.'); end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' then return jsonb_build_object('status', 'not_found'); end if;
  select * into r from public.worker_voice_reports where code_hash = public.mg_wv_hash(p_code);
  if not found then
    if not public.mg_wv_rate(public.mg_wv_src('wv:lf'), case when v_known then 10 else 100 end, interval '1 hour') then return jsonb_build_object('status', 'rate_limited'); end if;
    return jsonb_build_object('status', 'not_found');
  end if;
  if r.status = 'closed' then return jsonb_build_object('status', 'closed'); end if;
  if (select count(*) from public.worker_voice_messages m where m.report_id = r.id and m.from_reporter and m.at > now() - interval '1 day') >= 10 then return jsonb_build_object('status', 'rate_limited'); end if;
  insert into public.worker_voice_messages (report_id, from_reporter, body, at) values (r.id, true, v_body, date_trunc('hour', now()));
  perform public.mg_wv_notify(r.id, r.organization_id, r.site_id, r.route, false, null);
  return jsonb_build_object('status', 'received');
end;
$mg$;

create or replace function public.mg_wv_reply_mine(p_id uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports; v_body text := btrim(coalesce(p_text, ''));
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select rr.* into r from public.worker_voice_reports rr join public.worker_voice_identity i on i.report_id = rr.id where rr.id = p_id and i.reporter_id = auth.uid();
  if not found then raise exception 'FORBIDDEN: this is not your report'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1000 then raise exception 'INVALID: write 1 to 1000 characters'; end if;
  if r.status = 'closed' then raise exception 'CONFLICT: this report is closed'; end if;
  if (select count(*) from public.worker_voice_messages m where m.report_id = r.id and m.from_reporter and m.at > now() - interval '1 day') >= 10 then raise exception 'RATE_LIMITED: too many messages today'; end if;
  insert into public.worker_voice_messages (report_id, from_reporter, body, at) values (r.id, true, v_body, date_trunc('hour', now()));
  perform public.mg_wv_notify(r.id, r.organization_id, r.site_id, r.route, false, auth.uid());
end;
$mg$;

drop function if exists public.mg_wv_my_reports();
create or replace function public.mg_wv_my_reports()
returns table (id uuid, received_on date, mode text, category text, stage text, reporter_update text, reporter_update_on date, identity_opened integer, can_reply boolean)
language sql stable security definer set search_path = public as $mg$
  select r.id, r.created_at::date, r.mode, r.category,
         case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed' when 'investigating' then 'Under investigation'
                       when 'action_assigned' then 'Action in progress' when 'follow_up' then 'Action in progress' else 'Closed' end,
         r.reporter_update, r.reporter_update_at::date,
         (select count(*)::int from public.worker_voice_events e where e.report_id = r.id and e.event = 'identity_revealed'), r.status <> 'closed'
    from public.worker_voice_identity i join public.worker_voice_reports r on r.id = i.report_id
   where i.reporter_id = auth.uid() order by r.created_at desc limit 50
$mg$;

-- photos ----------------------------------------------------------------------------------------------------------------------
create or replace function public.mg_wv_attachments(p_report uuid)
returns table (id uuid, bytes integer, sha256 text, data text)
language plpgsql stable security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  select * into r from public.worker_voice_reports where worker_voice_reports.id = p_report;
  if not found or not public.mg_wv_can_review(r.organization_id, r.site_id, r.route) then raise exception 'FORBIDDEN: you are not authorized to see this report''s photos'; end if;
  return query select a.id, a.bytes, a.sha256, encode(a.content, 'base64') from public.worker_voice_attachments a where a.report_id = p_report order by a.created_at, a.id;
end;
$mg$;
create or replace function public.mg_wv_attachment_counts()
returns table (report_id uuid, n integer)
language sql stable security definer set search_path = public as $mg$
  select a.report_id, count(*)::int from public.worker_voice_attachments a join public.worker_voice_reports r on r.id = a.report_id
   where public.mg_wv_can_review(r.organization_id, r.site_id, r.route) group by a.report_id
$mg$;

-- F2: the escalation dead end now points somewhere --------------------------------------------------------------------------
create or replace function public.mg_wv_escalate(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  r := public.mg_wv_load(p_id);
  if r.route = 'company_admin' then
    raise exception 'ALREADY_ESCALATED: this is with the company administrators. For a concern about the company''s administrators or management, the reporter can use the Ministry channel';
  end if;
  if coalesce(char_length(btrim(p_reason)), 0) < 10 then raise exception 'INVALID: give a reason of at least 10 characters'; end if;
  update public.worker_voice_reports set route = 'company_admin', escalated_at = now(), assigned_to = null where id = p_id;
  insert into public.worker_voice_events (report_id, event, actor_id, detail) values (p_id, 'escalated', auth.uid(), left(btrim(p_reason), 300));
  perform public.mg_wv_notify(p_id, r.organization_id, r.site_id, 'company_admin', true, auth.uid());
end;
$mg$;

-- A8: legal hold and disposal (company administrators, for their own company's reports) -----------------------------------
create or replace function public.mg_wv_set_hold(p_id uuid, p_hold boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  r := public.mg_wv_load(p_id);
  if not public.mg_is_company_admin(r.organization_id) then raise exception 'FORBIDDEN: only a company administrator can place or lift a legal hold'; end if;
  if coalesce(p_hold, false) and coalesce(char_length(btrim(p_reason)), 0) < 10 then raise exception 'INVALID: state the reason for the hold (at least 10 characters)'; end if;
  update public.worker_voice_reports set legal_hold = coalesce(p_hold, false), legal_hold_reason = case when coalesce(p_hold, false) then btrim(p_reason) else null end where id = p_id;
  insert into public.worker_voice_events (report_id, event, actor_id, detail) values (p_id, case when coalesce(p_hold, false) then 'hold_set' else 'hold_cleared' end, auth.uid(), left(btrim(coalesce(p_reason, '')), 300));
end;
$mg$;

create or replace function public.mg_wv_dispose(p_org uuid, p_dry_run boolean default true, p_confirm text default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_months integer; v_ids uuid[]; v_n integer;
begin
  if auth.uid() is null or not public.mg_is_company_admin(p_org) then raise exception 'FORBIDDEN: only a company administrator can dispose of the company''s reports'; end if;
  select retention_months into v_months from public.voice_retention_policy where channel = 'company';
  select coalesce(array_agg(r.id), '{}') into v_ids from public.worker_voice_reports r
   where r.organization_id = p_org and r.status = 'closed' and not r.legal_hold
     and coalesce(r.closed_at, r.updated_at, r.created_at) < now() - make_interval(months => v_months);
  v_n := coalesce(array_length(v_ids, 1), 0);
  if coalesce(p_dry_run, true) then return jsonb_build_object('dryRun', true, 'eligible', v_n, 'retentionMonths', v_months); end if;
  if p_confirm is distinct from 'DISPOSE' then raise exception 'CONFIRMATION_REQUIRED: type DISPOSE to permanently delete % report(s)', v_n; end if;
  perform set_config('mg.voice_disposal', '1', true);
  delete from public.worker_voice_events where report_id = any (v_ids);
  delete from public.worker_voice_identity where report_id = any (v_ids);
  delete from public.worker_voice_messages where report_id = any (v_ids);
  delete from public.worker_voice_attachments where report_id = any (v_ids);
  delete from public.worker_voice_reports where id = any (v_ids);
  perform set_config('mg.voice_disposal', '0', true);
  insert into public.voice_disposal_log (channel, organization_id, actor_id, deleted_reports, retention_months) values ('company', p_org, auth.uid(), v_n, v_months);
  return jsonb_build_object('dryRun', false, 'deleted', v_n, 'retentionMonths', v_months);
end;
$mg$;

-- ===========================================================================
-- MINISTRY CHANNEL
-- ===========================================================================
drop policy if exists "mv messages read" on public.ministry_voice_messages;
create policy "mv messages read" on public.ministry_voice_messages for select to authenticated
  using (public.mg_mv_is_reviewer());
grant select on public.ministry_voice_messages to authenticated;

drop function if exists public.mg_mv_insert(text, uuid, text, text, text, timestamptz, text, text, uuid);
create or replace function public.mg_mv_insert(
  p_mode text, p_site uuid, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_code text, p_reporter uuid, p_attachments jsonb)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare
  v_org uuid; v_fp text; v_dup uuid; v_id uuid; v_desc text := btrim(coalesce(p_description, ''));
  v_created timestamptz; v_small boolean; v_occ timestamptz; v_files bytea[]; v_err text;
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
  select * into v_err, v_files from public.mg_voice_photos(p_attachments);
  if v_err is not null then return jsonb_build_object('status','invalid','message', v_err); end if;

  v_small := public.mg_wv_small_site(p_site);
  v_fp := encode(sha256(convert_to(lower(regexp_replace(v_desc, '\s+', ' ', 'g')) || '|' || p_category, 'UTF8')), 'hex');
  select r.id into v_dup from public.ministry_voice_reports r
   where r.site_id = p_site and r.fingerprint = v_fp and r.created_at > now() - interval '14 days' order by r.created_at limit 1;
  v_created := case when p_mode = 'named' then now() when v_small then date_trunc('day', now()) else date_trunc('hour', now()) end;
  v_occ := case when p_mode <> 'named' and v_small and p_occurred is not null then date_trunc('day', p_occurred) else p_occurred end;

  insert into public.ministry_voice_reports (organization_id, site_id, mode, category, urgency, description, occurred_at,
                                             previously_reported, fingerprint, duplicate_of, code_hash, created_at, small_site)
  values (v_org, p_site, p_mode, p_category, p_urgency, v_desc, v_occ, p_previously, v_fp, v_dup, public.mg_mv_hash(p_code), v_created, v_small)
  on conflict (code_hash) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('status','duplicate'); end if;

  for i in 1 .. coalesce(array_length(v_files, 1), 0) loop
    insert into public.ministry_voice_attachments (report_id, content, bytes, sha256) values (v_id, v_files[i], length(v_files[i]), encode(sha256(v_files[i]), 'hex'));
  end loop;
  if p_reporter is not null then insert into public.ministry_voice_identity (report_id, reporter_id) values (v_id, p_reporter); end if;
  if p_mode = 'anonymous' then
    insert into public.ministry_voice_code_usage (site_id, day, n) values (p_site, current_date, 1)
    on conflict (site_id, day) do update set n = public.ministry_voice_code_usage.n + 1;
  end if;
  insert into public.ministry_voice_events (report_id, event, actor_id) values (v_id, 'submitted', null);
  perform public.mg_mv_notify(v_id, p_urgency in ('high','critical'), p_reporter);
  return jsonb_build_object('status','received', 'possibleDuplicate', v_dup is not null, 'smallSite', v_small);
end;
$mg$;
revoke all on function public.mg_mv_insert(text, uuid, text, text, text, timestamptz, text, text, uuid, jsonb) from public, anon, authenticated;

drop function if exists public.mg_mv_submit(text, uuid, text, text, text, timestamptz, text, text);
create or replace function public.mg_mv_submit(
  p_mode text, p_site uuid, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_code text, p_attachments jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in to send a named or confidential report'; end if;
  if p_mode not in ('named','confidential') then raise exception 'INVALID: use the anonymous route for anonymous reports'; end if;
  if not public.mg_can_prepare_jsa(p_site) then raise exception 'FORBIDDEN: you are not a member allowed at this site'; end if;
  if not public.mg_wv_rate('mv:u:' || encode(sha256(convert_to('mv-user:' || auth.uid()::text, 'UTF8')), 'hex'), 10, interval '1 hour') then
    return jsonb_build_object('status','rate_limited'); end if;
  return public.mg_mv_insert(p_mode, p_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_code, auth.uid(), p_attachments);
end;
$mg$;

-- F1: anonymous Ministry intake uses the MINISTRY's code, never the company's ------------------------------------------------
drop function if exists public.mg_mv_submit_anonymous(text, text, text, text, timestamptz, text, text);
create or replace function public.mg_mv_submit_anonymous(
  p_site_code text, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_code text, p_attachments jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_site uuid; v_enabled boolean; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  delete from public.rate_limits where bucket like 'mv:%' and window_start < now() - interval '1 day';
  if not public.mg_wv_rate(public.mg_mv_src('mv:a'), case when v_known then 10 else 200 end, interval '1 hour') then return jsonb_build_object('status','rate_limited'); end if;
  select c.site_id, c.anonymous_enabled into v_site, v_enabled from public.ministry_voice_site_codes c
   where c.code = upper(regexp_replace(coalesce(p_site_code, ''), '[^0-9A-Za-z]', '', 'g'));
  if v_site is null then
    if not public.mg_wv_rate(public.mg_mv_src('mv:f'), case when v_known then 10 else 100 end, interval '1 hour') then return jsonb_build_object('status','rate_limited'); end if;
    return jsonb_build_object('status','invalid_site_code');
  end if;
  if not v_enabled then return jsonb_build_object('status','anonymous_paused'); end if;
  if not public.mg_wv_rate('mv:s:' || v_site::text, 60, interval '1 hour') then return jsonb_build_object('status','rate_limited'); end if;
  return public.mg_mv_insert('anonymous', v_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_code, null, p_attachments);
end;
$mg$;

create or replace function public.mg_mv_site_info(p_site_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_site uuid; v_enabled boolean; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  if not public.mg_wv_rate(public.mg_mv_src('mv:i'), case when v_known then 60 else 600 end, interval '1 hour') then return jsonb_build_object('valid', false, 'status', 'rate_limited'); end if;
  select c.site_id, c.anonymous_enabled into v_site, v_enabled from public.ministry_voice_site_codes c
   where c.code = upper(regexp_replace(coalesce(p_site_code, ''), '[^0-9A-Za-z]', '', 'g'));
  if v_site is null then
    if not public.mg_wv_rate(public.mg_mv_src('mv:f'), case when v_known then 10 else 100 end, interval '1 hour') then return jsonb_build_object('valid', false, 'status', 'rate_limited'); end if;
    return jsonb_build_object('valid', false);
  end if;
  return jsonb_build_object('valid', true, 'smallSite', public.mg_wv_small_site(v_site), 'paused', not v_enabled);
end;
$mg$;

-- a site member's app fetches the Ministry code so they can report anonymously without typing it; they can read it and
-- send with it, nothing more (rotation and pausing are Ministry administrators only)
create or replace function public.mg_mv_site_code(p_site uuid)
returns text language plpgsql security definer set search_path = public as $mg$
declare v_code text;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if not (public.mg_can_prepare_jsa(p_site) or public.mg_mv_is_reviewer()) then raise exception 'FORBIDDEN: you cannot see this site''s code'; end if;
  select code into v_code from public.ministry_voice_site_codes where site_id = p_site;
  if v_code is null then
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    insert into public.ministry_voice_site_codes (site_id, code) values (p_site, v_code) on conflict (site_id) do nothing;
    select code into v_code from public.ministry_voice_site_codes where site_id = p_site;
  end if;
  return v_code;
end;
$mg$;

create or replace function public.mg_mv_code_sites(p_search text default null)
returns table (site_id uuid, site_name text, organization_name text)
language plpgsql stable security definer set search_path = public as $mg$
begin
  if not public.mg_voice_is_ministry_admin() then raise exception 'FORBIDDEN: only a Ministry administrator manages intake codes'; end if;
  return query select s.id, s.name::text, o.name::text from public.sites s join public.organizations o on o.id = s.organization_id
    where coalesce(btrim(p_search), '') = '' or s.name ilike '%' || btrim(p_search) || '%' or o.name ilike '%' || btrim(p_search) || '%'
    order by o.name, s.name limit 40;
end;
$mg$;

create or replace function public.mg_mv_code_info(p_site uuid)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare c public.ministry_voice_site_codes; v_today integer; v_week integer; v_avg numeric;
begin
  if not public.mg_voice_is_ministry_admin() then raise exception 'FORBIDDEN: only a Ministry administrator manages intake codes'; end if;
  perform public.mg_mv_site_code(p_site);
  select * into c from public.ministry_voice_site_codes where site_id = p_site;
  select coalesce(sum(n) filter (where day = current_date), 0), coalesce(sum(n) filter (where day > current_date - 7), 0) into v_today, v_week
    from public.ministry_voice_code_usage where site_id = p_site;
  v_avg := greatest((v_week - v_today) / 6.0, 1);
  return jsonb_build_object('code', c.code, 'changedOn', c.rotated_at::date, 'enabled', c.anonymous_enabled, 'today', v_today, 'week', v_week,
                            'unusual', v_today >= 20 and v_today > 4 * v_avg);
end;
$mg$;

create or replace function public.mg_mv_rotate_code(p_site uuid)
returns text language plpgsql security definer set search_path = public as $mg$
declare v_code text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
begin
  if not public.mg_voice_is_ministry_admin() then raise exception 'FORBIDDEN: only a Ministry administrator manages intake codes'; end if;
  insert into public.ministry_voice_site_codes (site_id, code) values (p_site, v_code)
  on conflict (site_id) do update set code = excluded.code, rotated_at = now();
  return v_code;
end;
$mg$;

create or replace function public.mg_mv_set_anonymous(p_site uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  if not public.mg_voice_is_ministry_admin() then raise exception 'FORBIDDEN: only a Ministry administrator manages intake codes'; end if;
  perform public.mg_mv_site_code(p_site);
  update public.ministry_voice_site_codes set anonymous_enabled = coalesce(p_enabled, true) where site_id = p_site;
end;
$mg$;

-- messaging --------------------------------------------------------------------------------------------------------------------
create or replace function public.mg_mv_post_update(p_id uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports;
begin
  r := public.mg_mv_load(p_id);
  if coalesce(char_length(btrim(p_text)), 0) not between 1 and 500 then raise exception 'INVALID: write 1 to 500 characters for the reporter'; end if;
  update public.ministry_voice_reports set reporter_update = btrim(p_text), reporter_update_at = now() where id = p_id;
  insert into public.ministry_voice_messages (report_id, from_reporter, body) values (p_id, false, btrim(p_text));
  insert into public.ministry_voice_events (report_id, event, actor_id) values (p_id, 'update_posted', auth.uid());
end;
$mg$;

drop function if exists public.mg_mv_status(text);
create or replace function public.mg_mv_status(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports; v_known boolean := coalesce(public.mg_client_ip(), '') <> ''; v_msgs jsonb;
begin
  if not public.mg_wv_rate(public.mg_mv_src('mv:l'), case when v_known then 60 else 600 end, interval '1 hour') then return jsonb_build_object('found', false, 'status', 'rate_limited'); end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' then return jsonb_build_object('found', false); end if;
  select * into r from public.ministry_voice_reports where code_hash = public.mg_mv_hash(p_code);
  if not found then
    if not public.mg_wv_rate(public.mg_mv_src('mv:lf'), case when v_known then 10 else 100 end, interval '1 hour') then return jsonb_build_object('found', false, 'status', 'rate_limited'); end if;
    return jsonb_build_object('found', false);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('from', case when m.from_reporter then 'you' else 'reviewers' end, 'text', m.body, 'on', m.at::date) order by m.seq), '[]'::jsonb)
    into v_msgs from (select * from public.ministry_voice_messages where report_id = r.id order by seq desc limit 30) m;
  return jsonb_build_object(
    'found', true,
    'stage', case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed'
                           when 'investigating' then 'Under review by the Ministry' when 'action_taken' then 'Action taken' else 'Closed' end,
    'closed', r.status = 'closed', 'lastChange', (coalesce(r.updated_at, r.created_at))::date,
    'update', r.reporter_update, 'updateOn', r.reporter_update_at::date, 'messages', v_msgs, 'canReply', r.status <> 'closed');
end;
$mg$;

create or replace function public.mg_mv_reply(p_code text, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports; v_known boolean := coalesce(public.mg_client_ip(), '') <> ''; v_body text := btrim(coalesce(p_text, ''));
begin
  if not public.mg_wv_rate(public.mg_mv_src('mv:r'), case when v_known then 20 else 200 end, interval '1 hour') then return jsonb_build_object('status', 'rate_limited'); end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1000 then return jsonb_build_object('status', 'invalid', 'message', 'Write 1 to 1000 characters.'); end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' then return jsonb_build_object('status', 'not_found'); end if;
  select * into r from public.ministry_voice_reports where code_hash = public.mg_mv_hash(p_code);
  if not found then
    if not public.mg_wv_rate(public.mg_mv_src('mv:lf'), case when v_known then 10 else 100 end, interval '1 hour') then return jsonb_build_object('status', 'rate_limited'); end if;
    return jsonb_build_object('status', 'not_found');
  end if;
  if r.status = 'closed' then return jsonb_build_object('status', 'closed'); end if;
  if (select count(*) from public.ministry_voice_messages m where m.report_id = r.id and m.from_reporter and m.at > now() - interval '1 day') >= 10 then return jsonb_build_object('status', 'rate_limited'); end if;
  insert into public.ministry_voice_messages (report_id, from_reporter, body, at) values (r.id, true, v_body, date_trunc('hour', now()));
  perform public.mg_mv_notify(r.id, false, null);
  return jsonb_build_object('status', 'received');
end;
$mg$;

create or replace function public.mg_mv_reply_mine(p_id uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports; v_body text := btrim(coalesce(p_text, ''));
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select rr.* into r from public.ministry_voice_reports rr join public.ministry_voice_identity i on i.report_id = rr.id where rr.id = p_id and i.reporter_id = auth.uid();
  if not found then raise exception 'FORBIDDEN: this is not your report'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1000 then raise exception 'INVALID: write 1 to 1000 characters'; end if;
  if r.status = 'closed' then raise exception 'CONFLICT: this report is closed'; end if;
  if (select count(*) from public.ministry_voice_messages m where m.report_id = r.id and m.from_reporter and m.at > now() - interval '1 day') >= 10 then raise exception 'RATE_LIMITED: too many messages today'; end if;
  insert into public.ministry_voice_messages (report_id, from_reporter, body, at) values (r.id, true, v_body, date_trunc('hour', now()));
  perform public.mg_mv_notify(r.id, false, auth.uid());
end;
$mg$;

drop function if exists public.mg_mv_my_reports();
create or replace function public.mg_mv_my_reports()
returns table (id uuid, received_on date, mode text, category text, stage text, reporter_update text, reporter_update_on date, identity_opened integer, can_reply boolean)
language sql stable security definer set search_path = public as $mg$
  select r.id, r.created_at::date, r.mode, r.category,
         case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed'
                       when 'investigating' then 'Under review by the Ministry' when 'action_taken' then 'Action taken' else 'Closed' end,
         r.reporter_update, r.reporter_update_at::date,
         (select count(*)::int from public.ministry_voice_events e where e.report_id = r.id and e.event = 'identity_revealed'), r.status <> 'closed'
    from public.ministry_voice_identity i join public.ministry_voice_reports r on r.id = i.report_id
   where i.reporter_id = auth.uid() order by r.created_at desc limit 50
$mg$;

-- photos -----------------------------------------------------------------------------------------------------------------------
create or replace function public.mg_mv_attachments(p_report uuid)
returns table (id uuid, bytes integer, sha256 text, data text)
language plpgsql stable security definer set search_path = public as $mg$
begin
  if not public.mg_mv_is_reviewer() then raise exception 'FORBIDDEN: you are not authorized to see this report''s photos'; end if;
  return query select a.id, a.bytes, a.sha256, encode(a.content, 'base64') from public.ministry_voice_attachments a where a.report_id = p_report order by a.created_at, a.id;
end;
$mg$;
create or replace function public.mg_mv_attachment_counts()
returns table (report_id uuid, n integer)
language plpgsql stable security definer set search_path = public as $mg$
begin
  if not public.mg_mv_is_reviewer() then raise exception 'FORBIDDEN'; end if;
  return query select a.report_id, count(*)::int from public.ministry_voice_attachments a group by a.report_id;
end;
$mg$;

-- the list now carries small-site, hold and close dates -------------------------------------------------------------------------
drop function if exists public.mg_mv_list(integer);
create or replace function public.mg_mv_list(p_limit integer default 300)
returns table (id uuid, organization_id uuid, organization_name text, site_id uuid, site_name text, mode text, category text,
               urgency text, description text, occurred_at timestamptz, previously_reported text, status text,
               triage_severity text, assigned_to uuid, assigned_name text, duplicate_of uuid, closure_reason text,
               reporter_update text, created_at timestamptz, small_site boolean, legal_hold boolean, closed_at timestamptz)
language plpgsql stable security definer set search_path = public as $mg$
begin
  if not public.mg_mv_is_reviewer() then raise exception 'FORBIDDEN: you are not authorized to review worker reports'; end if;
  return query
    select r.id, r.organization_id, o.name::text, r.site_id, s.name::text, r.mode, r.category, r.urgency, r.description,
           r.occurred_at, r.previously_reported, r.status, r.triage_severity, r.assigned_to, a.name::text, r.duplicate_of,
           r.closure_reason, r.reporter_update, r.created_at, r.small_site, r.legal_hold, r.closed_at
      from public.ministry_voice_reports r join public.organizations o on o.id = r.organization_id join public.sites s on s.id = r.site_id
      left join public.profiles a on a.id = r.assigned_to
     order by r.created_at desc limit least(greatest(coalesce(p_limit, 300), 1), 500);
end;
$mg$;

-- A8: hold and disposal for the Ministry channel (Ministry administrators) ---------------------------------------------------------
create or replace function public.mg_mv_set_hold(p_id uuid, p_hold boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.ministry_voice_reports;
begin
  r := public.mg_mv_load(p_id);
  if not public.mg_voice_is_ministry_admin() then raise exception 'FORBIDDEN: only a Ministry administrator can place or lift a legal hold'; end if;
  if coalesce(p_hold, false) and coalesce(char_length(btrim(p_reason)), 0) < 10 then raise exception 'INVALID: state the reason for the hold (at least 10 characters)'; end if;
  update public.ministry_voice_reports set legal_hold = coalesce(p_hold, false), legal_hold_reason = case when coalesce(p_hold, false) then btrim(p_reason) else null end where id = p_id;
  insert into public.ministry_voice_events (report_id, event, actor_id, detail) values (p_id, case when coalesce(p_hold, false) then 'hold_set' else 'hold_cleared' end, auth.uid(), left(btrim(coalesce(p_reason, '')), 300));
end;
$mg$;

create or replace function public.mg_mv_dispose(p_dry_run boolean default true, p_confirm text default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_months integer; v_ids uuid[]; v_n integer;
begin
  if not public.mg_voice_is_ministry_admin() then raise exception 'FORBIDDEN: only a Ministry administrator can dispose of Ministry reports'; end if;
  select retention_months into v_months from public.voice_retention_policy where channel = 'ministry';
  select coalesce(array_agg(r.id), '{}') into v_ids from public.ministry_voice_reports r
   where r.status = 'closed' and not r.legal_hold and coalesce(r.closed_at, r.updated_at, r.created_at) < now() - make_interval(months => v_months);
  v_n := coalesce(array_length(v_ids, 1), 0);
  if coalesce(p_dry_run, true) then return jsonb_build_object('dryRun', true, 'eligible', v_n, 'retentionMonths', v_months); end if;
  if p_confirm is distinct from 'DISPOSE' then raise exception 'CONFIRMATION_REQUIRED: type DISPOSE to permanently delete % report(s)', v_n; end if;
  perform set_config('mg.voice_disposal', '1', true);
  delete from public.ministry_voice_events where report_id = any (v_ids);
  delete from public.ministry_voice_identity where report_id = any (v_ids);
  delete from public.ministry_voice_messages where report_id = any (v_ids);
  delete from public.ministry_voice_attachments where report_id = any (v_ids);
  delete from public.ministry_voice_reports where id = any (v_ids);
  perform set_config('mg.voice_disposal', '0', true);
  insert into public.voice_disposal_log (channel, organization_id, actor_id, deleted_reports, retention_months) values ('ministry', null, auth.uid(), v_n, v_months);
  return jsonb_build_object('dryRun', false, 'deleted', v_n, 'retentionMonths', v_months);
end;
$mg$;

create or replace function public.mg_voice_set_retention(p_channel text, p_months integer)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  if not public.mg_voice_is_ministry_admin() then raise exception 'FORBIDDEN: only a Ministry administrator sets the retention period'; end if;
  if p_channel not in ('company','ministry') then raise exception 'INVALID: unknown channel'; end if;
  if p_months is null or p_months < 12 or p_months > 120 then raise exception 'INVALID: retention must be between 12 and 120 months'; end if;
  update public.voice_retention_policy set retention_months = p_months, updated_by = auth.uid(), updated_at = now() where channel = p_channel;
end;
$mg$;
drop policy if exists "voice retention read" on public.voice_retention_policy;
create policy "voice retention read" on public.voice_retention_policy for select to authenticated using (true);
grant select on public.voice_retention_policy to authenticated;

-- ===========================================================================
-- A7 trends · A2 ageing · A9 Ministry → company requests · A3 push dispatch surface
-- ===========================================================================
create or replace function public.mg_mv_trends(p_months integer default 6)
returns jsonb language plpgsql stable security definer set search_path = public as $mg$
declare v_months integer := least(greatest(coalesce(p_months, 6), 1), 24); v jsonb;
begin
  if not public.mg_mv_is_reviewer() then raise exception 'FORBIDDEN: you are not authorized to review worker reports'; end if;
  with g as (
    select r.*, case when category in ('unsafe_practice','missing_ppe_or_training','hazard_ignored','falsified_records') then 'safety'
                     when category = 'bad_work_habit' then 'conduct' when category = 'other' then 'other' else 'labour' end as grp
      from public.ministry_voice_reports r),
  mo as (select m from generate_series(date_trunc('month', now()) - make_interval(months => v_months - 1), date_trunc('month', now()), interval '1 month') m),
  months as (
    select jsonb_agg(jsonb_build_object('month', to_char(mo.m, 'YYYY-MM'),
             'total', count(g.id), 'safety', count(g.id) filter (where g.grp = 'safety'), 'labour', count(g.id) filter (where g.grp = 'labour'),
             'conduct', count(g.id) filter (where g.grp = 'conduct'), 'other', count(g.id) filter (where g.grp = 'other')) order by mo.m) as j
      from mo left join g on date_trunc('month', g.created_at) = mo.m group by ()),
  att as (
    select o.id, o.name,
           count(*) filter (where g.created_at >= now() - interval '90 days') as r90,
           count(*) filter (where g.created_at >= now() - interval '180 days' and g.created_at < now() - interval '90 days') as p90,
           count(*) filter (where g.created_at >= now() - interval '90 days' and coalesce(g.triage_severity, g.urgency) in ('high','critical')) as s90,
           count(distinct g.site_id) filter (where g.created_at >= now() - interval '90 days') as sites90,
           (select c from (select category c, count(*) n from public.ministry_voice_reports x where x.organization_id = o.id and x.created_at >= now() - interval '90 days' group by 1 order by 2 desc, 1 limit 1) t) as top_cat
      from public.organizations o join g on g.organization_id = o.id group by o.id, o.name),
  flagged as (select * from att where r90 >= 3 or s90 >= 2)
  select jsonb_build_object(
    'months', coalesce((select j from months), '[]'::jsonb),
    'attention', coalesce((select jsonb_agg(jsonb_build_object('organization_id', id, 'name', name, 'reports90', r90, 'previous90', p90, 'serious90', s90, 'sites90', sites90, 'topCategory', top_cat,
        'why', format('%s report(s) in the last 90 days (%s in the 90 days before), %s marked high or critical, across %s site(s).', r90, p90, s90, sites90)) order by r90 desc, name) from flagged), '[]'::jsonb),
    'ageing', jsonb_build_object(
        'unacknowledged3d', (select count(*) from public.ministry_voice_reports where status = 'received' and created_at < now() - interval '3 days'),
        'open14d', (select count(*) from public.ministry_voice_reports where status <> 'closed' and created_at < now() - interval '14 days'),
        'open30d', (select count(*) from public.ministry_voice_reports where status <> 'closed' and created_at < now() - interval '30 days')),
    'notice', 'These are counts of reports, not findings. They are a prompt for a person to look, not a prediction and not evidence that any company has done wrong.',
    'limits', jsonb_build_array('One person can send several reports, so a count is not a count of people.',
                                'Named, confidential and anonymous reports are counted alike; duplicates are included.',
                                'Small numbers can be chance. Reports may be mistaken or malicious.',
                                'Companies with few workers or few reports in total may simply be less visible.')
  ) into v;
  return v;
end;
$mg$;

-- A2: reminders and automatic escalation, run by a scheduler (supabase/cron/voice-ageing-sweep.sql) ------------------------------------
create or replace function public.mg_voice_ageing_sweep()
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r record; u record; v_remind integer := 0; v_escalated integer := 0; v_mremind integer := 0; v_day text := to_char(current_date, 'YYYYMMDD');
begin
  -- company: unacknowledged for 7 days at site level -> company administrators (never silently dropped)
  for r in select id, organization_id, site_id from public.worker_voice_reports where status = 'received' and route = 'site' and created_at < now() - interval '7 days' loop
    update public.worker_voice_reports set route = 'company_admin', escalated_at = now(), assigned_to = null where id = r.id;
    insert into public.worker_voice_events (report_id, event, actor_id, detail) values (r.id, 'auto_escalated', null, 'unacknowledged for 7 days');
    perform public.mg_wv_notify(r.id, r.organization_id, r.site_id, 'company_admin', true, null);
    v_escalated := v_escalated + 1;
  end loop;
  -- company: daily reminder for anything still unacknowledged after 3 days
  for r in select id, organization_id, site_id, route from public.worker_voice_reports where status = 'received' and created_at < now() - interval '3 days' loop
    for u in select m.user_id from public.organization_members m join public.organizations o on o.id = m.organization_id
              where m.organization_id = r.organization_id and m.status = 'active' and o.status = 'approved'
                and public.mg_wv_user_can_review(m.user_id, r.organization_id, r.site_id, r.route) loop
      perform public.mg_voice_notify_user(u.user_id, 'wvage:' || r.id::text || ':' || v_day, 'A safety report is still waiting for review',
        'MineGuard: A safety report is still waiting for review. Sign in with your authorized account to access it.', '/operate/voice-review', false, 'company');
    end loop;
    v_remind := v_remind + 1;
  end loop;
  -- Ministry: daily reminder for anything still unacknowledged after 3 days
  for r in select id from public.ministry_voice_reports where status = 'received' and created_at < now() - interval '3 days' loop
    for u in select p.id from public.profiles p where public.mg_mv_user_is_reviewer(p.id) loop
      perform public.mg_voice_notify_user(u.id, 'mvage:' || r.id::text || ':' || v_day, 'A worker report is still waiting for review',
        'MineGuard: A worker report is still waiting for review. Sign in with your authorized account to access it.', '/portal/voice-ministry', false, 'ministry');
    end loop;
    v_mremind := v_mremind + 1;
  end loop;
  return jsonb_build_object('companyReminded', v_remind, 'autoEscalated', v_escalated, 'ministryReminded', v_mremind);
end;
$mg$;

-- A9: Ministry -> company requests. NO report id, NO fingerprint, NO link of any kind to a report. ----------------------------------
create or replace function public.mg_mr_categories(p_topic text)
returns text[] language sql immutable as $mg$
  select case p_topic
    when 'working_hours_and_rest' then array['working_hours']
    when 'wages_and_benefits_records' then array['wages_or_benefits']
    when 'safety_training_and_ppe' then array['missing_ppe_or_training']
    when 'hazard_controls_and_maintenance' then array['hazard_ignored','unsafe_practice','falsified_records']
    when 'workplace_conduct_and_discrimination' then array['harassment_or_discrimination','retaliation','bad_work_habit']
    when 'contracts_and_dismissals' then array['contract_or_dismissal']
    else array[]::text[] end
$mg$;

create or replace function public.mg_mr_create(p_org uuid, p_topic text, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $mg$
declare v_id uuid; v_n integer; u record; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.mg_voice_is_ministry_admin() then raise exception 'FORBIDDEN: only a Ministry administrator can send a request to a company'; end if;
  if not exists (select 1 from public.organizations where id = p_org and status = 'approved') then raise exception 'INVALID: unknown company'; end if;
  if cardinality(public.mg_mr_categories(p_topic)) = 0 then raise exception 'INVALID: choose one of the listed topics'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'INVALID: the note is limited to 300 characters'; end if;
  select count(*) into v_n from public.ministry_voice_reports r
   where r.organization_id = p_org and r.category = any (public.mg_mr_categories(p_topic)) and r.created_at > now() - interval '180 days';
  if v_n < 3 then raise exception 'TOO_FEW: there are not enough reports on this topic to ask the company without risking identifying a reporter'; end if;
  if exists (select 1 from public.ministry_company_requests q where q.organization_id = p_org and q.topic = p_topic and q.created_on > current_date - 30) then
    raise exception 'CONFLICT: this company was already asked about this topic in the last 30 days'; end if;
  insert into public.ministry_company_requests (organization_id, topic, note, created_by) values (p_org, p_topic, v_note, auth.uid()) returning id into v_id;
  for u in select m.user_id from public.organization_members m where m.organization_id = p_org and m.status = 'active' and m.org_role = 'company_admin' loop
    perform public.mg_voice_notify_user(u.user_id, 'mr:' || v_id::text, 'The Ministry has sent your company a request',
      'MineGuard: The Ministry has sent a request to your company. Sign in with your authorized account to see it.', '/operate/ministry-requests', false, 'request');
  end loop;
  return v_id;
end;
$mg$;

create or replace function public.mg_mr_respond(p_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $mg$
declare q public.ministry_company_requests; v_body text := btrim(coalesce(p_body, '')); v_rid uuid; u record;
begin
  select * into q from public.ministry_company_requests where id = p_id;
  if not found or auth.uid() is null or not public.mg_is_company_admin(q.organization_id) then raise exception 'FORBIDDEN: only a company administrator can answer this request'; end if;
  if q.status = 'closed' then raise exception 'CONFLICT: this request is closed'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1500 then raise exception 'INVALID: write 1 to 1500 characters'; end if;
  insert into public.ministry_company_responses (request_id, body, by_user, by_ministry) values (p_id, v_body, auth.uid(), false) returning id into v_rid;
  update public.ministry_company_requests set status = 'answered' where id = p_id;
  for u in select p.id from public.profiles p where public.mg_mv_user_is_custodian(p.id) loop
    perform public.mg_voice_notify_user(u.id, 'mrr:' || v_rid::text, 'A company has answered a Ministry request',
      'MineGuard: A company has answered a Ministry request. Sign in with your authorized account to see it.', '/portal/voice-ministry', false, null);
  end loop;
end;
$mg$;

create or replace function public.mg_mr_followup(p_id uuid, p_body text, p_close boolean default false)
returns void language plpgsql security definer set search_path = public as $mg$
declare q public.ministry_company_requests; v_body text := btrim(coalesce(p_body, '')); u record;
begin
  if not public.mg_voice_is_ministry_admin() then raise exception 'FORBIDDEN: only a Ministry administrator can follow up'; end if;
  select * into q from public.ministry_company_requests where id = p_id;
  if not found then raise exception 'INVALID: unknown request'; end if;
  if q.status = 'closed' then raise exception 'CONFLICT: this request is closed'; end if;
  if char_length(v_body) > 1500 or (char_length(v_body) < 1 and not coalesce(p_close, false)) then raise exception 'INVALID: write 1 to 1500 characters'; end if;
  if char_length(v_body) >= 1 then
    insert into public.ministry_company_responses (request_id, body, by_user, by_ministry) values (p_id, v_body, auth.uid(), true);
    for u in select m.user_id from public.organization_members m where m.organization_id = q.organization_id and m.status = 'active' and m.org_role = 'company_admin' loop
      perform public.mg_voice_notify_user(u.user_id, 'mrf:' || p_id::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'), 'The Ministry has sent your company a request',
        'MineGuard: The Ministry has sent a request to your company. Sign in with your authorized account to see it.', '/operate/ministry-requests', false, 'request');
    end loop;
  end if;
  update public.ministry_company_requests set status = case when coalesce(p_close, false) then 'closed' else 'open' end where id = p_id;
end;
$mg$;

create or replace function public.mg_mr_list()
returns table (id uuid, organization_id uuid, organization_name text, topic text, note text, created_on date, status text, responses jsonb)
language plpgsql stable security definer set search_path = public as $mg$
declare v_min boolean := public.mg_voice_is_ministry_admin();
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  return query
    select q.id, q.organization_id, o.name::text, q.topic, q.note, q.created_on, q.status,
           coalesce((select jsonb_agg(jsonb_build_object('from', case when x.by_ministry then 'Ministry' else 'Company' end, 'text', x.body, 'on', x.on_date) order by x.seq)
                       from public.ministry_company_responses x where x.request_id = q.id), '[]'::jsonb)
      from public.ministry_company_requests q join public.organizations o on o.id = q.organization_id
     where v_min or public.mg_is_company_admin(q.organization_id)
     order by q.created_on desc, q.id limit 100;
end;
$mg$;

-- A3: push dispatch surface (service_role only). The payload kind picks one of three fixed generic payloads. ---------------------------------
create or replace function public.mg_voice_push_claim(p_limit integer default 100)
returns table (outbox_id uuid, subscription_id uuid, kind text, endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = public as $mg$
begin
  update public.voice_push_outbox set state = 'expired', detail = 'not sent: older than 6 hours', updated_at = now()
   where state in ('queued','sending') and created_at < now() - interval '6 hours';
  return query
  with c as (select o.id from public.voice_push_outbox o
              where (o.state = 'queued' or (o.state = 'sending' and o.updated_at < now() - interval '2 minutes')) and o.attempts < 5
              order by o.created_at limit greatest(1, least(p_limit, 500)) for update skip locked),
  u as (update public.voice_push_outbox o set state = 'sending', attempts = o.attempts + 1, updated_at = now() from c where o.id = c.id returning o.id, o.user_id, o.kind)
  select u.id, ps.id, u.kind, ps.endpoint, ps.p256dh, ps.auth from u join public.push_subscriptions ps on ps.user_id = u.user_id and ps.expired_at is null and ps.revoked_at is null;
end;
$mg$;
create or replace function public.mg_voice_push_record(p_outbox uuid, p_state text, p_detail text default null, p_dead_subscription uuid default null)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  if p_state not in ('queued','sent','expired','failed') then raise exception 'INVALID_STATE'; end if;
  update public.voice_push_outbox set state = p_state, detail = left(p_detail, 200), updated_at = now() where id = p_outbox;
  if p_dead_subscription is not null then update public.push_subscriptions set expired_at = now() where id = p_dead_subscription and expired_at is null; end if;
end;
$mg$;

-- grants ------------------------------------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'mg_wv_submit(text,uuid,text,text,text,timestamptz,text,boolean,text,jsonb)', 'mg_wv_site_small(uuid)', 'mg_wv_site_code(uuid)', 'mg_wv_rotate_code(uuid)',
    'mg_wv_set_anonymous(uuid,boolean)', 'mg_wv_code_info(uuid)', 'mg_wv_post_update(uuid,text)', 'mg_wv_reply_mine(uuid,text)', 'mg_wv_my_reports()',
    'mg_wv_attachments(uuid)', 'mg_wv_attachment_counts()', 'mg_wv_escalate(uuid,text)', 'mg_wv_set_hold(uuid,boolean,text)', 'mg_wv_dispose(uuid,boolean,text)',
    'mg_mv_submit(text,uuid,text,text,text,timestamptz,text,text,jsonb)', 'mg_mv_site_code(uuid)', 'mg_mv_code_sites(text)', 'mg_mv_code_info(uuid)',
    'mg_mv_rotate_code(uuid)', 'mg_mv_set_anonymous(uuid,boolean)', 'mg_mv_post_update(uuid,text)', 'mg_mv_reply_mine(uuid,text)', 'mg_mv_my_reports()',
    'mg_mv_attachments(uuid)', 'mg_mv_attachment_counts()', 'mg_mv_list(integer)', 'mg_mv_set_hold(uuid,boolean,text)', 'mg_mv_dispose(boolean,text)',
    'mg_voice_set_retention(text,integer)', 'mg_mv_trends(integer)', 'mg_mr_create(uuid,text,text)', 'mg_mr_respond(uuid,text)', 'mg_mr_followup(uuid,text,boolean)', 'mg_mr_list()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'mg_wv_submit_anonymous(text,text,text,text,timestamptz,text,boolean,text,jsonb)', 'mg_wv_site_info(text)', 'mg_wv_status(text)', 'mg_wv_reply(text,text)',
    'mg_mv_submit_anonymous(text,text,text,text,timestamptz,text,text,jsonb)', 'mg_mv_site_info(text)', 'mg_mv_status(text)', 'mg_mv_reply(text,text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  revoke all on function public.mg_wv_jpeg_problem(bytea), public.mg_voice_photos(jsonb), public.mg_wv_small_site(uuid), public.mg_wv_small_site_threshold(),
    public.mg_voice_is_ministry_admin(), public.mg_mr_categories(text), public.mg_voice_ageing_sweep(),
    public.mg_voice_push_claim(integer), public.mg_voice_push_record(uuid, text, text, uuid) from public, anon, authenticated;
  grant execute on function public.mg_voice_push_claim(integer), public.mg_voice_push_record(uuid, text, text, uuid), public.mg_voice_ageing_sweep() to service_role;
end $$;

commit;
