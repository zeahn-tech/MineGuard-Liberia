-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0049: public reports with ownership, personal tracking,
--                                     feedback & inquiries (Public User programme, Phase C)
--
-- Builds on 0047 (no self-service admin) and 0048 (server-side public-user identity).
--
-- WHAT THIS ADDS
--   A. report_category gains 'other' (other mining-related concerns). The enum value cannot be
--      removed again; the rollback leaves it in place (unused values are harmless).
--   B. community_reports.submitter_id (nullable). ANONYMOUS reporting is unchanged:
--      submit_community_report is NOT modified and still records no owner.
--      submit_my_community_report(...) is the opt-in path for VERIFIED public users: it reuses the
--      anonymous function (so every validation, network rate limit and server-minted code is the
--      same) and then claims the row for auth.uid(). The browser never sends an owner id.
--      It adds a per-user limit (10 per hour) and refuses an identical report within 24 hours.
--   C. mg_guard_report_update(): ownership and tracking code are immutable — for staff and
--      administrators too. Only two trusted, transaction-local modes exist: 'claim' (the submit
--      function above: NULL -> auth.uid() and nothing else) and 'clear' (account deletion:
--      owner -> NULL and nothing else). Triage transitions are unchanged.
--   D. mg_my_community_reports(): an account's OWN reports, curated columns only. It takes no id,
--      so there is nothing to tamper with; it never returns the reviewer's note or identity.
--      Owners get no direct table access (row-level security cannot hide columns).
--   E. public_feedback + submit_public_feedback / mg_my_feedback / mg_feedback_queue /
--      mg_respond_feedback: feedback and inquiries from verified public users, answered in-app by
--      Ministry reviewers (administrators and supervisors). RPC-only for writes; the internal
--      note is never returned to the submitter.
--   F. mg_prepare_account_deletion_core(): before anything else, the person's reports and
--      messages keep their content but lose the link to the account (submitter_id -> NULL).
--      (Body = 0039 verbatim plus that one step.)
--
-- Idempotent. ROLLBACK: supabase/maintenance/rollback_0049_public_reports_feedback.sql
-- ===========================================================================

begin;

-- A. category 'other' ---------------------------------------------------------------------
do $do$
declare
  v_typ    oid;
  v_schema text;
  v_name   text;
  v_kind   "char";
begin
  select t.oid, n.nspname, t.typname, t.typtype
    into v_typ, v_schema, v_name, v_kind
    from pg_attribute a
    join pg_type t      on t.oid = a.atttypid
    join pg_namespace n on n.oid = t.typnamespace
   where a.attrelid = 'public.community_reports'::regclass
     and a.attname = 'category'
     and not a.attisdropped;
  if v_typ is null then
    raise exception 'MG0049: public.community_reports.category column not found';
  end if;
  if v_kind = 'e' then
    if not exists (select 1 from pg_enum e where e.enumtypid = v_typ and e.enumlabel = 'other') then
      execute format('alter type %I.%I add value ''other''', v_schema, v_name);
    end if;
  end if;
end
$do$;

-- B. ownership column ---------------------------------------------------------------------
alter table public.community_reports
  add column if not exists submitter_id uuid references public.profiles(id);
create index if not exists community_reports_submitter_idx
  on public.community_reports (submitter_id, created_at desc)
  where submitter_id is not null;

