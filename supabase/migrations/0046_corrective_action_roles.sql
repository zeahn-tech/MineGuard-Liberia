-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0046: who may answer a corrective action
--
-- DEFECTS (confirmed against the migrated schema):
--  1. Any company account with operator access could answer a corrective
--     action — company administrators, workers and onboarding officers
--     included. Responding is a compliance act and belongs to the people who
--     run the site's safety: site managers and safety officers.
--  2. The reviewer guard (mg_guard_ca_update) only let an operator move an
--     action from 'open' to 'submitted'. Actions the reviewing authority had
--     moved to 'in_progress' showed a Respond button in the app but every
--     response was refused by the database.
--
-- FIX: a single database rule, mg_can_work_corrective_actions() — an ACTIVE
-- member of an APPROVED company whose role is site_manager or safety_officer —
-- now gates the operator branch of both the UPDATE policy and the guard, and
-- the guard accepts open OR in_progress as the starting state. Reviewers
-- (admin, supervisor) are unchanged. Per-site scoping is unchanged
-- (mg_can_access_site still decides WHICH sites). No rows are touched.
-- Idempotent. Run in a transaction.
-- ===========================================================================
begin;

create or replace function public.mg_can_work_corrective_actions()
returns boolean
language sql stable security definer set search_path = public
as $mg$
  select
    -- a company member: only an ACTIVE site manager / safety officer of an APPROVED company
    exists (
      select 1
        from public.organization_members m
        join public.organizations o on o.id = m.organization_id
       where m.user_id = auth.uid()
         and m.status = 'active'
         and o.status = 'approved'
         and m.org_role in ('site_manager', 'safety_officer')
    )
    -- a legacy single-account operator that predates company roles has NO membership
    -- row at all and is the company itself; anyone who has ever held a membership
    -- (even a revoked or pending one) is judged by it and never falls through here.
    or (
      auth.uid() is not null
      and not exists (select 1 from public.organization_members m where m.user_id = auth.uid())
    )
$mg$;
revoke all on function public.mg_can_work_corrective_actions() from public, anon;
grant execute on function public.mg_can_work_corrective_actions() to authenticated;

create or replace function public.mg_guard_ca_update()
returns trigger
language plpgsql
security definer set search_path = public
as $mg$
begin
  if public.mg_is_reviewer() then return new; end if;
  if (select role from public.mg_profile()) = 'operator'
     and public.mg_can_work_corrective_actions()
     and new.operator_note is distinct from old.operator_note
     and new.status = 'submitted'
     and old.status in ('open', 'in_progress') then
    return new;
  end if;
  raise exception 'FORBIDDEN: corrective action decision requires a reviewer';
end;
$mg$;

drop policy if exists "corrective actions update" on public.corrective_actions;
create policy "corrective actions update" on public.corrective_actions
  for update
  using (
    (public.mg_is_reviewer()
      or (public.mg_role() = 'operator' and public.mg_can_work_corrective_actions()))
    and public.mg_can_access_site(site_id)
  )
  with check (
    (public.mg_is_reviewer()
      or (public.mg_role() = 'operator' and public.mg_can_work_corrective_actions()))
    and public.mg_can_access_site(site_id)
  );

commit;
