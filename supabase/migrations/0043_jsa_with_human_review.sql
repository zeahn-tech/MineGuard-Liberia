-- ===========================================================================
-- MINEGUARD LIBERIA — migration 0043: Job Safety Analysis with mandatory human review
--                                      (Implementation Phase 3, capabilities A + C)
--
-- 1. ai_request_log accepts the two new capabilities (safety_guidance, jsa_suggestions).
-- 2. A JSA record + workflow, because the repository had none to attach AI drafting to.
--
-- JSA lifecycle: draft -> submitted -> approved | rejected  (rejected -> draft by the author).
--   * Prepared by an active member allowed at the site (mg_operator_site_ok).
--   * APPROVED only by a DIFFERENT person who is a company_admin, or a site_manager /
--     safety_officer assigned to that site, and who types the confirmation word APPROVE.
--     This is enforced here, twice: in the RPC and by a CHECK constraint, so no code path
--     (including a future one) can mark a JSA approved without a distinct reviewer.
--   * AI is not a principal. No function accepts "approved by AI"; `ai_assisted` is DERIVED
--     from the hazards (any with source 'ai_suggested') and cannot be set or cleared directly.
--   * Approval authorises nothing by itself: it records that a qualified person reviewed
--     the analysis. The task's permission to proceed remains the site's own process.
--   * The table holds no worker names: the preparer and reviewer are profile ids.
--   * The AI prompt (task text) is NEVER stored by the AI function; only what the person
--     chooses to save in the JSA is stored here.
--
-- Client writes are closed; every change is a self-authorizing RPC. Idempotent.
-- ROLLBACK: docs/08_AI_GOVERNANCE.MD (Phase 3, section "Rollback").
-- ===========================================================================

begin;

-- 1. request-log capability list -------------------------------------------------------------
alter table public.ai_request_log drop constraint if exists ai_request_log_capability_check;
alter table public.ai_request_log
  add constraint ai_request_log_capability_check check (capability in (
    'nl_search', 'site_summary', 'trend_notes',
    'inspection_priorities', 'executive_briefing',
    'document_analysis',
    'incident_trend_summary', 'risk_patterns',
    'safety_guidance', 'jsa_suggestions'));

-- 2. permission: Ministry staff may read JSAs in their scope ----------------------------------
insert into public.permissions (role, permission) values
  ('admin', 'jsa.read'), ('supervisor', 'jsa.read'), ('inspector', 'jsa.read')
on conflict (role, permission) do nothing;

-- 3. table ---------------------------------------------------------------------------------------
create table if not exists public.job_safety_analyses (
  id               uuid primary key default gen_random_uuid(),
  site_id          uuid not null references public.sites(id),
  prepared_by      uuid not null references public.profiles(id),
  task_description text not null check (char_length(task_description) between 10 and 500),
  location_area   text check (location_area is null or char_length(location_area) <= 120),
  job_date         date not null,
  hazards          jsonb not null default '[]'::jsonb
                   check (jsonb_typeof(hazards) = 'array' and jsonb_array_length(hazards) <= 20),
  ppe              jsonb not null default '[]'::jsonb
                   check (jsonb_typeof(ppe) = 'array' and jsonb_array_length(ppe) <= 30),
  ai_assisted      boolean not null default false,
  status           text not null default 'draft'
                   check (status in ('draft','submitted','approved','rejected')),
  idempotency_key  text not null check (char_length(idempotency_key) between 8 and 80),
  submitted_at     timestamptz,
  reviewed_by      uuid references public.profiles(id),
  reviewed_at      timestamptz,
  review_note      text check (review_note is null or char_length(review_note) <= 1000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz,
  updated_by       uuid,
  row_version      integer not null default 1,
  unique (prepared_by, idempotency_key),
  -- THE human-review invariant: approval needs a reviewer who is not the preparer.
  constraint jsa_approval_needs_distinct_reviewer check (
    status <> 'approved'
    or (reviewed_by is not null and reviewed_at is not null and reviewed_by <> prepared_by)),
  constraint jsa_rejection_needs_reviewer check (
    status <> 'rejected' or (reviewed_by is not null and reviewed_at is not null))
);
create index if not exists jsa_site_status_idx on public.job_safety_analyses (site_id, status);

alter table public.job_safety_analyses enable row level security;
revoke all on public.job_safety_analyses from anon, authenticated;

-- 4. guard: legal transitions only; submitted/approved content is frozen -------------------------
create or replace function public.mg_jsa_guard()
returns trigger language plpgsql as $mg$
begin
  if tg_op = 'DELETE' then raise exception 'IMMUTABLE: JSAs are never deleted'; end if;
  if old.status = 'approved' then raise exception 'IMMUTABLE: an approved JSA cannot be changed; prepare a new one'; end if;
  if old.status = 'submitted' and new.status = 'submitted' then raise exception 'IMMUTABLE: a submitted JSA is awaiting review and cannot be edited'; end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft'     and new.status = 'submitted') or
       (old.status = 'submitted' and new.status in ('approved','rejected')) or
       (old.status = 'rejected'  and new.status = 'draft')) then
    raise exception 'CONFLICT: illegal JSA transition % -> %', old.status, new.status;
  end if;
  if new.site_id is distinct from old.site_id or new.prepared_by is distinct from old.prepared_by then
    raise exception 'IMMUTABLE: site and preparer cannot change';
  end if;
  return new;
