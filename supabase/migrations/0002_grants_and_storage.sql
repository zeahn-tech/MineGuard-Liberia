-- ============================================================================
-- MINEGUARD LIBERIA — migration 0002: privilege grants + storage policies
--
-- Why this exists: migration 0001 was applied to the live project (tables,
-- functions, triggers, RLS policies are all present), but it was executed by a
-- role WITHOUT Supabase's default privilege wiring, so none of the standard
-- `GRANT ... TO anon, authenticated` statements ran. Every REST/Realtime
-- request from the app fails with 42501 "permission denied for table …".
--
-- This migration grants exactly the privileges Supabase would have granted by
-- default:
--   * anon + authenticated: SELECT/INSERT/UPDATE/DELETE on public tables
--     (Row Level Security remains the true boundary — a grant without a
--     matching RLS policy still returns zero rows / rejects writes).
--   * anon + authenticated: USAGE on the public schema and on every sequence.
--   * EXECUTE on the public RPCs per 0001's grant/revoke table.
--   * The private `evidence` storage bucket + its storage.objects policies
--     (0001's storage section never reached the live project either).
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ------------------------------------------------------------------- schemas
grant usage on schema public to anon, authenticated;

-- -------------------------------------------------------------------- tables
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- ----------------------------------------------------------------- sequences
grant usage, select on all sequences in schema public to anon, authenticated;

-- ----------------------------------------------------------------- functions
-- Match 0001's intended execute surface.
grant execute on function public.complete_staff_profile(text, text, text, text, text) to authenticated;
grant execute on function public.provision_user_by_email(text, public.user_role, text, text, text) to authenticated;
grant execute on function public.submit_community_report(text, public.report_category, text, text, text, text, double precision, double precision, text) to anon, authenticated;
grant execute on function public.triage_community_report(uuid, public.report_status, text) to authenticated;
grant execute on function public.refresh_public_stats() to anon, authenticated;
grant execute on function public.evidence_for_parent(public.evidence_parent_type, uuid) to authenticated;
revoke execute on function public.provision_user_by_email(text, public.user_role, text, text, text) from anon;
revoke execute on function public.triage_community_report(uuid, public.report_status, text) from anon;

-- Defaults for future functions/tables created by later migrations:
alter default privileges in schema public grant execute on functions to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;

-- ============================================================================
-- STORAGE — private `evidence` bucket (25MB cap) + tenant-checked policies.
-- Mirrors 0001's storage section. Read requires either own-namespace upload
-- or a public.evidence metadata row the caller can select (RLS-checked join).
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('evidence', 'evidence', false, 26214400)
on conflict (id) do nothing;

-- Upload: authenticated users may create objects only inside their own
-- `{auth.uid()}/` namespace. The public.evidence insert later re-checks site
-- visibility against the caller's profile via RLS.
drop policy if exists "evidence upload own namespace" on storage.objects;
create policy "evidence upload own namespace" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Read: own namespace, or the object is referenced by an evidence metadata row
-- whose site the caller can access (re-derives role + tenant from profiles).
drop policy if exists "evidence storage read" on storage.objects;
create policy "evidence storage read" on storage.objects for select to authenticated
  using (
    bucket_id = 'evidence'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.evidence e
        where e.storage_path = name
          and public.mg_can_access_site(e.county, e.operator_name)
      )
    )
  );

-- No update/delete policies: evidence is append-only by design.
