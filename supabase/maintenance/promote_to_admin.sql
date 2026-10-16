-- ===========================================================================
-- MINEGUARD LIBERIA — make an existing account a platform ADMINISTRATOR
--
-- Run it in the project the app really uses (the ref in src/lib/supabase.ts),
-- in the SQL Editor or with the runner:
--   SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts supabase/maintenance/promote_to_admin.sql
--
-- BEFORE YOU RUN IT
--   1. The person must have signed up / signed in to MineGuard at least once —
--      that is what creates their row in public.profiles. No row = nothing to
--      promote (the statement then returns ZERO rows and changes nothing).
--   2. Edit the ONE email address below.
--
-- WHAT IT DOES (the same fields the app's own "set role" action writes)
--   role              -> 'admin'     (public.mg_is_admin() is exactly role = 'admin')
--   scope             -> 'national'  (an admin is not limited to a county/operator)
--   county, operator_name -> cleared (an admin is not a tenant; clearing
--                       operator_name also removes an operator's organisation
--                       link, via the profiles_org trigger)
--   profile_complete  -> true        (skip the "complete your profile" step)
--
-- It touches one account only, matches the email ignoring case, is safe to run
-- twice, and the change is recorded in the audit trail like any other profile
-- change. The app reads the role when you sign in: SIGN OUT AND SIGN BACK IN.
--
-- NOTE: MineGuard keeps roles in public.profiles.role. A statement written for
-- another application's schema (e.g. "update public.users set system_role = …")
-- does nothing here — and may change an unrelated project if run there.
-- ===========================================================================
with who as (
  select lower('replace-with-email@example.org') as email   -- <-- EDIT THIS LINE ONLY
),
promoted as (
  update public.profiles p
     set role = 'admin',
         scope = 'national',
         county = null,
         operator_name = null,
         profile_complete = true
    from who
   where lower(p.email) = who.email
  returning p.id, p.email, p.role, p.scope, p.county, p.operator_name, p.profile_complete
)
select * from promoted;
