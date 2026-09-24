-- ============================================================================
-- MINEGUARD LIBERIA — SUPABASE SCHEMA (migration 0001)
-- National mining oversight platform. Postgres + RLS replaces the Firebase
-- Firestore/Storage security rules 1:1. Apply in the Supabase SQL Editor
-- (or via the Management API). Safe to re-run only on an empty database.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------- enums
create type public.user_role   as enum ('admin','supervisor','inspector','operator');
create type public.site_status as enum ('pending_verification','active','suspended','closed');
create type public.inspection_status as enum ('draft','submitted','under_review','approved','rejected');
create type public.severity    as enum ('low','medium','high','critical');
create type public.finding_status as enum ('open','acknowledged','resolved','verified');
create type public.ca_status   as enum ('open','in_progress','submitted','verified','closed','escalated');
create type public.incident_type as enum (
  'fatality','injury','near_miss','equipment_accident','vehicle_accident','fire',
  'structural_failure','chemical_exposure','environmental','other');
create type public.incident_status as enum ('reported','investigating','closed');
create type public.env_category as enum (
  'water_pollution','river_disturbance','river_diversion','deforestation',
  'soil_degradation','waste','tailings','chemical_handling','rehabilitation','land_impact');
create type public.verification as enum ('observed','measured','verified','unverified','alleged');
create type public.env_status   as enum ('open','monitoring','resolved');
create type public.report_category as enum (
  'suspected_illegal_mining','pollution','environmental_damage','safety_concern',
  'land_concern','unauthorized_activity');
create type public.report_status as enum ('submitted','under_review','verified','dismissed','referred');
create type public.evidence_kind as enum ('photo','video','audio','document');
create type public.evidence_parent_type as enum ('inspection','incident','observation');

-- ============================================================================
-- TABLES (mirror the former Firestore collections; _id -> id uuid pk)
-- ============================================================================

-- profiles: row id = auth.users.id (was /users/{uid})
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  role public.user_role,
  job_title text,
  organization text,
  scope text check (scope in ('national','county','site')),
  county text,
  operator_name text,
  profile_complete boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  operator_name text not null,
  mineral_type text,
  county text not null,
  district text,
  community text,
  status public.site_status not null default 'pending_verification',
  latitude double precision,
  longitude double precision,
  notes text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index sites_county_idx   on public.sites(county);
create index sites_operator_idx on public.sites(operator_name);

create table public.inspection_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  active boolean not null default true,
  sections jsonb not null default '[]'::jsonb,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.inspections (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id),
  template_id uuid not null references public.inspection_templates(id),
  inspector_id uuid not null references public.profiles(id),
  status public.inspection_status not null default 'draft',
  answers jsonb,
  notes text,
  latitude double precision,
  longitude double precision,
  gps_accuracy_m double precision,
  client_ref text unique,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewer_id uuid references public.profiles(id),
  review_note text,
  -- denormalized scope stamp (set by trigger from the site)
  county text not null default 'Unknown',
  operator_name text not null default 'Unknown',
  created_at timestamptz not null default now()
);
create index inspections_site_idx     on public.inspections(site_id);
create index inspections_inspector_idx on public.inspections(inspector_id);
create index inspections_county_idx   on public.inspections(county);
create index inspections_operator_idx on public.inspections(operator_name);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.inspections(id),
  site_id uuid not null references public.sites(id),
  title text not null,
  description text,
  severity public.severity not null,
  status public.finding_status not null default 'open',
  created_by_id uuid not null references public.profiles(id),
  county text not null default 'Unknown',
  operator_name text not null default 'Unknown',
  created_at timestamptz not null default now()
);
create index findings_site_idx on public.findings(site_id);
create index findings_inspection_idx on public.findings(inspection_id);
create index findings_county_idx on public.findings(county);
create index findings_operator_idx on public.findings(operator_name);

