-- READ-ONLY. Lists accounts that hold NO role but carry a company binding set
-- through the pre-0024 self-service profile form. They have no access (no role)
-- and are overwritten when an administrator assigns a role. Review before
-- deciding whether to clear them; this script changes nothing.
select p.id, p.email, p.operator_name, p.organization_id, p.scope, p.county, p.created_at
  from public.profiles p
 where p.role is null
   and (p.operator_name is not null or p.organization_id is not null)
 order by p.created_at desc;
