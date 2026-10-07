-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0014: scale surfaces (security roadmap
-- SEC-4 follow-up: server-side aggregation & scale)
--
-- PROBLEM (SEC-4 residual, measured at 10× the pilot scale): after the
-- pagination round every read is exact, but the aggregation-heavy surfaces
-- still ship O(n) ROWS to the browser and aggregate there:
--   * sites.riskScores fetched ALL of findings / corrective actions /
--     incidents / environmental observations (paged, exact — but ~5,000+ rows
--     per table on the wire per refresh) to multiply counts by weights,
--   * the §18 AI explainer did the same for a single site,
--   * CSV exports serialized rows the client had joined from three tables,
--   * list pages rendered whole feeds — with offset-paging the ONLY paging
--     primitive, so a table growing underneath a pager can skip or repeat
--     rows (offset windows are not stable; keyset windows are).
--
-- FIX (THIS FILE) — five more SECURITY INVOKER SQL functions, the 0012
-- pattern generalized:
--   mg_risk_scores()              per visible site: the exact count
--                                 aggregates the risk model consumes; the
--                                 client rebuilds factors from RISK_WEIGHTS.
--   mg_risk_explanation(p_site)   one site: the same aggregates PLUS the
--                                 record-id arrays the cite-or-abstain
--                                 explainer needs (single site ⇒ bounded).
--   mg_incidents_page(...)        KEYSET page (before-cursor, stable across
--   mg_inspections_page(...)      concurrent inserts — no offset skew) over
--   mg_compliance_page(...)       the feeds/exports, site-joined in SQL so
--                                 the browser neither joins nor re-scopes.
--
-- SECURITY MODEL — every function is SECURITY INVOKER: the SELECTs run as
-- the calling role under the SAME RLS policies the paginated reads go
-- through (findings, corrective actions, incidents and observations all
-- scope on mg_can_access_site(site_id); inspections additionally enforce the
-- inspector-owns-row rule server-side). RLS IS the authorization — no scope
-- re-derivation to get wrong, and the exports/feeds built on these pages
-- cannot exceed the caller's existing authorization by construction.
-- EXECUTE is revoked from PUBLIC and anon right after creation (the built-in
-- `=X` materializes on CREATE FUNCTION; 0011's default privileges cannot
-- express its removal) and granted to `authenticated` only. 0011's
-- authenticated allowlist is amended in the same release so its
-- revoke-then-restore (re-applied by the 0002/0009 idempotency chains) keeps
-- this surface.
--
-- KEYSET CONTRACT: pages return rows in (sort_at DESC, id DESC) order and
-- carry `cursorAt`/`cursorId` from the SAME expressions the WHERE clause
-- compares — the next request resumes exactly where the previous one
-- stopped, independent of concurrent inserts (which shift offset windows).
-- The first page passes NULL cursors. Rows that never saw an explicit
-- timestamp sort on created_at (coalesce in the same expression everywhere).
--
-- PARITY: predicates mirror the client model exactly —
--   risk: findings counted by severity (any status); overdue CAs =
--     status NOT IN ('closed','verified') AND due_at < now(); fatality
--     incidents = type = 'fatality'; serious incidents = type <> 'fatality'
--     AND severity IN ('high','critical'); env alerts = status <>
--     'resolved' AND verification IN ('measured','verified'); repeat
--     findings derive from findings_total (client: floor(n/4)).
--   lists: the feeds' enrichments (site code/name/county) are computed in
--     SQL; the client only maps fields. tests/scale-aggregation.test.ts pins
--     every figure to SQL ground truth at >5,000 rows per table.
--
-- Idempotent (create or replace + if not exists indexes + idempotent
-- grants/revokes). No schema columns change; three supporting indexes only.
--
-- Acceptance:
--   * tests/scale-aggregation.test.ts — >5,000-row tables: command center,
--     risk scores, keyset walks and streaming exports all equal SQL truth;
--     anon EXECUTE denied; security_invoker pinned; source contract (no
--     unranged select, aggregation via the RPCs).
--   * tests/migration-apply.test.ts GAP-0 — authenticated surface =
--     pinned allowlist + these five signatures; anon unchanged; zero PUBLIC
--     grants; 0011 re-runs byte-stable with the new entries.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Supporting indexes (keyset scans + per-site aggregation laterals).
--    Plain/expression indexes only — no column or policy changes.
-- ---------------------------------------------------------------------------
create index if not exists incidents_keyset_idx
  on public.incidents (coalesce(occurred_at, created_at) desc, id desc);