create table public.corrective_actions (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings(id),
  site_id uuid not null references public.sites(id),
  description text not null,
  status public.ca_status not null default 'open',
  due_at timestamptz not null,
  opened_by_id uuid not null references public.profiles(id),
  operator_note text,
  verified_by_id uuid references public.profiles(id),
  closed_at timestamptz,
  county text not null default 'Unknown',
  operator_name text not null default 'Unknown',
  created_at timestamptz not null default now()
);
create index ca_site_idx on public.corrective_actions(site_id);
create index ca_finding_idx on public.corrective_actions(finding_id);
create index ca_county_idx on public.corrective_actions(county);
create index ca_operator_idx on public.corrective_actions(operator_name);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id),
  type public.incident_type not null,
  severity public.severity not null,
  description text not null,
  occurred_at timestamptz not null,
  fatalities integer,
  injured integer,
  status public.incident_status not null default 'reported',
  reported_by_id uuid not null references public.profiles(id),
  report_source text not null check (report_source in ('inspector','operator')),
  client_ref text unique,
  county text not null default 'Unknown',
  operator_name text not null default 'Unknown',
  created_at timestamptz not null default now()
);
create index incidents_site_idx on public.incidents(site_id);
create index incidents_county_idx on public.incidents(county);
create index incidents_operator_idx on public.incidents(operator_name);

create table public.environmental_observations (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites(id),
  category public.env_category not null,
  verification public.verification not null,
  description text not null,
  observed_at timestamptz not null,
  latitude double precision,
  longitude double precision,
  status public.env_status not null default 'open',
  reported_by_id uuid not null references public.profiles(id),
  client_ref text unique,
  county text not null default 'Unknown',
  operator_name text not null default 'Unknown',
  created_at timestamptz not null default now()
);
create index obs_site_idx on public.environmental_observations(site_id);
create index obs_county_idx on public.environmental_observations(county);
create index obs_operator_idx on public.environmental_observations(operator_name);

create table public.evidence (
  id uuid primary key,
  storage_path text not null unique,
  parent_type public.evidence_parent_type not null,
  parent_id uuid not null,
  site_id uuid not null references public.sites(id),
  kind public.evidence_kind not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes <= 26214400),
  caption text,
  captured_at timestamptz,
  uploaded_by_id uuid not null references public.profiles(id),
  county text not null default 'Unknown',
  operator_name text not null default 'Unknown',
  created_at timestamptz not null default now()
);
create index evidence_parent_idx on public.evidence(parent_type, parent_id);
create index evidence_site_idx on public.evidence(site_id);

create table public.community_reports (
  id uuid primary key default gen_random_uuid(),
  tracking_code text not null unique,
  category public.report_category not null,
  description text not null check (char_length(description) between 10 and 4000),
  county text not null,
  district text,
  community text,
  latitude double precision,
  longitude double precision,
  contact_phone text,
  status public.report_status not null default 'submitted',
  rate_bucket text,
  triage_note text,
  reviewed_by_id uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index reports_county_idx on public.community_reports(county);
create index reports_created_idx on public.community_reports(created_at desc);

create table public.report_tracking (
  tracking_code text primary key,
  status text not null,
  created_at timestamptz not null default now()
);

create table public.meta (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_label text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  summary text not null,
  created_at timestamptz not null default now()
);
create index audit_created_idx on public.audit_log(created_at desc);

create table public.rate_limits (
  bucket text primary key,
  count integer not null,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- AUTH HELPERS (mirror src/lib/types.ts scopeConstraintForUser / canAccessSite)
-- ============================================================================

create or replace function public.mg_profile()
returns public.profiles
language sql stable security definer set search_path = public as $$
  select * from public.profiles where id = auth.uid();
$$;

create or replace function public.mg_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.mg_profile();
$$;

create or replace function public.mg_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.mg_profile()), false);
$$;

create or replace function public.mg_is_reviewer() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','supervisor') from public.mg_profile()), false);
$$;

