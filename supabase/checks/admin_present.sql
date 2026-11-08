-- ===========================================================================
-- READ-ONLY CHECK: does the platform have an active administrator?
-- Run in the Supabase SQL editor against the project the app really uses.
-- Since migration 0047 there is NO self-service first-administrator path, so a
-- database with zero administrators (fresh install, restored backup) has nobody who
-- can manage roles until the project owner runs supabase/maintenance/promote_to_admin.sql.
-- Run this BEFORE applying 0047 to production and after any restore.
-- ===========================================================================
select count(*) filter (where role = 'admin' and deleted_at is null) as active_admins,
       case when count(*) filter (where role = 'admin' and deleted_at is null) = 0
            then 'NO ADMINISTRATOR - run supabase/maintenance/promote_to_admin.sql as the project owner'
            else 'ok' end as status
  from public.profiles;
