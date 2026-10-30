-- ============================================================================
-- MINEGUARD LIBERIA — migration 0033: a company must be REGISTERED, never typed into existence
--
-- GAP CLOSED. Registering a site (or assigning an operator role) with a free-text
-- "operator name" silently CREATED a new, already-approved company whenever the name
-- did not match exactly: a typo produced a duplicate company, and a company could come
-- into being without the registrar ever approving it (see mg_resolve_organization,
-- migration 0010).
--
-- RULE for every SIGNED-IN session (the app, the API, the admin dialogs):
--   * a name that matches no registered company is REFUSED: UNKNOWN_COMPANY — register
--     it first in Companies (that is where approval happens);
--   * a NEW site may only be registered for an APPROVED company (COMPANY_NOT_APPROVED).
-- Existing sites and companies are untouched. Owner-run SQL (Supabase SQL editor,
-- migrations, seed scripts: no signed-in user) keeps the historical behaviour so
-- maintenance and data loads are not broken.
-- Idempotent. Rollback: restore the 0010 mg_resolve_organization / mg_sync_site_org.
-- ============================================================================

begin;

create or replace function public.mg_resolve_organization(p_name text)
returns uuid
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_id uuid;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_name is null then
    return null;
  end if;
  select id into v_id
    from public.organizations
   where lower(name) = lower(v_name)
   order by created_at, id
   limit 1;
  if v_id is null then
    if auth.uid() is not null then
      raise exception 'UNKNOWN_COMPANY: "%" is not a registered company. Register it in Companies first.', v_name;
    end if;
    insert into public.organizations (name, kind)
    values (v_name, 'operator')
    returning id into v_id;
  end if;
  return v_id;
end;
$mg$;

create or replace function public.mg_sync_site_org()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
declare
  v_name text;
begin
  if new.organization_id is null and new.operator_name is not null then
    new.organization_id := public.mg_resolve_organization(new.operator_name);
  end if;
  if new.organization_id is not null then
    select name into v_name from public.organizations where id = new.organization_id;
    if v_name is not null then
      new.operator_name := v_name;
    end if;
    -- a site is registered for an APPROVED company (checked when the company link is
    -- created or changed by a signed-in session; later status changes do not hide sites)
    if auth.uid() is not null
       and (tg_op = 'INSERT' or new.organization_id is distinct from old.organization_id)
       and not exists (select 1 from public.organizations o
                        where o.id = new.organization_id and o.status = 'approved') then
      raise exception 'COMPANY_NOT_APPROVED: sites can only be registered for an approved company';
    end if;
  end if;
  return new;
end;
$mg$;

revoke execute on function public.mg_resolve_organization(text) from anon, authenticated;
revoke execute on function public.mg_sync_site_org() from anon, authenticated;

commit;