create or replace function public.mg_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin','supervisor','inspector') from public.mg_profile()), false);
$$;

create or replace function public.mg_is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'operator' from public.mg_profile()), false);
$$;

-- The single source of truth for per-user site visibility. County-scoped
-- staff see only their county; operators only their organization; admins and
-- national staff see everything; unassigned accounts see nothing.
create or replace function public.mg_can_access_site(p_county text, p_operator text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when p.role = 'admin' then true
      when p.role = 'operator' then p.operator_name is not null and p.operator_name = p_operator
      when p.role in ('supervisor','inspector') then
        (p.scope = 'national')
        or (p.scope = 'county' and p.county is not null and p.county = p_county)
      else false
    end
    from public.mg_profile() p
  ), false);
$$;

-- Community reports are staff-readable; county staff triage only their county.
create or replace function public.mg_can_read_county_rows(p_county text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when p.role = 'admin' then true
      when p.role in ('supervisor','inspector') then
        (p.scope = 'national') or (p.scope = 'county' and p.county = p_county)
      else false
    end
    from public.mg_profile() p
  ), false);
$$;

-- ---------------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------------

-- Auto-create a profile row for every new auth user (belt-and-suspenders —
-- the client also ensures it after sign-in).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data->>'name')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Stamp denormalized county/operator_name from the site on every site-scoped
-- record. This is what makes rules-level list scoping possible (doc 04 gap 5).
create or replace function public.mg_stamp_site()
returns trigger
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select county, operator_name into s from public.sites where id = new.site_id;
  new.county := coalesce(s.county, 'Unknown');
  new.operator_name := coalesce(s.operator_name, 'Unknown');
  return new;
end $$;

create trigger stamp_site_inspections before insert on public.inspections
for each row execute function public.mg_stamp_site();
create trigger stamp_site_findings before insert on public.findings
for each row execute function public.mg_stamp_site();
create trigger stamp_site_cas before insert on public.corrective_actions
for each row execute function public.mg_stamp_site();
create trigger stamp_site_incidents before insert on public.incidents
for each row execute function public.mg_stamp_site();
create trigger stamp_site_obs before insert on public.environmental_observations
for each row execute function public.mg_stamp_site();
create trigger stamp_site_evidence before insert on public.evidence
for each row execute function public.mg_stamp_site();

-- profiles guard: users may edit their own non-privileged fields; role/scope
-- changes require an admin, except the one-time first-admin bootstrap.
create or replace function public.mg_guard_profile_update()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_user <> 'authenticated' then
    return new; -- security definer functions / service role
  end if;

  if auth.uid() is null or auth.uid() <> new.id then
    if not public.mg_is_admin() then
      raise exception 'FORBIDDEN';
    end if;
    return new; -- admin provisioning another user
  end if;

  if new.role is distinct from old.role
     or new.scope is distinct from old.scope
     or new.county is distinct from old.county
     or new.operator_name is distinct from old.operator_name
     or new.email is distinct from old.email then
    -- first-run bootstrap: no staff exists yet, first profile claims admin
    if new.role = 'admin' and old.role is null
       and not exists (select 1 from public.profiles where role is not null) then
      return new;
    end if;
    raise exception 'FORBIDDEN_ROLE_CHANGE';
  end if;
  return new;
end $$;

create trigger guard_profile_update before update on public.profiles
for each row execute function public.mg_guard_profile_update();

-- inspections guard: inspector edits/submit while draft; reviewer approves/rejects.
create or replace function public.mg_guard_inspection_update()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if old.status = 'draft' and old.inspector_id = auth.uid()
     and new.status in ('draft','under_review') then
    return new;
  end if;
  if old.status = 'under_review' and public.mg_is_reviewer()
     and new.status in ('approved','rejected') then
    return new;
  end if;
  raise exception 'NOT_EDITABLE';
end $$;

