-- 0023_security_audit_hardening.sql
-- Independent pre-deployment audit remediation (findings F2, F3, F4, F8, F11).
--
--   F2  Rate limiter trusted the FIRST X-Forwarded-For hop, which a client can
--       set. Now prefers the CDN-set connecting IP, and adds a global backstop
--       bucket so rotating spoofed sources cannot flood the table.
--   F3  submit_community_report accepted unbounded / invalid input and a
--       client-chosen tracking code. Now validates server-side and ALWAYS
--       generates the tracking code on the server (80 bits, CSPRNG).
--   F4  report_tracking was world-readable (every code + status listable).
--       Direct reads are removed for anon and for non-staff; lookups go through
--       a rate-limited RPC that answers one code at a time.
--   F8  evidence bucket gets a MIME allow-list (no SVG / HTML / scripts).
--   F11 refresh_public_stats() is throttled for anonymous callers.
--
-- Existing rows are NOT re-validated (constraints are NOT VALID) so applying
-- this migration cannot fail on historical data.

begin;

-- ---------------------------------------------------------------------------
-- F2: trusted client address
-- ---------------------------------------------------------------------------
create or replace function public.mg_client_ip()
returns text
language sql stable
set search_path = public
as $$
  with h as (
    select coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb) as j
  )
  select nullif(lower(btrim(coalesce(
    nullif(h.j ->> 'cf-connecting-ip', ''),   -- set by the CDN; not client-forgeable
    nullif(split_part(coalesce(h.j ->> 'x-forwarded-for', ''), ',', 1), ''),
    nullif(h.j ->> 'x-real-ip', '')
  ))), '')
  from h
$$;

-- ---------------------------------------------------------------------------
-- F3: server-side bounds (new rows only)
-- ---------------------------------------------------------------------------
alter table public.community_reports drop constraint if exists community_reports_len_chk;
alter table public.community_reports
  add constraint community_reports_len_chk check (
    char_length(description) between 1 and 5000
    and char_length(county) <= 100
    and (district      is null or char_length(district)      <= 200)
    and (community     is null or char_length(community)     <= 200)
    and (contact_phone is null or char_length(contact_phone) <= 32)
  ) not valid;

alter table public.community_reports drop constraint if exists community_reports_geo_chk;
alter table public.community_reports
  add constraint community_reports_geo_chk check (
    (latitude  is null or latitude  between -90  and 90)
    and (longitude is null or longitude between -180 and 180)
  ) not valid;

-- ---------------------------------------------------------------------------
-- Internal stats recompute (not callable by API roles)
-- ---------------------------------------------------------------------------
create or replace function public.mg_recompute_public_stats()
returns void
language sql
security definer set search_path = public
as $$
  insert into public.meta (key, value)
  values (
    'public_stats',
    jsonb_build_object(
      'sites',            (select count(*) from public.sites),
      'inspections',      (select count(*) from public.inspections),
      'incidents',        (select count(*) from public.incidents),
      'communityReports', (select count(*) from public.community_reports)
    )
  )
  on conflict (key) do update
    set value = excluded.value;
$$;
revoke all on function public.mg_recompute_public_stats() from public, anon, authenticated;

-- F11: anonymous callers may refresh at most once per 10 seconds.
create or replace function public.refresh_public_stats()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_ok timestamptz;
begin
  if coalesce(auth.role(), 'anon') = 'anon' then
    insert into public.rate_limits (bucket, count, window_start)
    values ('stats:refresh', 1, now())
    on conflict (bucket) do update
      set count = 1, window_start = now()
      where public.rate_limits.window_start < now() - interval '10 seconds'
    returning window_start into v_ok;
    if v_ok is null then
      return; -- throttled: the stored value is at most 10s stale
    end if;
  end if;
  perform public.mg_recompute_public_stats();
end;
$$;

-- ---------------------------------------------------------------------------
-- F2 + F3: submit_community_report (signature unchanged; p_tracking_code is
-- now ignored — the server always mints the code)
-- ---------------------------------------------------------------------------
create or replace function public.submit_community_report(
  p_tracking_code text,
  p_category      text,
  p_description   text,
  p_county        text,
  p_district      text default null,
  p_community     text default null,
  p_latitude      double precision default null,
  p_longitude     double precision default null,
  p_contact_phone text default null
)
returns jsonb
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_id     uuid;
  v_code   text;
  v_src    text;
  v_key    text;
  v_count  integer;
  v_all    integer;
  v_county text;
  v_try    integer := 0;
  c_counties constant text[] := array[
    'bomi','bong','gbarpolu','grandbassa','grandcapemount','grandgedeh','grandkru',
    'lofa','margibi','maryland','montserrado','nimba','rivercess','rivergee','sinoe'];
