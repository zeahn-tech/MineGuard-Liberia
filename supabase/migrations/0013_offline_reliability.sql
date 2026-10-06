-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0013: offline reliability + evidence parents
-- (Session 4, OFF-1…7 / EVD-1)
--
-- PROBLEM:
--   * Evidence could only attach to inspection / incident / observation
--     parents. Two flows needed their own attachments but had nowhere to
--     put them: staff triaging a PUBLIC community report (which is not
--     bound to any site), and an operator attaching documents to a
--     corrective-action response.
--   * The evidence row carried no integrity hash, so a corrupted queued
--     upload (device storage decay, truncated write) was indistinguishable
--     from the original bytes.
--
-- CHANGES (all idempotent):
--   1. evidence_parent enum gains 'community_report' and 'corrective_action'.
--      NOTE: ALTER TYPE ... ADD VALUE cannot be USED in the same transaction
--      that adds it (Postgres defers new-label visibility to commit; hosted
--      runs each migration inside one transaction). This file therefore only
--      ADDS the labels — no statement here casts or compares them. Every
--      consumer (policies, RPCs, client) matches parent types through the
--      text cast or the enum column itself at RUNTIME, long after commit.
--   2. evidence.sha256 — lowercase hex SHA-256 of the uploaded bytes,
--      computed independently by the data layer on upload and re-verified
--      before any queued replay; a mismatch is refused, never stored.
--   3. evidence.site_id becomes NULLABLE: a community report has no site.
--      Null-site evidence is the staff-only triage attachment case;
--      mg_stamp_site_scope() learns to leave such rows on their 'Unknown'
--      stamp defaults instead of assigning NULL into NOT NULL columns.
--   4. The read/insert RLS policies, the storage read policy,
--      evidence_for_parent() and evidence_url() all gain the matching
--      branch: site-visible rows keep working exactly as before
--      (mg_can_access_site), and NULL-site rows are visible to staff only
--      (mg_is_staff: admin/supervisor/inspector — operators and guests
--      never see community-report attachments).
--      create or replace preserves each function's OID and therefore its
--      0011-pinned execute grants (GAP-0 surface unchanged).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Enum: two new evidence parents. Guarded so re-runs are no-ops, and
--    deliberately the ONLY reference to these labels in this file (see the
--    transaction note above — nothing here may use a value added here).
-- ---------------------------------------------------------------------------
do $do$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'evidence_parent' and e.enumlabel = 'community_report'
  ) then
    execute 'alter type public.evidence_parent add value ''community_report''';
  end if;
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'evidence_parent' and e.enumlabel = 'corrective_action'
  ) then
    execute 'alter type public.evidence_parent add value ''corrective_action''';
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- 2. Integrity hash. Format is pinned by a check constraint: 64 lowercase
--    hex chars (sha256 output), NULL allowed only for rows that predate this
--    migration (live lineage backfills nothing — no bytes exist to hash).
-- ---------------------------------------------------------------------------
alter table public.evidence add column if not exists sha256 text;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'evidence_sha256_fmt' and conrelid = 'public.evidence'::regclass
  ) then
    alter table public.evidence
      add constraint evidence_sha256_fmt
      check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- 3. Nullable site: community-report attachments belong to no site.
--    DROP NOT NULL is naturally idempotent (dropping an absent constraint
--    is a no-op).
-- ---------------------------------------------------------------------------
alter table public.evidence alter column site_id drop not null;

-- The shared stamp trigger would assign NULL county/operator_name (the row
-- is NOT NULL DEFAULT 'Unknown') for a site-less row. Recreate the function
-- with an explicit null-site branch; every other table keeps its NOT NULL
-- site_id, so the guard never fires for them.
create or replace function public.mg_stamp_site_scope()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  s public.sites%rowtype;
begin
  -- Site-less evidence (community-report attachments, migration 0013): there
  -- is nothing to stamp — leave the column defaults in place.
  if new.site_id is null then
    return new;
  end if;
  select * into s from public.sites where id = new.site_id;
  new.county        := s.county;
  new.operator_name := s.operator_name;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS — same policy names (pinned in tests/migration-apply.test.ts),
