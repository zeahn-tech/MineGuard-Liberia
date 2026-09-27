-- ============================================================================
-- MINEGUARD LIBERIA — migration 0007: sites INSERT/RETURNING + review guard
--
-- Two production defects proven by the backend-edge suite (Gap #3 of the Gap
-- Closure Directive, tests/backend-edge.test.ts), both reproduced against the
-- migration lineage inside transactional probes and fixed with probe-verified
-- SQL (DDL + assertions rolled back after proof).

-- 1. The "sites read" policy broke INSERT … RETURNING.
--    The policy called mg_can_access_site(id), which re-queries public.sites
--    via `exists (select 1 from sites …)`. Postgres evaluates the SELECT
--    policy on RETURNING rows, but during the INSERT's own command snapshot
--    the new row is not yet visible to an inner SELECT — so every
--    `.insert(...).select("id")` (exactly the request PostgREST-js sends from
--    insertReturningId() in src/lib/backend.ts) failed with
--    "new row violates row-level security policy for table sites", even for
--    admins. Admin site creation from the app was therefore impossible on a
--    fresh install of this lineage. Seed-style inserts without RETURNING
--    worked, which is why the clean-apply suite never caught it.
--    Fix: mg_can_access_site_row(county, operator_name) — the same role
--    matrix computed over the row's OWN columns, with no inner SELECT —
--    now backs the "sites read" policy. mg_can_access_site(p_site_id) keeps
--    its uuid signature for the storage policies, evidence_for_parent() and
--    the scope-stamp helpers, delegating to the row form: those call sites
--    always reference rows that already exist, so the inner SELECT is safe.
--    Verified in-probe: admin INSERT … RETURNING succeeds; per-role site
--    visibility is unchanged (operator sees only own tenant, county staff
--    only their county, guest nothing).

-- 2. mg_guard_inspection_update() made review impossible.
--    The ownership check (`new.inspector_id <> auth.uid()` → FORBIDDEN) ran
--    BEFORE the reviewer branch, contradicting the "inspections update" RLS
--    policy, which grants reviewers update access. A supervisor approving an
--    inspector's submitted inspection always raised
--    'FORBIDDEN: only the owning inspector may modify an inspection', so the
--    draft → submitted → approved workflow could never complete for any
--    inspection the reviewer did not personally own. Fix: the reviewer
--    allowance (under_review → approved/rejected) now precedes the ownership
--    check, matching the RLS policy and api.inspections.review(). Admin
--    bypass, submission path and NOT_EDITABLE / reviewer-required denials
--    are preserved verbatim.
--
-- Probe transcript (PGlite, per-request authed sessions via
-- set local role / request.jwt.claims):
--   * admin `insert into sites (…) returning id` → INSERT(1)
--     (42501 "new row violates row-level security policy" before)
--   * opB `select id from sites` → exactly the one OreCo row (isolation kept)
--   * county inspector draft → submit, national supervisor review
--     → status 'approved' (FORBIDDEN before)
--   * non-owner non-reviewer update → still FORBIDDEN
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Sites visibility over the row's own columns (no inner SELECT).
-- ---------------------------------------------------------------------------

create or replace function public.mg_can_access_site_row(
  p_county        text,
  p_operator_name text
)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (select
       public.mg_is_admin()
       or (
         public.mg_is_staff()
         and (select scope from public.mg_profile()) = 'national'
       )
       or (
         public.mg_is_staff()
         and (select scope from public.mg_profile()) = 'county'
         and (select county from public.mg_profile()) = p_county
       )
       or (
         (select role from public.mg_profile()) = 'operator'
         and (select operator_name from public.mg_profile()) = p_operator_name
       )
    ),
    false)
$$;

-- uuid form kept for storage policies, evidence_for_parent() and the
-- scope-stamp helpers — every caller there references rows that already
-- exist, so the inner SELECT is safe for them.
create or replace function public.mg_can_access_site(p_site_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (select public.mg_can_access_site_row(s.county, s.operator_name)
       from public.sites s
      where s.id = p_site_id),
    false)
$$;

-- Row-arg form: RETURNING re-checks can no longer fail for lack of visibility.
drop policy "sites read" on public.sites;
create policy "sites read" on public.sites
  for select using (public.mg_can_access_site_row(county, operator_name));

-- ---------------------------------------------------------------------------
-- 2. Reviewer allowance precedes the ownership check.
-- ---------------------------------------------------------------------------

create or replace function public.mg_guard_inspection_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if public.mg_is_admin() then return new; end if;

  -- Reviewers act on any under_review inspection (mirrors the "inspections
  -- update" RLS policy). MUST precede the ownership check — see header.
  if public.mg_is_reviewer()
     and old.status = 'under_review'
     and new.status in ('approved','rejected') then
    return new;
  end if;

  if new.inspector_id <> auth.uid() then
    raise exception 'FORBIDDEN: only the owning inspector may modify an inspection';
  end if;

  if old.status = 'draft' and new.status <> 'draft' then
    -- submission: any authenticated owner may submit (rule mirrors client)
    null;
  elsif old.status = 'under_review'
        and new.status in ('approved','rejected')
        and not public.mg_is_reviewer() then
    raise exception 'FORBIDDEN: reviewer role required to approve or reject';
  elsif old.status <> 'draft' and new.status <> old.status then
    raise exception 'NOT_EDITABLE: inspection is no longer a draft';
  end if;
  return new;
end;
$$;