end;
$mg$;
revoke all on function public.mg_jsa_guard() from public, anon, authenticated;
drop trigger if exists job_safety_analyses_guard on public.job_safety_analyses;
create trigger job_safety_analyses_guard before update or delete on public.job_safety_analyses
  for each row execute function public.mg_jsa_guard();

drop trigger if exists job_safety_analyses_touch on public.job_safety_analyses;
create trigger job_safety_analyses_touch before insert or update on public.job_safety_analyses
  for each row execute function public.mg_touch_row();
drop trigger if exists job_safety_analyses_audit on public.job_safety_analyses;
create trigger job_safety_analyses_audit after insert or update on public.job_safety_analyses
  for each row execute function public.mg_audit_row();

-- 5. predicates ----------------------------------------------------------------------------------
create or replace function public.mg_can_prepare_jsa(p_site_id uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null and exists (
    select 1 from public.sites s
      join public.organizations o on o.id = s.organization_id and o.status = 'approved'
     where s.id = p_site_id
       and public.mg_operator_site_ok(auth.uid(), s.id, s.organization_id))
$mg$;

create or replace function public.mg_can_review_jsa(p_site_id uuid)
returns boolean language sql stable security definer set search_path = public as $mg$
  select auth.uid() is not null and exists (
    select 1
      from public.sites s
      join public.organization_members m on m.organization_id = s.organization_id
      join public.organizations o on o.id = m.organization_id
     where s.id = p_site_id
       and m.user_id = auth.uid() and m.status = 'active' and o.status = 'approved'
       and (m.org_role = 'company_admin'
            or (m.org_role in ('site_manager','safety_officer')
                and exists (select 1 from public.site_assignments sa
                             where sa.user_id = m.user_id and sa.site_id = s.id and sa.revoked_at is null))))
$mg$;

drop policy if exists "jsa read" on public.job_safety_analyses;
create policy "jsa read" on public.job_safety_analyses for select to authenticated using (
  prepared_by = auth.uid()
  or public.mg_can_review_jsa(site_id)
  or (public.mg_has_permission('jsa.read') and exists (
        select 1 from public.sites s
         where s.id = site_id
           and public.mg_can_access_site_row(s.id, s.county, s.district, s.operator_name, s.organization_id))));
grant select on public.job_safety_analyses to authenticated;

-- 6. hazard validation ---------------------------------------------------------------------------
create or replace function public.mg_jsa_validate(p_hazards jsonb, p_ppe jsonb)
returns void language plpgsql immutable as $mg$
declare h jsonb; p jsonb;
begin
  if p_hazards is null or jsonb_typeof(p_hazards) <> 'array' or jsonb_array_length(p_hazards) > 20 then
    raise exception 'INVALID: hazards must be a list of at most 20 items';
  end if;
  for h in select * from jsonb_array_elements(p_hazards) loop
    if jsonb_typeof(h) <> 'object'
       or coalesce(char_length(btrim(h->>'hazard')), 0) not between 1 and 200
       or (h->>'risk_level') is null or (h->>'risk_level') not in ('low','medium','high','critical')
       or coalesce(char_length(btrim(h->>'control')), 0) not between 1 and 600
       or (h ? 'consequence' and char_length(coalesce(h->>'consequence','')) > 400)
       or (h ? 'source' and (h->>'source') not in ('person','ai_suggested')) then
      raise exception 'INVALID: each hazard needs hazard text, a risk level (low/medium/high/critical) and a control measure';
    end if;
  end loop;
  if p_ppe is null or jsonb_typeof(p_ppe) <> 'array' or jsonb_array_length(p_ppe) > 30 then
    raise exception 'INVALID: ppe must be a list of at most 30 items';
  end if;
  for p in select * from jsonb_array_elements(p_ppe) loop
    if jsonb_typeof(p) <> 'string' or char_length(p #>> '{}') not between 1 and 80 then
      raise exception 'INVALID: ppe entries must be short text';
    end if;
  end loop;
end;
$mg$;

-- 7. RPC: save draft ---------------------------------------------------------------------------
create or replace function public.mg_jsa_save(
  p_site_id uuid, p_task text, p_job_date date, p_hazards jsonb, p_ppe jsonb,
  p_idempotency_key text, p_location text default null, p_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $mg$
declare v_row public.job_safety_analyses; v_ai boolean;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  perform public.mg_jsa_validate(p_hazards, p_ppe);
  v_ai := exists (select 1 from jsonb_array_elements(p_hazards) h where h->>'source' = 'ai_suggested');
  if p_id is null then
    if not public.mg_can_prepare_jsa(p_site_id) then
      raise exception 'FORBIDDEN: you are not allowed to prepare JSAs for this site';
    end if;
    select * into v_row from public.job_safety_analyses where prepared_by = auth.uid() and idempotency_key = p_idempotency_key;
    if found then return v_row.id; end if;
    insert into public.job_safety_analyses (site_id, prepared_by, task_description, location_area, job_date, hazards, ppe, ai_assisted, idempotency_key)
    values (p_site_id, auth.uid(), btrim(p_task), nullif(btrim(p_location),''), p_job_date, p_hazards, p_ppe, v_ai, p_idempotency_key)
    returning * into v_row;
    return v_row.id;
  end if;
  select * into v_row from public.job_safety_analyses where id = p_id for update;
  if not found or v_row.prepared_by <> auth.uid() or not public.mg_can_prepare_jsa(v_row.site_id) then
    raise exception 'FORBIDDEN: you cannot edit this JSA';
  end if;
  if v_row.status not in ('draft','rejected') then raise exception 'CONFLICT: only a draft or rejected JSA can be edited'; end if;
  update public.job_safety_analyses set
      task_description = btrim(p_task), location_area = nullif(btrim(p_location),''), job_date = p_job_date,
      hazards = p_hazards, ppe = p_ppe, ai_assisted = v_ai,
      status = 'draft', reviewed_by = null, reviewed_at = null, review_note = null
   where id = p_id;
  return p_id;
end;
$mg$;

-- 8. RPC: submit for review ------------------------------------------------------------------------
create or replace function public.mg_jsa_submit(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_row public.job_safety_analyses;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  select * into v_row from public.job_safety_analyses where id = p_id for update;
  if not found or v_row.prepared_by <> auth.uid() or not public.mg_can_prepare_jsa(v_row.site_id) then
    raise exception 'FORBIDDEN: you cannot submit this JSA';
  end if;
  if v_row.status <> 'draft' then raise exception 'CONFLICT: only a draft can be submitted'; end if;
  if jsonb_array_length(v_row.hazards) = 0 then raise exception 'INVALID: add at least one hazard with a control measure before submitting'; end if;
  update public.job_safety_analyses set status = 'submitted', submitted_at = now() where id = p_id
    returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'ai_assisted', v_row.ai_assisted);
end;
$mg$;

-- 9. RPC: review (approve / reject) ---------------------------------------------------------------
create or replace function public.mg_jsa_review(p_id uuid, p_decision text, p_confirm text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $mg$
declare v_row public.job_safety_analyses;
begin
  if auth.uid() is null then raise exception 'UNAUTHENTICATED: sign in required'; end if;
  select * into v_row from public.job_safety_analyses where id = p_id for update;
  if not found or not public.mg_can_review_jsa(v_row.site_id) then
    raise exception 'FORBIDDEN: you are not authorized to review this JSA';
  end if;
  if v_row.prepared_by = auth.uid() then
    raise exception 'FORBIDDEN: a JSA cannot be reviewed by the person who prepared it';
  end if;
  if v_row.status <> 'submitted' then raise exception 'CONFLICT: only a submitted JSA can be reviewed'; end if;
  if p_decision = 'approve' then
    if p_confirm is distinct from 'APPROVE' then raise exception 'CONFIRMATION_REQUIRED: type APPROVE to confirm you reviewed this JSA'; end if;
  elsif p_decision = 'reject' then
    if p_confirm is distinct from 'REJECT' then raise exception 'CONFIRMATION_REQUIRED: type REJECT to confirm'; end if;
    if nullif(btrim(p_note),'') is null then raise exception 'NOTE_REQUIRED: say what must change'; end if;
  else
    raise exception 'INVALID: decision must be approve or reject';
  end if;
  update public.job_safety_analyses set
      status = case p_decision when 'approve' then 'approved' else 'rejected' end,
      reviewed_by = auth.uid(), reviewed_at = now(), review_note = nullif(btrim(p_note),'')
   where id = p_id returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$mg$;

-- 10. sites the caller may prepare a JSA for (for the app's site picker; the RPCs re-check) -----
create or replace function public.mg_jsa_sites()
returns table (id uuid, name text, code text)
language sql stable security definer set search_path = public as $mg$
  select s.id, s.name, s.code from public.sites s
   where public.mg_can_prepare_jsa(s.id)
   order by s.name
$mg$;

do $$
declare f text;
begin
  foreach f in array array[
    'mg_can_prepare_jsa(uuid)', 'mg_can_review_jsa(uuid)',
    'mg_jsa_save(uuid,text,date,jsonb,jsonb,text,text,uuid)', 'mg_jsa_submit(uuid)',
    'mg_jsa_review(uuid,text,text,text)', 'mg_jsa_sites()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- the predicate used inside the RLS policy and validation helper must stay callable by the policy
  revoke all on function public.mg_jsa_validate(jsonb, jsonb) from public, anon, authenticated;
end $$;

commit;
