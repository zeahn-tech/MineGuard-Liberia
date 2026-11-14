-- ============================================================================
-- 0054 — Company workforce discipline: suspend, reinstate, remove, block
--
-- A company administrator (or the Ministry) can now, for their OWN company only:
--   * SUSPEND a member   — access stops at once, the membership and the person's site
--                          assignments are kept, and the suspension can be lifted
--                          (mg_suspend_member / mg_reinstate_member).
--   * REMOVE a member    — the existing removal, now with an optional reason, and it also
--                          works on a suspended member (mg_remove_member).
--   * BLOCK a person     — removal PLUS a standing block: the person cannot request to join,
--                          be invited, accept an old invitation, or be reinstated until an
--                          administrator unblocks them (mg_block_member / mg_unblock).
--
-- Rules shared by every action (the browser only mirrors them):
--   * authorization is mg_can_manage_company(org): an active administrator of an APPROVED
--     company, or the Ministry. Nobody else; no cross-company reach.
--   * never against yourself; never against a company administrator unless the Ministry.
--   * suspend and block REQUIRE a written reason (5–500 characters). It is kept on the
--     membership / block row, is visible to company administrators only, and is audited
--     (mg_audit_row). The affected person is told THAT access changed, not the reason.
--   * the block is enforced by database triggers on organization_members and
--     organization_invitations, so every existing and future path (join request, invitation,
--     bulk import, accept, approve, reinstate) is covered — not just the new screen.
--
-- Clients stay SELECT-only; every write is a definer function.
-- Idempotent. Rollback: drop the functions/triggers/table below, delete rows with
-- status 'suspended' (or set them to 'revoked'), restore the status check without
-- 'suspended' and 0034's mg_notify_on_membership / 0031's mg_import_eval.
-- Deployment order: this migration BEFORE the updated frontend.
-- ============================================================================

begin;

-- A. membership: a 'suspended' state and who/why ------------------------------------------------
alter table public.organization_members drop constraint if exists organization_members_status_check;
alter table public.organization_members
  add constraint organization_members_status_check
  check (status in ('pending','active','suspended','revoked','rejected'));

alter table public.organization_members add column if not exists status_reason text;
alter table public.organization_members add column if not exists status_changed_at timestamptz;
alter table public.organization_members add column if not exists status_changed_by uuid;

-- NOTE: organization_members_one_live_per_user covers only 'pending' and 'active'. A suspended
-- person therefore does not block themselves from joining elsewhere; reinstatement re-checks.

-- B. the block list -------------------------------------------------------------------------------
create table if not exists public.organization_member_blocks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid,
  email           text not null check (email = lower(email) and char_length(email) <= 254),
  reason          text not null check (char_length(reason) between 5 and 500),
  blocked_by      uuid,
  blocked_at      timestamptz not null default now(),
  lifted_by       uuid,
  lifted_at       timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  updated_by      uuid,
  row_version     integer not null default 1
);
create unique index if not exists organization_member_blocks_one_live
  on public.organization_member_blocks (organization_id, email) where lifted_at is null;
create index if not exists organization_member_blocks_org_idx
  on public.organization_member_blocks (organization_id);

alter table public.organization_member_blocks enable row level security;
drop policy if exists "org blocks read" on public.organization_member_blocks;
create policy "org blocks read" on public.organization_member_blocks
  for select to authenticated
  using (public.mg_has_permission('users.manage') or public.mg_can_manage_company(organization_id));
revoke all on public.organization_member_blocks from public, anon, authenticated;
grant select on public.organization_member_blocks to authenticated;

drop trigger if exists organization_member_blocks_touch on public.organization_member_blocks;
create trigger organization_member_blocks_touch before insert or update on public.organization_member_blocks
  for each row execute function public.mg_touch_row();
drop trigger if exists organization_member_blocks_audit on public.organization_member_blocks;
create trigger organization_member_blocks_audit after insert or update on public.organization_member_blocks
  for each row execute function public.mg_audit_row();