create index if not exists inspections_keyset_idx
  on public.inspections (created_at desc, id desc);
create index if not exists corrective_actions_keyset_idx
  on public.corrective_actions (created_at desc, id desc);
create index if not exists findings_site_idx on public.findings (site_id);
create index if not exists corrective_actions_site_idx
  on public.corrective_actions (site_id);
create index if not exists incidents_site_idx on public.incidents (site_id);
create index if not exists observations_site_idx
  on public.environmental_observations (site_id);

-- ---------------------------------------------------------------------------
-- 2. mg_risk_scores() — one jsonb row per RLS-VISIBLE site with the exact
--    count aggregates the risk model consumes. The client multiplies by
--    RISK_WEIGHTS (weights stay TypeScript-owned so labels/weights cannot
--    drift between the SQL source and the fallback computation).
-- ---------------------------------------------------------------------------
create or replace function public.mg_risk_scores()
returns setof jsonb
language sql
stable
security invoker
set search_path = public
as $mg$
  select jsonb_build_object(
    'siteId', s.id,
    'findingsTotal', f.total,
    'lowFindings', f.low,
    'mediumFindings', f.med,
    'highFindings', f.high,
    'criticalFindings', f.crit,
    'overdueCAs', c.overdue,
    'fatalityIncidents', i.fat,
    'seriousIncidents', i.ser,
    'envAlerts', e.alerts
  )
  from public.sites s
  left join lateral (
    select count(*) as total,
           count(*) filter (where f2.severity = 'low') as low,
           count(*) filter (where f2.severity = 'medium') as med,
           count(*) filter (where f2.severity = 'high') as high,
           count(*) filter (where f2.severity = 'critical') as crit
      from public.findings f2
     where f2.site_id = s.id
  ) f on true
  left join lateral (
    select count(*) as overdue
      from public.corrective_actions c2
     where c2.site_id = s.id
       and c2.status not in ('closed', 'verified')
       and c2.due_at < now()
  ) c on true
  left join lateral (
    select count(*) filter (where i2.type = 'fatality') as fat,
           count(*) filter (where i2.type <> 'fatality'
                              and i2.severity in ('high', 'critical')) as ser
      from public.incidents i2
     where i2.site_id = s.id
  ) i on true
  left join lateral (
    select count(*) as alerts
      from public.environmental_observations o2
     where o2.site_id = s.id
       and o2.status <> 'resolved'
       and o2.verification in ('measured', 'verified')
  ) e on true
$mg$;

