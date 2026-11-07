-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0045: colleague names for safety analytics
--
-- The operator Safety analytics page (all active company members) ranks the
-- company's most active reporters. Names live in profiles, which a worker may
-- not read for others, and mg_company_workforce is administrator-only (it also
-- returns emails). This function returns ONLY id + display name of ACTIVE
-- members of the caller's own company, and only to an active member of it.
-- No email, role, status or any other company. Idempotent.
-- ===========================================================================
begin;

create or replace function public.mg_company_member_names(p_org uuid)
returns table (user_id uuid, name text)
language plpgsql stable security definer set search_path = public
as $mg$
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_members me
     where me.organization_id = p_org and me.user_id = auth.uid() and me.status = 'active'
  ) then
    raise exception 'FORBIDDEN';
  end if;
  return query
    select m.user_id, p.name
      from public.organization_members m
      join public.profiles p on p.id = m.user_id
     where m.organization_id = p_org and m.status = 'active';
end;
$mg$;

revoke all on function public.mg_company_member_names(uuid) from public, anon;
grant execute on function public.mg_company_member_names(uuid) to authenticated;

commit;
