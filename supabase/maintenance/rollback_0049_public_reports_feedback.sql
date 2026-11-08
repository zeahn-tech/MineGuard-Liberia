-- ===========================================================================
-- ROLLBACK of migration 0049 (public reports with ownership, feedback and inquiries).
-- LOSES: every report's owner link (reports themselves stay, anonymous again) and ALL
-- public_feedback rows (messages and answers). Export first if they matter:
--   select * from public.public_feedback;  select id, submitter_id from public.community_reports where submitter_id is not null;
-- The report_category value 'other' stays (an enum value cannot be removed; unused it is harmless;
-- reports already filed as 'other' keep it). Not in supabase/migrations (the suite and fresh
-- installs apply everything there). Run before rolling back 0048, never after.
-- ===========================================================================
begin;

-- restore 0039's deletion routine (no owner-link step)
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

-- restore the 0001 report guard (no ownership rules)
create or replace function public.mg_guard_report_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
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
$$;

drop function if exists public.mg_respond_feedback(uuid, text, text, text);
drop function if exists public.mg_feedback_queue(text, integer);
drop function if exists public.mg_my_feedback();
drop function if exists public.submit_public_feedback(text, text, text);
drop table if exists public.public_feedback;

drop function if exists public.mg_my_community_reports();
drop function if exists public.submit_my_community_report(text, text, text, text, text, double precision, double precision, text);
drop index if exists public.community_reports_submitter_idx;
alter table public.community_reports drop column if exists submitter_id;

commit;
