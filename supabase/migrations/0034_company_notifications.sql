-- ============================================================================
-- MINEGUARD LIBERIA — migration 0034: in-app notifications for company administration
--
-- Reuses the 0021 notifications inbox (private per user, content immutable, one-way
-- read/dismiss state). Notifications for company administration are created BY THE
-- DATABASE from the events themselves (triggers), so every route — the screens, the
-- API, SQL, bulk import — produces them and none can be forgotten:
--
--   invitation created          -> the invitee, if they already have an account
--   invitation accepted         -> whoever sent it
--   join request                -> the company's administrators
--   request approved / declined -> the requester
--   role changed / removed      -> the member
--   company status changed      -> the company's administrators
--   site status changed         -> the company's administrators
--
-- PRIVACY: titles and bodies carry company names and role labels only — never an email
-- address, an invitation link or any secret. Nothing is sent outside the app.
-- RELIABILITY: a failure while notifying is logged as a WARNING and never blocks the
-- action that caused it.
-- (Site REGISTRATION requests from companies do not exist as a workflow yet, so there
-- is nothing to notify for them.)
--
-- Idempotent. Rollback: drop the five triggers and functions, restore 0021's guard,
-- kind CHECK and link CHECK.
-- ============================================================================

begin;

-- kinds + in-app link paths ---------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('ca_deadline','ca_decision','report_status',
                  'org_invitation','org_request','org_decision','org_role','org_status'));

alter table public.notifications drop constraint if exists notifications_link_to_check;
alter table public.notifications add constraint notifications_link_to_check
  check (link_to ~ '^/(portal|operate|registry|invitation|join)(/[A-Za-z0-9._~:@!$&()*+,;=%-]*)*$');

-- the guard: identical to 0021 except that a definer function that raised the transaction-
-- local flag may address ANOTHER user's inbox. Client sessions never can.
create or replace function public.mg_notifications_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $mg$
begin
  if tg_op = 'DELETE' then
    if auth.uid() is not null then
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

-- helpers (internal: not callable by clients) ----------------------------------------------------
create or replace function public.mg_org_role_label(p_role text)
returns text
language sql immutable
as $mg$
  select case p_role
           when 'company_admin'       then 'Company administrator'
           when 'site_manager'        then 'Site manager'
           when 'safety_officer'      then 'Safety officer'
           when 'onboarding_officer'  then 'Onboarding officer'
           else 'Worker' end
$mg$;

create or replace function public.mg_notify(
  p_user uuid, p_key text, p_kind text, p_severity text,
  p_title text, p_body text, p_link text)
returns void
language plpgsql security definer set search_path = public
as $mg$
begin
  if p_user is null then return; end if;
  perform set_config('mg.notify', '1', true);
  begin
    insert into public.notifications (user_id, source_key, kind, severity, title, body, link_to, event_at)
    values (p_user, left(p_key, 160), p_kind, p_severity, left(p_title, 300), left(coalesce(p_body, ''), 1000), p_link, now())
    on conflict (user_id, source_key) do nothing;
  exception when others then
    raise warning 'mg_notify failed (%): %', p_kind, sqlerrm;   -- never block the real action
  end;
  perform set_config('mg.notify', '0', true);
end;
$mg$;

create or replace function public.mg_notify_company_admins(
  p_org uuid, p_key text, p_kind text, p_severity text,
  p_title text, p_body text, p_link text)
returns void
language plpgsql security definer set search_path = public
as $mg$
declare r record;
begin
  for r in select m.user_id from public.organization_members m
            where m.organization_id = p_org and m.org_role = 'company_admin' and m.status = 'active' loop
    perform public.mg_notify(r.user_id, p_key, p_kind, p_severity, p_title, p_body, p_link);
  end loop;