-- C. report guard: immutable ownership and tracking code -----------------------------------
create or replace function public.mg_guard_report_update()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_mode text := coalesce(current_setting('mg.report_owner', true), '');
begin
  if v_mode in ('claim', 'clear') then
    -- trusted, transaction-local modes: ONLY the owner link may change, and only in one direction
    if (to_jsonb(new) - 'submitter_id' - 'updated_at' - 'updated_by' - 'row_version')
         is distinct from
       (to_jsonb(old) - 'submitter_id' - 'updated_at' - 'updated_by' - 'row_version') then
      raise exception 'FORBIDDEN: only the owner link may change here';
    end if;
    if v_mode = 'claim'
       and not (old.submitter_id is null and auth.uid() is not null and new.submitter_id = auth.uid()) then
      raise exception 'FORBIDDEN: a report can only be claimed by its submitter';
    end if;
    if v_mode = 'clear' and new.submitter_id is not null then
      raise exception 'FORBIDDEN: the owner link can only be cleared here';
    end if;
    return new;
  end if;

  if new.submitter_id is distinct from old.submitter_id then
    raise exception 'FORBIDDEN: report ownership cannot be changed';
  end if;
  if new.tracking_code is distinct from old.tracking_code then
    raise exception 'FORBIDDEN: the tracking code cannot be changed';
  end if;

  if not public.mg_is_staff() then
    raise exception 'FORBIDDEN: staff required';
  end if;
  if old.status = 'submitted' and new.status = 'under_review' then
    return new;
  end if;
  if old.status = 'under_review'
     and new.status in ('verified','dismissed','referred')
     and public.mg_is_reviewer() then
    return new;
  end if;
  raise exception 'NOT_REVIEWABLE: triage transition not permitted';
end;
$mg$;

