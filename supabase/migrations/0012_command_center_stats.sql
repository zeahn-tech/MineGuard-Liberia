-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0012: command-center stats RPC
-- (security roadmap SEC-4, HIGH: silent truncation / scale)
--
-- PROBLEM (SEC-4 audit): every read in src/lib/backend.ts fetched whole
-- tables with a bare PostgREST select — no Range, no limit — and aggregated
-- in the browser. Hosted PostgREST caps unranged responses at db-max-rows
-- (default 1,000 rows), so past that size the data arrived SILENTLY
-- truncated and every figure computed from it was quietly wrong:
--   * stats.commandCenter under-counted every dashboard statistic,
--   * sites.riskScores and the §18 AI explainer scored sites from a partial
--     slice of findings / corrective actions / incidents / observations,
--   * CSV exports and list surfaces shipped partial data,
-- with no error anywhere — wrong numbers presented as fact.
--
-- FIX, in two halves:
--   * PAGINATION (src/lib/backend.ts): row-level reads page with an explicit
--     ordered Range until a short page returns (pagedRows/allRows), so
--     correctness no longer depends on the server's row cap at any size.
--   * AGGREGATION (THIS FILE): the Command Center's 18 figures over seven
--     tables are computed IN THE DATABASE — counts, sums, rounds and
--     group-bys — and ONE jsonb row comes back. The flagship statistics
--     surface stops shipping O(n) rows to the browser entirely.
--
-- SECURITY MODEL — SECURITY INVOKER, deliberately: the function executes as
-- the calling role, so every SELECT inside it runs under the SAME row level
-- security policies the paginated client reads go through. No privilege
-- escalation, no scope re-derivation to get wrong — RLS IS the
-- authorization, matching docs/04's posture for invoker surfaces (and the
-- GAP-0 definer-self-authorization pin therefore does not apply: this is not
-- a definer function). EXECUTE is granted to `authenticated` only. The
-- built-in PUBLIC grant materializes on CREATE FUNCTION and 0011's default
-- privileges cannot express its removal, so this file revokes PUBLIC and
-- anon explicitly right after creation — the anon surface stays EXACTLY the
-- two public flows (GAP-0 pins in tests/migration-apply.test.ts).
--
-- ALLOWLIST LINEAGE: 0011 performs a full revoke-then-restore of the client
-- function surface on every (idempotent) run, so 0011's authenticated
-- allowlist carries 'mg_command_center_stats' — otherwise any later re-apply
-- of 0011 (the 0002/0009 idempotency chains do exactly that) would silently
-- revoke this RPC. The GAP-0 authenticated-surface pin was extended with
-- this signature in the same change.
--
-- PARITY: the SQL below mirrors the former client-side aggregation
-- statement for statement (the commandCenter body kept in backend.ts as the
-- fallback): identical predicates, identical rounding (round() on positive
-- values ≡ Math.round), identical fatalities coalesce, identical group-bys.
-- RLS row visibility is the same set the old "fetch all, then
-- canAccessSite-filter" pair could produce — the client mirror can only ever
-- DROP rows RLS already allowed, and the server matrix is the authority.
-- tests/sec4-pagination.test.ts pins both paths to return IDENTICAL objects
-- over the same data, and pins exact figures past the 1,000-row cap with
-- fixtures of 1,250 findings / 1,200 incidents.
--
-- No schema changes, no indexes, no data movement. Idempotent: safe to re-run
-- (create or replace + idempotent revokes/grants).
--
-- Acceptance:
--   * tests/sec4-pagination.test.ts — stats exact past the cap; RPC ≡
--     client fallback; anon EXECUTE denied; row-level lists complete;
--     source contract (reads paged, aggregation via the RPC).
--   * tests/migration-apply.test.ts GAP-0 — authenticated surface = pinned
--     allowlist + this signature; anon surface unchanged; zero PUBLIC
--     grants; 0011 re-runs byte-stable with the new allowlist entry.
-- ===========================================================================

begin;

create or replace function public.mg_command_center_stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $mg$
  select jsonb_build_object(
    'scope',
      coalesce((select p.scope::text from public.mg_profile() p), 'national'),
    'sites',
      (select count(*) from public.sites),
    'activeSites',
      (select count(*) from public.sites where status = 'active'),
    'inspectionsTotal',
      (select count(*) from public.inspections),
    'inspectionsUnderReview',
      (select count(*) from public.inspections where status = 'under_review'),
    'findingsTotal',
      (select count(*) from public.findings),
    'findingsCriticalOpen',
      (select count(*) from public.findings
        where severity = 'critical' and status in ('open', 'acknowledged')),
    'correctiveActionsOpen',
      (select count(*) from public.corrective_actions
        where status not in ('closed', 'verified')),
    'correctiveActionsOverdue',
      (select count(*) from public.corrective_actions
        where status not in ('closed', 'verified') and due_at < now()),
    'incidentsTotal',
      (select count(*) from public.incidents),
    'fatalities',
      (select coalesce(sum(coalesce(fatalities, 1)), 0)
         from public.incidents
        where type = 'fatality'),
    'envAlerts',
      (select count(*) from public.environmental_observations
        where status <> 'resolved'
          and verification in ('measured', 'verified')),
    'envByCategory',
      (select coalesce(jsonb_object_agg(g.category::text, g.n), '{}'::jsonb)
         from (select category, count(*) as n
                 from public.environmental_observations
                group by category) g),
    'communityReports',
      (select count(*) from public.community_reports),
    'communityReportsPending',
      (select count(*) from public.community_reports
        where status = 'submitted'),
    'inspectionCoveragePct',
      (select case
                when count(*) = 0 then 0
                else round(
                  100.0
                  * (select count(distinct i.site_id)
                       from public.inspections i
                      where i.status = 'approved')
                  / count(*))
              end
         from public.sites),
    'countyCounts',
      (select coalesce(jsonb_object_agg(g.county::text, g.n), '{}'::jsonb)
         from (select county, count(*) as n
                 from public.sites
                group by county) g),
    'incidentTypes',
      (select coalesce(jsonb_object_agg(g.type::text, g.n), '{}'::jsonb)
         from (select type, count(*) as n
                 from public.incidents
                group by type) g)
  )
$mg$;

-- The built-in PUBLIC grant materializes on CREATE FUNCTION (0011 header,
-- point 2) and survives default privileges — revoke it explicitly so the
-- GAP-0 "no PUBLIC execute grant" pin holds, and keep anon out: the
-- authenticated surface is this RPC's only client entry point.
revoke execute on function public.mg_command_center_stats() from public;
revoke execute on function public.mg_command_center_stats() from anon;
grant execute on function public.mg_command_center_stats() to authenticated;

commit;
