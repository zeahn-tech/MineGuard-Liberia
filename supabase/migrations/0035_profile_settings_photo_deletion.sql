-- ============================================================================
-- MINEGUARD LIBERIA — migration 0035: profile settings, profile photo, account deletion
--
-- PROFILE: profiles.avatar_path (always '<uid>/avatar.jpg'), profiles.deleted_at.
--   mg_update_my_profile validates the editable details (name, job title); role,
--   scope, company binding and email stay admin-only (the existing profile guard).
-- PHOTO: a PRIVATE bucket `avatars` (2 MB, JPEG only). A person can read, write and
--   remove ONLY their own file (`<uid>/avatar.jpg`); nobody else can read it. The
--   browser shrinks the picture to a small square JPEG first (which also drops any
--   location data in the original); mg_set_my_avatar refuses a path that has no file.
-- DELETION (self-service; the edge function `account-delete` re-checks the password):
--   mg_account_deletion_blockers  why it is not allowed yet (last platform administrator;
--                                 sole administrator of a company)
--   mg_prepare_account_deletion   ends company memberships + site assignments, clears
--                                 the person's notifications, scrubs the profile
--                                 (name, email, job title, photo, role, binding) and
--                                 reports whether the person OWNS records.
--   The edge function then REMOVES the login when the person owns no records, and
--   otherwise DISABLES + anonymizes it — safety records (sites, inspections, findings,
--   incidents, corrective actions, evidence, templates) are never deleted and keep
--   their history under "Deleted user". Audit entries keep their text (accountability)
--   but lose the link to the account.
-- Idempotent. Rollback: drop the four functions, the avatars policies/bucket, and the
-- two columns (not before restoring any anonymized profiles you still need).
-- ============================================================================

begin;

alter table public.profiles add column if not exists avatar_path text;
alter table public.profiles add column if not exists deleted_at timestamptz;
alter table public.profiles drop constraint if exists profiles_avatar_path_check;
alter table public.profiles add constraint profiles_avatar_path_check
  check (avatar_path is null or avatar_path = id::text || '/avatar.jpg');

-- the notifications guard (0034) + one narrow allowance: a definer function that raised
-- the transaction-local flag may clear the leaving person's own inbox
create or replace function public.mg_notifications_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $mg$
begin
  if tg_op = 'DELETE' then
    if auth.uid() is not null and coalesce(current_setting('mg.notify', true), '') <> '1' then
      raise exception 'IMMUTABLE: notifications cannot be deleted by a client';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if auth.uid() is not null and coalesce(current_setting('mg.notify', true), '') <> '1' then
      new.user_id := auth.uid();
    end if;
    new.id           := coalesce(new.id, gen_random_uuid());
    new.created_at   := now();
    new.read_at      := null;
    new.dismissed_at := null;
    new.resolved_at  := null;
    return new;
  end if;

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
revoke execute on function public.mg_notifications_guard() from public, anon, authenticated;

-- PHOTO: private bucket, own file only ------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', false, 2097152)
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'allowed_mime_types') then
    update storage.buckets set allowed_mime_types = array['image/jpeg'] where id = 'avatars';
  end if;
end $$;

drop policy if exists "avatars read own" on storage.objects;
drop policy if exists "avatars insert own" on storage.objects;
drop policy if exists "avatars update own" on storage.objects;
drop policy if exists "avatars delete own" on storage.objects;

create policy "avatars read own" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and name = auth.uid()::text || '/avatar.jpg');
create policy "avatars insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and name = auth.uid()::text || '/avatar.jpg');
create policy "avatars update own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and name = auth.uid()::text || '/avatar.jpg')
  with check (bucket_id = 'avatars' and name = auth.uid()::text || '/avatar.jpg');
create policy "avatars delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and name = auth.uid()::text || '/avatar.jpg');

-- PROFILE DETAILS --------------------------------------------------------------------------------
create or replace function public.mg_update_my_profile(p_name text, p_job_title text default null)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_title text := nullif(btrim(coalesce(p_job_title, '')), '');
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    raise exception 'INVALID_NAME: enter your full name (2 to 120 characters)';
  end if;
  if v_title is not null and char_length(v_title) > 120 then
    raise exception 'INVALID_JOB_TITLE: at most 120 characters';
  end if;
  update public.profiles
     set name = v_name, job_title = v_title
   where id = auth.uid() and deleted_at is null;
  if not found then raise exception 'UNREGISTERED_USER'; end if;
end;
$mg$;

create or replace function public.mg_set_my_avatar(p_set boolean)
returns void
language plpgsql security definer set search_path = public
as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  if p_set then
    if not exists (select 1 from storage.objects
                    where bucket_id = 'avatars' and name = auth.uid()::text || '/avatar.jpg') then
      raise exception 'AVATAR_NOT_UPLOADED';
    end if;
    update public.profiles set avatar_path = id::text || '/avatar.jpg'
     where id = auth.uid() and deleted_at is null;
  else
    update public.profiles set avatar_path = null where id = auth.uid();
  end if;
end;
$mg$;

-- DELETION ----------------------------------------------------------------------------------------------
create or replace function public.mg_account_deletion_blockers()
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
declare
  v_uid uuid := auth.uid();
  out jsonb := '[]'::jsonb;
  r record;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if exists (select 1 from public.profiles where id = v_uid and role = 'admin')
     and not exists (select 1 from public.profiles
                      where role = 'admin' and id <> v_uid and deleted_at is null) then
    out := out || jsonb_build_array(jsonb_build_object('code', 'LAST_ADMIN',
      'message', 'You are the only administrator. Assign another administrator first.'));
  end if;
  for r in
    select o.name
      from public.organization_members m
      join public.organizations o on o.id = m.organization_id
     where m.user_id = v_uid and m.org_role = 'company_admin' and m.status = 'active'
       and not exists (select 1 from public.organization_members x
                        where x.organization_id = m.organization_id and x.org_role = 'company_admin'
                          and x.status = 'active' and x.user_id <> v_uid)
  loop
    out := out || jsonb_build_array(jsonb_build_object('code', 'SOLE_COMPANY_ADMIN',
      'message', 'You are the only administrator of ' || r.name || '. Ask the Ministry to appoint another administrator first.'));
  end loop;
  return out;
end;
$mg$;

create or replace function public.mg_prepare_account_deletion()
returns jsonb
language plpgsql security definer set search_path = public
as $mg$
declare
  v_uid uuid := auth.uid();
  v_blockers jsonb;
  v_avatar text;
  v_has boolean := false;
  r record;
  n bigint;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  v_blockers := public.mg_account_deletion_blockers();
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
  update public.site_assignments set revoked_at = now(), revoked_by = v_uid
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

do $$
declare f text;
begin
  foreach f in array array[
    'mg_update_my_profile(text, text)',
    'mg_set_my_avatar(boolean)',
    'mg_account_deletion_blockers()',
    'mg_prepare_account_deletion()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
