-- ===========================================================================
-- ROLLBACK of migration 0067 (Ministry-controlled licence grace period). Not in supabase/migrations.
-- Restores the pre-0067 state and leaves 0065 and 0066 intact:
--   * drops mg_set_licence_grace_until(date, text) and mg_licence_grace_status()
--   * deletes the 'platform_settings.write' rows from public.permissions
--   * restores mg_platform_settings_changelog() to its 0065 definition (copied verbatim from 0065 section E2), so the audit
--     trigger no longer reads a reason.
-- NOT touched: the grace setting itself (its value is kept), platform_settings, audit_log history (rows written by 0067 stay),
-- notifications already sent, mg_licence_grace_until(), mg_request_site(). Data-safe and idempotent.
-- After this, change the date with SQL again (docs/27). Then remove the history row:
--   delete from supabase_migrations.schema_migrations where version = '0067';
-- Order when rolling back several: 0067 first, then 0066, then 0065.
-- ===========================================================================
begin;

drop function if exists public.mg_set_licence_grace_until(date, text);
drop function if exists public.mg_licence_grace_status();
delete from public.permissions where permission = 'platform_settings.write';

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
begin
  if tg_op = 'UPDATE' and v_old is not distinct from v_new then
    return null;
  end if;
  select coalesce(p.email, p.name) into v_label from public.profiles p where p.id = v_actor;
  v_label := coalesce(v_label, case when v_actor is null then 'database:' || session_user else 'unregistered:' || v_actor::text end);
  insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary, details)
  values ((select p.id from public.profiles p where p.id = v_actor), v_label, 'platform_settings.' || lower(tg_op), 'platform_settings', v_key,
          'Setting ' || v_key || ' ' || case tg_op when 'INSERT' then 'created as ' when 'DELETE' then 'deleted (was ' else 'changed from ' || coalesce(v_old, 'NULL (off)') || ' to ' end
            || case tg_op when 'DELETE' then coalesce(v_old, 'NULL (off)') || ')' else coalesce(v_new, 'NULL (off)') end,
          jsonb_build_object('before', v_old, 'after', v_new, 'database_user', session_user));
  return null;
end;
$mg$;

commit;
