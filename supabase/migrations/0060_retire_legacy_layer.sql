-- ============================================================================
-- MINEGUARD LIBERIA — migration 0060: retire the legacy layer that survived in production (forward-only)
--
-- WHY. The staging rehearsal and a follow-up inventory (docs/db-forensics/phase1-findings.md, "Cleanup 2026-11-15")
-- found objects in production that no migration creates and that the repository's design explicitly retires:
--   SECURITY
--   * storage.objects policy "evidence storage read": reads evidence FILES by the legacy county/operator-name text match
--     (migration 0002 drops this exact policy; production still had it). It bypasses site assignment and company approval.
--   * report_tracking policy "tracking select public" (USING true): any signed-in account could list every tracking code and
--     status, defeating the rate-limited track_community_report() lookup built to stop enumeration (the app only reads the
--     table directly as a fallback when that function is missing).
--   * function EXECUTE rights: anon could execute mg_backfill_scope_stamps(), mg_guard_report_update() and mg_operator_name()
--     (created or left with default PUBLIC execute); the repo grants none of these to anon.
--   CONVERGENCE (the guards and stamps production runs under legacy names)
--   * legacy BEFORE triggers guard_*/stamp_site_* and their functions (mg_guard_staff_update, mg_stamp_site, mg_is_operator)
--     are replaced by the repo's *_guard / *_stamp triggers and functions; mg_guard_finding_update and the five identity
--     helpers are set to the repo's text (the helpers differ only cosmetically).
--   * orphaned legacy functions: mg_can_access_site(text,text), mg_can_access_site_row(text,text), mg_can_read_county_rows(text)
--     (pg_depend showed no dependents once the storage policy above is gone).
--   * inspections.county / operator_name and their two indexes: legacy scope stamps written only by the retired trigger and
--     read by no policy, function, view or app code.
--
-- DELIBERATELY NOT CHANGED (reviewed): the platform's rls_auto_enable() event trigger; policy "meta select public"
-- (aggregated public statistics only); the three "admin seed" write policies and "tracking update" (they back the app's
-- admin demo-seeding feature); columns community_reports.rate_bucket, meta.updated_at, rate_limits.updated_at and the
-- rate_limits.window_start nullability; community_reports_description_check / the NOT VALID len_chk; audit_log_actor_id_fkey
-- (4 of 160 audit rows reference deleted accounts and audit rows are immutable).
--
-- SAFETY. One transaction (atomic). Idempotent on a database built from the repo. Capture first:
-- supabase/maintenance/capture_pre_0056.sql is superseded by capture_pre_0060.sql (also restores the policies listed above).
-- Tested by tests/phase-e-legacy-cleanup.test.ts: production's legacy layer is rebuilt on a clean build, this migration is
-- applied, and the full schema fingerprint must equal the clean build again.
-- ============================================================================

-- destructive-approved: legacy scope-stamp columns on inspections (county, operator_name) — test data, written only by the retired mg_stamp_site trigger, referenced by no policy, function, view or app code (checked 2026-11-15)

begin;

-- 1. Close the two exposures first.
drop policy if exists "evidence storage read" on storage.objects;
drop policy if exists "tracking select public" on public.report_tracking;

-- 2. The repo's guard functions and helper text (replaces legacy bodies; callers keep working).
CREATE OR REPLACE FUNCTION public.mg_guard_incident_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$
begin
  if public.mg_is_staff() then return new; end if;
  -- Operators may file incidents at their own sites; nothing else changes.
  if (select role from public.mg_profile()) = 'operator'
     and public.mg_can_access_site(new.site_id)
     and new.status = old.status then
    return new;
  end if;
  raise exception 'FORBIDDEN: staff required for incident status changes';
end;
$mg$;

CREATE OR REPLACE FUNCTION public.mg_guard_observation_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$
begin
  if public.mg_is_staff() then return new; end if;
  if (select role from public.mg_profile()) = 'operator'
     and public.mg_can_access_site(new.site_id)
     and new.status = old.status then
    return new;
  end if;
  raise exception 'FORBIDDEN: staff required for observation status changes';
end;
$mg$;

CREATE OR REPLACE FUNCTION public.mg_guard_finding_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$
begin
  if public.mg_is_admin() or public.mg_is_reviewer() then return new; end if;
  if old.created_by_id = auth.uid() then return new; end if;
  if (select role from public.mg_profile()) = 'operator'
     and new.status = 'acknowledged' then
    return new;
  end if;
  raise exception 'FORBIDDEN: finding status transition not permitted';
end;
$mg$;

CREATE OR REPLACE FUNCTION public.mg_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$ select coalesce((select role = 'admin' from public.mg_profile()), false) $mg$;

CREATE OR REPLACE FUNCTION public.mg_is_reviewer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$
  select coalesce(
    (select role in ('admin','supervisor') from public.mg_profile()),
    false)
$mg$;

CREATE OR REPLACE FUNCTION public.mg_is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$
  select coalesce(
    (select role in ('admin','supervisor','inspector') from public.mg_profile()),
    false)
$mg$;

CREATE OR REPLACE FUNCTION public.mg_profile()
 RETURNS profiles
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$ select * from public.profiles where id = auth.uid() $mg$;

CREATE OR REPLACE FUNCTION public.mg_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$ select role from public.mg_profile() $mg$;

