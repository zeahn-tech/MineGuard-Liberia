-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0011: function execute surface
-- (docs/04 "Known gaps" item 0 — Gap 0: privileged surfaces are intent,
--  not guarantee — repo half of the closure)
--
-- docs/04 Gap 0 says every RPC must keep its internal authorization check
-- because the EXECUTE privilege layer cannot be trusted everywhere. Auditing
-- the harness revealed the privilege layer is weaker than the docs assume,
-- in four concrete ways (probe-verified against the test database):
--
--   1. 0002's `grant execute on all functions in schema public to anon,
--      authenticated` gave BOTH client roles the ENTIRE function surface —
--      helpers, sync machinery, backfills — not just the documented RPCs.
--   2. Functions created after 0002's `revoke … from public` carry the
--      built-in PUBLIC grant (=X) on creation. On this PostgreSQL, PUBLIC's
--      built-in EXECUTE for functions CANNOT be removed by ALTER DEFAULT
--      PRIVILEGES (probe: the default-ACL row never records it; a freshly
--      created function always materializes =X). Consequence: the per-
--      function `revoke … from anon` in 0009 (triage_community_report) and
--      0010 (mg_resolve_organization, the sync/guard functions) was VAIN —
--      anon still executed them through PUBLIC. Confirmed:
--      has_function_privilege('anon', triage…) = true after 0009's revoke.
--   3. 0002 line "alter default privileges … grant execute on functions to
--      anon, authenticated" still re-grants every FUTURE function to both
--      client roles (0009's default-privileges rewrite covered tables and
--      sequences only).
--   4. The documented client surface is seven RPCs; the actual anon surface
--      was 37 functions.
--
-- What this migration does (single transaction, idempotent — safe to
-- re-run; verified by tests/migration-apply.test.ts "GAP-0" block):
--
--   A  Default privileges: future functions start with NO anon/authenticated
--      grant (reverses 0002's blanket default) and the PUBLIC revoke is
--      re-asserted for lineages where it does bite (hosted Supabase revokes
--      the PUBLIC default platform-wide — docs/04 parity note). On this
--      harness PUBLIC's built-in still survives for new objects; the
--      guarantee here is therefore the PINNED SURFACE TESTS, not the
--      default ACL: any future migration that creates a function without an
--      explicit `revoke … from public/anon` fails the suite.
--   B  Revoke EXECUTE on every function in public from public, anon and
--      authenticated — the full reset (as postgres/owner the migration
--      itself is unaffected).
--   C  Restore EXACTLY the extension-member functions (pgcrypto, pg_trgm —
--      planner operator support such as gin_extract_query_trgm must stay
--      callable or ILIKE/trgm index scans fail for every role; on hosted
--      Supabase these live in the extensions schema, outside this surface).
--   D  anon allowlist = the two public flows: submit_community_report and
--      refresh_public_stats (the public mirrors' policies are `using (true)`
--      and call no functions, so anon needs no authorization helpers).
--   E  authenticated allowlist = the documented client RPC surface
--      (complete_staff_profile, provision_user_by_email, evidence_for_parent,
--      evidence_url, triage_community_report, submit_community_report,
--      refresh_public_stats) + the authorization-helper class (pure reads
--      over claims/matrix that RLS policies and SECURITY INVOKER guards
--      evaluate AS THE CALLING ROLE: mg_profile, mg_role, mg_operator_name,
--      mg_is_admin, mg_is_staff, mg_is_reviewer, mg_has_permission,
--      mg_any_profile_role, mg_can_access_site, mg_can_access_site_row) +
--      mg_command_center_stats (0012, SEC-4): a SECURITY INVOKER stats
--      aggregator whose every SELECT runs under RLS exactly like the
--      paginated client reads it replaces — invoker surface, no definer
--      body, authorization is row visibility itself. Machinery
--      (mg_resolve_organization, mg_client_ip) and trigger functions get NO
--      client grant: triggers are fired by the executor without an EXECUTE
--      check, and definer bodies run as their owner.
--   F  Grants are issued per function NAME over the overloads that exist in
--      the APPLYING lineage — never as hard-coded signatures. The live
--      project runs a pre-repository lineage where
--      `evidence_for_parent(text, uuid)` does not exist; the first live run
--      of this file aborted with SQLSTATE 42883. Names absent from a lineage
--      are skipped with a NOTICE instead of failing the migration. On the
--      repository lineage every name exists and the GAP-0 pins assert the
--      resulting surface exactly, so a skip can never weaken the guarantee
--      this migration makes in the repo.
--
-- Acceptance (tests/migration-apply.test.ts, describe "GAP-0"):
--   * anon executes EXACTLY the two public flows (PUBLIC fallback included)
--   * no non-extension function retains a PUBLIC grant
--   * the authenticated surface equals the pinned allowlist
--   * default privileges grant future functions to neither client role
--   * every client-REACHABLE SECURITY DEFINER function either carries an
--     internal authorization pattern or is on the reviewed helper /
--     public-flow allowlist (Gap 0's core requirement, now mechanical)
--   * 0011 is idempotent — re-runs leave the matrix unchanged
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- A. Default privileges — future functions start closed for client roles.
--    (0002 granted execute on functions to anon+authenticated by default;
--    0009 rewrote only tables/sequences. PUBLIC's built-in default cannot be
--    expressed away here — see header — the pinned tests enforce it.)
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- B. Full reset on the EXISTING surface. Owner (postgres) keeps its
--    privileges — definer bodies and this migration are unaffected.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from authenticated;

-- ---------------------------------------------------------------------------
-- C. Restore extension members (planner + crypto support) to both client
--    roles — they were never part of our surface and are consumed implicitly
--    by operator/index evaluation. Extension membership = pg_depend deptype
--    'e'; on hosted Supabase these functions live in `extensions`, not here.
-- ---------------------------------------------------------------------------
do $mg$
declare
  fn record;
begin
  for fn in
    select p.proname, pg_catalog.oidvectortypes(p.proargtypes) as arg_types
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and exists (
             select 1 from pg_catalog.pg_depend d
              where d.classid = 'pg_catalog.pg_proc'::regclass
                and d.objid = p.oid
                and d.deptype = 'e')
  loop
    execute format(
      'grant execute on function public.%I(%s) to anon, authenticated',
      fn.proname, fn.arg_types);
  end loop;
end
$mg$;

-- ---------------------------------------------------------------------------
-- D/E. Client allowlists — granted per function NAME (see header bullet F).
--      D. anon = the two public flows (their mirrors' policies are
--          `using (true)` and call no functions, so anon needs no
--          authorization helpers).
--      E. authenticated = the seven documented RPCs + the authorization
--          helpers (pure reads over claims/matrix that policies and
--          SECURITY INVOKER guards evaluate IN THE CALLING ROLE's context,
--          hence the caller needs EXECUTE).
-- ---------------------------------------------------------------------------
do $mg$
declare
  fn      record;
begin
  -- D. anon (+ authenticated) — the public flows.
  for fn in
    select p.proname, pg_catalog.oidvectortypes(p.proargtypes) as arg_types
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname in ('submit_community_report', 'refresh_public_stats')
  loop
    execute format(
      'grant execute on function public.%I(%s) to anon, authenticated',
      fn.proname, fn.arg_types);
  end loop;

  -- E. authenticated — documented RPC surface + authorization helpers.
  for fn in
    select p.proname, pg_catalog.oidvectortypes(p.proargtypes) as arg_types
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname in (
             'complete_staff_profile', 'provision_user_by_email',
             'evidence_for_parent', 'evidence_url',
             'triage_community_report', 'submit_community_report',
             'refresh_public_stats', 'mg_profile', 'mg_role',
             'mg_operator_name', 'mg_is_admin', 'mg_is_staff',
             'mg_is_reviewer', 'mg_has_permission', 'mg_any_profile_role',
             'mg_can_access_site', 'mg_can_access_site_row',
             'mg_command_center_stats')
  loop
    execute format(
      'grant execute on function public.%I(%s) to authenticated',
      fn.proname, fn.arg_types);
  end loop;

  -- Lineage report: names this lineage does not carry (informational — the
  -- repository lineage produces no notices here).
  for fn in
    select u.proname
      from unnest(array[
             'submit_community_report', 'refresh_public_stats',
             'complete_staff_profile', 'provision_user_by_email',
             'evidence_for_parent', 'evidence_url',
             'triage_community_report', 'mg_profile', 'mg_role',
             'mg_operator_name', 'mg_is_admin', 'mg_is_staff',
             'mg_is_reviewer', 'mg_has_permission', 'mg_any_profile_role',
             'mg_can_access_site', 'mg_can_access_site_row',
             'mg_command_center_stats'
           ]) as u(proname)
     where not exists (
             select 1
               from pg_catalog.pg_proc p
               join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = u.proname)
  loop
    raise notice '0011: % is not present in this lineage — grant skipped',
      fn.proname;
  end loop;
end
$mg$;

commit;
