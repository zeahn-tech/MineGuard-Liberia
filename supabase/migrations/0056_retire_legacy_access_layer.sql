-- ============================================================================
-- MINEGUARD LIBERIA — migration 0056: retire the legacy access layer (forward-only)
--
-- WHY. A read-only comparison of production against a clean build of 0001-0054
-- (see docs/db-forensics/phase1-findings.md; applied to production by hand on 2026-11-13 under the former number 0055 — the replay is idempotent) found that production still answers
-- "may this user see this site?" with the pre-organisation model:
--   * public.mg_can_access_site(uuid) is the 0007 body (calls the two-argument
--     mg_can_access_site_row(county, operator_name)); 0010 redefines it, but that
--     redefinition never took effect there.
--   * Legacy policies ("... select scoped", "... insert ... visible", "... update
--     guard", "templates ... admin/assigned", "audit select staff", ...) exist
--     that no migration creates. Permissive policies are OR-ed, so they bypass the
--     company-membership, approved-company and site-assignment rules of
--     0025 / 0027 (e.g. an assigned-only site manager reads every site of the
--     company).
--   * 12 policies the repo expects are absent.
--
-- WHAT. (1) restores the repo's definition of mg_can_access_site(uuid);
-- (2) re-creates the repo's policies that are missing or different;
-- (3) drops the legacy policies that the repo's policies supersede.
-- Policy texts below were generated from a clean build of 0001-0054, not typed.
--
-- NOT DONE HERE (deliberately). Legacy functions (mg_can_access_site(text,text),
-- mg_can_access_site_row(text,text), mg_is_operator, mg_can_read_county_rows,
-- mg_stamp_site, mg_guard_staff_update), the inspections.county/operator_name
-- columns, and the world-readable meta/report_tracking policies are left alone;
-- they carry no access once the legacy policies are gone and need their own review.
--
-- SAFETY. Idempotent: on a database built from the repo it is a no-op rewrite of
-- identical objects. Forward-only: capture supabase/maintenance/capture_pre_0056.sql
-- BEFORE applying (read-only) so the exact previous definitions can be restored if
-- a rollback is ever needed. Apply to staging first and run
-- tests/phase-e-legacy-access-retirement.test.ts' scenarios against real roles.
-- ============================================================================

begin;

-- 1. The organisation-aware site access check (repo end state, from 0010).
CREATE OR REPLACE FUNCTION public.mg_can_access_site(p_site_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$
  select coalesce(
    (
      select public.mg_can_access_site_row(
               s.id, s.county, s.district, s.operator_name, s.organization_id)
        from public.sites s
       where s.id = p_site_id
    ),
    false)
$mg$;

-- 2. The repo's policies that production lacks or has in a different form.
drop policy if exists "corrective actions insert" on public.corrective_actions;
create policy "corrective actions insert" on public.corrective_actions
  for insert
  with check (((opened_by_id = auth.uid()) AND mg_is_staff() AND mg_can_access_site(site_id)))
;

drop policy if exists "corrective actions read" on public.corrective_actions;
create policy "corrective actions read" on public.corrective_actions
  for select
  using (mg_can_access_site(site_id))
;

drop policy if exists "observations insert" on public.environmental_observations;
create policy "observations insert" on public.environmental_observations
  for insert
  with check (((reported_by_id = auth.uid()) AND mg_can_access_site(site_id)))
;

drop policy if exists "observations read" on public.environmental_observations;
create policy "observations read" on public.environmental_observations
  for select
  using (mg_can_access_site(site_id))
;

drop policy if exists "findings insert" on public.findings;
create policy "findings insert" on public.findings
  for insert
  with check (((created_by_id = auth.uid()) AND mg_is_staff() AND mg_can_access_site(site_id)))
;

drop policy if exists "findings read" on public.findings;
create policy "findings read" on public.findings
  for select
  using (mg_can_access_site(site_id))
;

drop policy if exists "incidents insert" on public.incidents;
create policy "incidents insert" on public.incidents
  for insert
  with check (((reported_by_id = auth.uid()) AND mg_can_access_site(site_id)))
;

drop policy if exists "incidents read" on public.incidents;
create policy "incidents read" on public.incidents
  for select
  using (mg_can_access_site(site_id))
;

drop policy if exists "templates insert" on public.inspection_templates;
create policy "templates insert" on public.inspection_templates
  for insert
  with check (mg_is_staff())
;

drop policy if exists "templates read" on public.inspection_templates;
create policy "templates read" on public.inspection_templates
  for select
  using ((mg_is_staff() OR (mg_role() = 'operator'::user_role)))
;

drop policy if exists "templates update" on public.inspection_templates;
create policy "templates update" on public.inspection_templates
  for update
  using (mg_is_staff())
;

drop policy if exists "inspections insert" on public.inspections;
create policy "inspections insert" on public.inspections
  for insert
  with check (((inspector_id = auth.uid()) AND mg_is_staff() AND mg_can_access_site(site_id)))
;

drop policy if exists "inspections read" on public.inspections;
create policy "inspections read" on public.inspections
  for select
  using ((mg_can_access_site(site_id) AND (mg_is_admin() OR (( SELECT mg_profile.scope
   FROM mg_profile() mg_profile(id, email, name, role, job_title, organization, scope, county, operator_name, profile_complete, created_at, updated_at, updated_by, row_version)) = 'national'::user_scope) OR (inspector_id = auth.uid()))))
;

drop policy if exists "permissions read" on public.permissions;
create policy "permissions read" on public.permissions
  for select to authenticated
  using ((( SELECT mg_profile.role
   FROM mg_profile() mg_profile(id, email, name, role, job_title, organization, scope, county, operator_name, profile_complete, created_at, updated_at, updated_by, row_version)) IS NOT NULL))
;

drop policy if exists "sites read" on public.sites;
create policy "sites read" on public.sites
  for select
  using (mg_can_access_site_row(id, county, district, operator_name, organization_id))
;

-- 3. Legacy policies superseded by the above (no table is left without a policy for a command it had).
drop policy if exists "audit insert authenticated" on public.audit_log;
drop policy if exists "audit select staff" on public.audit_log;
drop policy if exists "reports update reviewer" on public.community_reports;
drop policy if exists "cas insert staff visible" on public.corrective_actions;
drop policy if exists "cas select scoped" on public.corrective_actions;
drop policy if exists "cas update guard" on public.corrective_actions;
drop policy if exists "obs insert assigned visible" on public.environmental_observations;
drop policy if exists "obs select scoped" on public.environmental_observations;
drop policy if exists "obs update staff" on public.environmental_observations;
drop policy if exists "evidence insert assigned visible" on public.evidence;
drop policy if exists "evidence select scoped" on public.evidence;
drop policy if exists "findings insert staff visible" on public.findings;
drop policy if exists "findings select scoped" on public.findings;
drop policy if exists "findings update guard" on public.findings;
drop policy if exists "incidents insert assigned visible" on public.incidents;
drop policy if exists "incidents select scoped" on public.incidents;
drop policy if exists "incidents update staff" on public.incidents;
drop policy if exists "templates insert admin" on public.inspection_templates;
drop policy if exists "templates select assigned" on public.inspection_templates;
drop policy if exists "templates update admin" on public.inspection_templates;
drop policy if exists "inspections insert staff visible" on public.inspections;
drop policy if exists "inspections select scoped" on public.inspections;
drop policy if exists "inspections update guard" on public.inspections;
drop policy if exists "sites select scoped" on public.sites;
drop policy if exists "sites insert admin" on public.sites;
drop policy if exists "sites update admin" on public.sites;

commit;