end;
$mg$;
revoke all on function public.mg_org_role_label(text) from public, anon, authenticated;
revoke all on function public.mg_notify(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.mg_notify_company_admins(uuid, text, text, text, text, text, text) from public, anon, authenticated;

-- events ----------------------------------------------------------------------------------------------
create or replace function public.mg_notify_on_invitation()
returns trigger
language plpgsql security definer set search_path = public
as $mg$
declare
  v_company text;
  v_user uuid;
  v_by_role text;
  v_link text;
begin
  begin
    select name into v_company from public.organizations where id = new.organization_id;
    if tg_op = 'INSERT' and new.status = 'pending' then
      select id into v_user from public.profiles where lower(email) = new.email limit 1;
      perform public.mg_notify(v_user, 'inv:' || new.id, 'org_invitation', 'info',
        'You have been invited to ' || v_company,
        'Role: ' || public.mg_org_role_label(new.org_role) || '. Open to review and accept.',
        '/invitation');
    elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' and new.created_by is not null then
      select role::text into v_by_role from public.profiles where id = new.created_by;
      v_link := case v_by_role
                  when 'registrar' then '/registry'
                  when 'admin'     then '/portal/companies/' || new.organization_id::text
                  else '/operate/team' end;
      perform public.mg_notify(new.created_by, 'invacc:' || new.id, 'org_invitation', 'info',
        'Invitation accepted',
        v_company || ' — ' || public.mg_org_role_label(new.org_role) || ' accepted.',
        v_link);
    end if;
  exception when others then
    raise warning 'invitation notification failed: %', sqlerrm;
  end;
  return new;
end;
$mg$;

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
    elsif tg_op = 'UPDATE' and old.status = 'active' and new.status = 'revoked' then
      perform public.mg_notify(new.user_id, 'rm:' || new.id, 'org_role', 'warning',
        'Removed from ' || v_company, 'Your access to ' || v_company || ' has ended.', '/join');
    end if;
  exception when others then
    raise warning 'membership notification failed: %', sqlerrm;
  end;
  return new;
end;
$mg$;

create or replace function public.mg_notify_on_company_status()
returns trigger
language plpgsql security definer set search_path = public
as $mg$
begin
  if new.status is distinct from old.status then
    begin
      perform public.mg_notify_company_admins(new.id,
        'orgst:' || new.id || ':' || new.status || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint,
        'org_status', case when new.status = 'approved' then 'info' else 'urgent' end,
        new.name || ' is now ' || replace(new.status, '_', ' '),
        case when new.status = 'approved'
             then 'Access has been restored.'
             else 'Company access is paused. Nothing has been deleted.'
                  || coalesce(' Reason: ' || nullif(new.status_reason, ''), '') end,
        '/operate');
    exception when others then
      raise warning 'company status notification failed: %', sqlerrm;
    end;
  end if;
  return new;
end;
$mg$;

create or replace function public.mg_notify_on_site_status()
returns trigger
language plpgsql security definer set search_path = public
as $mg$
begin
  if new.status is distinct from old.status and new.organization_id is not null then
    begin
      perform public.mg_notify_company_admins(new.organization_id,
        'sitest:' || new.id || ':' || new.status || ':' || (extract(epoch from clock_timestamp()) * 1000)::bigint,
        'org_status', case when new.status::text = 'active' then 'info' else 'warning' end,
        'Site status changed: ' || new.name,
        new.name || ' is now ' || replace(new.status::text, '_', ' ') || '.',
        '/operate/sites');
    exception when others then
      raise warning 'site status notification failed: %', sqlerrm;
    end;
  end if;
  return new;
end;
$mg$;

revoke all on function public.mg_notify_on_invitation() from public, anon, authenticated;
revoke all on function public.mg_notify_on_membership() from public, anon, authenticated;
revoke all on function public.mg_notify_on_company_status() from public, anon, authenticated;
revoke all on function public.mg_notify_on_site_status() from public, anon, authenticated;

drop trigger if exists organization_invitations_notify on public.organization_invitations;
create trigger organization_invitations_notify
  after insert or update on public.organization_invitations
  for each row execute function public.mg_notify_on_invitation();

drop trigger if exists organization_members_notify on public.organization_members;
create trigger organization_members_notify
  after insert or update on public.organization_members
  for each row execute function public.mg_notify_on_membership();

drop trigger if exists organizations_notify_status on public.organizations;
create trigger organizations_notify_status
  after update of status on public.organizations
  for each row execute function public.mg_notify_on_company_status();

drop trigger if exists sites_notify_status on public.sites;
create trigger sites_notify_status
  after update of status on public.sites
  for each row execute function public.mg_notify_on_site_status();

commit;