-- ---------------------------------------------------------------------------
-- 3. mg_risk_explanation(p_site_id) — ONE visible site: the same aggregates
--    plus the record-id arrays the cite-or-abstain explainer cites. A site
--    the caller cannot see yields no row (NULL) — the client null-masks
--    exactly like the fallback path (not found OR out of scope → same null).
-- ---------------------------------------------------------------------------
create or replace function public.mg_risk_explanation(p_site_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $mg$
  select jsonb_build_object(
    'siteId', s.id,
    'code', s.code,
    'name', s.name,
    'findingsTotal', f.total,
    'lowFindings', f.low,
    'mediumFindings', f.med,
    'highFindings', f.high,
    'criticalFindings', f.crit,
    'overdueCAs', c.overdue,
    'fatalityIncidents', i.fat,
    'seriousIncidents', i.ser,
    'envAlerts', e.alerts,
    'lowIds', f.low_ids,
    'mediumIds', f.med_ids,
    'highIds', f.high_ids,
    'criticalIds', f.crit_ids,
    'overdueCaIds', c.overdue_ids,
    'fatalityIds', i.fat_ids,
    'seriousIncidentIds', i.ser_ids,
    'envAlertIds', e.alert_ids,
    'allFindingIds', f.all_ids
  )
  from public.sites s
  left join lateral (
    select count(*) as total,
           count(*) filter (where f2.severity = 'low') as low,
           count(*) filter (where f2.severity = 'medium') as med,
           count(*) filter (where f2.severity = 'high') as high,
           count(*) filter (where f2.severity = 'critical') as crit,
           coalesce(jsonb_agg(f2.id::text order by f2.id)
                      filter (where f2.severity = 'low'), '[]'::jsonb) as low_ids,
           coalesce(jsonb_agg(f2.id::text order by f2.id)
                      filter (where f2.severity = 'medium'), '[]'::jsonb) as med_ids,
           coalesce(jsonb_agg(f2.id::text order by f2.id)
                      filter (where f2.severity = 'high'), '[]'::jsonb) as high_ids,
           coalesce(jsonb_agg(f2.id::text order by f2.id)
                      filter (where f2.severity = 'critical'), '[]'::jsonb) as crit_ids,
           coalesce(jsonb_agg(f2.id::text order by f2.id), '[]'::jsonb) as all_ids
      from public.findings f2
     where f2.site_id = s.id
  ) f on true
  left join lateral (
    select count(*) as overdue,
           coalesce(jsonb_agg(c2.id::text order by c2.id), '[]'::jsonb) as overdue_ids
      from public.corrective_actions c2
     where c2.site_id = s.id
       and c2.status not in ('closed', 'verified')
       and c2.due_at < now()
  ) c on true
  left join lateral (
    select count(*) filter (where i2.type = 'fatality') as fat,
           count(*) filter (where i2.type <> 'fatality'
                              and i2.severity in ('high', 'critical')) as ser,
           coalesce(jsonb_agg(i2.id::text order by i2.id)
                      filter (where i2.type = 'fatality'), '[]'::jsonb) as fat_ids,
           coalesce(jsonb_agg(i2.id::text order by i2.id)
                      filter (where i2.type <> 'fatality'
                                and i2.severity in ('high', 'critical')),
                      '[]'::jsonb) as ser_ids
      from public.incidents i2
     where i2.site_id = s.id
  ) i on true
  left join lateral (
    select count(*) as alerts,
           coalesce(jsonb_agg(o2.id::text order by o2.id), '[]'::jsonb) as alert_ids
      from public.environmental_observations o2
     where o2.site_id = s.id
       and o2.status <> 'resolved'
       and o2.verification in ('measured', 'verified')
  ) e on true
  where s.id = p_site_id
$mg$;

-- ---------------------------------------------------------------------------
-- 4. Keyset pages — the list/export surfaces' row source. Every page is
--    (sort_at DESC, id DESC) ordered, site-joined in SQL, and carries the
--    cursor of its own last row. NULL cursors = first page. Rows are
--    jsonb with camelCase keys (the client mapper's only job is coercion).
-- ---------------------------------------------------------------------------

-- Incidents feed/export row: matches the former listIncidents output shape
-- (enriched incident) + the cursor pair. Sort key: coalesce(occurred_at,
-- created_at) — the exact expression the incidents list sorted on.
create or replace function public.mg_incidents_page(
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 500
)
returns setof jsonb
language sql
stable
security invoker
set search_path = public
as $mg$
  select jsonb_build_object(
    '_id', i.id,
    'siteId', i.site_id,
    'type', i.type,
    'severity', i.severity,
    'description', i.description,
    'occurredAt', extract(epoch from coalesce(i.occurred_at, i.created_at)) * 1000,
    'fatalities', i.fatalities,
    'injured', i.injured,
    'status', i.status,
    'reportedById', i.reported_by_id,
    'reportSource', i.report_source,
    'createdAt', extract(epoch from i.created_at) * 1000,
    'siteCode', s.code,
    'siteName', s.name,
    'county', s.county,
    'cursorAt', extract(epoch from coalesce(i.occurred_at, i.created_at)) * 1000,
    'cursorId', i.id::text
  )
  from public.incidents i
  join public.sites s on s.id = i.site_id
  where (p_before is null
         or (coalesce(i.occurred_at, i.created_at), i.id) < (p_before, p_before_id))
  order by coalesce(i.occurred_at, i.created_at) desc, i.id desc
  limit coalesce(greatest(p_limit, 1), 500)
$mg$;

-- Inspections list/export row: the former inspections.list output shape.
-- The inspector-owns-row rule is ALREADY an RLS predicate on the table
-- (policy "inspections read"), so the page reproduces the client list's
-- visible set without re-deriving any scope in SQL.
create or replace function public.mg_inspections_page(
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 500
)
returns setof jsonb
language sql
stable
security invoker
set search_path = public
as $mg$
  select jsonb_build_object(
    '_id', i.id,
    'siteId', i.site_id,
    'siteCode', s.code,
    'siteName', s.name,
    'county', s.county,
    'status', i.status,
    'submittedAt', case when i.submitted_at is null
                        then null
                        else extract(epoch from i.submitted_at) * 1000 end,
    'createdAt', extract(epoch from i.created_at) * 1000,
    'inspectorId', i.inspector_id,
    'cursorAt', extract(epoch from i.created_at) * 1000,
    'cursorId', i.id::text
  )
  from public.inspections i
  join public.sites s on s.id = i.site_id
  where (p_before is null
         or (i.created_at, i.id) < (p_before, p_before_id))
  order by i.created_at desc, i.id desc
  limit coalesce(greatest(p_limit, 1), 500)
$mg$;

-- Compliance export row: the former listMyCorrectiveActions output shape
-- (CA + finding title/severity + site identity). Sort key created_at.
create or replace function public.mg_compliance_page(
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 500
)
returns setof jsonb
language sql
stable
security invoker
set search_path = public
as $mg$
  select jsonb_build_object(
    '_id', ca.id,
    'siteId', ca.site_id,
    'findingId', ca.finding_id,
    'description', ca.description,
    'status', ca.status,
    'dueAt', extract(epoch from ca.due_at) * 1000,
    'operatorNote', ca.operator_note,
    'createdAt', extract(epoch from ca.created_at) * 1000,
    'findingTitle', f.title,
    'findingSeverity', f.severity,
    'siteCode', s.code,
    'siteName', s.name,
    'county', s.county,
    'cursorAt', extract(epoch from ca.created_at) * 1000,
    'cursorId', ca.id::text
  )
  from public.corrective_actions ca
  left join public.findings f on f.id = ca.finding_id
  join public.sites s on s.id = ca.site_id
  where (p_before is null
         or (ca.created_at, ca.id) < (p_before, p_before_id))
  order by ca.created_at desc, ca.id desc
  limit coalesce(greatest(p_limit, 1), 500)
$mg$;

-- ---------------------------------------------------------------------------
-- 5. Grants — authenticated only (0012 pattern: the built-in PUBLIC grant
--    materializes on CREATE FUNCTION and must be revoked explicitly; 0011's
--    allowlist is amended to carry these names so its revoke-then-restore
--    keeps them).
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
       and p.proname in ('mg_risk_scores', 'mg_risk_explanation',
                         'mg_incidents_page', 'mg_inspections_page',
                         'mg_compliance_page')
  loop
    execute format(
      'revoke execute on function public.%I(%s) from public, anon', fn.proname, fn.arg_types);
    execute format(
      'grant execute on function public.%I(%s) to authenticated', fn.proname, fn.arg_types);
  end loop;
end
$mg$;

commit;
