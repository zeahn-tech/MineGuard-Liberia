-- ============================================================================
-- MINEGUARD LIBERIA — migration 0039: Ministry oversight summary + administrator removal of users
--
-- OVERSIGHT. mg_company_oversight(): one row per company with its sites, open and overdue
-- corrective actions, incidents in the last 30 days and last inspection — a cross-company
-- summary for the Ministry's staff. It runs as the CALLER (security invoker), so row-level
-- security scopes every number: a county inspector sees only what that county's scope
-- allows, an administrator sees everything. The registrar and company users are refused.
--
-- USER REMOVAL BY AN ADMINISTRATOR. The deletion rules of migration 0035 are generalised
-- to "a given person" (cores are internal): the same blockers (last platform administrator,
-- sole company administrator), the same scrub, and the same two outcomes (login removed
-- when the person owns no records; otherwise disabled + anonymized with their safety
-- records kept as "Deleted user"). On top of that, for an administrator acting on SOMEONE
-- ELSE: users.manage is required, never oneself (that is the self-service flow), the exact
-- email must be typed, and an audit entry records who removed whom.
--   mg_admin_user_directory            find a person (search, paging) — administrators only
--   mg_admin_account_deletion_blockers why it cannot be done yet
--   mg_admin_prepare_account_deletion  do the database part (the edge function then acts on
--                                      the login, after re-checking the administrator's password)
-- Removing someone from their COMPANY only (the account stays) uses the existing
-- mg_revoke_member, which the Ministry administrator already holds through oversight.
-- The self-service functions keep their behaviour exactly (thin wrappers over the cores).
-- Idempotent. Rollback: drop the new functions; restore the 0035 definitions of
-- mg_account_deletion_blockers / mg_prepare_account_deletion.
-- ============================================================================

begin;

create or replace function public.mg_account_deletion_blockers_core(p_uid uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
declare
  v_uid uuid := p_uid;
  out jsonb := '[]'::jsonb;
  r record;
begin
  if v_uid is null then raise exception 'NOT_FOUND'; end if;
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

revoke all on function public.mg_account_deletion_blockers_core(uuid) from public, anon, authenticated;
revoke all on function public.mg_prepare_account_deletion_core(uuid, uuid) from public, anon, authenticated;

-- the self-service functions: unchanged behaviour, now thin wrappers
create or replace function public.mg_account_deletion_blockers()
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  return public.mg_account_deletion_blockers_core(auth.uid());
end;
$mg$;

create or replace function public.mg_prepare_account_deletion()
returns jsonb
language plpgsql security definer set search_path = public
as $mg$
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED'; end if;
  return public.mg_prepare_account_deletion_core(auth.uid(), auth.uid());
end;
$mg$;

-- ADMINISTRATOR: find people ---------------------------------------------------------------------------
create or replace function public.mg_admin_user_directory(
  p_query text default null, p_limit integer default 25, p_offset integer default 0)
returns table (user_id uuid, email text, name text, role text, company text,
               org_role text, member_id uuid, created_at timestamptz, removed boolean)
language plpgsql stable security definer set search_path = public
as $mg$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_like text;
begin
  if auth.uid() is null or not public.mg_has_permission('users.manage') then
    raise exception 'FORBIDDEN: users.manage required';
  end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return query
    select p.id, p.email, p.name, p.role::text, o.name, m.org_role, m.id, p.created_at, p.deleted_at is not null
      from public.profiles p
      left join public.organization_members m on m.user_id = p.id and m.status = 'active'
      left join public.organizations o on o.id = m.organization_id
     where v_q is null or p.email ilike v_like escape '\' or p.name ilike v_like escape '\'
     order by p.created_at desc, p.id
     limit greatest(1, least(coalesce(p_limit, 25), 50))
    offset greatest(0, coalesce(p_offset, 0));
end;
$mg$;

create or replace function public.mg_admin_account_deletion_blockers(p_target uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_has_permission('users.manage') then
    raise exception 'FORBIDDEN: users.manage required';
  end if;
  if p_target = auth.uid() then
    raise exception 'USE_SELF_SERVICE: delete your own account from My profile';
  end if;
  if not exists (select 1 from public.profiles where id = p_target and deleted_at is null) then
    raise exception 'NOT_FOUND';
  end if;
  return public.mg_account_deletion_blockers_core(p_target);
end;
$mg$;

create or replace function public.mg_admin_prepare_account_deletion(p_target uuid, p_confirm_email text)
returns jsonb
language plpgsql security definer set search_path = public
as $mg$
declare
  v_email text;
  v_actor_label text;
begin
  if auth.uid() is null or not public.mg_has_permission('users.manage') then
    raise exception 'FORBIDDEN: users.manage required';
  end if;
  if p_target = auth.uid() then
    raise exception 'USE_SELF_SERVICE: delete your own account from My profile';
  end if;
  select email into v_email from public.profiles where id = p_target and deleted_at is null;
  if not found then raise exception 'NOT_FOUND'; end if;
  if lower(btrim(coalesce(p_confirm_email, ''))) <> lower(coalesce(v_email, '')) then
    raise exception 'CONFIRM_MISMATCH: type the account''s exact email address';
  end if;

  select coalesce(email, 'administrator') into v_actor_label from public.profiles where id = auth.uid();
  insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary, details)
  values (auth.uid(), v_actor_label, 'account.removed', 'profiles', p_target::text,
          'Account removed by an administrator', '{}'::jsonb);

  return public.mg_prepare_account_deletion_core(p_target, auth.uid());
end;
$mg$;

-- MINISTRY: cross-company oversight ---------------------------------------------------------------------
create or replace function public.mg_company_oversight()
returns table (organization_id uuid, name text, status text, sites integer, open_actions integer,
               overdue_actions integer, incidents_30d integer, last_inspection timestamptz)
language plpgsql stable security invoker set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_is_staff() then
    raise exception 'FORBIDDEN: Ministry staff only';
  end if;
  return query
    select o.id, o.name, o.status,
           (select count(*)::int from public.sites s where s.organization_id = o.id),
           (select count(*)::int from public.corrective_actions ca join public.sites s on s.id = ca.site_id
             where s.organization_id = o.id and ca.status not in ('verified', 'closed')),
           (select count(*)::int from public.corrective_actions ca join public.sites s on s.id = ca.site_id
             where s.organization_id = o.id and ca.status not in ('verified', 'closed') and ca.due_at < now()),
           (select count(*)::int from public.incidents i join public.sites s on s.id = i.site_id
             where s.organization_id = o.id and i.occurred_at > now() - interval '30 days'),
           (select max(coalesce(n.submitted_at, n.created_at)) from public.inspections n join public.sites s on s.id = n.site_id
             where s.organization_id = o.id)
      from public.organizations o
     where public.mg_is_admin()
        or exists (select 1 from public.sites s where s.organization_id = o.id)
     order by 6 desc, 5 desc, o.name;
end;
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_account_deletion_blockers()',
    'mg_prepare_account_deletion()',
    'mg_admin_user_directory(text, integer, integer)',
    'mg_admin_account_deletion_blockers(uuid)',
    'mg_admin_prepare_account_deletion(uuid, text)',
    'mg_company_oversight()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
