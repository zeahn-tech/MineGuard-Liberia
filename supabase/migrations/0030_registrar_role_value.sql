-- ============================================================================
-- MINEGUARD LIBERIA — migration 0030: the `registrar` role value
--
-- Adds ONE enum value. It is a migration of its own on purpose: PostgreSQL
-- cannot USE a new enum value in the same transaction that adds it, so the rules
-- that reference 'registrar' live in 0031 (run it AFTER this one).
-- Idempotent. Rollback: not needed for a harmless unused value (PostgreSQL cannot
-- drop an enum value); remove the role by clearing profiles.role = 'registrar'.
-- ============================================================================
alter type public.user_role add value if not exists 'registrar';
