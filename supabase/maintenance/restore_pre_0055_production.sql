-- RECOVERY ONLY. Restores production's access layer exactly as captured read-only on 2026-11-13,
-- immediately BEFORE migration 0055/0056 were applied. This reinstates the legacy (county/operator-name)
-- behaviour that bypasses the 0025/0027 company rules — use it only if 0055 breaks something that
-- cannot be fixed forward. Not tested against a live database; review before running.
begin;
-- drop what 0055 created or replaced
drop policy if exists "corrective actions insert" on public.corrective_actions;
drop policy if exists "corrective actions read" on public.corrective_actions;
drop policy if exists "observations insert" on public.environmental_observations;
drop policy if exists "observations read" on public.environmental_observations;
drop policy if exists "findings insert" on public.findings;
drop policy if exists "findings read" on public.findings;
drop policy if exists "incidents insert" on public.incidents;
drop policy if exists "incidents read" on public.incidents;
drop policy if exists "templates insert" on public.inspection_templates;
drop policy if exists "templates read" on public.inspection_templates;
drop policy if exists "templates update" on public.inspection_templates;
drop policy if exists "inspections insert" on public.inspections;
drop policy if exists "inspections read" on public.inspections;
drop policy if exists "permissions read" on public.permissions;
drop policy if exists "sites read" on public.sites;

CREATE OR REPLACE FUNCTION public.mg_can_access_site(p_site_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  select coalesce(
    (select public.mg_can_access_site_row(s.county, s.operator_name)
       from public.sites s
      where s.id = p_site_id),
    false)
$fn$;

create policy "audit insert authenticated" on public.audit_log for insert to authenticated with check (true);
create policy "audit select staff" on public.audit_log for select to authenticated using (mg_is_staff());
create policy "reports update reviewer" on public.community_reports for update to authenticated using (mg_is_reviewer());
create policy "cas insert staff visible" on public.corrective_actions for insert to authenticated with check ((mg_is_staff() AND (EXISTS ( SELECT 1 FROM sites s WHERE ((s.id = corrective_actions.site_id) AND mg_can_access_site(s.county, s.operator_name))))));
create policy "cas select scoped" on public.corrective_actions for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "cas update guard" on public.corrective_actions for update to public using ((mg_is_reviewer() OR ((mg_role() = 'operator'::user_role) AND mg_can_access_site(site_id))));
create policy "obs insert assigned visible" on public.environmental_observations for insert to authenticated with check (((mg_role() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM sites s WHERE ((s.id = environmental_observations.site_id) AND mg_can_access_site(s.county, s.operator_name))))));
create policy "obs select scoped" on public.environmental_observations for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "obs update staff" on public.environmental_observations for update to authenticated using (mg_is_staff());
create policy "evidence insert assigned visible" on public.evidence for insert to authenticated with check (((mg_role() IS NOT NULL) AND (uploaded_by_id = auth.uid()) AND (EXISTS ( SELECT 1 FROM sites s WHERE ((s.id = evidence.site_id) AND mg_can_access_site(s.county, s.operator_name))))));
create policy "evidence select scoped" on public.evidence for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "findings insert staff visible" on public.findings for insert to authenticated with check ((mg_is_staff() AND (EXISTS ( SELECT 1 FROM sites s WHERE ((s.id = findings.site_id) AND mg_can_access_site(s.county, s.operator_name))))));
create policy "findings select scoped" on public.findings for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "findings update guard" on public.findings for update to public using (((created_by_id = auth.uid()) OR mg_is_reviewer() OR ((mg_role() = 'operator'::user_role) AND mg_can_access_site(site_id))));
create policy "incidents insert assigned visible" on public.incidents for insert to authenticated with check (((mg_role() IS NOT NULL) AND (EXISTS ( SELECT 1 FROM sites s WHERE ((s.id = incidents.site_id) AND mg_can_access_site(s.county, s.operator_name))))));
create policy "incidents select scoped" on public.incidents for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "incidents update staff" on public.incidents for update to authenticated using (mg_is_staff());
create policy "templates insert admin" on public.inspection_templates for insert to authenticated with check (mg_is_admin());
create policy "templates select assigned" on public.inspection_templates for select to authenticated using ((mg_role() IS NOT NULL));
create policy "templates update admin" on public.inspection_templates for update to authenticated using (mg_is_admin());
create policy "inspections insert staff visible" on public.inspections for insert to authenticated with check ((mg_is_staff() AND (EXISTS ( SELECT 1 FROM sites s WHERE ((s.id = inspections.site_id) AND mg_can_access_site(s.county, s.operator_name))))));
create policy "inspections read" on public.inspections for select to public using ((mg_can_access_site(site_id) AND (mg_is_admin() OR (( SELECT scope FROM mg_profile()) = 'national'::user_scope) OR (inspector_id = auth.uid()))));
create policy "inspections select scoped" on public.inspections for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "inspections update guard" on public.inspections for update to authenticated using (((inspector_id = auth.uid()) OR mg_is_reviewer()));
create policy "permissions read" on public.permissions for select to authenticated using ((( SELECT role FROM mg_profile()) IS NOT NULL));
create policy "sites insert admin" on public.sites for insert to authenticated with check (mg_is_admin());
create policy "sites read" on public.sites for select to public using (mg_can_access_site_row(county, operator_name));
create policy "sites select scoped" on public.sites for select to authenticated using (mg_can_access_site(county, operator_name));
create policy "sites update admin" on public.sites for update to authenticated using (mg_is_admin());

-- 0056 revoked TRUNCATE from authenticated on these tables (not restored by default; REST never uses it):
-- grant truncate on public.admin_areas, public.admin_boundaries, public.audit_log, public.community_reports, public.corrective_actions,
--   public.environmental_observations, public.evidence, public.evidence_url_audit, public.findings, public.incidents,
--   public.inspection_templates, public.inspections, public.meta, public.organizations, public.permissions, public.profiles,
--   public.rate_limits, public.report_tracking, public.site_assignments, public.site_boundaries, public.sites to authenticated;
commit;
