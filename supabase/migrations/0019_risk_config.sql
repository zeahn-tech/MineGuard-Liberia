-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0019: configurable risk engine
-- (Session 7: RSK-1 versioned, admin-only, audited, effective-dated weights;
--  RSK-2 server-side computation + historical-compliance factor)
--
-- Before this migration the risk weights were a TypeScript constant
-- (RISK_WEIGHTS) and the database only returned COUNTS: changing a weight
-- meant a code deploy, left no trace of who changed what, and made every old
-- score unreproducible. This migration moves the weights into the database:
--
--   risk_config_versions   append-only, numbered, effective-dated weight sets.
--                          Admin-only INSERT (permission risk.config.write),
--                          no UPDATE / DELETE for anyone, one audit_log row per
--                          publish (the 0009 trigger — the single audit writer).
--   mg_risk_config_at(ts)  the version in force at a moment.
--   mg_risk_build(c, w, d) the ONE factor builder: counts + weights -> score and
--                          factors, with score = SUM(points) by construction.
--   mg_risk_scores(v, ts)  per-visible-site counts AND the computed score /
--                          factors, under an explicit version or the version in
--                          force at ts (default now()).
--   mg_risk_explanation    same, plus the record-id arrays the cite-or-abstain
--                          explainer anchors to.
--
-- Decisions worth knowing:
--   * Versions are IMMUTABLE and strictly ordered. A new version must take
--     effect at or after "now" and strictly after every earlier version, so
--     "the version in force at t" can never change once t has passed — that is
--     what makes an old score reproducible by (version, inputs).
--   * Version 1 reproduces the pre-Session-7 weights exactly, with the new
--     historical-compliance weight at 0: shipping this migration changes no
--     score. An administrator turns the new factor on by publishing version 2.
--   * Reproducibility covers the CONFIG. Inputs are the live records; record
--     status history is not retained (only audit diffs), so recomputing an old
--     moment's score from today's records is not claimed.
--   * mg_risk_scores() and mg_risk_explanation(uuid) are REPLACED by versions
--     taking optional (version, as_of) arguments. Do not re-apply 0014 on top
--     of this migration: it would recreate the old overloads.
--
-- Idempotent: safe to re-run (verified by tests/migration-apply.test.ts).
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- A. Permission: only administrators publish risk configuration.
-- ---------------------------------------------------------------------------
insert into public.permissions (role, permission) values
  ('admin', 'risk.config.write')
on conflict (role, permission) do nothing;

