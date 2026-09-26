-- ============================================================================
-- MINEGUARD LIBERIA — migration 0006: evidence signed-URL mint gate +
-- short-TTL re-issue (Gap Closure Directive v1.0, Priority A, Gap #2)
--
-- DEFECT: evidence.getUrl minted 1-hour signed URLs with no revocation and no
-- server-side gate: the client read the storage path with its own RLS SELECT
-- and signed whatever it got (backend.ts). A leaked link stayed valid for the
-- full hour; a permission change never reached already-minted URLs; no record
-- existed of who viewed what. docs/04 listed this honestly as residual risk;
-- Gap #2 closes it.
--
-- DESIGN (revocation-at-mint + short TTL — the directive's first suggested
-- mechanism, no new infrastructure):
--   * A SECURITY DEFINER RPC `evidence_url(p_evidence_id, p_ttl_seconds)`
--     becomes the only mint gate. It re-derives the caller's CURRENT
--     authorization at every mint via mg_can_access_site() — the exact
--     predicate the storage read policy uses — so losing site access means
--     the next mint is refused. Revocation is thus permission-bound, not
--     clock-bound.
--   * The client caps the TTL at 120 seconds (was 3600). A leaked URL is a
--     2-minute exposure instead of an hour. The RPC clamps hard: >300s →
--     clamped, <30s → floor. The server, not the client, decides the
--     ceiling.
--   * Every mint appends to evidence_url_audit (actor, evidence, TTL, when).
--     No URL material is stored — signed URLs are not secrets in a table.
--   * In-flight URLs (≤120s) after a permission change are the residual,
--     documented honestly in docs/04. A revocation-at-fetch proxy would close
--     even that but requires edge infrastructure this change deliberately
--     does not add.
--
-- The RPC returns the STORAGE PATH (text), not the signed URL: signing
-- (createSignedUrl) is a storage-API operation done by the client with the
-- anon key, and the definer function must not pretend otherwise. The gate
-- the storage layer keeps (read policy joins metadata + mg_can_access_site)
-- is unchanged and remains the second layer.
--
-- LINEAGE: applies to the repository lineage; the live project receives the
-- same function via Management API hotfix (docs/11 records both).
-- ============================================================================

begin;

-- Append-only mint log. No UPDATE/DELETE grants, no policies: definer-only
-- table, same pattern as rate_limits (anon/authenticated see ZERO rows —
-- no policy exists, so RLS silently filters everything; superuser/definer
-- writes and reads).
create table if not exists public.evidence_url_audit (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references auth.users(id) on delete cascade,
  evidence_id  uuid not null references public.evidence(id) on delete cascade,
  ttl_seconds  integer not null,
  created_at   timestamptz not null default now()
);

alter table public.evidence_url_audit enable row level security;

-- No policies on purpose — see the table comment above. The audit_log
-- pattern (append-only, staff-readable) is deliberately NOT copied here:
-- URL mints are high-volume telemetry, not a governance record; keeping it
-- definer-only also means the log cannot be enumerated by any client role.

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

  -- The gate: same predicate as the "evidence read scoped" storage policy.
  if not public.mg_can_access_site(v_row.site_id) then
    return null;
  end if;

  insert into public.evidence_url_audit (actor_id, evidence_id, ttl_seconds)
  values (auth.uid(), p_evidence_id, v_ttl);

  return v_row.storage_path;
end;
$fn$;

-- Explicit, signature-auditable execute grants (0002 pattern).
grant execute on function public.evidence_url(uuid, integer) to authenticated;
revoke execute on function public.evidence_url(uuid, integer) from anon;
revoke execute on function public.evidence_url(uuid, integer) from public;

commit;
