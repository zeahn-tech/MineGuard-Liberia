-- ============================================================================
-- MINEGUARD LIBERIA — migration 0003: lock down public.profiles
--
-- Closes forensic re-audit §0.1 (docs/11): migration 0001 defined
--
--     create policy "profiles read" on public.profiles for select using (true);
--
-- with no role restriction. RLS policies with no role list apply to PUBLIC,
-- which includes the anonymous `anon` role — and 0002 grants SELECT on all
-- tables to anon. On a fresh 0001+0002 install, anyone holding the published
-- anon key (which ships in the client bundle by design) could read every
-- user's email, name, role, job_title, organization, county and
-- operator_name with no login. For a national oversight platform that is an
-- unacceptable personal-safety and data-governance exposure (Directive §7
-- least privilege, §15 data governance).
--
-- This migration, idempotently and atomically:
--   1. drops every historical profiles SELECT/INSERT/UPDATE policy variant
--      (the permissive 0001 names AND the already-hardened live names, so
--      both lineages converge on one policy set);
--   2. recreates the policy set exactly as the live deployment has run it
--      for weeks — self-or-admin SELECT, self INSERT, self-or-admin UPDATE,
--      all pinned `to authenticated` (an unauthenticated caller is rejected
--      at the role level before any qual is even evaluated);
--   3. revokes anon's direct table privileges on profiles entirely, so even a
--      future mis-authored permissive policy could not expose the directory
--      to anonymous callers.
--
-- Verified: see docs/11 §0.1 — anonymous REST probe returns [] (0 rows) for
-- profiles, and tests/rls.test.ts asserts the anon/authenticated/guest
-- boundaries against the live database.
--
-- App compatibility: backend.ts only ever reads profiles for the signed-in
-- user's own row (getProfile/getProfileCached, eq id = auth.uid()) or, as an
-- admin, the full list (users.listUsers, behind requireAdminUser()). The
-- live deployment has run with exactly this policy set throughout.
-- ============================================================================

begin;

-- 1. Remove every historical variant (no-op when absent).
drop policy if exists "profiles read" on public.profiles;              -- 0001 (defect)
drop policy if exists "profiles self insert" on public.profiles;       -- 0001
drop policy if exists "profiles self update" on public.profiles;       -- 0001
drop policy if exists "profiles insert self" on public.profiles;       -- live
drop policy if exists "profiles select self or admin" on public.profiles; -- live
drop policy if exists "profiles update self or admin" on public.profiles; -- live

-- 2. Canonical policy set (matches the live deployment).
create policy "profiles select self or admin" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.mg_is_admin());

create policy "profiles insert self" on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

create policy "profiles update self or admin" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.mg_is_admin())
  with check (id = auth.uid() or public.mg_is_admin());

-- 3. No direct table privileges for the anonymous role on the user
--    directory. (meta + report_tracking stay world-readable — they are the
--    only tables the signed-out landing/tracking pages touch.)
revoke all on public.profiles from anon;

commit;