begin
  -- ---- validation (before touching any counter) ----
  p_description := btrim(coalesce(p_description, ''));
  if p_description = '' or char_length(p_description) > 5000 then
    raise exception 'INVALID_INPUT: description must be 1-5000 characters';
  end if;
  v_county := lower(regexp_replace(coalesce(p_county, ''), '[^A-Za-z]', '', 'g'));
  if not (v_county = any (c_counties)) then
    raise exception 'INVALID_INPUT: unknown county';
  end if;
  if char_length(coalesce(p_district, '')) > 200 or char_length(coalesce(p_community, '')) > 200 then
    raise exception 'INVALID_INPUT: district/community too long';
  end if;
  p_contact_phone := nullif(btrim(coalesce(p_contact_phone, '')), '');
  if p_contact_phone is not null and p_contact_phone !~ '^[0-9+()\- ]{5,32}$' then
    raise exception 'INVALID_INPUT: contact phone format';
  end if;
  if (p_latitude is null) <> (p_longitude is null) then
    raise exception 'INVALID_INPUT: latitude and longitude must be given together';
  end if;
  if p_latitude is not null and not (
       p_latitude  between 3.0  and 10.0
   and p_longitude between -12.5 and -7.0) then
    raise exception 'INVALID_INPUT: coordinates are outside Liberia';
  end if;

  -- ---- rate limits: per source + global backstop ----
  v_src := public.mg_client_ip();
  if v_src is null or v_src = '' then
    v_key := 'report:global';
  else
    v_key := 'report:' || encode(digest('mgliberia-v1:' || v_src, 'sha256'), 'hex');
  end if;

  if random() < 0.02 then  -- opportunistic housekeeping; keeps the table bounded
    delete from public.rate_limits where window_start < now() - interval '1 hour';
  end if;

  insert into public.rate_limits (bucket, count, window_start)
  values (v_key, 1, now())
  on conflict (bucket) do update
    set count = case when public.rate_limits.window_start < now() - interval '60 seconds'
                     then 1 else public.rate_limits.count + 1 end,
        window_start = case when public.rate_limits.window_start < now() - interval '60 seconds'
                            then now() else public.rate_limits.window_start end
  returning count into v_count;
  if v_count > 30 then
    raise exception 'RATE_LIMITED: too many reports submitted from your network right now; try again in a minute';
  end if;

  insert into public.rate_limits (bucket, count, window_start)
  values ('global:report_all', 1, now())
  on conflict (bucket) do update
    set count = case when public.rate_limits.window_start < now() - interval '60 seconds'
                     then 1 else public.rate_limits.count + 1 end,
        window_start = case when public.rate_limits.window_start < now() - interval '60 seconds'
                            then now() else public.rate_limits.window_start end
  returning count into v_all;
  if v_all > 300 then
    raise exception 'RATE_LIMITED: the reporting service is busy; try again in a minute';
  end if;

  -- ---- insert with a server-minted code (retry on the astronomically rare clash) ----
  loop
    v_try := v_try + 1;
    v_code := 'CR-' || regexp_replace(
      upper(encode(gen_random_bytes(10), 'hex')), '(.{4})(?=.)', E'\\1-', 'g');
    begin
      insert into public.community_reports (
        tracking_code, category, description, county, district, community,
        latitude, longitude, contact_phone
      ) values (
        v_code, p_category::report_category, p_description, btrim(p_county),
        p_district, p_community, p_latitude, p_longitude, p_contact_phone
      )
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_try >= 3 then raise; end if;
    end;
  end loop;

  insert into public.report_tracking (tracking_code, status)
  values (v_code, 'submitted')
  on conflict (tracking_code) do nothing;

  perform public.mg_recompute_public_stats();
  return jsonb_build_object('id', v_id, 'trackingCode', v_code);
end;
$$;

grant execute on function
  public.submit_community_report(text, text, text, text, text, text, double precision, double precision, text)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- F4: single-code, rate-limited, non-enumerating tracking lookup
-- ---------------------------------------------------------------------------
create or replace function public.track_community_report(p_code text)
returns jsonb
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_code  text;
  v_src   text;
  v_key   text;
  v_count integer;
  v_row   record;
begin
  v_code := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  if char_length(v_code) < 6 or char_length(v_code) > 40 then
    return null;  -- same answer as "not found"
  end if;

  v_src := public.mg_client_ip();
  v_key := 'track:' || case when v_src is null or v_src = ''
                            then 'global'
                            else encode(digest('mgliberia-v1:' || v_src, 'sha256'), 'hex') end;
  insert into public.rate_limits (bucket, count, window_start)
  values (v_key, 1, now())
  on conflict (bucket) do update
    set count = case when public.rate_limits.window_start < now() - interval '60 seconds'
                     then 1 else public.rate_limits.count + 1 end,
        window_start = case when public.rate_limits.window_start < now() - interval '60 seconds'
                            then now() else public.rate_limits.window_start end
  returning count into v_count;
  if v_count > 20 then
    raise exception 'RATE_LIMITED: too many lookups from your network right now; try again in a minute';
  end if;

  select tracking_code, status, created_at into v_row
    from public.report_tracking where tracking_code = v_code;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'trackingCode', v_row.tracking_code,
    'status',       v_row.status,
    'createdAt',    v_row.created_at);
end;
$$;

grant execute on function public.track_community_report(text) to anon, authenticated;

-- Direct table reads: staff only (guests are `authenticated` too, so the old
-- world-readable policy exposed every code to anonymous-sign-in users as well).
drop policy if exists "tracking public read" on public.report_tracking;
drop policy if exists "tracking staff read" on public.report_tracking;
create policy "tracking staff read" on public.report_tracking
  for select to authenticated
  using (public.mg_is_staff());
revoke select on public.report_tracking from anon;

-- ---------------------------------------------------------------------------
-- F8: evidence bucket MIME allow-list
-- ---------------------------------------------------------------------------
update storage.buckets
   set allowed_mime_types = array[
     'image/jpeg','image/png','image/webp','image/heic','image/heif',
     'video/mp4','video/quicktime','video/webm','video/3gpp',
     'audio/mpeg','audio/mp4','audio/aac','audio/x-m4a','audio/webm','audio/ogg','audio/wav',
     'application/pdf','application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
 where id = 'evidence';

commit;
