-- ============================================================================
-- MINEGUARD LIBERIA — migration 0036: site-scope the UPDATE policies (audit finding E1)
--
-- DEFECT (confirmed against the fully migrated schema, not just by reading code):
-- five UPDATE policies checked only WHO the caller is, never WHICH SITE the row
-- belongs to. The SELECT policies are site-scoped, which hides out-of-scope rows
-- from a filtered update (`... where id = X` touches 0 rows), but an UNFILTERED
-- update (no WHERE) never reads a column, so the SELECT policy is not applied and
-- the broad UPDATE policy let the statement change rows in OTHER counties:
--
--   incidents                  USING mg_is_staff()                              (any admin/supervisor/inspector)
--   environmental_observations USING mg_is_staff()
--   findings                   USING creator OR mg_is_reviewer() OR operator+site
--   corrective_actions         USING mg_is_reviewer() OR operator+site
--   inspections                USING own inspector OR mg_is_reviewer()
--
-- Reproduced before this migration: a Bomi-scoped inspector rewrote the
-- description, fatalities and severity of a Grand Cape Mount incident and
-- resolved another county's observation; a county-scoped supervisor resolved
-- another county's finding. (Company operators were already blocked.) The audit
-- log recorded the actor, so it was detectable, but it was not prevented.
--
-- FIX: every one of these policies now ALSO requires mg_can_access_site(site_id)
-- in USING (which rows may be touched) and WITH CHECK (which rows they may
-- become — so a row cannot be moved to a site the caller cannot see). The WHO
-- part of each policy is unchanged, so nothing is widened and in-scope
-- workflows behave exactly as before. mg_can_access_site() is the same
-- function the SELECT and operator policies already use; it returns false for
-- an unknown site, and every site_id column here is NOT NULL.
--
-- NOT CHANGED, deliberately (own review): inspection_templates (staff, global
-- rows with no site), and site/boundary/assignment/organization writes, which
-- are gated by named permissions (mg_has_permission) rather than by role alone.
-- community_reports already carries a county/district scope in its policy.
--
-- DATA: no rows are read, changed or deleted. Policies only.
-- Idempotent (drop-if-exists + create). Run in a transaction: all five change or
-- none do. Safe to run while the application is live.
-- Rollback: re-create the five policies from their pre-0036 definitions, which
-- are reproduced in the comment block at the end of this file.
-- ============================================================================

begin;

-- incidents --------------------------------------------------------------------
drop policy if exists "incidents update" on public.incidents;
create policy "incidents update" on public.incidents
  for update
  using (public.mg_is_staff() and public.mg_can_access_site(site_id))
  with check (public.mg_is_staff() and public.mg_can_access_site(site_id));

-- environmental observations ---------------------------------------------------
drop policy if exists "observations update" on public.environmental_observations;
create policy "observations update" on public.environmental_observations
  for update
  using (public.mg_is_staff() and public.mg_can_access_site(site_id))
  with check (public.mg_is_staff() and public.mg_can_access_site(site_id));

-- findings ---------------------------------------------------------------------
drop policy if exists "findings update" on public.findings;
create policy "findings update" on public.findings
  for update
  using (
    (created_by_id = auth.uid()
      or public.mg_is_reviewer()
      or public.mg_role() = 'operator')
    and public.mg_can_access_site(site_id)
  )
  with check (
    (created_by_id = auth.uid()
      or public.mg_is_reviewer()
      or public.mg_role() = 'operator')
    and public.mg_can_access_site(site_id)
  );

-- corrective actions -----------------------------------------------------------
drop policy if exists "corrective actions update" on public.corrective_actions;
create policy "corrective actions update" on public.corrective_actions
  for update
  using (
    (public.mg_is_reviewer() or public.mg_role() = 'operator')
    and public.mg_can_access_site(site_id)
  )
  with check (
    (public.mg_is_reviewer() or public.mg_role() = 'operator')
    and public.mg_can_access_site(site_id)
  );

-- inspections ------------------------------------------------------------------
drop policy if exists "inspections update" on public.inspections;
create policy "inspections update" on public.inspections
  for update
  using (
    (inspector_id = auth.uid() or public.mg_is_reviewer())
    and public.mg_can_access_site(site_id)
  )
  with check (
    (inspector_id = auth.uid() or public.mg_is_reviewer())
    and public.mg_can_access_site(site_id)
  );

commit;

-- ----------------------------------------------------------------------------
-- ROLLBACK (pre-0036 definitions; run in a transaction):
--
--   drop policy if exists "incidents update" on public.incidents;
--   create policy "incidents update" on public.incidents
--     for update using (public.mg_is_staff());
--
--   drop policy if exists "observations update" on public.environmental_observations;
--   create policy "observations update" on public.environmental_observations
--     for update using (public.mg_is_staff());
--
--   drop policy if exists "findings update" on public.findings;
--   create policy "findings update" on public.findings
--     for update using (
--       created_by_id = auth.uid() or public.mg_is_reviewer()
--       or (public.mg_role() = 'operator' and public.mg_can_access_site(site_id)));
--
--   drop policy if exists "corrective actions update" on public.corrective_actions;
--   create policy "corrective actions update" on public.corrective_actions
--     for update using (
--       public.mg_is_reviewer()
--       or (public.mg_role() = 'operator' and public.mg_can_access_site(site_id)));
--
--   drop policy if exists "inspections update" on public.inspections;
--   create policy "inspections update" on public.inspections
--     for update using (inspector_id = auth.uid() or public.mg_is_reviewer());
-- ----------------------------------------------------------------------------