-- B (cont). opt-in submission that links the report to the verified account -----------------
create or replace function public.submit_my_community_report(
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
as $mg$
declare
  v_uid   uuid := auth.uid();
  v_res   jsonb;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: sign in to link a report to your account';
  end if;
  if not public.mg_is_verified_public_user() then
    raise exception 'FORBIDDEN: linking reports to an account needs a verified public account; you can still send this report anonymously';
  end if;

  if exists (
    select 1 from public.community_reports r
     where r.submitter_id = v_uid
       and r.created_at > now() - interval '24 hours'
       and md5(lower(btrim(r.description))) = md5(lower(btrim(coalesce(p_description, ''))))
  ) then
    raise exception 'DUPLICATE: you already sent this report in the last 24 hours; see My reports';
  end if;

  insert into public.rate_limits (bucket, count, window_start)
  values ('report-user:' || v_uid::text, 1, now())
  on conflict (bucket) do update
    set count = case when public.rate_limits.window_start < now() - interval '1 hour'
                     then 1 else public.rate_limits.count + 1 end,
        window_start = case when public.rate_limits.window_start < now() - interval '1 hour'
                            then now() else public.rate_limits.window_start end
  returning count into v_count;
  if v_count > 10 then
    raise exception 'RATE_LIMITED: you have sent many reports in the last hour; try again later';
  end if;

  -- every validation, network rate limit and the server-minted tracking code
  v_res := public.submit_community_report(
    null, p_category, p_description, p_county, p_district, p_community,
    p_latitude, p_longitude, p_contact_phone);

  perform set_config('mg.report_owner', 'claim', true);
  update public.community_reports
     set submitter_id = v_uid
   where id = (v_res ->> 'id')::uuid and submitter_id is null;
  perform set_config('mg.report_owner', '', true);

  return v_res;
end;
$mg$;

-- D. an account's own reports (curated columns) ---------------------------------------------
create or replace function public.mg_my_community_reports()
returns table (
  id            uuid,
  tracking_code text,
  category      text,
  description   text,
  county        text,
  district      text,
  community     text,
  status        text,
  created_at    timestamptz,
  reviewed_at   timestamptz
)
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or public.mg_is_anonymous() then
    return;
  end if;
  return query
    select r.id, r.tracking_code, r.category::text, r.description, r.county, r.district,
           r.community, r.status::text, r.created_at, r.reviewed_at
      from public.community_reports r
     where r.submitter_id = auth.uid()
     order by r.created_at desc
     limit 100;
end;
$mg$;

-- E. feedback and inquiries -----------------------------------------------------------------
create table if not exists public.public_feedback (
  id            uuid primary key default gen_random_uuid(),
  submitter_id  uuid references public.profiles(id),
  kind          text not null check (kind in ('feedback', 'inquiry')),
  subject       text not null check (char_length(subject) between 3 and 120),
  message       text not null check (char_length(message) between 10 and 2000),
  status        text not null default 'new' check (status in ('new', 'in_review', 'answered', 'closed')),
  response      text check (response is null or char_length(response) between 5 and 2000),
  responded_at  timestamptz,
  responded_by  uuid references public.profiles(id),
  internal_note text check (internal_note is null or char_length(internal_note) <= 1000),
  fingerprint   text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  updated_by    uuid,
  row_version   integer not null default 1
);
create index if not exists public_feedback_owner_idx
  on public.public_feedback (submitter_id, created_at desc) where submitter_id is not null;
create index if not exists public_feedback_queue_idx
  on public.public_feedback (status, created_at);

alter table public.public_feedback enable row level security;
revoke all on public.public_feedback from public, anon, authenticated;
grant select on public.public_feedback to authenticated;
drop policy if exists "feedback reviewers read" on public.public_feedback;
create policy "feedback reviewers read" on public.public_feedback
  for select to authenticated using (public.mg_is_reviewer());

drop trigger if exists public_feedback_touch on public.public_feedback;
create trigger public_feedback_touch before insert or update on public.public_feedback
  for each row execute function public.mg_touch_row();
drop trigger if exists public_feedback_audit on public.public_feedback;
create trigger public_feedback_audit after insert or update on public.public_feedback
  for each row execute function public.mg_audit_row();

create or replace function public.submit_public_feedback(p_kind text, p_subject text, p_message text)
returns jsonb
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_uid     uuid := auth.uid();
  v_kind    text := lower(btrim(coalesce(p_kind, '')));
  v_subject text := btrim(coalesce(p_subject, ''));
  v_message text := btrim(coalesce(p_message, ''));
  v_fp      text;
  v_count   integer;
  v_all     integer;
  v_id      uuid;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: sign in to send feedback';
  end if;
  if not public.mg_is_verified_public_user() then
    raise exception 'FORBIDDEN: feedback needs a verified public account';
  end if;
  if v_kind not in ('feedback', 'inquiry') then
    raise exception 'INVALID_INPUT: kind must be feedback or inquiry';
  end if;
  if char_length(v_subject) not between 3 and 120 then
    raise exception 'INVALID_INPUT: subject must be 3 to 120 characters';
  end if;
  if char_length(v_message) not between 10 and 2000 then
    raise exception 'INVALID_INPUT: message must be 10 to 2000 characters';
  end if;
  if (select count(*) from regexp_matches(lower(v_subject || ' ' || v_message), 'https?://', 'g')) > 2 then
    raise exception 'INVALID_INPUT: please include at most two web links';
  end if;

  v_fp := md5(lower(v_subject || '|' || v_message));
  if exists (select 1 from public.public_feedback f
              where f.submitter_id = v_uid and f.fingerprint = v_fp
                and f.created_at > now() - interval '24 hours') then
    raise exception 'DUPLICATE: you already sent this message in the last 24 hours';
  end if;
  if (select count(*) from public.public_feedback f
       where f.submitter_id = v_uid and f.status in ('new', 'in_review')) >= 20 then
    raise exception 'LIMIT: you have 20 open messages; wait for answers before sending more';
  end if;

  insert into public.rate_limits (bucket, count, window_start)
  values ('feedback-user:' || v_uid::text, 1, now())
  on conflict (bucket) do update
    set count = case when public.rate_limits.window_start < now() - interval '1 hour'
                     then 1 else public.rate_limits.count + 1 end,
        window_start = case when public.rate_limits.window_start < now() - interval '1 hour'
                            then now() else public.rate_limits.window_start end
  returning count into v_count;
  if v_count > 5 then
    raise exception 'RATE_LIMITED: you have sent several messages in the last hour; try again later';
  end if;

  insert into public.rate_limits (bucket, count, window_start)
  values ('global:feedback_all', 1, now())
  on conflict (bucket) do update
    set count = case when public.rate_limits.window_start < now() - interval '60 seconds'
                     then 1 else public.rate_limits.count + 1 end,
        window_start = case when public.rate_limits.window_start < now() - interval '60 seconds'
                            then now() else public.rate_limits.window_start end
  returning count into v_all;
  if v_all > 120 then
    raise exception 'RATE_LIMITED: the feedback service is busy; try again in a minute';
  end if;

  insert into public.public_feedback (submitter_id, kind, subject, message, fingerprint)
  values (v_uid, v_kind, v_subject, v_message, v_fp)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$mg$;

create or replace function public.mg_my_feedback()
returns table (
  id           uuid,
  kind         text,
  subject      text,
  message      text,
  status       text,
  response     text,
  responded_at timestamptz,
  created_at   timestamptz
)
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or public.mg_is_anonymous() then
    return;
  end if;
  return query
    select f.id, f.kind, f.subject, f.message, f.status, f.response, f.responded_at, f.created_at
      from public.public_feedback f
     where f.submitter_id = auth.uid()
     order by f.created_at desc
     limit 100;
end;
$mg$;

create or replace function public.mg_feedback_queue(p_status text default null, p_limit integer default 50)
returns table (
  id            uuid,
  submitter_id  uuid,
  kind          text,
  subject       text,
  message       text,
  status        text,
  response      text,
  responded_at  timestamptz,
  internal_note text,
  created_at    timestamptz
)
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_is_reviewer() then
    raise exception 'FORBIDDEN: reviewer role required';
  end if;
  return query
    select f.id, f.submitter_id, f.kind, f.subject, f.message, f.status, f.response,
           f.responded_at, f.internal_note, f.created_at
      from public.public_feedback f
     where p_status is null or f.status = p_status
     order by (f.status in ('new', 'in_review')) desc, f.created_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$mg$;

create or replace function public.mg_respond_feedback(
  p_id uuid, p_status text, p_response text default null, p_internal_note text default null)
returns void
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_resp text := nullif(btrim(coalesce(p_response, '')), '');
  v_note text := nullif(btrim(coalesce(p_internal_note, '')), '');
  v_old  record;
begin
  if auth.uid() is null or not public.mg_is_reviewer() then
    raise exception 'FORBIDDEN: reviewer role required';
  end if;
  if p_status not in ('in_review', 'answered', 'closed') then
    raise exception 'INVALID_INPUT: status must be in_review, answered or closed';
  end if;
  select * into v_old from public.public_feedback where id = p_id;
  if not found then
    raise exception 'NOT_FOUND: no such message';
  end if;
  if p_status = 'answered' and coalesce(char_length(v_resp), 0) < 5 then
    raise exception 'INVALID_INPUT: write the answer the person will read (at least 5 characters)';
  end if;
  if v_resp is not null and char_length(v_resp) > 2000 then
    raise exception 'INVALID_INPUT: the answer can be at most 2000 characters';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'INVALID_INPUT: the internal note can be at most 1000 characters';
  end if;

  update public.public_feedback
     set status        = p_status,
         response      = coalesce(v_resp, response),
         responded_at  = case when v_resp is not null then now() else responded_at end,
         responded_by  = case when v_resp is not null then auth.uid() else responded_by end,
         internal_note = coalesce(v_note, internal_note)
   where id = p_id;
end;
$mg$;

-- grants: signed-in sessions only (each function re-checks who is calling)
revoke all on function public.submit_my_community_report(text, text, text, text, text, double precision, double precision, text) from public, anon;
revoke all on function public.mg_my_community_reports() from public, anon;
revoke all on function public.submit_public_feedback(text, text, text) from public, anon;
revoke all on function public.mg_my_feedback() from public, anon;
revoke all on function public.mg_feedback_queue(text, integer) from public, anon;
revoke all on function public.mg_respond_feedback(uuid, text, text, text) from public, anon;
grant execute on function public.submit_my_community_report(text, text, text, text, text, double precision, double precision, text) to authenticated;
grant execute on function public.mg_my_community_reports() to authenticated;
grant execute on function public.submit_public_feedback(text, text, text) to authenticated;
grant execute on function public.mg_my_feedback() to authenticated;
grant execute on function public.mg_feedback_queue(text, integer) to authenticated;
grant execute on function public.mg_respond_feedback(uuid, text, text, text) to authenticated;

-- F. account deletion: reports and messages stay, the link to the account goes ---------------
create or replace function public.mg_prepare_account_deletion_core(p_uid uuid, p_actor uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $mg$
declare
  v_uid uuid := p_uid;
  v_blockers jsonb;
  v_avatar text;
  v_has boolean := false;
  r record;
  n bigint;
begin
  if v_uid is null then raise exception 'NOT_FOUND'; end if;
  v_blockers := public.mg_account_deletion_blockers_core(v_uid);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'BLOCKED: %', v_blockers->0->>'message';
  end if;
  select avatar_path into v_avatar from public.profiles where id = v_uid;

  -- A0 (0049). Their public reports and messages keep their content but lose the link to the
  -- account, so nothing below treats them as records the person owns. Report ownership may only
  -- be cleared (never set or moved) in this trusted, transaction-local mode.
  perform set_config('mg.report_owner', 'clear', true);
  update public.community_reports set submitter_id = null where submitter_id = v_uid;
  perform set_config('mg.report_owner', '', true);
  update public.public_feedback set submitter_id = null where submitter_id = v_uid;

  -- A. DETECT (changes nothing): does the person OWN records? A required link means yes;
  -- an optional link that cannot be cleared (e.g. an append-only table) also means yes.
  for r in
    select regexp_replace(c.conrelid::regclass::text, '^public\.', '') as tbl,
           a.attname as col, a.attnotnull as notnull
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass and c.confdeltype <> 'c'
       and regexp_replace(c.conrelid::regclass::text, '^public\.', '')
           not in ('organization_members', 'notifications', 'ai_request_log', 'site_assignments')
  loop
    execute format('select count(*) from public.%I where %I = $1', r.tbl, r.col) into n using v_uid;
    if n > 0 then
      if r.notnull then
        v_has := true;
      else
        begin   -- dry run: try it, then undo it with a sentinel error
          execute format('update public.%I set %I = null where %I = $1', r.tbl, r.col, r.col) using v_uid;
          raise exception 'DRYRUN';
        exception when others then
          if sqlerrm <> 'DRYRUN' then v_has := true; end if;
        end;
      end if;
    end if;
  end loop;

  -- B. they stop being a company person right now
  update public.organization_members set status = 'revoked'
   where user_id = v_uid and status in ('pending', 'active');
  update public.site_assignments set revoked_at = now(), revoked_by = p_actor
   where user_id = v_uid and revoked_at is null;

  -- the private inbox is theirs alone: it goes with them
  perform set_config('mg.notify', '1', true);
  delete from public.notifications where user_id = v_uid;
  perform set_config('mg.notify', '0', true);

  perform set_config('mg.org_assign', '1', true);
  update public.profiles
     set name = 'Deleted user',
         email = 'deleted-' || id::text || '@deleted.invalid',
         job_title = null, organization = null, county = null, avatar_path = null,
         role = null, scope = null, operator_name = null, organization_id = null,
         scope_area_id = null, profile_complete = false, deleted_at = now()
   where id = v_uid;
  perform set_config('mg.org_assign', '0', true);

  -- C. nothing to protect: clear every remaining link so the login can be deleted outright.
  -- (Their records, when they have any, keep their link and their history.)
  if not v_has then
    delete from public.ai_request_log where user_id = v_uid;
    delete from public.organization_members where user_id = v_uid;
    update public.site_assignments set assigned_by = null where assigned_by = v_uid;
    for r in
      select regexp_replace(c.conrelid::regclass::text, '^public\.', '') as tbl, a.attname as col
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass and c.confdeltype <> 'c'
         and not a.attnotnull
         and regexp_replace(c.conrelid::regclass::text, '^public\.', '')
             not in ('audit_log', 'site_assignments')
    loop
      execute format('update public.%I set %I = null where %I = $1', r.tbl, r.col, r.col) using v_uid;
    end loop;
    -- last: the audit trail (earlier statements above wrote entries too). The entries keep
    -- their text for accountability but no longer point at the account.
    update public.audit_log set actor_id = null where actor_id = v_uid;
  end if;

  return jsonb_build_object('avatarPath', v_avatar, 'hasRecords', v_has);
end;
$mg$;

commit;