create trigger guard_inspection_update before update on public.inspections
for each row execute function public.mg_guard_inspection_update();

-- findings guard: creator or reviewer any transition; operator acknowledge-only.
create or replace function public.mg_guard_finding_update()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if old.created_by_id = auth.uid() or public.mg_is_reviewer() then return new; end if;
  if public.mg_is_operator()
     and new.status = 'acknowledged' and old.status = 'open'
     and new.operator_name = (select operator_name from public.mg_profile()) then
    return new;
  end if;
  raise exception 'FORBIDDEN';
end $$;

create trigger guard_finding_update before update on public.findings
for each row execute function public.mg_guard_finding_update();

-- corrective actions guard: reviewer any transition; operator may only submit
-- a response note on their own site's open/in_progress action.
create or replace function public.mg_guard_ca_update()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if public.mg_is_reviewer() then return new; end if;
  if public.mg_is_operator()
     and new.status = 'submitted' and old.status in ('open','in_progress')
     and new.operator_name = (select operator_name from public.mg_profile())
     and new.description = old.description then
    return new;
  end if;
  raise exception 'FORBIDDEN';
end $$;

create trigger guard_ca_update before update on public.corrective_actions
for each row execute function public.mg_guard_ca_update();

-- incidents / observations guard: staff-only status transitions.
create or replace function public.mg_guard_staff_update()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if not public.mg_is_staff() then raise exception 'FORBIDDEN'; end if;
  return new;
end $$;

create trigger guard_incident_update before update on public.incidents
for each row execute function public.mg_guard_staff_update();
create trigger guard_obs_update before update on public.environmental_observations
for each row execute function public.mg_guard_staff_update();

-- ============================================================================
-- SECURITY DEFINER RPCs (audit-logged, server-enforced business logic)
-- ============================================================================

-- First-admin bootstrap + profile completion. Called by the signed-in user.
create or replace function public.complete_staff_profile(
  p_job_title text,
  p_organization text,
  p_scope text,
  p_county text default null,
  p_operator_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_is_first boolean;
begin
  if v_uid is null then raise exception 'UNAUTHENTICATED'; end if;
  if exists (select 1 from auth.users u where u.id = v_uid and u.is_anonymous) then
    raise exception 'GUEST_ACCOUNT: guest accounts cannot hold staff roles. Sign up with an email account instead.';
  end if;

  select not exists (select 1 from public.profiles where role is not null) into v_is_first;

  update public.profiles set
    job_title = p_job_title,
    organization = p_organization,
    scope = p_scope,
    county = p_county,
    operator_name = p_operator_name,
    profile_complete = true,
    role = case when v_is_first then 'admin'::public.user_role else role end;

  if v_is_first then
    insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary)
    select v_uid, coalesce(email, v_uid::text), 'user.profile.complete', 'users', v_uid::text,
           'Profile completed for ' || coalesce(email, v_uid::text) || ' (bootstrapped as first admin)'
    from public.profiles where id = v_uid;
  else
    insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary)
    select v_uid, coalesce(email, v_uid::text), 'user.profile.complete', 'users', v_uid::text,
           'Profile completed for ' || coalesce(email, v_uid::text)
    from public.profiles where id = v_uid;
  end if;
end $$;

-- Admin: assign a role to a user who has signed in at least once (by email).
create or replace function public.provision_user_by_email(
  p_email text,
  p_role public.user_role,
  p_scope text,
  p_county text default null,
  p_operator_name text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_target uuid;
  v_caller public.profiles;
  v_target_email text;
begin
  select * into v_caller from public.mg_profile();
  if v_caller is null or v_caller.role <> 'admin' then raise exception 'FORBIDDEN'; end if;

  select u.id, lower(u.email) into v_target, v_target_email
  from auth.users u where lower(u.email) = lower(p_email) limit 1;
  if v_target is null then
    raise exception 'USER_NOT_FOUND: that email has not signed in yet';
  end if;

  insert into public.profiles (id, email, profile_complete)
  values (v_target, v_target_email, true)
  on conflict (id) do update set
    role = p_role,
    scope = p_scope,
    county = coalesce(p_county, public.profiles.county),
    operator_name = coalesce(p_operator_name, public.profiles.operator_name),
    profile_complete = true;

  insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary)
  values (v_caller.id, coalesce(v_caller.email, v_caller.id::text), 'user.role.set', 'users',
          v_target::text, 'Role ' || p_role::text || ' (' || p_scope || ') assigned to ' || p_email);
