-- ============================================================================
-- MINEGUARD LIBERIA — migration 0041: emergency alert authority corrections
--
-- 1. Owner decision: Ministry roles do NOT create/activate/cancel company-site alerts.
--    A database that applied an EARLIER draft of 0040 may still carry 'emergency.manage'
--    for admin; this removes it everywhere (idempotent). Ministry roles keep read access.
-- 2. mg_emergency_manageable_sites(): the sites the signed-in user may manage alerts for,
--    computed by the SAME predicate that guards every write (mg_can_manage_emergency), so the
--    app shows "New alert" only to people the database would actually let through.
--    This is for display; the write RPCs still self-authorize on every call.
-- Idempotent.
-- ============================================================================
begin;

delete from public.permissions where permission = 'emergency.manage';

create or replace function public.mg_emergency_manageable_sites()
returns table (id uuid, name text, code text)
language sql stable security definer set search_path = public as $mg$
  select s.id, s.name, s.code
    from public.sites s
   where auth.uid() is not null
     and public.mg_can_manage_emergency(s.id)
   order by s.name
$mg$;
revoke all on function public.mg_emergency_manageable_sites() from public, anon;
grant execute on function public.mg_emergency_manageable_sites() to authenticated;

commit;
