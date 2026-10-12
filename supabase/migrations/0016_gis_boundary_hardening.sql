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

-- ---------------------------------------------------------------------------
-- Precondition: fail early, in plain words, instead of halfway through with an
-- opaque 'relation does not exist'. The usual cause is running this file in the
-- WRONG Supabase project (the project ref must match src/lib/supabase.ts), or
-- running it before the earlier migrations.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.admin_boundaries') is null
     or to_regclass('public.site_boundaries') is null then
    raise exception using
      message = 'MineGuard migration 0016_gis_boundary_hardening cannot run: the boundary tables do not exist.',
      detail  = 'public.admin_boundaries / public.site_boundaries are created by migration 0015_gis.sql. Apply 0015 first (and 0001-0014 before it).',
      hint    = 'Check you are connected to the project whose ref matches src/lib/supabase.ts. Safest: SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts supabase/migrations/0016_gis_boundary_hardening.sql (the runner is tied to the right project).';
  end if;
end $$;

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