-- C. enforcement: a blocked person cannot become live in that company by ANY path ------------------
create or replace function public.mg_is_blocked(p_org uuid, p_user uuid, p_email text)
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select exists (
    select 1 from public.organization_member_blocks b
     where b.organization_id = p_org and b.lifted_at is null
       and ((p_user is not null and b.user_id = p_user)
            or (p_email is not null and b.email = lower(btrim(p_email)))))
$mg$;
revoke all on function public.mg_is_blocked(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.mg_guard_blocked_member()
returns trigger
language plpgsql security definer set search_path = public
as $mg$
declare v_email text;
begin
  if new.status in ('pending','active')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    select lower(p.email) into v_email from public.profiles p where p.id = new.user_id;
    if public.mg_is_blocked(new.organization_id, new.user_id, v_email) then
      raise exception 'BLOCKED_FROM_COMPANY: this person is blocked from the company';
    end if;
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_guard_blocked_member() from public, anon, authenticated;

drop trigger if exists organization_members_block_guard on public.organization_members;
create trigger organization_members_block_guard before insert or update on public.organization_members
  for each row execute function public.mg_guard_blocked_member();

create or replace function public.mg_guard_blocked_invitation()
returns trigger
language plpgsql security definer set search_path = public
as $mg$
begin
  if public.mg_is_blocked(new.organization_id, null, new.email) then
    raise exception 'BLOCKED_FROM_COMPANY: this person is blocked from the company';
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_guard_blocked_invitation() from public, anon, authenticated;

drop trigger if exists organization_invitations_block_guard on public.organization_invitations;
create trigger organization_invitations_block_guard before insert on public.organization_invitations
  for each row execute function public.mg_guard_blocked_invitation();

-- Bulk import: report a blocked address as an error row instead of failing the batch.
create or replace function public.mg_import_eval(p_org uuid, p_row jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $mg$
declare
  v_email text := lower(btrim(coalesce(p_row->>'email', '')));
  v_role  text := lower(regexp_replace(btrim(coalesce(nullif(p_row->>'role', ''), 'worker')), '[\s-]+', '_', 'g'));
  v_name  text := btrim(coalesce(p_row->>'full_name', ''));
  v_code  text := btrim(coalesce(p_row->>'site_code', ''));
  v_site  uuid;
  v_prof  public.profiles;
  v_found boolean;
begin
  if v_email = '' then
    return jsonb_build_object('outcome','error','message','Email is required');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    return jsonb_build_object('outcome','error','message','Invalid email address');
  end if;
  if v_role not in ('worker','safety_officer') then
    return jsonb_build_object('outcome','error',
      'message','Role must be worker or safety_officer (administrative roles cannot be imported)');
  end if;
  if char_length(v_name) > 120 then
    return jsonb_build_object('outcome','error','message','Name is too long (120 characters maximum)');
  end if;
  if char_length(v_code) > 60 then
    return jsonb_build_object('outcome','error','message','Site code is too long');
  end if;
  if v_code <> '' then
    select s.id into v_site from public.sites s
     where s.organization_id = p_org and lower(s.code) = lower(v_code);
    if v_site is null then
      return jsonb_build_object('outcome','error','message','Unknown site code for this company');
    end if;
  end if;

  select * into v_prof from public.profiles where lower(email) = v_email limit 1;
  v_found := found;
  if public.mg_is_blocked(p_org, case when v_found then v_prof.id end, v_email) then
    return jsonb_build_object('outcome','error','message','This person is blocked from the company');
  end if;
  if v_found then
    if v_prof.role in ('admin','supervisor','inspector','registrar')
       or exists (select 1 from public.organization_members m
                   where m.user_id = v_prof.id and m.status = 'active' and m.organization_id <> p_org) then
      return jsonb_build_object('outcome','error','message','This address cannot be invited');
    end if;
    if exists (select 1 from public.organization_members m
                where m.user_id = v_prof.id and m.status = 'active' and m.organization_id = p_org) then
      return jsonb_build_object('outcome','already_member','message','Already a member of this company',
                                'email', v_email, 'role', v_role);
    end if;
  end if;
  if exists (select 1 from public.organization_invitations i
              where i.organization_id = p_org and i.email = v_email and i.status = 'pending'
                and i.expires_at > now()) then
    return jsonb_build_object('outcome','already_invited','message','An invitation is already pending',
                              'email', v_email, 'role', v_role);
  end if;
  return jsonb_build_object('outcome','ok','message','Ready to invite','email', v_email,
                            'role', v_role, 'full_name', v_name, 'site_code', v_code,
                            'site_id', v_site);
end;
$mg$;
revoke all on function public.mg_import_eval(uuid, jsonb) from public, anon, authenticated;

-- D. shared guard for the four actions ---------------------------------------------------------------
create or replace function public.mg_member_action_target(p_member_id uuid, p_allowed text[])
returns public.organization_members
language plpgsql security definer set search_path = public
as $mg$
declare m public.organization_members;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into m from public.organization_members where id = p_member_id for update;
  if not found or not public.mg_can_manage_company(m.organization_id) then
    raise exception 'FORBIDDEN';
  end if;
  if not (m.status = any (p_allowed)) then raise exception 'MEMBERSHIP_NOT_ACTIVE'; end if;
  if m.user_id = auth.uid() then raise exception 'FORBIDDEN: you cannot do that to yourself'; end if;
  if m.org_role = 'company_admin' and not public.mg_has_permission('organizations.write') then
    raise exception 'FORBIDDEN: only the Ministry manages company administrators';
  end if;
  return m;
end;
$mg$;
revoke all on function public.mg_member_action_target(uuid, text[]) from public, anon, authenticated;

create or replace function public.mg_clean_reason(p_reason text, p_required boolean)
returns text
language plpgsql immutable
as $mg$
declare v text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v is null then
    if p_required then raise exception 'REASON_REQUIRED'; end if;
    return null;
  end if;
  if char_length(v) < 5 and p_required then raise exception 'REASON_REQUIRED'; end if;
  if char_length(v) > 500 then raise exception 'REASON_REQUIRED: keep the reason under 500 characters'; end if;
  return v;
end;
$mg$;
revoke all on function public.mg_clean_reason(text, boolean) from public, anon, authenticated;

-- Ends a person's access to the company (profile role + binding). Idempotent. The operator
-- name is cleared by every caller (see mg_suspend_member); the flag is kept for clarity.
create or replace function public.mg_end_company_access(m public.organization_members, p_clear_name boolean)
returns void
language plpgsql security definer set search_path = public
as $mg$
begin
  perform set_config('mg.org_assign', '1', true);
  update public.profiles
     set role = null, organization_id = null,
         operator_name = case when p_clear_name then null else operator_name end
   where id = m.user_id and organization_id = m.organization_id and role = 'operator';
  perform set_config('mg.org_assign', '0', true);
end;
$mg$;
revoke all on function public.mg_end_company_access(public.organization_members, boolean) from public, anon, authenticated;

-- E. suspend / reinstate ---------------------------------------------------------------------------------
create or replace function public.mg_suspend_member(p_member_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  m public.organization_members;
  v_reason text := public.mg_clean_reason(p_reason, true);
begin
  m := public.mg_member_action_target(p_member_id, array['active']);
  update public.organization_members
     set status = 'suspended', status_reason = v_reason,
         status_changed_at = now(), status_changed_by = auth.uid()
   where id = m.id;
  -- Access stops in the same transaction. Site assignments are KEPT for reinstatement, but a
  -- suspended member is not an active member, so every site-scoped check already fails.
  -- operator_name must be cleared too: the profiles_org trigger would otherwise re-derive the
  -- company binding from it. Reinstatement re-binds explicitly (the trigger restores the name).
  perform public.mg_end_company_access(m, true);
end;
$mg$;

create or replace function public.mg_reinstate_member(p_member_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  m public.organization_members;
  v_prof public.profiles;
begin
  m := public.mg_member_action_target(p_member_id, array['suspended']);
  select * into v_prof from public.profiles where id = m.user_id;
  if not found or v_prof.role in ('admin','supervisor','inspector','registrar') then
    raise exception 'INELIGIBLE_ACCOUNT';
  end if;
  if exists (select 1 from public.organization_members x
              where x.user_id = m.user_id and x.id <> m.id and x.status in ('pending','active')) then
    raise exception 'ALREADY_MEMBER_OTHER_ORG';
  end if;
  update public.organization_members
     set status = 'active', status_reason = null,
         status_changed_at = now(), status_changed_by = auth.uid()
   where id = m.id;            -- the block guard refuses this if the person has since been blocked
  perform set_config('mg.org_assign', '1', true);
  update public.profiles
     set role = 'operator', scope = 'operator', organization_id = m.organization_id, profile_complete = true
   where id = m.user_id and role is null and organization_id is null;
  perform set_config('mg.org_assign', '0', true);
end;
$mg$;

-- F. remove (with reason; also for a suspended member) -----------------------------------------------------
create or replace function public.mg_remove_member(p_member_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare
  m public.organization_members;
  v_reason text := public.mg_clean_reason(p_reason, false);
begin
  m := public.mg_member_action_target(p_member_id, array['active','suspended']);
  update public.organization_members
     set status = 'revoked', status_reason = v_reason,
         status_changed_at = now(), status_changed_by = auth.uid()
   where id = m.id;
  update public.site_assignments sa
     set revoked_at = now(), revoked_by = auth.uid()
    from public.sites s
   where sa.site_id = s.id and s.organization_id = m.organization_id
     and sa.user_id = m.user_id and sa.revoked_at is null;
  perform public.mg_end_company_access(m, true);
end;
$mg$;

-- G. block / unblock -------------------------------------------------------------------------------------------
create or replace function public.mg_block_member(p_member_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $mg$
declare
  m public.organization_members;
  v_reason text := public.mg_clean_reason(p_reason, true);
  v_email text;
  v_id uuid;
begin
  m := public.mg_member_action_target(p_member_id, array['active','suspended','pending']);
  select lower(btrim(p.email)) into v_email from public.profiles p where p.id = m.user_id;
  if v_email is null then raise exception 'INVALID_EMAIL'; end if;

  update public.organization_members
     set status = 'revoked', status_reason = v_reason,
         status_changed_at = now(), status_changed_by = auth.uid()
   where id = m.id;
  update public.site_assignments sa
     set revoked_at = now(), revoked_by = auth.uid()
    from public.sites s
   where sa.site_id = s.id and s.organization_id = m.organization_id
     and sa.user_id = m.user_id and sa.revoked_at is null;
  perform public.mg_end_company_access(m, true);

  -- No invitation can bring them back while the block stands.
  update public.organization_invitations
     set status = 'revoked', revoked_by = auth.uid(), revoked_at = now()
   where organization_id = m.organization_id and email = v_email and status = 'pending';

  insert into public.organization_member_blocks (organization_id, user_id, email, reason, blocked_by, created_by)
  values (m.organization_id, m.user_id, v_email, v_reason, auth.uid(), auth.uid())
  on conflict (organization_id, email) where lifted_at is null
  do update set reason = excluded.reason, blocked_by = excluded.blocked_by, blocked_at = now()
  returning id into v_id;
  return v_id;
end;
$mg$;

create or replace function public.mg_unblock(p_block_id uuid)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare b public.organization_member_blocks;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  select * into b from public.organization_member_blocks where id = p_block_id for update;
  if not found or not public.mg_can_manage_company(b.organization_id) then
    raise exception 'FORBIDDEN';
  end if;
  if b.lifted_at is not null then raise exception 'BLOCK_NOT_ACTIVE'; end if;
  update public.organization_member_blocks
     set lifted_at = now(), lifted_by = auth.uid()
   where id = b.id;
  -- Unblocking only lifts the barrier. It does NOT restore access: they must be invited or
  -- request to join again, and be approved.
end;
$mg$;

-- H. the team list for the administrator screen -----------------------------------------------------------------
-- Includes suspended members (and, for them, the reason and who/when) beside pending and active.
create or replace function public.mg_company_team(p_org uuid)
returns table (member_id uuid, user_id uuid, email text, name text, org_role text, status text,
               created_at timestamptz, status_reason text, status_changed_at timestamptz,
               status_changed_by_name text)
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_can_manage_company(p_org) then
    raise exception 'FORBIDDEN';
  end if;
  return query
    select m.id, m.user_id, p.email, p.name, m.org_role, m.status, m.created_at,
           case when m.status = 'suspended' then m.status_reason end,
           case when m.status = 'suspended' then m.status_changed_at end,
           case when m.status = 'suspended' then a.name end
      from public.organization_members m
      join public.profiles p on p.id = m.user_id
      left join public.profiles a on a.id = m.status_changed_by
     where m.organization_id = p_org and m.status in ('pending','active','suspended')
     order by m.status, p.name nulls last, p.email;
end;
$mg$;

create or replace function public.mg_company_blocks(p_org uuid)
returns table (block_id uuid, email text, name text, reason text, blocked_at timestamptz, blocked_by_name text)
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not public.mg_can_manage_company(p_org) then
    raise exception 'FORBIDDEN';
  end if;
  return query
    select b.id, b.email, p.name, b.reason, b.blocked_at, a.name
      from public.organization_member_blocks b
      left join public.profiles p on p.id = b.user_id
      left join public.profiles a on a.id = b.blocked_by
     where b.organization_id = p_org and b.lifted_at is null
     order by b.blocked_at desc;
end;
$mg$;

-- I. tell the person THAT access changed (never the reason) --------------------------------------------------------
create or replace function public.mg_notify_on_membership()
returns trigger
language plpgsql security definer set search_path = public
as $mg$
declare v_company text;
begin
  begin
    select name into v_company from public.organizations where id = new.organization_id;
    if (tg_op = 'INSERT' and new.status = 'pending')
       or (tg_op = 'UPDATE' and old.status is distinct from 'pending' and new.status = 'pending') then
      perform public.mg_notify_company_admins(new.organization_id, 'req:' || new.id, 'org_request', 'info',
        'New request to join ' || v_company, 'Someone asked to join. Review it in Team.', '/operate/team');
    elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'active' then
      perform public.mg_notify(new.user_id, 'dec:' || new.id, 'org_decision', 'info',
        'Request approved',
        'You were added to ' || v_company || ' as ' || public.mg_org_role_label(new.org_role) || '.',
        '/operate');
    elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'rejected' then
      perform public.mg_notify(new.user_id, 'dec:' || new.id, 'org_decision', 'warning',
        'Request declined', 'Your request to join ' || v_company || ' was declined.', '/join');
    elsif tg_op = 'UPDATE' and old.status = 'active' and new.status = 'active'
          and old.org_role is distinct from new.org_role then
      perform public.mg_notify(new.user_id, 'role:' || new.id || ':' || new.org_role, 'org_role', 'info',
        'Your role changed',
        'At ' || v_company || ' you are now ' || public.mg_org_role_label(new.org_role) || '.',
        '/operate');
    elsif tg_op = 'UPDATE' and old.status = 'active' and new.status = 'suspended' then
      perform public.mg_notify(new.user_id, 'sus:' || new.id || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint,
        'org_role', 'warning',
        'Access suspended', 'Your access to ' || v_company || ' is suspended. Contact a company administrator.', '/join');
    elsif tg_op = 'UPDATE' and old.status = 'suspended' and new.status = 'active' then
      perform public.mg_notify(new.user_id, 'rein:' || new.id || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint,
        'org_role', 'info',
        'Access restored', 'Your access to ' || v_company || ' has been restored.', '/operate');
    elsif tg_op = 'UPDATE' and old.status in ('active','suspended') and new.status = 'revoked' then
      perform public.mg_notify(new.user_id, 'rm:' || new.id, 'org_role', 'warning',
        'Removed from ' || v_company, 'Your access to ' || v_company || ' has ended.', '/join');
    end if;
  exception when others then
    raise warning 'membership notification failed: %', sqlerrm;
  end;
  return new;
end;
$mg$;
revoke all on function public.mg_notify_on_membership() from public, anon, authenticated;

-- J. execute surface -------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'mg_suspend_member(uuid, text)',
    'mg_reinstate_member(uuid)',
    'mg_remove_member(uuid, text)',
    'mg_block_member(uuid, text)',
    'mg_unblock(uuid)',
    'mg_company_team(uuid)',
    'mg_company_blocks(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
