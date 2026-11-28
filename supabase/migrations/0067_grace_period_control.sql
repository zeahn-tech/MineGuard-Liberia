-- ============================================================================
-- MINEGUARD LIBERIA — migration 0067: Ministry-controlled licence grace period
--
-- WHAT THIS ADDS (0065 is untouched; this file only builds on it)
--   * permission 'platform_settings.write' in public.permissions, granted to exactly TWO Ministry roles: admin and registrar.
--     The Ministry changes who holds it by editing that table (no code change). The gate is mg_has_permission(), which reads
--     ONLY profiles.role — never organization_members — so a company membership can never carry this permission. (0032 already
--     guarantees a government role holds no company.)
--   * mg_set_licence_grace_until(date, text): the ONLY client path to change the platform-wide grace date. Reason required
--     (5..300 chars), NULL switches the grace period off, a past date is refused, a date more than 365 days ahead is refused
--     (the cap is the named constant c_max_grace_days below). It writes through public.platform_settings, so the 0065 guard
--     (date validation) and the 0065 audit trigger still run. Every OTHER admin is notified; the actor is not.
--   * mg_licence_grace_status(): read model for the screen { until, is_active, days_left, companies_without_licence }.
--     Same permission, FORBIDDEN otherwise.
--   * mg_platform_settings_changelog() is re-created so that, when mg.grace_change_reason is set by the function above, the
--     reason lands in audit_log (summary + details.reason). Direct SQL changes (no reason set) keep the exact 0065 format.
--
-- NOT CHANGED: mg_licence_grace_until(), mg_request_site(), the guard, platform_settings itself (RLS on, no policy, no grant),
-- the stored value or the date format. There is still exactly ONE place the date is stored.
--
-- Idempotent and one transaction: re-applying never changes the setting, never duplicates a permission row, and is a no-op
-- for data. Rollback: supabase/maintenance/rollback_0067_grace_period_control.sql
-- ============================================================================
begin;

-- A. permission: admin and registrar only ---------------------------------------------------------------------------------
insert into public.permissions (role, permission) values
  ('admin',     'platform_settings.write'),
  ('registrar', 'platform_settings.write')
on conflict (role, permission) do nothing;

-- B. audit trigger: carry the reason when the function below supplied one ----------------------------------------------------
-- Identical to 0065 except for v_reason. Without mg.grace_change_reason (direct SQL, owner scripts) nothing changes.
create or replace function public.mg_platform_settings_changelog()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_actor uuid := auth.uid();
  v_label text;
  v_key text := case when tg_op = 'DELETE' then old.key else new.key end;
  v_old text := case when tg_op = 'INSERT' then null else old.value end;
  v_new text := case when tg_op = 'DELETE' then null else new.value end;
  v_reason text := nullif(btrim(coalesce(current_setting('mg.grace_change_reason', true), '')), '');