-- ---------------------------------------------------------------------------
-- B. Validation: the exact weight key set, non-negative integers.
--    (Integers keep score = SUM(points) an exact identity — no rounding.)
-- ---------------------------------------------------------------------------
create or replace function public.mg_valid_risk_weights(p_weights jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = public
as $mg$
declare
  k text;
  expected constant text[] := array[
    'criticalFinding', 'highFinding', 'mediumFinding', 'lowFinding',
    'repeatFinding', 'overdueCA', 'fatality', 'seriousIncident',
    'envAlert', 'lateClosedCA'];
  v jsonb;
begin
  if p_weights is null or jsonb_typeof(p_weights) <> 'object' then
    return false;
  end if;
  -- no unknown keys
  for k in select jsonb_object_keys(p_weights) loop
    if not (k = any (expected)) then
      return false;
    end if;
  end loop;
  -- every expected key present, a JSON number, an integer in [0, 1000]
  foreach k in array expected loop
    v := p_weights -> k;
    if v is null or jsonb_typeof(v) <> 'number' then
      return false;
    end if;
    if (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric)
       or (v #>> '{}')::numeric < 0
       or (v #>> '{}')::numeric > 1000 then
      return false;
    end if;
  end loop;
  return true;
end
$mg$;

-- ---------------------------------------------------------------------------
-- C. risk_config_versions — append-only, numbered, effective-dated.
-- ---------------------------------------------------------------------------
create table if not exists public.risk_config_versions (
  id                       uuid primary key default gen_random_uuid(),
  version                  integer not null unique check (version >= 1),
  weights                  jsonb not null,
  historical_lookback_days integer not null default 365
                           check (historical_lookback_days between 1 and 3650),
  effective_from           timestamptz not null,
  change_note              text not null check (length(btrim(change_note)) >= 3),
  created_by               uuid references public.profiles(id),
  created_at               timestamptz not null default now()
);

-- Server-owned columns and ordering rules. SECURITY DEFINER only so the
-- permission/ordering reads are not blocked by the caller's RLS; it touches
-- nothing but NEW and the table's own max().
create or replace function public.mg_risk_config_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $mg$
declare
  v_max_version integer;
  v_max_eff     timestamptz;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'IMMUTABLE: risk configuration versions are append-only — publish a new version instead';
  end if;

  -- Session identity only: with a session, the caller must hold the
  -- permission (admin). A null uid is the migration owner / service role.
  if auth.uid() is not null and not public.mg_has_permission('risk.config.write') then
    raise exception 'FORBIDDEN: administrator required to publish risk configuration';
  end if;

  if not public.mg_valid_risk_weights(new.weights) then
    raise exception 'INVALID_RISK_CONFIG: weights must contain exactly the ten known keys as integers between 0 and 1000';
  end if;

  -- Serialize publishers so version numbers and the ordering check are race-free.
  perform pg_advisory_xact_lock(hashtext('mineguard.risk_config_versions'));
  select max(version), max(effective_from)
    into v_max_version, v_max_eff
    from public.risk_config_versions;

  -- Server-assigned, never client-supplied.
  new.version    := coalesce(v_max_version, 0) + 1;
  new.created_at := now();
  new.created_by := auth.uid();
  new.id         := coalesce(new.id, gen_random_uuid());

  if new.effective_from is null then
    new.effective_from := now();
  end if;

  if v_max_eff is not null then
    if new.effective_from < now() then
      raise exception 'INVALID_EFFECTIVE_DATE: a new version cannot take effect in the past (history is immutable)';
    end if;
    if new.effective_from <= v_max_eff then
      raise exception 'INVALID_EFFECTIVE_DATE: a new version must take effect after the latest existing version (%)', v_max_eff;
    end if;
  end if;
  return new;
end
$mg$;

drop trigger if exists risk_config_versions_guard on public.risk_config_versions;
create trigger risk_config_versions_guard
  before insert or update or delete on public.risk_config_versions
  for each row execute function public.mg_risk_config_guard();

-- Exactly one audit row per publish, written by the SEC-1 trigger.
drop trigger if exists risk_config_versions_audit on public.risk_config_versions;
create trigger risk_config_versions_audit
  after insert on public.risk_config_versions
  for each row execute function public.mg_audit_row();

-- Row-level security: any signed-in account with a role may READ the config
-- (the weights are the explanation of the score they already see); only the
-- permission holder may INSERT. There is no UPDATE or DELETE policy at all.
alter table public.risk_config_versions enable row level security;

drop policy if exists "risk config read" on public.risk_config_versions;
create policy "risk config read" on public.risk_config_versions
  for select to authenticated
  using ((select role from public.mg_profile()) is not null);

drop policy if exists "risk config publish" on public.risk_config_versions;
create policy "risk config publish" on public.risk_config_versions
  for insert to authenticated
  with check (public.mg_has_permission('risk.config.write'));

revoke all on public.risk_config_versions from anon, authenticated, public;
grant select, insert on public.risk_config_versions to authenticated;

-- Version 1 = the pre-Session-7 weights, historical factor off. The guard
-- accepts it with no session (migration owner) and an empty table.
insert into public.risk_config_versions
  (version, weights, historical_lookback_days, effective_from, change_note)
select 1,
       jsonb_build_object(
         'criticalFinding', 10, 'highFinding', 6, 'mediumFinding', 3,
         'lowFinding', 1, 'repeatFinding', 4, 'overdueCA', 8,
         'fatality', 15, 'seriousIncident', 7, 'envAlert', 5,
         'lateClosedCA', 0),
       365,
       timestamptz '1970-01-01 00:00:00+00',
       'Initial configuration: the weights in force before configurable risk (historical compliance off)'
 where not exists (select 1 from public.risk_config_versions);

-- ---------------------------------------------------------------------------
-- D. mg_risk_config_at — the version in force at a moment.
-- ---------------------------------------------------------------------------
create or replace function public.mg_risk_config_at(p_as_of timestamptz default null)
returns public.risk_config_versions
language sql
stable
security invoker
set search_path = public
as $mg$
  select c.*
    from public.risk_config_versions c
   where c.effective_from <= coalesce(p_as_of, now())
   order by c.effective_from desc, c.version desc
   limit 1
$mg$;

-- ---------------------------------------------------------------------------
-- E. mg_risk_build — THE factor builder (pure).
--    p_counts: the count aggregates (keys as returned by mg_risk_scores)
--    p_weights: a validated weight set
--    p_lookback_days: only used in the historical factor's label
--    Returns {"score": n, "factors": [{"key","label","points"}...]}.
--    INVARIANT: score is computed as the sum of the emitted factor points, so
--    score = SUM(points) holds for every counts/weights input — never a
--    separately computed total.
--    Factor order is fixed; zero-point factors never materialize.
-- ---------------------------------------------------------------------------
create or replace function public.mg_risk_build(
  p_counts        jsonb,
  p_weights       jsonb,
  p_lookback_days integer default 365
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = public
as $mg$
declare
  v_factors jsonb := '[]'::jsonb;
  v_score   bigint := 0;
  c_total   bigint := coalesce((p_counts ->> 'findingsTotal')::bigint, 0);
  r record;
begin
  for r in
    select * from (values
      (1, 'criticalFindings',
          coalesce((p_counts ->> 'criticalFindings')::bigint, 0),
          (p_weights ->> 'criticalFinding')::numeric::bigint, '%s critical finding(s)'),
      (2, 'highFindings',
          coalesce((p_counts ->> 'highFindings')::bigint, 0),
          (p_weights ->> 'highFinding')::numeric::bigint, '%s high finding(s)'),
      (3, 'mediumFindings',
          coalesce((p_counts ->> 'mediumFindings')::bigint, 0),
          (p_weights ->> 'mediumFinding')::numeric::bigint, '%s medium finding(s)'),
      (4, 'lowFindings',
          coalesce((p_counts ->> 'lowFindings')::bigint, 0),
          (p_weights ->> 'lowFinding')::numeric::bigint, '%s low finding(s)'),
      -- repeat: one unit per full block of four findings at the site
      (5, 'repeatFindings',
          case when c_total > 3 then c_total / 4 else 0 end,
          (p_weights ->> 'repeatFinding')::numeric::bigint, 'Repeat findings at site'),
      (6, 'overdueCAs',
          coalesce((p_counts ->> 'overdueCAs')::bigint, 0),
          (p_weights ->> 'overdueCA')::numeric::bigint, '%s overdue corrective action(s)'),
      (7, 'fatalities',
          coalesce((p_counts ->> 'fatalityIncidents')::bigint, 0),
          (p_weights ->> 'fatality')::numeric::bigint, '%s fatality incident(s)'),
      (8, 'seriousIncidents',
          coalesce((p_counts ->> 'seriousIncidents')::bigint, 0),
          (p_weights ->> 'seriousIncident')::numeric::bigint, '%s serious incident(s)'),
      (9, 'envAlerts',
          coalesce((p_counts ->> 'envAlerts')::bigint, 0),
          (p_weights ->> 'envAlert')::numeric::bigint, '%s verified environmental alert(s)'),
      (10, 'lateClosedCAs',
          coalesce((p_counts ->> 'lateClosedCAs')::bigint, 0),
          (p_weights ->> 'lateClosedCA')::numeric::bigint,
          '%s corrective action(s) closed late in the last ' || p_lookback_days || ' days')
    ) as t(ord, key, n, w, label)
    order by ord
  loop
    if r.n * r.w > 0 then
      v_factors := v_factors || jsonb_build_array(jsonb_build_object(
        'key', r.key,
        'label', replace(r.label, '%s', r.n::text),
        'points', r.n * r.w));
      v_score := v_score + r.n * r.w;
    end if;
  end loop;
  return jsonb_build_object('score', v_score, 'factors', v_factors);
end
$mg$;

-- ---------------------------------------------------------------------------
-- F. mg_risk_scores(p_version, p_as_of) — one jsonb row per RLS-VISIBLE site.
--    The config is: the explicit version if given (error if it does not
--    exist), else the version in force at p_as_of (default now()). The same
--    row keys as 0014 are kept (counts), plus lateClosedCAs, the computed
--    score/factors and the config version that produced them.
-- ---------------------------------------------------------------------------
drop function if exists public.mg_risk_scores();

create or replace function public.mg_risk_scores(
  p_version integer default null,
  p_as_of   timestamptz default null
)
returns setof jsonb
language plpgsql
stable
security invoker
set search_path = public
as $mg$
declare
  cfg  public.risk_config_versions;
  asof timestamptz := coalesce(p_as_of, now());
begin
  if p_version is not null then
    select * into cfg from public.risk_config_versions where version = p_version;
    if not found then
      raise exception 'RISK_CONFIG_NOT_FOUND: no risk configuration version %', p_version;
    end if;
  else
    cfg := public.mg_risk_config_at(asof);
    if cfg.id is null then
      return; -- caller cannot read any configuration (no role): no scores
    end if;
  end if;

  return query
  with counts as (
    select s.id as site_id,
           jsonb_build_object(
             'siteId', s.id,
             'findingsTotal', f.total,
             'lowFindings', f.low,
             'mediumFindings', f.med,
             'highFindings', f.high,
             'criticalFindings', f.crit,
             'overdueCAs', c.overdue,
             'lateClosedCAs', c.late_closed,
             'fatalityIncidents', i.fat,
             'seriousIncidents', i.ser,
             'envAlerts', e.alerts) as j
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
        select count(*) filter (
                 where c2.status not in ('closed', 'verified')
                   and c2.due_at < now()) as overdue,
               count(*) filter (
                 where c2.status in ('closed', 'verified')
                   and c2.closed_at is not null
                   and c2.closed_at > c2.due_at
                   and c2.closed_at >= asof - make_interval(days => cfg.historical_lookback_days)
                   and c2.closed_at <= asof) as late_closed
          from public.corrective_actions c2
         where c2.site_id = s.id
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
  )
  select counts.j
         || public.mg_risk_build(counts.j, cfg.weights, cfg.historical_lookback_days)
         || jsonb_build_object('configVersion', cfg.version,
                               'configEffectiveFrom', cfg.effective_from)
    from counts;
end
$mg$;

-- ---------------------------------------------------------------------------
-- G. mg_risk_explanation(p_site_id, p_version, p_as_of) — ONE visible site:
--    the same row as mg_risk_scores PLUS the record-id arrays the
--    cite-or-abstain explainer cites. Reads the SAME config selection as
--    mg_risk_scores — there is no second weight source.
-- ---------------------------------------------------------------------------
drop function if exists public.mg_risk_explanation(uuid);

create or replace function public.mg_risk_explanation(
  p_site_id uuid,
  p_version integer default null,
  p_as_of   timestamptz default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $mg$
declare
  cfg  public.risk_config_versions;
  asof timestamptz := coalesce(p_as_of, now());
  res  jsonb;
begin
  if p_version is not null then
    select * into cfg from public.risk_config_versions where version = p_version;
    if not found then
      raise exception 'RISK_CONFIG_NOT_FOUND: no risk configuration version %', p_version;
    end if;
  else
    cfg := public.mg_risk_config_at(asof);
    if cfg.id is null then
      return null;
    end if;
  end if;

  select base.j
         || public.mg_risk_build(base.j, cfg.weights, cfg.historical_lookback_days)
         || jsonb_build_object('configVersion', cfg.version,
                               'configEffectiveFrom', cfg.effective_from)
    into res
    from (
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
        'lateClosedCAs', c.late_closed,
        'fatalityIncidents', i.fat,
        'seriousIncidents', i.ser,
        'envAlerts', e.alerts,
        'lowIds', f.low_ids,
        'mediumIds', f.med_ids,
        'highIds', f.high_ids,
        'criticalIds', f.crit_ids,
        'overdueCaIds', c.overdue_ids,
        'lateClosedCaIds', c.late_ids,
        'fatalityIds', i.fat_ids,
        'seriousIncidentIds', i.ser_ids,
        'envAlertIds', e.alert_ids,
        'allFindingIds', f.all_ids) as j
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
        select count(*) filter (
                 where c2.status not in ('closed', 'verified')
                   and c2.due_at < now()) as overdue,
               count(*) filter (
                 where c2.status in ('closed', 'verified')
                   and c2.closed_at is not null
                   and c2.closed_at > c2.due_at
                   and c2.closed_at >= asof - make_interval(days => cfg.historical_lookback_days)
                   and c2.closed_at <= asof) as late_closed,
               coalesce(jsonb_agg(c2.id::text order by c2.id) filter (
                 where c2.status not in ('closed', 'verified')
                   and c2.due_at < now()), '[]'::jsonb) as overdue_ids,
               coalesce(jsonb_agg(c2.id::text order by c2.id) filter (
                 where c2.status in ('closed', 'verified')
                   and c2.closed_at is not null
                   and c2.closed_at > c2.due_at
                   and c2.closed_at >= asof - make_interval(days => cfg.historical_lookback_days)
                   and c2.closed_at <= asof), '[]'::jsonb) as late_ids
          from public.corrective_actions c2
         where c2.site_id = s.id
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
    ) base;

  return res; -- NULL when the site is absent or not visible to the caller (RLS)
end
$mg$;

-- ---------------------------------------------------------------------------
-- H. Execute surface (0011's rule): nothing is callable by anon/PUBLIC; the
--    SECURITY INVOKER readers/builders are granted to authenticated only.
--    Guard / validator functions are trigger-or-invoker internals: no grant
--    beyond what the validator's caller (the guard, a definer) needs.
-- ---------------------------------------------------------------------------
revoke execute on function public.mg_valid_risk_weights(jsonb) from public, anon, authenticated;
revoke execute on function public.mg_risk_config_guard() from public, anon, authenticated;
revoke execute on function public.mg_risk_config_at(timestamptz) from public, anon;
revoke execute on function public.mg_risk_build(jsonb, jsonb, integer) from public, anon;
revoke execute on function public.mg_risk_scores(integer, timestamptz) from public, anon;
revoke execute on function public.mg_risk_explanation(uuid, integer, timestamptz) from public, anon;

grant execute on function public.mg_risk_config_at(timestamptz) to authenticated;
grant execute on function public.mg_risk_build(jsonb, jsonb, integer) to authenticated;
grant execute on function public.mg_risk_scores(integer, timestamptz) to authenticated;
grant execute on function public.mg_risk_explanation(uuid, integer, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- I. Realtime: a published version refreshes other administrators' open pages.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public'
          and tablename = 'risk_config_versions') then
    alter publication supabase_realtime add table public.risk_config_versions;
  end if;
end $$;

commit;