end $$;

-- Public: submit a community report. Rate limited server-side (30/min),
-- tracking mirrored for the public tracker, audit logged. Callable by anon.
create or replace function public.submit_community_report(
  p_tracking_code text,
  p_category public.report_category,
  p_description text,
  p_county text,
  p_district text default null,
  p_community text default null,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_contact_phone text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_bucket text := 'cr-' || (extract(epoch from now())::bigint / 60)::text;
  v_count integer;
  v_code text;
  v_id uuid;
begin
  insert into public.rate_limits (bucket, count) values (v_bucket, 1)
  on conflict (bucket) do update
    set count = public.rate_limits.count + 1, updated_at = now()
  returning count into v_count;
  if v_count > 30 then
    raise exception 'RATE_LIMITED';
  end if;

  -- The client passes its own makeTrackingCode() value when it matches the
  -- CR-XXXXXXXXXX format; otherwise the server generates one.
  if p_tracking_code is not null and p_tracking_code ~ '^CR-[A-Z0-9]{8,}$' then
    v_code := upper(p_tracking_code);
  else
    v_code := 'CR-' || upper(replace(gen_random_uuid()::text, '-', ''));
    v_code := substr(v_code, 1, 15);
  end if;
  if char_length(p_description) < 10 or char_length(p_description) > 4000 then
    raise exception 'INVALID_REPORT';
  end if;

  insert into public.community_reports
    (tracking_code, category, description, county, district, community,
     latitude, longitude, contact_phone, status, rate_bucket)
  values
    (v_code, p_category, p_description, p_county, p_district, p_community,
     p_latitude, p_longitude, p_contact_phone, 'submitted', v_bucket)
  returning id into v_id;

  insert into public.report_tracking (tracking_code, status)
  values (v_code, 'submitted');

  insert into public.audit_log (actor_label, action, entity_type, entity_id, summary)
  values ('public', 'communityReport.submit', 'communityReports', v_id::text,
          'Public report ' || v_code || ' (' || p_category::text || ') in ' || p_county);

  perform public.refresh_public_stats();

  return jsonb_build_object('id', v_id, 'trackingCode', v_code);
end $$;

-- Reviewer: triage a community report and mirror the public tracking status.
create or replace function public.triage_community_report(
  p_report_id uuid,
  p_decision public.report_status,
  p_note text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_caller public.profiles;
  v_code text;
begin
  select * into v_caller from public.mg_profile();
  if v_caller is null or v_caller.role not in ('admin','supervisor') then
    raise exception 'FORBIDDEN';
  end if;

  select tracking_code into v_code from public.community_reports where id = p_report_id;
  if v_code is null then raise exception 'NOT_FOUND'; end if;

  update public.community_reports set
    status = p_decision,
    triage_note = p_note,
    reviewed_by_id = v_caller.id,
    reviewed_at = now()
  where id = p_report_id;

  update public.report_tracking set status = p_decision::text where tracking_code = v_code;

  insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary)
  values (v_caller.id, coalesce(v_caller.email, v_caller.id::text),
          'communityReport.triage', 'communityReports', p_report_id::text,
          'Report ' || v_code || ' triaged: ' || p_decision::text);
end $$;

-- Recompute the public aggregate counts (landing page). Never exposes content.
create or replace function public.refresh_public_stats()
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.meta (key, value, updated_at)
  values ('public_stats', jsonb_build_object(
    'sites', (select count(*) from public.sites),
    'inspections', (select count(*) from public.inspections),
    'incidents', (select count(*) from public.incidents),
    'communityReports', (select count(*) from public.community_reports),
    'updatedAt', (extract(epoch from now()) * 1000)::bigint
  ), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- ------------------------------------------------------------------- grants
grant execute on function public.complete_staff_profile to authenticated;
grant execute on function public.provision_user_by_email to authenticated;
grant execute on function public.submit_community_report to anon, authenticated;
grant execute on function public.triage_community_report to authenticated;
grant execute on function public.refresh_public_stats to anon, authenticated;
revoke execute on function public.provision_user_by_email from anon;
revoke execute on function public.triage_community_report from anon;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.sites enable row level security;
alter table public.inspection_templates enable row level security;
alter table public.inspections enable row level security;
alter table public.findings enable row level security;
alter table public.corrective_actions enable row level security;
alter table public.incidents enable row level security;
alter table public.environmental_observations enable row level security;
alter table public.evidence enable row level security;
alter table public.community_reports enable row level security;
alter table public.report_tracking enable row level security;
alter table public.meta enable row level security;
alter table public.audit_log enable row level security;
alter table public.rate_limits enable row level security;

-- profiles: read own (admins read all); insert own; update via guard trigger
create policy "profiles select self or admin" on public.profiles for select to authenticated
  using (id = auth.uid() or public.mg_is_admin());
create policy "profiles insert self" on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy "profiles update self or admin" on public.profiles for update to authenticated
  using (id = auth.uid() or public.mg_is_admin());

-- sites: scope-visible reads; admin-only writes
create policy "sites select scoped" on public.sites for select to authenticated
  using (public.mg_can_access_site(county, operator_name));
create policy "sites insert admin" on public.sites for insert to authenticated
  with check (public.mg_is_admin());
create policy "sites update admin" on public.sites for update to authenticated
  using (public.mg_is_admin());

-- inspection templates: assigned accounts read; admin writes
create policy "templates select assigned" on public.inspection_templates for select to authenticated
  using (public.mg_role() is not null);
create policy "templates insert admin" on public.inspection_templates for insert to authenticated
  with check (public.mg_is_admin());
create policy "templates update admin" on public.inspection_templates for update to authenticated
  using (public.mg_is_admin());

-- Site-scoped records: scope-visible reads; staff/assigned inserts with a
-- server-side site-visibility re-check; updates via guard triggers.
create policy "inspections select scoped" on public.inspections for select to authenticated
  using (public.mg_can_access_site(county, operator_name));
create policy "inspections insert staff visible" on public.inspections for insert to authenticated
  with check (
    public.mg_is_staff()
    and exists (select 1 from public.sites s
                where s.id = site_id and public.mg_can_access_site(s.county, s.operator_name)));
create policy "inspections update guard" on public.inspections for update to authenticated
  using (inspector_id = auth.uid() or public.mg_is_reviewer());

create policy "findings select scoped" on public.findings for select to authenticated
  using (public.mg_can_access_site(county, operator_name));
create policy "findings insert staff visible" on public.findings for insert to authenticated
  with check (
    public.mg_is_staff()
    and exists (select 1 from public.sites s
                where s.id = site_id and public.mg_can_access_site(s.county, s.operator_name)));
create policy "findings update guard" on public.findings for update to authenticated
  using (created_by_id = auth.uid() or public.mg_is_reviewer() or public.mg_is_operator());

create policy "cas select scoped" on public.corrective_actions for select to authenticated
  using (public.mg_can_access_site(county, operator_name));
create policy "cas insert staff visible" on public.corrective_actions for insert to authenticated
  with check (
    public.mg_is_staff()
    and exists (select 1 from public.sites s
                where s.id = site_id and public.mg_can_access_site(s.county, s.operator_name)));
create policy "cas update guard" on public.corrective_actions for update to authenticated
  using (public.mg_is_reviewer() or public.mg_is_operator());

create policy "incidents select scoped" on public.incidents for select to authenticated
  using (public.mg_can_access_site(county, operator_name));
create policy "incidents insert assigned visible" on public.incidents for insert to authenticated
  with check (
    public.mg_role() is not null
    and exists (select 1 from public.sites s
                where s.id = site_id and public.mg_can_access_site(s.county, s.operator_name)));
create policy "incidents update staff" on public.incidents for update to authenticated
  using (public.mg_is_staff());

create policy "obs select scoped" on public.environmental_observations for select to authenticated
  using (public.mg_can_access_site(county, operator_name));
create policy "obs insert assigned visible" on public.environmental_observations for insert to authenticated
  with check (
    public.mg_role() is not null
    and exists (select 1 from public.sites s
                where s.id = site_id and public.mg_can_access_site(s.county, s.operator_name)));
create policy "obs update staff" on public.environmental_observations for update to authenticated
  using (public.mg_is_staff());

create policy "evidence select scoped" on public.evidence for select to authenticated
  using (public.mg_can_access_site(county, operator_name));
create policy "evidence insert assigned visible" on public.evidence for insert to authenticated
  with check (
    public.mg_role() is not null
    and uploaded_by_id = auth.uid()
    and exists (select 1 from public.sites s
                where s.id = site_id and public.mg_can_access_site(s.county, s.operator_name)));

-- community reports: staff triage reads (county-scoped); reviewer updates;
-- public inserts go exclusively through submit_community_report (rate limited).
create policy "reports select staff county" on public.community_reports for select to authenticated
  using (public.mg_can_read_county_rows(county));
create policy "reports insert admin seed" on public.community_reports for insert to authenticated
  with check (public.mg_is_admin());
create policy "reports update reviewer" on public.community_reports for update to authenticated
  using (public.mg_is_reviewer());

create policy "tracking select public" on public.report_tracking for select
  using (true);
create policy "tracking insert admin seed" on public.report_tracking for insert to authenticated
  with check (public.mg_is_admin());
create policy "tracking update" on public.report_tracking for update to authenticated
  using (public.mg_is_reviewer());

create policy "meta select public" on public.meta for select using (true);

create policy "audit insert authenticated" on public.audit_log for insert to authenticated
  with check (true);
create policy "audit select staff" on public.audit_log for select to authenticated
  using (public.mg_is_staff());

-- rate_limits: no client policies — only the security definer touches it.

-- ============================================================================
-- STORAGE — evidence bucket (25MB cap), bytes before metadata, tenant-checked
-- reads via the evidence metadata join.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('evidence', 'evidence', false, 26214400)
on conflict (id) do nothing;

create policy "evidence upload own namespace" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

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

-- ------------------------------------------------------------------- realtime
-- Supabase realtime (used for live queries) only broadcasts tables that are
-- members of the supabase_realtime publication.
alter publication supabase_realtime add table
  public.sites,
  public.inspections,
  public.inspection_templates,
  public.findings,
  public.corrective_actions,
  public.incidents,
  public.environmental_observations,
  public.evidence,
  public.community_reports,
  public.report_tracking,
  public.meta,
  public.audit_log;

-- Live-reading helpers for the client's listForParent evidence query, so the
-- anon/authenticated client never queries evidence metadata directly without
-- the rules-equivalent scope check (mirrors evidence select policy).
create or replace function public.evidence_for_parent(
  p_parent_type public.evidence_parent_type,
  p_parent_id uuid
) returns setof public.evidence
language sql stable security definer set search_path = public as $$
  select e.* from public.evidence e
  where e.parent_type = p_parent_type and e.parent_id = p_parent_id
    and public.mg_can_access_site(e.county, e.operator_name);
$$;
grant execute on function public.evidence_for_parent to authenticated;
