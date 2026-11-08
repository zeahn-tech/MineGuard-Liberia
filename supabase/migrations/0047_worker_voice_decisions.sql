-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0047: Worker Voice — the five owner decisions
--
--  1. CONFIDENTIAL IDENTITY is opened by MINISTRY staff only (administrators, supervisors, inspectors),
--     within their jurisdiction, with a stated purpose, recorded, count shown to the reporter. The
--     company's own administrators, site managers and safety officers can NO LONGER open it. To do
--     that job Ministry staff can READ reports (and their messages and photos) in their scope. They
--     cannot triage, assign, escalate, close or message. NOTE: this reverses 0046, under which the
--     Ministry had no access at all. The app's wording changes with it.
--  2. PHOTOS (JPEG only, up to 3 per report, 1 MB each). Cleaned on the phone, then REFUSED by the
--     server unless the file is structurally clean: only JFIF + quantization/Huffman/frame/scan
--     segments; no EXIF/GPS/XMP/ICC/comment data, no embedded thumbnail, size and dimensions capped.
--     Stored in a closed table (no URL exists), served only to authorized reviewers, immutable, with a
--     server-computed SHA-256 for evidence integrity. There is NO malware scanning (see docs).
--  3. SITE CODE CONTROLS: expiry (90 days; a member's request after expiry issues a new code), pause
--     switch for anonymous intake, and per-day intake counts (not linked to any report) with an
--     unusual-volume signal.
--  4. TWO-WAY MESSAGING by follow-up code, and PUSH for reviewers. Push carries a fixed generic
--     payload and no report reference at all; it is sent by a service-role function that a scheduler
--     calls (see supabase/cron/worker-voice-push-sweep.sql). In-app notifications work without it.
--  5. SMALL SITES (fewer than 10 people assigned): reporters are warned before sending, the received
--     time and the occurrence time are coarsened to the DAY, and reviewers see a "small site" flag.
--
-- Anonymity rules from 0046 are unchanged: nothing here adds an identity column, reads auth.uid() on
-- the anonymous path, or records an address. Idempotent. Not applied by anyone but the owner.
-- ROLLBACK: docs/22_WORKER_VOICE.MD.
-- ===========================================================================

begin;

-- 1. Ministry access ---------------------------------------------------------------------------------
insert into public.permissions (role, permission) values
  ('admin', 'wv.identity'), ('supervisor', 'wv.identity'), ('inspector', 'wv.identity')
on conflict (role, permission) do nothing;

create or replace function public.mg_wv_ministry_can_read(p_site uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null and public.mg_has_permission('wv.identity') and exists (
    select 1 from public.sites s
     where s.id = p_site
       and public.mg_can_access_site_row(s.id, s.county, s.district, s.operator_name, s.organization_id))
$mg$;

-- 2/3/5. columns ---------------------------------------------------------------------------------------
alter table public.worker_voice_reports add column if not exists small_site boolean not null default false;
alter table public.worker_voice_site_codes add column if not exists anonymous_enabled boolean not null default true;
alter table public.worker_voice_site_codes add column if not exists expires_at timestamptz not null default (now() + interval '90 days');

-- new tables ---------------------------------------------------------------------------------------------
create table if not exists public.worker_voice_messages (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity,   -- true order of the thread (reporter times are rounded to the hour)
  report_id     uuid not null references public.worker_voice_reports(id),
  from_reporter boolean not null,
  body          text not null check (char_length(body) between 1 and 1000),
  at            timestamptz not null default now()
);
create index if not exists wv_messages_report_idx on public.worker_voice_messages (report_id, seq);

create table if not exists public.worker_voice_attachments (
  id         uuid primary key default gen_random_uuid(),
  report_id  uuid not null references public.worker_voice_reports(id),
  content    bytea not null check (length(content) between 100 and 1000000),
  mime       text not null default 'image/jpeg' check (mime = 'image/jpeg'),
  bytes      integer not null,
  sha256     text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index if not exists wv_attachments_report_idx on public.worker_voice_attachments (report_id);

-- intake volume per site per day. NOT linked to any report.
create table if not exists public.worker_voice_code_usage (
  site_id uuid not null references public.sites(id),
  day     date not null,
  n       integer not null default 0,
  primary key (site_id, day)
);

-- reviewer push: who to wake, nothing about why
create table if not exists public.worker_voice_push_outbox (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  state      text not null default 'queued' check (state in ('queued','sending','sent','expired','failed')),
  attempts   integer not null default 0,
  detail     text check (detail is null or char_length(detail) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wv_push_state_idx on public.worker_voice_push_outbox (state, created_at);

alter table public.worker_voice_messages     enable row level security;
alter table public.worker_voice_attachments  enable row level security;
alter table public.worker_voice_code_usage   enable row level security;
alter table public.worker_voice_push_outbox  enable row level security;
revoke all on public.worker_voice_messages, public.worker_voice_attachments,
              public.worker_voice_code_usage, public.worker_voice_push_outbox from anon, authenticated;

create or replace function public.mg_wv_immutable()
returns trigger language plpgsql as $mg$
begin raise exception 'IMMUTABLE: this record is never edited or deleted'; end;
$mg$;
revoke all on function public.mg_wv_immutable() from public, anon, authenticated;
drop trigger if exists wv_messages_immutable on public.worker_voice_messages;
create trigger wv_messages_immutable before update or delete on public.worker_voice_messages for each row execute function public.mg_wv_immutable();
drop trigger if exists wv_attachments_immutable on public.worker_voice_attachments;
create trigger wv_attachments_immutable before update or delete on public.worker_voice_attachments for each row execute function public.mg_wv_immutable();

-- read policies: company reviewers and in-scope Ministry staff --------------------------------------------
drop policy if exists "wv reports read" on public.worker_voice_reports;
create policy "wv reports read" on public.worker_voice_reports for select to authenticated
  using (public.mg_wv_can_review(organization_id, site_id, route) or public.mg_wv_ministry_can_read(site_id));

drop policy if exists "wv messages read" on public.worker_voice_messages;
create policy "wv messages read" on public.worker_voice_messages for select to authenticated
  using (exists (select 1 from public.worker_voice_reports r where r.id = report_id
                  and (public.mg_wv_can_review(r.organization_id, r.site_id, r.route) or public.mg_wv_ministry_can_read(r.site_id))));
grant select on public.worker_voice_messages to authenticated;
-- attachments, usage and the outbox have NO policy and NO grant: RPCs only.

-- 2. JPEG structure check ----------------------------------------------------------------------------------
-- Returns NULL when the file is acceptable, otherwise a message for the person. Walks the header segments
-- only (never the pixel data), then looks for stray APPn/COM markers hidden after the first scan.
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
    if m = 224 then                                   -- APP0: a bare JFIF header, no embedded thumbnail
      if len <> 16 or encode(substring(p from i + 5 for 4), 'escape') <> 'JFIF' or get_byte(p, i + 16) <> 0 or get_byte(p, i + 17) <> 0 then
        return 'The photo carries extra data (such as an embedded thumbnail).';
      end if;
    elsif m in (219, 196, 221) then null;             -- DQT, DHT, DRI
    elsif m in (192, 193, 194) then                   -- SOF0/1/2: dimensions
      h := get_byte(p, i + 5) * 256 + get_byte(p, i + 6);
      w := get_byte(p, i + 7) * 256 + get_byte(p, i + 8);
      if h < 1 or w < 1 or h > 4096 or w > 4096 then return 'The photo is too large (at most 4096 pixels on a side).'; end if;
      seen_sof := true;
    elsif m = 218 then                                -- SOS: header ends, entropy data follows
      if not seen_sof then return 'The photo is not a valid JPEG.'; end if;
      exit;
    else
      return 'The photo carries location, camera or other hidden data. Remove it and try again.';
    end if;
    i := i + 2 + len;
  end loop;
  -- an FF Ex / FF FE pair can never occur inside entropy-coded data, so finding one means hidden metadata
  for k in 224..239 loop
    if position(decode('ff' || lpad(to_hex(k), 2, '0'), 'hex') in substring(p from i + 2)) > 0 then
      return 'The photo carries location, camera or other hidden data. Remove it and try again.';
    end if;
  end loop;
  if position('\xfffe'::bytea in substring(p from i + 2)) > 0 then
    return 'The photo carries location, camera or other hidden data. Remove it and try again.';
  end if;
  return null;
end;
$mg$;

-- 5. small sites -------------------------------------------------------------------------------------------
create or replace function public.mg_wv_small_site_threshold() returns integer language sql immutable as $mg$ select 10 $mg$;

create or replace function public.mg_wv_small_site(p_site uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select (select count(distinct sa.user_id) from public.site_assignments sa
            join public.organization_members m on m.user_id = sa.user_id and m.status = 'active'
           where sa.site_id = p_site and sa.revoked_at is null) < public.mg_wv_small_site_threshold()
$mg$;

-- notifications + push outbox (generic; no report id in the outbox) -----------------------------------------------
create or replace function public.mg_wv_notify(p_report uuid, p_org uuid, p_site uuid, p_route text, p_urgent boolean, p_skip uuid)
returns void language plpgsql security definer set search_path = public as $mg$
begin
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
  -- one queued push per reviewer who has a live subscription; the row says WHO to wake and nothing else
  insert into public.worker_voice_push_outbox (user_id)
  select distinct m.user_id
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
   where m.organization_id = p_org and m.status = 'active' and o.status = 'approved'
     and (p_skip is null or m.user_id <> p_skip)
     and public.mg_wv_user_can_review(m.user_id, p_org, p_site, p_route)
     and exists (select 1 from public.push_subscriptions ps where ps.user_id = m.user_id and ps.expired_at is null and ps.revoked_at is null);
end;
$mg$;

-- the one place a report is written (now with photos, small-site handling and intake counts) ----------------------
drop function if exists public.mg_wv_insert(text, uuid, text, text, text, timestamptz, text, boolean, text, uuid);
create or replace function public.mg_wv_insert(
  p_mode text, p_site uuid, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_concerns boolean, p_code text, p_reporter uuid, p_attachments jsonb)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare
  v_org uuid; v_route text; v_fp text; v_dup uuid; v_id uuid; v_desc text := btrim(coalesce(p_description, ''));
  v_created timestamptz; v_small boolean; v_occ timestamptz; v_files bytea[] := '{}'; v_item jsonb; v_bin bytea; v_problem text; v_total integer := 0;
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

  -- photos: every one is checked BEFORE anything is stored
  if p_attachments is not null and p_attachments <> 'null'::jsonb then
    if jsonb_typeof(p_attachments) <> 'array' or jsonb_array_length(p_attachments) > 3 then
      return jsonb_build_object('status','invalid','message','You can attach up to 3 photos.'); end if;
    for v_item in select * from jsonb_array_elements(p_attachments) loop
      if jsonb_typeof(v_item) <> 'string' or char_length(v_item #>> '{}') > 1400000 then
        return jsonb_build_object('status','invalid','message','A photo is too large or not valid.'); end if;
      begin
        v_bin := decode(v_item #>> '{}', 'base64');
      exception when others then
        return jsonb_build_object('status','invalid','message','A photo could not be read.');
      end;
      v_problem := public.mg_wv_jpeg_problem(v_bin);
      if v_problem is not null then return jsonb_build_object('status','invalid','message', v_problem); end if;
      v_total := v_total + length(v_bin);
      v_files := v_files || v_bin;
    end loop;
    if v_total > 2400000 then return jsonb_build_object('status','invalid','message','The photos together are too large.'); end if;
  end if;

  v_route := case when coalesce(p_concerns, false) then 'company_admin' else 'site' end;
  v_small := public.mg_wv_small_site(p_site);
  v_fp := encode(sha256(convert_to(lower(regexp_replace(v_desc, '\s+', ' ', 'g')) || '|' || p_category, 'UTF8')), 'hex');
  select r.id into v_dup from public.worker_voice_reports r
   where r.site_id = p_site and r.fingerprint = v_fp and r.created_at > now() - interval '14 days'
   order by r.created_at limit 1;
  -- confidential/anonymous: no precise timestamp. A small site is coarsened to the DAY (and the occurrence time too).
  v_created := case when p_mode = 'named' then now() when v_small then date_trunc('day', now()) else date_trunc('hour', now()) end;
  v_occ := case when p_mode <> 'named' and v_small and p_occurred is not null then date_trunc('day', p_occurred) else p_occurred end;

  insert into public.worker_voice_reports (organization_id, site_id, mode, category, urgency, description, occurred_at,
                                           previously_reported, route, fingerprint, duplicate_of, code_hash, created_at, small_site)
  values (v_org, p_site, p_mode, p_category, p_urgency, v_desc, v_occ, p_previously, v_route, v_fp, v_dup,
          public.mg_wv_hash(p_code), v_created, v_small)
  on conflict (code_hash) do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('status','duplicate'); end if;

  for i in 1 .. coalesce(array_length(v_files, 1), 0) loop
    insert into public.worker_voice_attachments (report_id, content, bytes, sha256)
    values (v_id, v_files[i], length(v_files[i]), encode(sha256(v_files[i]), 'hex'));
  end loop;
  if p_reporter is not null then
    insert into public.worker_voice_identity (report_id, reporter_id) values (v_id, p_reporter);
  end if;
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

-- submit (signed in) ---------------------------------------------------------------------------------------------------
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
    return jsonb_build_object('status','rate_limited');
  end if;
  return public.mg_wv_insert(p_mode, p_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_concerns, p_code, auth.uid(), p_attachments);
end;
$mg$;

-- submit (anonymous). Still never reads auth.uid(). ----------------------------------------------------------------------
drop function if exists public.mg_wv_submit_anonymous(text, text, text, text, timestamptz, text, boolean, text);
create or replace function public.mg_wv_submit_anonymous(
  p_site_code text, p_category text, p_urgency text, p_description text, p_occurred timestamptz,
  p_previously text, p_concerns boolean, p_code text, p_attachments jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_site uuid; v_enabled boolean; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  delete from public.rate_limits where bucket like 'wv:%' and window_start < now() - interval '1 day';
  if not public.mg_wv_rate(public.mg_wv_src('wv:a'), case when v_known then 10 else 200 end, interval '1 hour') then
    return jsonb_build_object('status','rate_limited');
  end if;
  select c.site_id, c.anonymous_enabled into v_site, v_enabled from public.worker_voice_site_codes c
   where c.code = upper(regexp_replace(coalesce(p_site_code, ''), '[^0-9A-Za-z]', '', 'g')) and c.expires_at > now();
  if v_site is null then
    if not public.mg_wv_rate(public.mg_wv_src('wv:f'), case when v_known then 10 else 100 end, interval '1 hour') then
      return jsonb_build_object('status','rate_limited');
    end if;
    return jsonb_build_object('status','invalid_site_code');
  end if;
  if not v_enabled then return jsonb_build_object('status','anonymous_paused'); end if;
  if not public.mg_wv_rate('wv:s:' || v_site::text, 60, interval '1 hour') then
    return jsonb_build_object('status','rate_limited');
  end if;
  return public.mg_wv_insert('anonymous', v_site, p_category, p_urgency, p_description, p_occurred, p_previously, p_concerns, p_code, null, p_attachments);
end;
$mg$;

-- what a person should know about a site before sending (counts as a guess if the code is wrong) -----------------------
create or replace function public.mg_wv_site_info(p_site_code text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_site uuid; v_enabled boolean; v_known boolean := coalesce(public.mg_client_ip(), '') <> '';
begin
  if not public.mg_wv_rate(public.mg_wv_src('wv:i'), case when v_known then 60 else 600 end, interval '1 hour') then
    return jsonb_build_object('valid', false, 'status', 'rate_limited');
  end if;
  select c.site_id, c.anonymous_enabled into v_site, v_enabled from public.worker_voice_site_codes c
   where c.code = upper(regexp_replace(coalesce(p_site_code, ''), '[^0-9A-Za-z]', '', 'g')) and c.expires_at > now();
  if v_site is null then
    if not public.mg_wv_rate(public.mg_wv_src('wv:f'), case when v_known then 10 else 100 end, interval '1 hour') then
      return jsonb_build_object('valid', false, 'status', 'rate_limited');
    end if;
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

-- 3. site code controls ------------------------------------------------------------------------------------------------
create or replace function public.mg_wv_site_code(p_site uuid)
returns text language plpgsql security definer set search_path = public as $mg$
declare v_org uuid; v_code text; v_exp timestamptz;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select organization_id into v_org from public.sites where id = p_site;
  if v_org is null or not (public.mg_can_prepare_jsa(p_site) or public.mg_wv_can_review(v_org, p_site, 'site')) then
    raise exception 'FORBIDDEN: you cannot see this site''s code';
  end if;
  select code, expires_at into v_code, v_exp from public.worker_voice_site_codes where site_id = p_site;
  if v_code is null or v_exp <= now() then
    -- first use, or the posted code has expired: issue a fresh one (the old poster stops working)
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
    raise exception 'FORBIDDEN: only the company administrator or the site''s manager or safety officer can change the code';
  end if;
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
    raise exception 'FORBIDDEN: only the company administrator or the site''s manager or safety officer can pause anonymous reporting';
  end if;
  perform public.mg_wv_site_code(p_site);   -- makes sure a row exists
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
  select coalesce(sum(n) filter (where day = current_date), 0), coalesce(sum(n) filter (where day > current_date - 7), 0)
    into v_today, v_week from public.worker_voice_code_usage where site_id = p_site;
  v_avg := greatest((v_week - v_today) / 6.0, 1);
  return jsonb_build_object('code', c.code, 'expiresOn', c.expires_at::date, 'enabled', c.anonymous_enabled,
                            'today', v_today, 'week', v_week, 'unusual', v_today >= 20 and v_today > 4 * v_avg);
end;
$mg$;

-- 4. messaging --------------------------------------------------------------------------------------------------------
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
  if not public.mg_wv_rate(public.mg_wv_src('wv:l'), case when v_known then 60 else 600 end, interval '1 hour') then
    return jsonb_build_object('found', false, 'status', 'rate_limited');
  end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' then return jsonb_build_object('found', false); end if;
  select * into r from public.worker_voice_reports where code_hash = public.mg_wv_hash(p_code);
  if not found then
    if not public.mg_wv_rate(public.mg_wv_src('wv:lf'), case when v_known then 10 else 100 end, interval '1 hour') then
      return jsonb_build_object('found', false, 'status', 'rate_limited');
    end if;
    return jsonb_build_object('found', false);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('from', case when m.from_reporter then 'you' else 'reviewers' end,
                                               'text', m.body, 'on', m.at::date) order by m.seq), '[]'::jsonb)
    into v_msgs from (select * from public.worker_voice_messages where report_id = r.id order by seq desc limit 30) m;
  return jsonb_build_object(
    'found', true,
    'stage', case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed'
                           when 'investigating' then 'Under investigation' when 'action_assigned' then 'Action in progress'
                           when 'follow_up' then 'Action in progress' else 'Closed' end,
    'closed', r.status = 'closed',
    'lastChange', (coalesce(r.updated_at, r.created_at))::date,
    'update', r.reporter_update,
    'updateOn', r.reporter_update_at::date,
    'messages', v_msgs,
    'canReply', r.status <> 'closed');
end;
$mg$;

create or replace function public.mg_wv_reply(p_code text, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports; v_known boolean := coalesce(public.mg_client_ip(), '') <> ''; v_body text := btrim(coalesce(p_text, ''));
begin
  if not public.mg_wv_rate(public.mg_wv_src('wv:r'), case when v_known then 20 else 200 end, interval '1 hour') then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1000 then return jsonb_build_object('status', 'invalid', 'message', 'Write 1 to 1000 characters.'); end if;
  if p_code is null or p_code !~ '^[0-9A-F]{24}$' then return jsonb_build_object('status', 'not_found'); end if;
  select * into r from public.worker_voice_reports where code_hash = public.mg_wv_hash(p_code);
  if not found then
    if not public.mg_wv_rate(public.mg_wv_src('wv:lf'), case when v_known then 10 else 100 end, interval '1 hour') then
      return jsonb_build_object('status', 'rate_limited');
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;
  if r.status = 'closed' then return jsonb_build_object('status', 'closed'); end if;
  if (select count(*) from public.worker_voice_messages m where m.report_id = r.id and m.from_reporter and m.at > now() - interval '1 day') >= 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  -- the reporter's own messages carry an hourly time, like the report itself
  insert into public.worker_voice_messages (report_id, from_reporter, body, at) values (r.id, true, v_body, date_trunc('hour', now()));
  perform public.mg_wv_notify(r.id, r.organization_id, r.site_id, r.route, false, null);
  return jsonb_build_object('status', 'received');
end;
$mg$;

-- a named/confidential reporter replying from "my reports" (no code needed, still no extra identity stored)
create or replace function public.mg_wv_reply_mine(p_id uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports; v_body text := btrim(coalesce(p_text, ''));
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  select rr.* into r from public.worker_voice_reports rr join public.worker_voice_identity i on i.report_id = rr.id
   where rr.id = p_id and i.reporter_id = auth.uid();
  if not found then raise exception 'FORBIDDEN: this is not your report'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 1000 then raise exception 'INVALID: write 1 to 1000 characters'; end if;
  if r.status = 'closed' then raise exception 'CONFLICT: this report is closed'; end if;
  if (select count(*) from public.worker_voice_messages m where m.report_id = r.id and m.from_reporter and m.at > now() - interval '1 day') >= 10 then
    raise exception 'RATE_LIMITED: too many messages today';
  end if;
  insert into public.worker_voice_messages (report_id, from_reporter, body, at) values (r.id, true, v_body, date_trunc('hour', now()));
  perform public.mg_wv_notify(r.id, r.organization_id, r.site_id, r.route, false, auth.uid());
end;
$mg$;

-- my reports now also carry the thread
drop function if exists public.mg_wv_my_reports();
create or replace function public.mg_wv_my_reports()
returns table (id uuid, received_on date, mode text, category text, stage text, reporter_update text, reporter_update_on date, identity_opened integer, can_reply boolean)
language sql stable security definer set search_path = public as $mg$
  select r.id, r.created_at::date, r.mode, r.category,
         case r.status when 'received' then 'Received' when 'triage' then 'Being reviewed'
                       when 'investigating' then 'Under investigation' when 'action_assigned' then 'Action in progress'
                       when 'follow_up' then 'Action in progress' else 'Closed' end,
         r.reporter_update, r.reporter_update_at::date,
         (select count(*)::int from public.worker_voice_events e where e.report_id = r.id and e.event = 'identity_revealed'),
         r.status <> 'closed'
    from public.worker_voice_identity i join public.worker_voice_reports r on r.id = i.report_id
   where i.reporter_id = auth.uid()
   order by r.created_at desc limit 50
$mg$;

-- 2. photos: closed table, served only to people who may read the report ------------------------------------------------
create or replace function public.mg_wv_attachments(p_report uuid)
returns table (id uuid, bytes integer, sha256 text, data text)
language plpgsql stable security definer set search_path = public as $mg$
declare r public.worker_voice_reports;
begin
  select * into r from public.worker_voice_reports where worker_voice_reports.id = p_report;
  if not found or not (public.mg_wv_can_review(r.organization_id, r.site_id, r.route) or public.mg_wv_ministry_can_read(r.site_id)) then
    raise exception 'FORBIDDEN: you are not authorized to see this report''s photos';
  end if;
  return query select a.id, a.bytes, a.sha256, encode(a.content, 'base64') from public.worker_voice_attachments a
                where a.report_id = p_report order by a.created_at, a.id;
end;
$mg$;

create or replace function public.mg_wv_attachment_counts()
returns table (report_id uuid, n integer)
language sql stable security definer set search_path = public as $mg$
  select a.report_id, count(*)::int from public.worker_voice_attachments a
    join public.worker_voice_reports r on r.id = a.report_id
   where public.mg_wv_can_review(r.organization_id, r.site_id, r.route) or public.mg_wv_ministry_can_read(r.site_id)
   group by a.report_id
$mg$;

-- 1. identity: Ministry for confidential; company reviewers or Ministry for named ----------------------------------------
create or replace function public.mg_wv_identity(p_id uuid, p_purpose text default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare r public.worker_voice_reports; v_rep uuid; v_name text; v_title text; v_company boolean; v_ministry boolean;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  select * into r from public.worker_voice_reports where id = p_id;
  if not found then raise exception 'FORBIDDEN: you are not authorized to open this identity'; end if;
  v_company := public.mg_wv_can_review(r.organization_id, r.site_id, r.route);
  v_ministry := public.mg_wv_ministry_can_read(r.site_id);
  if not (v_company or v_ministry) then raise exception 'FORBIDDEN: you are not authorized to open this identity'; end if;
  if r.mode = 'anonymous' then raise exception 'NOT_AVAILABLE: this report is anonymous; no identity is held'; end if;
  select reporter_id into v_rep from public.worker_voice_identity where report_id = r.id;
  if v_rep is null then return jsonb_build_object('available', false); end if;
  if v_rep = auth.uid() then raise exception 'FORBIDDEN: you cannot review a report you sent'; end if;
  if r.mode = 'confidential' then
    if not v_ministry then
      raise exception 'FORBIDDEN: only Ministry staff for this area can open a confidential identity';
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

-- 4. push dispatcher surface (service_role ONLY) ------------------------------------------------------------------------
create or replace function public.mg_wv_push_claim(p_limit integer default 100)
returns table (outbox_id uuid, subscription_id uuid, endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = public as $mg$
begin
  update public.worker_voice_push_outbox set state = 'expired', detail = 'not sent: older than 6 hours', updated_at = now()
   where state in ('queued','sending') and created_at < now() - interval '6 hours';
  return query
  with c as (
    select o.id from public.worker_voice_push_outbox o
     where (o.state = 'queued' or (o.state = 'sending' and o.updated_at < now() - interval '2 minutes')) and o.attempts < 5
     order by o.created_at limit greatest(1, least(p_limit, 500)) for update skip locked
  ), u as (
    update public.worker_voice_push_outbox o set state = 'sending', attempts = o.attempts + 1, updated_at = now()
      from c where o.id = c.id returning o.id, o.user_id
  )
  select u.id, ps.id, ps.endpoint, ps.p256dh, ps.auth from u
    join public.push_subscriptions ps on ps.user_id = u.user_id and ps.expired_at is null and ps.revoked_at is null;
end;
$mg$;

create or replace function public.mg_wv_push_record(p_outbox uuid, p_state text, p_detail text default null, p_dead_subscription uuid default null)
returns void language plpgsql security definer set search_path = public as $mg$
begin
  if p_state not in ('queued','sent','expired','failed') then raise exception 'INVALID_STATE'; end if;
  update public.worker_voice_push_outbox set state = p_state, detail = left(p_detail, 200), updated_at = now() where id = p_outbox;
  -- the push service said the subscription is gone: stop targeting it until the device registers again
  if p_dead_subscription is not null then
    update public.push_subscriptions set expired_at = now() where id = p_dead_subscription and expired_at is null;
  end if;
end;
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_wv_site_small(uuid)', 'mg_wv_set_anonymous(uuid,boolean)', 'mg_wv_code_info(uuid)', 'mg_wv_reply_mine(uuid,text)',
    'mg_wv_my_reports()', 'mg_wv_attachments(uuid)', 'mg_wv_attachment_counts()', 'mg_wv_ministry_can_read(uuid)',
    'mg_wv_submit(text,uuid,text,text,text,timestamptz,text,boolean,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'mg_wv_submit_anonymous(text,text,text,text,timestamptz,text,boolean,text,jsonb)', 'mg_wv_status(text)',
    'mg_wv_reply(text,text)', 'mg_wv_site_info(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  revoke all on function public.mg_wv_jpeg_problem(bytea), public.mg_wv_small_site(uuid), public.mg_wv_small_site_threshold()
    from public, anon, authenticated;
  revoke all on function public.mg_wv_push_claim(integer), public.mg_wv_push_record(uuid, text, text, uuid) from public, anon, authenticated;
  grant execute on function public.mg_wv_push_claim(integer), public.mg_wv_push_record(uuid, text, text, uuid) to service_role;
end $$;

commit;
