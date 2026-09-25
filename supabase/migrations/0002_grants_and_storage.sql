-- ============================================================================
-- MINEGUARD LIBERIA — migration 0002: privilege grants + storage policies
--
-- CORRECTED 2026-09-25 (forensic re-audit §0.2). The original version of this
-- file referenced types and function signatures that do not exist in
-- 0001_initial_schema.sql (`public.report_status`, `public.evidence_parent_type`,
-- enum-typed params on provision_user_by_email/submit_community_report, and a
-- two-argument `mg_can_access_site(county, operator)` in the storage read
-- policy). Run top-to-bottom, Postgres would have halted at the first bad
-- GRANT, silently skipping the storage section below it — the very section
-- this migration exists to deliver. Every statement in this file has been
-- re-checked against 0001's actual definitions and is asserted mechanically
-- by tests/migration-consistency.test.ts.
--
-- Why this exists: migration 0001 creates tables, functions, triggers and RLS
-- policies but contains NO grants at all. On a project where Supabase's
-- default privilege wiring is absent, every REST/Realtime request from the
-- app fails with 42501 "permission denied for table …". This migration
-- grants exactly the privileges the app needs:
--   * anon + authenticated: SELECT/INSERT/UPDATE/DELETE on public tables
--     (Row Level Security remains the true boundary — a grant without a
--     matching RLS policy still returns zero rows / rejects writes).
--   * anon + authenticated: USAGE on the public schema, every sequence, and
--     EXECUTE on every function (RLS policy expressions such as
--     mg_can_access_site() execute AS THE CALLING ROLE, so without this the
--     policies themselves error out with 42501).
--   * EXECUTE on the admin-only RPCs is then revoked from anon.
--   * The private `evidence` storage bucket (25MB cap) + its storage.objects
--     policies, matching 0001's storage section exactly (0001's tail may not
--     have reached an already-provisioned database).
--
-- ATOMIC: the whole file runs in one transaction. A failure anywhere rolls
-- everything back — no more silent partial application.
--
-- Idempotent: safe to run more than once (drop-if-exists before every policy).
--
-- LINEAGE NOTE: this file, like 0001, describes the *repository* schema
-- lineage. The currently-live project was provisioned from an earlier,
-- divergent schema (enum-typed RPC params, mg_can_access_site(county,
-- operator)); see docs/11_IMPLEMENTATION_STATUS.MD before running this file
-- against an existing deployment.
-- ============================================================================

begin;

-- ------------------------------------------------------------------- schemas
grant usage on schema public to anon, authenticated;

-- -------------------------------------------------------------------- tables
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- ----------------------------------------------------------------- sequences
grant usage, select on all sequences in schema public to anon, authenticated;

-- ----------------------------------------------------------------- functions
-- RLS policy expressions (mg_is_admin, mg_can_access_site, mg_profile, …) run
-- as the calling role and therefore need EXECUTE. Grant the whole surface,
-- then revoke the privileged RPCs from the anonymous role.
grant execute on all functions in schema public to anon, authenticated;

-- Documented RPC surface, granted explicitly with 0001's exact signatures so
-- the intended execute surface is auditable statement-by-statement:
grant execute on function public.complete_staff_profile(text, text, text, text, text) to authenticated;
grant execute on function public.provision_user_by_email(text, text, text, text, text) to authenticated;
grant execute on function public.submit_community_report(text, text, text, text, text, text, double precision, double precision, text) to anon, authenticated;
grant execute on function public.triage_community_report(uuid, text, text) to authenticated;
grant execute on function public.refresh_public_stats() to anon, authenticated;
grant execute on function public.evidence_for_parent(text, uuid) to authenticated;

-- Privileged RPCs must never be callable without a session. (They also
-- re-check mg_is_admin()/mg_is_staff() internally — belt and braces.)
revoke execute on function public.provision_user_by_email(text, text, text, text, text) from anon;
revoke execute on function public.triage_community_report(uuid, text, text) from anon;
revoke execute on function public.complete_staff_profile(text, text, text, text, text) from anon;
revoke execute on function public.handle_new_user() from anon, authenticated;

-- Defaults for future functions/tables created by later migrations:
alter default privileges in schema public grant execute on functions to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;

-- ============================================================================
-- STORAGE — private `evidence` bucket (25MB cap) + tenant-checked policies.
-- Mirrors 0001's storage section exactly. Upload requires the caller's own
-- {auth.uid()}/ namespace AND an assigned role; read requires an
-- evidence metadata row the caller can select (RLS-checked join); update is
-- allowed only inside the caller's own namespace (retry/overwrite path).
-- There is deliberately NO delete policy: evidence is never deleted.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('evidence', 'evidence', false, 26214400)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;

-- Drop both the 0001-named and the historical 0002-named variants so exactly
-- one policy per command survives (permissive policies are OR'd — a stale
-- leftover would silently weaken the new one).
drop policy if exists "evidence upload own folder" on storage.objects;
drop policy if exists "evidence upload own namespace" on storage.objects;
drop policy if exists "evidence read scoped" on storage.objects;
drop policy if exists "evidence storage read" on storage.objects;
drop policy if exists "evidence owner update" on storage.objects;

create policy "evidence upload own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and auth.role() = 'authenticated'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role is not null
    )
  );

create policy "evidence read scoped"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'evidence'
    and exists (
      select 1 from public.evidence e
      where e.storage_path = name
        and public.mg_can_access_site(e.site_id)
    )
  );

create policy "evidence owner update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;
