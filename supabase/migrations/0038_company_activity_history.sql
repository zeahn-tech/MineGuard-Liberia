-- ============================================================================
-- MINEGUARD LIBERIA — migration 0038: activity history for companies and site managers
--
-- The audit trail (audit_log) stays Ministry-only — it holds raw before/after records
-- and the actor's email. Companies instead get a CURATED, read-only view of what
-- happened in THEIR scope, through one function:
--   mg_company_activity(p_org, p_site, p_limit, p_before, p_before_id)
--     company-wide  (p_site null)  company administrators (and Ministry oversight)
--     one site      (p_site given) company administrators and the site managers
--                                  assigned to THAT site
-- Scope is decided here, not by the browser: the entries of the company's own
-- membership / invitations / imports / site requests / sites / site assignments and
-- the safety records of its sites — or, for a site, that site's own entries only.
-- WHAT IS SHOWN: when, who (a person's NAME; government staff appear as "Ministry";
-- a removed account as "Former user"), what kind of record, what happened, and a
-- short plain line from an allow-list of fields (status, role, site/request name).
-- NEVER shown: email addresses, ids, raw before/after records, other companies.
-- Idempotent. Rollback: drop the function.
-- ============================================================================

begin;

create or replace function public.mg_company_activity(
  p_org uuid, p_site uuid default null, p_limit integer default 50,
  p_before timestamptz default null, p_before_id uuid default null)
returns table (id uuid, at timestamptz, who text, subject text, what text, detail text)
language plpgsql stable security definer set search_path = public
as $mg$
declare
  v_site_org uuid;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;

  if p_site is not null then
    select organization_id into v_site_org from public.sites where sites.id = p_site;
    if v_site_org is null or v_site_org is distinct from p_org
       or not public.mg_can_manage_site_people(p_site) then
      raise exception 'FORBIDDEN';
    end if;
  elsif not public.mg_can_manage_company(p_org) then
    raise exception 'FORBIDDEN';
  end if;

  return query
  with scoped(entity_type, entity_id) as (
    select 'sites', s.id::text from public.sites s
     where (p_site is null and s.organization_id = p_org) or s.id = p_site
    union all
    select 'site_assignments', sa.id::text from public.site_assignments sa
      join public.sites s on s.id = sa.site_id
     where (p_site is null and s.organization_id = p_org) or s.id = p_site
    union all select 'incidents', x.id::text from public.incidents x join public.sites s on s.id = x.site_id
     where (p_site is null and s.organization_id = p_org) or s.id = p_site
    union all select 'inspections', x.id::text from public.inspections x join public.sites s on s.id = x.site_id
     where (p_site is null and s.organization_id = p_org) or s.id = p_site
    union all select 'findings', x.id::text from public.findings x join public.sites s on s.id = x.site_id
     where (p_site is null and s.organization_id = p_org) or s.id = p_site
    union all select 'corrective_actions', x.id::text from public.corrective_actions x join public.sites s on s.id = x.site_id
     where (p_site is null and s.organization_id = p_org) or s.id = p_site
    union all select 'environmental_observations', x.id::text from public.environmental_observations x join public.sites s on s.id = x.site_id
     where (p_site is null and s.organization_id = p_org) or s.id = p_site
    union all select 'organizations', p_org::text where p_site is null
    union all select 'organization_members', m.id::text from public.organization_members m
     where p_site is null and m.organization_id = p_org
    union all select 'organization_invitations', i.id::text from public.organization_invitations i
     where p_site is null and i.organization_id = p_org
    union all select 'organization_imports', i.id::text from public.organization_imports i
     where p_site is null and i.organization_id = p_org
    union all select 'site_registration_requests', q.id::text from public.site_registration_requests q
     where p_site is null and q.organization_id = p_org
  )
  select a.id,
         a.created_at,
         case
           when a.actor_id is null then 'Former user or system'
           when pr.role in ('admin','supervisor','inspector','registrar') then 'Ministry'
           else coalesce(nullif(btrim(pr.name), ''), 'Company member')
         end,
         case a.entity_type
           when 'organizations' then 'Company'
           when 'organization_members' then 'Membership'
           when 'organization_invitations' then 'Invitation'
           when 'organization_imports' then 'Bulk import'
           when 'site_registration_requests' then 'Site request'
           when 'sites' then 'Site'
           when 'site_assignments' then 'Site assignment'
           when 'incidents' then 'Incident'
           when 'inspections' then 'Inspection'
           when 'findings' then 'Finding'
           when 'corrective_actions' then 'Corrective action'
           else 'Observation'
         end,
         case when a.action like '%.insert' then 'created' else 'updated' end,
         nullif(concat_ws(' · ',
           case when a.action like '%.insert' or (a.details #>> '{after,name}') is not null
                then case when a.entity_type in ('sites','site_registration_requests')
                          then (a.details #>> '{after,name}') end end,
           case when (a.details #>> '{after,status}') is not null
                then 'status: ' || replace(a.details #>> '{after,status}', '_', ' ') end,
           case when (a.details #>> '{after,org_role}') is not null
                then 'role: ' || replace(a.details #>> '{after,org_role}', '_', ' ') end,
           case when a.entity_type = 'site_assignments' and (a.details #>> '{after,revoked_at}') is not null
                then 'assignment ended' end
         ), '')
    from public.audit_log a
    join scoped sc on sc.entity_type = a.entity_type and sc.entity_id = a.entity_id
    left join public.profiles pr on pr.id = a.actor_id
   -- keyset cursor (time, id): entries written in one transaction share a timestamp (a bulk
   -- import does), so a time-only cursor could skip some at a page boundary
   where p_before is null
      or a.created_at < p_before
      or (p_before_id is not null and a.created_at = p_before and a.id < p_before_id)
   order by a.created_at desc, a.id desc
   limit v_limit;
end;
$mg$;

revoke all on function public.mg_company_activity(uuid, uuid, integer, timestamptz, uuid) from public, anon;
grant execute on function public.mg_company_activity(uuid, uuid, integer, timestamptz, uuid) to authenticated;

commit;