-- 3. Retire the legacy triggers, then attach the repo's.
drop trigger if exists guard_ca_update on public.corrective_actions;
drop trigger if exists stamp_site_cas on public.corrective_actions;
drop trigger if exists guard_obs_update on public.environmental_observations;
drop trigger if exists stamp_site_obs on public.environmental_observations;
drop trigger if exists stamp_site_evidence on public.evidence;
drop trigger if exists guard_finding_update on public.findings;
drop trigger if exists stamp_site_findings on public.findings;
drop trigger if exists guard_incident_update on public.incidents;
drop trigger if exists stamp_site_incidents on public.incidents;
drop trigger if exists guard_inspection_update on public.inspections;
drop trigger if exists stamp_site_inspections on public.inspections;
drop trigger if exists guard_profile_update on public.profiles;

drop trigger if exists corrective_actions_guard on public.corrective_actions;
CREATE TRIGGER corrective_actions_guard BEFORE UPDATE ON public.corrective_actions FOR EACH ROW EXECUTE FUNCTION mg_guard_ca_update();
drop trigger if exists corrective_actions_stamp on public.corrective_actions;
CREATE TRIGGER corrective_actions_stamp BEFORE INSERT ON public.corrective_actions FOR EACH ROW EXECUTE FUNCTION mg_stamp_site_scope();
drop trigger if exists environmental_observations_guard on public.environmental_observations;
CREATE TRIGGER environmental_observations_guard BEFORE UPDATE ON public.environmental_observations FOR EACH ROW EXECUTE FUNCTION mg_guard_observation_update();
drop trigger if exists environmental_observations_stamp on public.environmental_observations;
CREATE TRIGGER environmental_observations_stamp BEFORE INSERT ON public.environmental_observations FOR EACH ROW EXECUTE FUNCTION mg_stamp_site_scope();
drop trigger if exists evidence_stamp on public.evidence;
CREATE TRIGGER evidence_stamp BEFORE INSERT ON public.evidence FOR EACH ROW EXECUTE FUNCTION mg_stamp_site_scope();
drop trigger if exists findings_guard on public.findings;
CREATE TRIGGER findings_guard BEFORE UPDATE ON public.findings FOR EACH ROW EXECUTE FUNCTION mg_guard_finding_update();
drop trigger if exists findings_stamp on public.findings;
CREATE TRIGGER findings_stamp BEFORE INSERT ON public.findings FOR EACH ROW EXECUTE FUNCTION mg_stamp_site_scope();
drop trigger if exists incidents_guard on public.incidents;
CREATE TRIGGER incidents_guard BEFORE UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION mg_guard_incident_update();
drop trigger if exists incidents_stamp on public.incidents;
CREATE TRIGGER incidents_stamp BEFORE INSERT ON public.incidents FOR EACH ROW EXECUTE FUNCTION mg_stamp_site_scope();
drop trigger if exists inspections_guard on public.inspections;
CREATE TRIGGER inspections_guard BEFORE UPDATE ON public.inspections FOR EACH ROW EXECUTE FUNCTION mg_guard_inspection_update();
drop trigger if exists profiles_guard on public.profiles;
CREATE TRIGGER profiles_guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION mg_guard_profile_update();

-- 4. Drop what only the legacy layer used (a dependent object makes the DROP fail and the whole migration roll back).
drop function if exists public.mg_guard_staff_update();
drop function if exists public.mg_stamp_site();
drop function if exists public.mg_is_operator();
drop function if exists public.mg_can_access_site(text, text);
drop function if exists public.mg_can_access_site_row(text, text);
drop function if exists public.mg_can_read_county_rows(text);

drop index if exists public.inspections_county_idx;
drop index if exists public.inspections_operator_idx;
alter table public.inspections drop column if exists county;
alter table public.inspections drop column if exists operator_name;

-- 5. Policies that differ from the repo only in an older column-alias list.
drop policy if exists "admin_boundaries read" on public.admin_boundaries;
create policy "admin_boundaries read" on public.admin_boundaries
  for select to authenticated
  using ((mg_is_staff() OR (( SELECT mg_profile.role
   FROM mg_profile() mg_profile(id, email, name, role, job_title, organization, scope, county, operator_name, profile_complete, created_at, updated_at, updated_by, row_version, organization_id, scope_area_id)) = 'operator'::user_role)))
;
drop policy if exists "organizations read" on public.organizations;
create policy "organizations read" on public.organizations
  for select to authenticated
  using ((mg_is_staff() OR ((( SELECT mg_profile.role
   FROM mg_profile() mg_profile(id, email, name, role, job_title, organization, scope, county, operator_name, profile_complete, created_at, updated_at, updated_by, row_version, organization_id, scope_area_id)) = 'operator'::user_role) AND (NOT (( SELECT mg_profile.organization_id
   FROM mg_profile() mg_profile(id, email, name, role, job_title, organization, scope, county, operator_name, profile_complete, created_at, updated_at, updated_by, row_version, organization_id, scope_area_id)) IS DISTINCT FROM id)))))
;
drop policy if exists "risk config read" on public.risk_config_versions;
create policy "risk config read" on public.risk_config_versions
  for select to authenticated
  using ((( SELECT mg_profile.role
   FROM mg_profile() mg_profile(id, email, name, role, job_title, organization, scope, county, operator_name, profile_complete, created_at, updated_at, updated_by, row_version, organization_id, scope_area_id)) IS NOT NULL))
;

-- 6. Function execute rights as the repo defines them (all revoked, then the intended surface granted).
revoke execute on function public.mg_guard_incident_update() from public, anon, authenticated;
revoke execute on function public.mg_guard_observation_update() from public, anon, authenticated;
revoke execute on function public.mg_backfill_scope_stamps() from public, anon, authenticated;
revoke execute on function public.mg_guard_report_update() from public, anon, authenticated;
revoke execute on function public.mg_operator_name() from public, anon;
grant execute on function public.mg_operator_name() to authenticated;

commit;
