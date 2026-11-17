-- ============================================================================
-- MINEGUARD LIBERIA — migration 0061: finish the constraints production still carried half-done (forward-only)
--
-- WHY. After 0060 the staging rehearsal's fingerprint showed three remaining differences to the repo's design, all in constraints:
--   * community_reports_len_chk exists in production as NOT VALID (never checked against existing rows). 0 rows violate it.
--   * rate_limits.window_start is nullable in production; the repo defines it NOT NULL. 0 rows are null.
--   * audit_log_actor_id_fkey (actor_id -> profiles.id) is absent. The repo's account-deletion functions
--     (0035, 0039, 0050) set actor_id = NULL on that user's audit rows BEFORE removing the account, so no dangling id is ever
--     left; production has 4 audit rows (3 accounts) whose actor no longer exists, left by deletions made some other way.
--
-- WHAT. (1) validates the length constraint; (2) makes window_start NOT NULL; (3) detaches the orphaned actor ids exactly as
-- the deletion functions do (the row and its actor_label text are kept) and then adds the foreign key so a dangling actor
-- cannot be created again. If any row violates (1), (2) or (3) the statement fails and the whole migration rolls back.
--
-- SAFETY. One transaction. Idempotent on a database built from the repo (validating/setting again is a no-op; the foreign key is
-- dropped and recreated). supabase/maintenance/capture_pre_apply.sql records the orphaned audit rows' ids before this runs.
--
-- DELIBERATELY STILL NOT CHANGED: community_reports_description_check (legacy minimum of 10 characters; a stricter input rule than
-- the repo's), the harmless extra columns, "meta select public" and the admin-seed policies (see the 0060 header and
-- supabase/checks/accepted-drift.json).
-- ============================================================================

begin;

alter table public.community_reports validate constraint community_reports_len_chk;

alter table public.rate_limits alter column window_start set not null;

update public.audit_log a
   set actor_id = null
 where a.actor_id is not null
   and not exists (select 1 from public.profiles p where p.id = a.actor_id);

alter table public.audit_log drop constraint if exists audit_log_actor_id_fkey;
alter table public.audit_log
  add constraint audit_log_actor_id_fkey foreign key (actor_id) references public.profiles(id);

commit;
