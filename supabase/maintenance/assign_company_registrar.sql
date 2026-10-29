-- ===========================================================================
-- MINEGUARD LIBERIA — make an existing account a COMPANY REGISTRAR
--
-- Run in the Supabase SQL Editor AFTER migrations 0030 and 0031.
-- The person must have signed up first (that creates their profile row), and
-- must NOT already belong to a company (company staff cannot become registrars).
-- Edit the ONE email below. Safe to run twice; touches one account only.
--
-- A registrar can: register/approve companies, nominate the first company
-- administrator, suspend/deactivate/reactivate a company, see the company
-- directory. A registrar CANNOT see sites, incidents, inspections or audit
-- records, manage accounts, or see any company's workforce.
-- The person must SIGN OUT AND SIGN BACK IN afterwards.
-- ===========================================================================
with who as (
  select lower('chrisdestinymoorezeahn@gmail.com') as email   -- <-- EDIT THIS LINE ONLY
),
assigned as (
  update public.profiles p
     set role = 'registrar',
         scope = 'national',
         county = null,
         operator_name = null,
         organization_id = null,
         profile_complete = true
    from who
   where lower(p.email) = who.email
     and (p.role is null or p.role = 'registrar')          -- never convert staff, admins or company users
     and not exists (select 1 from public.organization_members m
                      where m.user_id = p.id and m.status in ('pending','active'))
  returning p.id, p.email, p.role, p.scope
)
select * from assigned;      -- zero rows = no such account, or the account already has another role/company
