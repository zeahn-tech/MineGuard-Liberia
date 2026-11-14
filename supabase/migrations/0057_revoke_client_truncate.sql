-- ============================================================================
-- MINEGUARD LIBERIA — migration 0057: client roles never need TRUNCATE
--
-- Production grants TRUNCATE to the authenticated role on 21 tables, including
-- audit_log, sites, profiles and permissions (found by the read-only grants probe).
-- TRUNCATE is not subject to row-level security and the REST API does not expose it,
-- so this is a least-privilege fix, not a closed hole. Idempotent; touches no data.
-- ============================================================================

begin;

revoke truncate on all tables in schema public from anon, authenticated;

commit;
