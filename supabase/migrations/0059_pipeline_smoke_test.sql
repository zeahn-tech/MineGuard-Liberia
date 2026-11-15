-- ============================================================================
-- MINEGUARD LIBERIA — migration 0059: pipeline smoke test (harmless, idempotent)
--
-- Purpose: prove the approval-gated migration pipeline end to end (validate -> plan -> approval -> apply ->
-- posture check -> history recorded). The only effect is a comment on the public schema, which names where
-- migrations are deployed from. No tables, policies, functions or data are touched.
-- ============================================================================

begin;

comment on schema public is 'MineGuard Liberia application schema. Migrations are deployed only by .github/workflows/db-migrate.yml (approval-gated).';

commit;
