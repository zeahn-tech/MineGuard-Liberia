-- ============================================================================
-- MINEGUARD LIBERIA — migration 0005: per-source rate limiting for
-- submit_community_report (Gap Closure Directive v1.0, Priority A, Gap #1)
--
-- DEFECT: 0001's submit_community_report counted submissions into ONE global
-- bucket ('public_report'). Any single source able to POST 31 times a minute
-- (a buggy loop, a captive-portal NAT, or an attacker) silenced community
-- reporting for the entire country until the window rolled over. Denial of
-- service against a public safety channel, one SQL literal away.
--
-- FIX: partition the same 30/minute capacity per client source. The source
-- key is derived SERVER-SIDE from the request headers PostgREST injects into
-- the `request.headers` GUC (x-forwarded-for, first hop = the connecting
-- client as seen by the platform edge). It is never read from a function
-- argument or request body — a client cannot spoof a fresh identity by
-- changing its payload.
--
-- What deliberately does NOT change:
--   * The RPC signature (text,text,text,text,text,text,double precision,
--     double precision,text) — 0002's EXECUTE grants and the client data
--     layer (src/lib/backend.ts) stay valid untouched.
--   * The 30/minute cap per source — same capacity, partitioned; not a
--     30x loosening.
--   * rate_limits' table shape — the existing bucket/count/window_start
--     columns carry the per-source buckets; no table migration needed.
--
-- PRIVACY: the bucket key stores only a salted SHA-256 digest of the IP
-- (pgcrypto digest, fixed application salt). No raw address is persisted,
-- so the limiter table cannot become a surveillance log. Direct connections
-- that present no forwardable client IP degrade to one shared global bucket
-- — fail-closed: capacity stays bounded even when the source is unknown.
--
-- EXTENSION SCHEMA: hosted Supabase installs pgcrypto's digest() into the
-- `extensions` schema, while a plain Postgres (the PGlite test harness)
-- puts it in `public`. `set search_path = public, extensions` resolves
-- digest() on both: on hosted Supabase via extensions, on plain Postgres
-- via public (nonexistent schemas in a search path are silently ignored,
-- so the harness is unaffected). An unqualified digest() under
-- `search_path = public` alone breaks this function on every hosted
-- Supabase deployment — found live on 2026-09-26 (42883 digest(text,
-- unknown) does not exist) and fixed in the same hotfix.
--
-- LINEAGE: 2026-09-26 the live deployment converged onto this body
-- (text-typed signature, per-source buckets) via the Management API, after a
-- partial paste by the owner left live public reporting DOWN (rate_limits
-- lacked window_start; digest() was unreachable under search_path = public).
-- The live table keeps its legacy updated_at column and an old enum-typed
-- overload of this RPC (unused by PostgREST string callers); both are
-- retained residue — see docs/11 before dropping anything.
-- ============================================================================

begin;

create or replace function public.mg_client_ip()
returns text
language sql stable
set search_path = public
as $$
  with h as (
    select coalesce(
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for',
      ''
    ) as xff
  )
  select case
    -- First XFF hop = client as seen by the platform edge (Supabase/Kong
    -- appends/normalises this). Trailing spaces stripped; empty stays empty.
    when h.xff <> '' then lower(btrim(split_part(h.xff, ',', 1)))
    -- PostgREST also forwards the peer address on this header in hosted
    -- Supabase; use it when no XFF chain exists at all.
    else lower(btrim(coalesce(
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-real-ip',
      ''
    )))
  end
  from h
$$;

create or replace function public.submit_community_report(
  p_tracking_code text,
  p_category      text,
  p_description   text,
  p_county        text,
  p_district      text default null,
  p_community     text default null,
  p_latitude      double precision default null,
  p_longitude     double precision default null,
  p_contact_phone text default null
)
returns jsonb
language plpgsql
security definer set search_path = public, extensions
as $$
declare
  v_id    uuid;
  v_src   text;
  v_key   text;
  v_count integer;
begin
  -- ------------------------------------------------------------------
  -- Rate limit: 30 reports per rolling minute PER SOURCE. The bucket key
  -- is 'report:<sha256(salt || client_ip)>' when a forwardable client IP
  -- exists, degrading to the shared 'report:global' bucket otherwise.
  -- The digest never reveals the address; the salt keeps preimage and
  -- rainbow attacks offline.
  -- ------------------------------------------------------------------
  v_src := public.mg_client_ip();

  if v_src is null or v_src = '' then
    v_key := 'report:global';
  else
    v_key := 'report:' || encode(
      digest('mgliberia-v1:' || v_src, 'sha256'), 'hex');
  end if;

  insert into public.rate_limits (bucket, count, window_start)
  values (v_key, 1, now())
  on conflict (bucket) do update
    set count = case
          when public.rate_limits.window_start < now() - interval '60 seconds'
          then 1 else public.rate_limits.count + 1 end,
        window_start = case
          when public.rate_limits.window_start < now() - interval '60 seconds'
          then now() else public.rate_limits.window_start end
  returning count into v_count;

  if v_count > 30 then
    raise exception 'RATE_LIMITED: too many reports submitted from your network right now; try again in a minute';
  end if;

  insert into public.community_reports (
    tracking_code, category, description, county, district, community,
    latitude, longitude, contact_phone
  ) values (
    p_tracking_code, p_category::report_category, p_description, p_county,
    p_district, p_community, p_latitude, p_longitude, p_contact_phone
  )
  returning id into v_id;

  insert into public.report_tracking (tracking_code, status)
  values (p_tracking_code, 'submitted')
  on conflict (tracking_code) do nothing;

  perform public.refresh_public_stats();
  return jsonb_build_object('id', v_id, 'trackingCode', p_tracking_code);
end;
$$;

-- 0002 grants EXECUTE by function signature; the signature is unchanged, but
-- re-grant explicitly so this migration is self-contained on databases that
-- never ran 0002's function grants.
grant execute on function
  public.submit_community_report(text, text, text, text, text, text, double precision, double precision, text)
  to anon, authenticated;

commit;