--    widened by exactly one branch each. Permissive policies OR, so the
--    site-visible branch behaves byte-for-byte as before.
-- ---------------------------------------------------------------------------
drop policy if exists "evidence read" on public.evidence;
create policy "evidence read" on public.evidence
  for select using (
    public.mg_can_access_site(site_id)
    or (site_id is null and public.mg_is_staff())
  );

drop policy if exists "evidence insert" on public.evidence;
create policy "evidence insert" on public.evidence
  for insert with check (
    uploaded_by_id = auth.uid()
    and (
      public.mg_can_access_site(site_id)
      or (site_id is null and public.mg_is_staff())
    )
  );

-- Storage read policy: same split as the metadata read policy — the signed
-- URL / byte read must re-derive the identical scope. Name is kept ("evidence
-- read scoped") because tests/migration-apply.test.ts pins the storage
-- policy surface by name.
drop policy if exists "evidence read scoped" on storage.objects;
create policy "evidence read scoped"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'evidence'
    and exists (
      select 1 from public.evidence e
      where e.storage_path = name
        and (
          public.mg_can_access_site(e.site_id)
          or (e.site_id is null and public.mg_is_staff())
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 5. evidence_for_parent — same signature (text, uuid) as the 0002 grant and
--    the 0011 allowlist pin; only the scope predicate gains the staff branch.
-- ---------------------------------------------------------------------------
create or replace function public.evidence_for_parent(
  p_parent_type text,
  p_parent_id   uuid
)
returns setof public.evidence
language plpgsql
stable
security definer set search_path = public
as $$
begin
  return query
    select e.* from public.evidence e
    where e.parent_type = p_parent_type::evidence_parent
      and e.parent_id = p_parent_id
      and (
        public.mg_can_access_site(e.site_id)
        or (e.site_id is null and public.mg_is_staff())
      )
    order by e.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. evidence_url mint gate — mirrors the storage read policy exactly
--    (doc 04 Gap #2: same predicate at every read path).
-- ---------------------------------------------------------------------------
create or replace function public.evidence_url(
  p_evidence_id uuid,
  p_ttl_seconds integer default 120
)
returns text
language plpgsql
-- VOLATILE (the default), deliberately: the mint appends an audit row, and
-- Postgres rejects data-modifying statements inside STABLE/IMMUTABLE
-- functions. Callers get no caching guarantees from a volatile gate — which
-- is exactly right for a permission check.
security definer set search_path = public
as $fn$
declare
  v_row      public.evidence%rowtype;
  v_ttl      integer := coalesce(p_ttl_seconds, 120);
begin
  -- Server-side TTL bounds: the client may not mint a long-lived URL.
  if v_ttl > 300 then
    v_ttl := 300;
  end if;
  if v_ttl < 30 then
    v_ttl := 30;
  end if;

  -- Guest accounts (no assigned role) must never mint evidence URLs —
  -- mirrors the storage upload policy's role requirement.
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role is not null
  ) then
    raise exception 'FORBIDDEN: an assigned role is required to open evidence';
  end if;

  select * into v_row from public.evidence where id = p_evidence_id;
  if not found then
    return null;  -- NOT_FOUND at the call site; never leak path existence
  end if;

  -- The gate: same predicate as the "evidence read scoped" storage policy —
  -- site-visible rows, plus staff-only rows for site-less community-report
  -- attachments (migration 0013).
  if not (
    public.mg_can_access_site(v_row.site_id)
    or (v_row.site_id is null and public.mg_is_staff())
  ) then
    return null;
  end if;

  insert into public.evidence_url_audit (actor_id, evidence_id, ttl_seconds)
  values (auth.uid(), v_row.id, v_ttl);

  return v_row.storage_path;
end;
$fn$;

-- create or replace keeps each function's OID (and thus its 0011-pinned
-- grants). Stated explicitly anyway so the intent survives a future
-- recreate-with-drop: authenticated only, never anon, never PUBLIC.
grant execute on function public.evidence_for_parent(text, uuid) to authenticated;
grant execute on function public.evidence_url(uuid, integer) to authenticated;
revoke execute on function public.evidence_for_parent(text, uuid) from anon, public;
revoke execute on function public.evidence_url(uuid, integer) from anon, public;
