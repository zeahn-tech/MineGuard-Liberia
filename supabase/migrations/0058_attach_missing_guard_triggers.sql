-- ============================================================================
-- MINEGUARD LIBERIA — migration 0058: attach the guard triggers production lacks (forward-only)
--
-- WHY. The staging rehearsal (production's schema + 0047-0057) compared against a clean build of the repo and found
-- that production's `public` schema never received four trigger attachments, although the functions exist:
--   * community_reports_guard  -> mg_guard_report_update(): report ownership and tracking code are immutable and status
--                                 moves only along submitted -> under_review -> verified/dismissed/referred
--   * inspection_templates_guard -> mg_guard_template_write(): staff only, templates are archived, never deleted
--   * sites_guard              -> mg_guard_site_write(): sites are never deleted; writes need sites.insert / sites.update
--   * sites_rescope            -> mg_backfill_scope_stamps(): child rows' stamped county/operator follow a site's re-scope
-- (the last needs mg_operator_name() / mg_backfill_scope_stamps(), also absent in production).
--
-- WHAT. Creates those functions and triggers exactly as the repo's earlier migrations define them (generated from a clean
-- build, not typed). Idempotent: on a database built from the repo it recreates identical objects.
--
-- NOT CHANGED (reviewed, deliberately left): production's legacy-named guards on incidents / observations
-- (mg_guard_staff_update: staff only) are STRICTER than the repo's, and mg_guard_finding_update additionally requires
-- open -> acknowledged for the operator's own company; the legacy stamp triggers (mg_stamp_site) stamp the same columns.
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.mg_operator_name()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$ select operator_name from public.mg_profile() $mg$;

CREATE OR REPLACE FUNCTION public.mg_backfill_scope_stamps()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $mg$
begin
  update public.findings f
    set county = new.county, operator_name = new.operator_name
    where f.site_id = new.id;
  update public.corrective_actions c
    set county = new.county, operator_name = new.operator_name
    where c.site_id = new.id;
  update public.incidents i
    set county = new.county, operator_name = new.operator_name
    where i.site_id = new.id;
  update public.environmental_observations o
    set county = new.county, operator_name = new.operator_name
    where o.site_id = new.id;
  update public.evidence e
    set county = new.county, operator_name = new.operator_name
    where e.site_id = new.id;
  return new;
end;
$mg$;

drop trigger if exists community_reports_guard on public.community_reports;
CREATE TRIGGER community_reports_guard BEFORE UPDATE ON public.community_reports FOR EACH ROW EXECUTE FUNCTION mg_guard_report_update();

drop trigger if exists inspection_templates_guard on public.inspection_templates;
CREATE TRIGGER inspection_templates_guard BEFORE INSERT OR DELETE OR UPDATE ON public.inspection_templates FOR EACH ROW EXECUTE FUNCTION mg_guard_template_write();

drop trigger if exists sites_guard on public.sites;
CREATE TRIGGER sites_guard BEFORE INSERT OR DELETE OR UPDATE ON public.sites FOR EACH ROW EXECUTE FUNCTION mg_guard_site_write();

drop trigger if exists sites_rescope on public.sites;
CREATE TRIGGER sites_rescope AFTER UPDATE OF county, operator_name ON public.sites FOR EACH ROW EXECUTE FUNCTION mg_backfill_scope_stamps();

commit;
