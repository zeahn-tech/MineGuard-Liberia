-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0016: GIS boundary hardening (follow-up to 0015)
--
-- 0009 revoked DELETE on every public table from the client roles, and the
-- audit trail (SEC-1) records INSERT and UPDATE only — so a client-reachable
-- DELETE is both against the platform posture and un-audited. 0015 granted
-- DELETE (and, via the default privileges of 0002, full access to anon) on
-- the two new boundary tables and wrote their policies as `for all`.
--
-- This migration brings them in line:
--   * no DELETE and nothing at all for `anon` (RLS already denied anon, this
--     is defence in depth);
--   * write policies split into INSERT and UPDATE, both geo.write only.
-- Replacing or correcting a boundary is an audited UPDATE; removing one is a
-- privileged (service-role) maintenance action by design.
-- ===========================================================================

revoke all on public.admin_boundaries, public.site_boundaries from anon;
revoke delete on public.admin_boundaries, public.site_boundaries from authenticated;

drop policy if exists "admin_boundaries write" on public.admin_boundaries;
drop policy if exists "admin_boundaries insert" on public.admin_boundaries;
create policy "admin_boundaries insert" on public.admin_boundaries
  for insert to authenticated
  with check (public.mg_has_permission('geo.write'));
drop policy if exists "admin_boundaries update" on public.admin_boundaries;
create policy "admin_boundaries update" on public.admin_boundaries
  for update to authenticated
  using (public.mg_has_permission('geo.write'))
  with check (public.mg_has_permission('geo.write'));

drop policy if exists "site_boundaries write" on public.site_boundaries;
drop policy if exists "site_boundaries insert" on public.site_boundaries;
create policy "site_boundaries insert" on public.site_boundaries
  for insert to authenticated
  with check (public.mg_has_permission('geo.write'));
drop policy if exists "site_boundaries update" on public.site_boundaries;
create policy "site_boundaries update" on public.site_boundaries
  for update to authenticated
  using (public.mg_has_permission('geo.write'))
  with check (public.mg_has_permission('geo.write'));