begin
  if tg_op = 'UPDATE' and v_old is not distinct from v_new then
    return null;
  end if;
  select coalesce(p.email, p.name) into v_label from public.profiles p where p.id = v_actor;
  v_label := coalesce(v_label, case when v_actor is null then 'database:' || session_user else 'unregistered:' || v_actor::text end);
  insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary, details)
  values ((select p.id from public.profiles p where p.id = v_actor), v_label, 'platform_settings.' || lower(tg_op), 'platform_settings', v_key,
          'Setting ' || v_key || ' ' || case tg_op when 'INSERT' then 'created as ' when 'DELETE' then 'deleted (was ' else 'changed from ' || coalesce(v_old, 'NULL (off)') || ' to ' end
            || case tg_op when 'DELETE' then coalesce(v_old, 'NULL (off)') || ')' else coalesce(v_new, 'NULL (off)') end
            || case when v_reason is null then '' else '. Reason: ' || v_reason end,
          jsonb_build_object('before', v_old, 'after', v_new, 'database_user', session_user)
            || case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason', v_reason) end);
  return null;
end;
$mg$;

-- C. the one write path for the Ministry ------------------------------------------------------------------------------------
-- Error codes (the text before the colon is what the screen maps to a friendly message):
--   FORBIDDEN, REASON_REQUIRED, PAST_DATE, MAX_GRACE_EXCEEDED.
create or replace function public.mg_set_licence_grace_until(p_date date, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $mg$
declare
  -- THE CAP: the furthest the grace date may be set ahead of today, in days. Change it here only (and in docs/27).
  c_max_grace_days constant integer := 365;
  c_key constant text := 'licence_grace_until_for_site_requests';
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old text;
  v_exists boolean;
  v_new text := case when p_date is null then null else to_char(p_date, 'YYYY-MM-DD') end;
  v_who text;
  r record;
begin
  if v_actor is null or not public.mg_has_permission('platform_settings.write') then
    raise exception 'FORBIDDEN: only the Ministry administrator or registrar can change the licence grace period';
  end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 300 then
    raise exception 'REASON_REQUIRED: give a reason of 5 to 300 characters';
  end if;
  if p_date is not null then
    if p_date < current_date then
      raise exception 'PAST_DATE: the grace date cannot be in the past (to end the grace period, switch it off instead)';
    end if;
    if p_date > current_date + c_max_grace_days then
      raise exception 'MAX_GRACE_EXCEEDED: the grace date can be at most % days from today', c_max_grace_days;
    end if;
  end if;

  select value into v_old from public.platform_settings where key = c_key for update;
  v_exists := found;                                              -- PERFORM below resets FOUND
  perform set_config('mg.grace_change_reason', v_reason, true);   -- read by the changelog trigger; transaction-local
  if v_exists then
    update public.platform_settings set value = v_new where key = c_key;
  else
    insert into public.platform_settings (key, value) values (c_key, v_new);
  end if;
  perform set_config('mg.grace_change_reason', '', true);

  if v_old is distinct from v_new then
    select coalesce(p.email, p.name, 'a Ministry user') into v_who from public.profiles p where p.id = v_actor;
    for r in select id from public.profiles where role = 'admin' and deleted_at is null and id <> v_actor loop
      perform public.mg_notify(r.id, 'grace:' || gen_random_uuid()::text, 'org_site_request', 'info',
        'Licence grace period changed',
        coalesce(v_who, 'A Ministry user') || ' changed the date until which companies without a licence number may request sites, from '
          || coalesce(v_old, 'off') || ' to ' || coalesce(v_new, 'off') || '. Reason: ' || v_reason,
        '/portal/companies');
    end loop;
  end if;
end;
$mg$;

-- D. read model for the screen ----------------------------------------------------------------------------------------------
create or replace function public.mg_licence_grace_status()
returns jsonb
language plpgsql stable
security definer set search_path = public
as $mg$
declare
  v_until date;
  v_active boolean;
begin
  if auth.uid() is null or not public.mg_has_permission('platform_settings.write') then
    raise exception 'FORBIDDEN: only the Ministry administrator or registrar can see the licence grace period';
  end if;
  v_until := public.mg_licence_grace_until();
  v_active := coalesce(v_until >= current_date, false);
  return jsonb_build_object(
    'until', case when v_until is null then null else to_char(v_until, 'YYYY-MM-DD') end,
    'is_active', v_active,
    'days_left', case when v_active then v_until - current_date else null end,
    'companies_without_licence',
      (select count(*) from public.organizations where licence_number is null and status <> 'deactivated'));
end;
$mg$;

-- E. grants: signed-in only; platform_settings stays closed ----------------------------------------------------------------
revoke all on function public.mg_set_licence_grace_until(date, text) from public, anon, authenticated;
revoke all on function public.mg_licence_grace_status() from public, anon, authenticated;
grant execute on function public.mg_set_licence_grace_until(date, text) to authenticated;
grant execute on function public.mg_licence_grace_status() to authenticated;
revoke all on public.platform_settings from public, anon, authenticated;

commit;
