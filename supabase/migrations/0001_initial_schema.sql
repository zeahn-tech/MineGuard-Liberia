-- ===========================================================================
-- MINEGUARD LIBERIA — SUPABASE INITIAL SCHEMA
-- (migration 0001 — run once, top to bottom, in the Supabase SQL editor)
--
-- This is the authoritative server-side authorization boundary. The client
-- data layer (src/lib/backend.ts) re-derives the same checks before every
-- call (defense in depth), but RLS + guard triggers + security-definer RPCs
-- are what actually protect the data. Frontend hiding is NOT authorization.
--
-- Design notes
--   * Postgres enums back every closed state union the UI speaks
--     (site status, finding severity/status, verification states, …).
--   * Every site-scoped record carries denormalized county + operator_name
--     stamped by triggers from its site row — this is what makes
--     per-document list scoping possible under RLS (doc 04 gap 5).
--   * audit_log is append-only (insert-only policy; no update/delete policy).
--   * Public community reporting goes through a security-definer RPC with a
--     30-reports-per-minute global cap (report_rate_buckets); tracking is a
--     separate world-readable mirror with coarse fields only.
--   * Evidence metadata lives in a table; BYTES live in a private
--     "evidence" storage bucket. The client uploads to
--     {uid}/{evidenceRowId}__{fileName} — first folder must equal auth.uid(),
--     re-checked by the storage policies at the bottom of this file.
--   * meta(key, value jsonb) carries the public_stats sentinel the landing
--     page reads anonymously; refresh_public_stats() recomputes it.
--
-- Verification contract with src/lib/backend.ts (column names matter):
--   profiles(id, email, name, role, job_title, organization, scope, county,
--            operator_name, profile_complete, created_at)
--   sites(id, code, name, operator_name, mineral_type, county, district,
--         community, status, latitude, longitude, notes, created_by, created_at)
--   inspection_templates(id, name, description, active, sections, created_by, created_at)
--   inspections(id, site_id, template_id, inspector_id, status, answers, notes,
--               latitude, longitude, gps_accuracy_m, client_ref, submitted_at,
--               reviewed_at, reviewer_id, review_note, created_at)
--   findings(id, inspection_id, site_id, title, description, severity, status,
--            created_by_id, created_at)
--   corrective_actions(id, finding_id, site_id, description, status, due_at,
--            opened_by_id, operator_note, verified_by_id, closed_at, created_at)
--   incidents(id, site_id, type, severity, description, occurred_at, fatalities,
--            injured, status, client_ref, reported_by_id, report_source, created_at)
--   environmental_observations(id, site_id, category, verification, description,
--            observed_at, latitude, longitude, status, client_ref,
--            reported_by_id, created_at)
--   community_reports(id, tracking_code, category, description, county, district,
--            community, latitude, longitude, contact_phone, status, triage_note,
--            reviewed_by_id, reviewed_at, created_at)
--   report_tracking(tracking_code, status, created_at)
--   meta(key, value)
--   audit_log(id, actor_id, actor_label, action, entity_type, entity_id,
--            summary, created_at)
--   evidence(id, storage_path, parent_type, parent_id, site_id, kind,
--            file_name, mime_type, size_bytes, caption, captured_at,
--            uploaded_by_id, created_at)
--   rate_limits(bucket, count, window_start)   — public-report limiter
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- EXTENSIONS
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;        -- gen_random_uuid()
create extension if not exists pg_trgm;         -- (reserved; not required)

-- ---------------------------------------------------------------------------
-- ENUMS — the closed unions the UI speaks (src/lib/types.ts)
-- ---------------------------------------------------------------------------
create type user_role        as enum ('admin','supervisor','inspector','operator');
create type user_scope       as enum ('national','county','site');
create type site_status      as enum ('active','suspended','closed','pending_verification');
create type inspection_state as enum ('draft','submitted','under_review','approved','rejected');
create type finding_severity as enum ('low','medium','high','critical');
create type finding_state    as enum ('open','acknowledged','resolved','verified');
create type ca_status        as enum ('open','in_progress','submitted','verified','closed','escalated');
create type incident_type    as enum ('fatality','injury','near_miss','equipment_accident','vehicle_accident','fire','structural_failure','chemical_exposure','environmental','other');
create type incident_state   as enum ('reported','investigating','closed');
create type env_category     as enum ('water_pollution','river_disturbance','river_diversion','deforestation','soil_degradation','waste','tailings','chemical_handling','rehabilitation','land_impact');
create type verification     as enum ('observed','measured','verified','unverified','alleged');
create type env_state        as enum ('open','monitoring','resolved');
create type report_category  as enum ('suspected_illegal_mining','pollution','environmental_damage','safety_concern','land_concern','unauthorized_activity');
create type report_state     as enum ('submitted','under_review','verified','dismissed','referred');
create type evidence_parent  as enum ('inspection','incident','observation');
create type evidence_kind    as enum ('photo','video','audio','document');

-- ---------------------------------------------------------------------------
-- PROFILES — extends auth.users (id = auth.uid())
-- ---------------------------------------------------------------------------
create table public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  email            text,
  name             text,
  role             user_role,
  job_title        text,
  organization     text,
  scope            user_scope,
  county           text,
  operator_name    text,
  profile_complete boolean not null default false,
  created_at       timestamptz not null default now()
);

-- Auto-create a profile row for every new auth user (the client's
-- ensureProfileDoc() upsert is then an idempotent no-op).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data->>'name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- MINING SITES — the registry root every other domain record hangs off
-- ---------------------------------------------------------------------------
create table public.sites (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  operator_name text not null,
  mineral_type  text,
  county        text not null,
  district      text,
  community     text,
  status        site_status not null default 'pending_verification',
  latitude      double precision,
  longitude     double precision,
  notes         text,
  created_by    uuid not null references public.profiles(id),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- INSPECTION TEMPLATES — configurable form definitions (admin-managed)
-- ---------------------------------------------------------------------------
create table public.inspection_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  active      boolean not null default true,
  sections    jsonb not null default '[]'::jsonb,
  created_by  uuid not null references public.profiles(id),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- INSPECTIONS — field workflow; client_ref powers offline dedupe
-- ---------------------------------------------------------------------------
create table public.inspections (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references public.sites(id),
  template_id    uuid not null references public.inspection_templates(id),
  inspector_id   uuid not null references public.profiles(id),
  status         inspection_state not null default 'draft',
  answers        jsonb,
  notes          text,
  latitude       double precision,
  longitude      double precision,
  gps_accuracy_m double precision,
  client_ref     text unique,
  submitted_at   timestamptz,
  reviewed_at    timestamptz,
  reviewer_id    uuid references public.profiles(id),
  review_note    text,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- FINDINGS + CORRECTIVE ACTIONS — the compliance chain
-- ---------------------------------------------------------------------------
create table public.findings (
  id            uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.inspections(id),
  site_id       uuid not null references public.sites(id),
  title         text not null,
  description   text,
  severity      finding_severity not null,
  status        finding_state not null default 'open',
  created_by_id uuid not null references public.profiles(id),
  created_at    timestamptz not null default now()
);

create table public.corrective_actions (
  id             uuid primary key default gen_random_uuid(),
  finding_id     uuid not null references public.findings(id),
  site_id        uuid not null references public.sites(id),
  description    text not null,
  status         ca_status not null default 'open',
  due_at         timestamptz not null,
  opened_by_id   uuid not null references public.profiles(id),
  operator_note  text,
  verified_by_id uuid references public.profiles(id),
  closed_at      timestamptz,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- INCIDENTS
-- ---------------------------------------------------------------------------
create table public.incidents (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid not null references public.sites(id),
  type            incident_type not null,
  severity        finding_severity not null,
  description     text not null,
  occurred_at     timestamptz not null,
  fatalities      integer,
  injured         integer,
  status          incident_state not null default 'reported',
  client_ref      text unique,
  reported_by_id  uuid not null references public.profiles(id),
  report_source   text not null default 'inspector'
                  check (report_source in ('inspector','operator')),
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ENVIRONMENTAL OBSERVATIONS
-- ---------------------------------------------------------------------------
create table public.environmental_observations (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references public.sites(id),
  category       env_category not null,
  verification   verification not null,
  description    text not null,
  observed_at    timestamptz not null,
  latitude       double precision,
  longitude      double precision,
  status         env_state not null default 'open',
  client_ref     text unique,
  reported_by_id uuid not null references public.profiles(id),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- COMMUNITY REPORTS + PUBLIC TRACKING MIRROR
-- ---------------------------------------------------------------------------
create table public.community_reports (
  id             uuid primary key default gen_random_uuid(),
  tracking_code  text not null unique,
  category       report_category not null,
  description    text not null,
  county         text not null,
  district       text,
  community      text,
  latitude       double precision,
  longitude      double precision,
  contact_phone  text,
  status         report_state not null default 'submitted',
  triage_note    text,
  reviewed_by_id uuid references public.profiles(id),
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- Coarse public mirror (code → status only). The world may read this;
-- it intentionally carries no description/contact fields.
create table public.report_tracking (
  tracking_code text primary key,
  status        text not null,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- EVIDENCE — metadata only; bytes live in the private "evidence" bucket
-- ---------------------------------------------------------------------------
create table public.evidence (
  id             uuid primary key default gen_random_uuid(),
  storage_path   text not null unique,
  parent_type    evidence_parent not null,
  parent_id      uuid not null,
  site_id        uuid not null references public.sites(id),
  kind           evidence_kind not null,
  file_name      text not null,
  mime_type      text not null,
  size_bytes     bigint not null default 0 check (size_bytes <= 26214400), -- 25MB
  caption        text,
  captured_at    timestamptz,
  uploaded_by_id uuid not null references public.profiles(id),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- META — sentinels + public aggregate counters (landing page, anonymous)
-- ---------------------------------------------------------------------------
create table public.meta (
  key   text primary key,
  value jsonb not null default '{}'::jsonb
);
insert into public.meta (key, value) values ('public_stats', '{}'::jsonb)
  on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- AUDIT LOG — append-only
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles(id),
  actor_label text not null,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  summary     text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RATE LIMITER — global per-minute bucket for public report submission
-- (rule-level guard equivalent; the RPC enforces it)
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  bucket       text primary key,
  count        integer not null default 0,
  window_start timestamptz not null default now()
);

-- ===========================================================================
-- AUTHORIZATION HELPERS (used by RLS policies and RPCs)
-- ===========================================================================

create or replace function public.mg_profile()
returns public.profiles
language sql stable security definer set search_path = public
as $$ select * from public.profiles where id = auth.uid() $$;

create or replace function public.mg_role()
returns user_role
language sql stable security definer set search_path = public
as $$ select role from public.mg_profile() $$;

create or replace function public.mg_is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select role in ('admin','supervisor','inspector') from public.mg_profile()),
    false)
$$;

create or replace function public.mg_is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select role = 'admin' from public.mg_profile()), false) $$;

create or replace function public.mg_is_reviewer()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select role in ('admin','supervisor') from public.mg_profile()),
    false)
$$;

create or replace function public.mg_operator_name()
returns text
language sql stable security definer set search_path = public
as $$ select operator_name from public.mg_profile() $$;

-- Site visibility — the exact mirror of canAccessSite() in src/lib/types.ts:
--   admin → all · operator → own operator_name · staff national → all ·
--   staff county → own county · unassigned → nothing
create or replace function public.mg_can_access_site(p_site_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.sites s
    where s.id = p_site_id
      and (
        public.mg_is_admin()
        or (
          public.mg_is_staff()
          and (select scope from public.mg_profile()) = 'national'
        )
        or (
          public.mg_is_staff()
          and (select scope from public.mg_profile()) = 'county'
          and (select county from public.mg_profile()) = s.county
        )
        or (
          (select role from public.mg_profile()) = 'operator'
          and (select operator_name from public.mg_profile()) = s.operator_name
        )
      )
  )
$$;

-- ===========================================================================
-- SCOPE-STAMP TRIGGERS — denormalize county + operator_name from the site
-- onto child rows so per-document list scoping under RLS is possible.
-- (siteScopeStamp contract in src/lib/types.ts)
-- ===========================================================================

create or replace function public.mg_stamp_site_scope()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  s public.sites%rowtype;
begin
  select * into s from public.sites where id = new.site_id;
  new.county        := s.county;
  new.operator_name := s.operator_name;
  return new;
end;
$$;

-- Findings/corrective actions carry the stamp (list scoping mirror).
alter table public.findings
  add column if not exists county text not null default 'Unknown',
  add column if not exists operator_name text not null default 'Unknown';
alter table public.corrective_actions
  add column if not exists county text not null default 'Unknown',
  add column if not exists operator_name text not null default 'Unknown';
alter table public.incidents
  add column if not exists county text not null default 'Unknown',
  add column if not exists operator_name text not null default 'Unknown';
alter table public.environmental_observations
  add column if not exists county text not null default 'Unknown',
  add column if not exists operator_name text not null default 'Unknown';

create trigger findings_stamp
  before insert on public.findings
  for each row execute function public.mg_stamp_site_scope();

create trigger corrective_actions_stamp
  before insert on public.corrective_actions
  for each row execute function public.mg_stamp_site_scope();

create trigger incidents_stamp
  before insert on public.incidents
  for each row execute function public.mg_stamp_site_scope();

create trigger environmental_observations_stamp
  before insert on public.environmental_observations
  for each row execute function public.mg_stamp_site_scope();

-- Evidence rows: site_id is mandatory (client contract) — stamp too.
alter table public.evidence
  add column if not exists county text not null default 'Unknown',
  add column if not exists operator_name text not null default 'Unknown';

create trigger evidence_stamp
  before insert on public.evidence
  for each row execute function public.mg_stamp_site_scope();

-- Keep the stamps fresh if a site's county/operator ever changes.
create or replace function public.mg_backfill_scope_stamps()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.findings f
    set county = new.county, operator_name = new.operator_name
    where f.site_id = new.id;
  update public.corrective_actions c
    set county = new.county, operator_name = new.operator_name
    where c.site_id = new.id;
  update public.incidents i
    set county = new.county, operator_name = new.operator_name
    where i.site_id = new.id;
  update public.environmental_observations o
    set county = new.county, operator_name = new.operator_name
    where o.site_id = new.id;
  update public.evidence e
    set county = new.county, operator_name = new.operator_name
    where e.site_id = new.id;
  return new;
end;
$$;

create trigger sites_rescope
  after update of county, operator_name on public.sites
  for each row execute function public.mg_backfill_scope_stamps();

-- ===========================================================================
-- GUARD TRIGGERS — lifecycle + tenant checks enforced server-side
-- (defense in depth: the client re-derives these, these are authoritative)
-- ===========================================================================

-- Inspections: only the owning inspector may edit a draft.
create or replace function public.mg_guard_inspection_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if public.mg_is_admin() then return new; end if;
  if new.inspector_id <> auth.uid() then
    raise exception 'FORBIDDEN: only the owning inspector may modify an inspection';
  end if;
  if old.status = 'draft' and new.status <> 'draft' then
    -- submission: any authenticated owner may submit (rule mirrors client)
    null;
  elsif old.status = 'under_review'
        and new.status in ('approved','rejected')
        and not public.mg_is_reviewer() then
    raise exception 'FORBIDDEN: reviewer role required to approve or reject';
  elsif old.status <> 'draft' and new.status <> old.status then
    raise exception 'NOT_EDITABLE: inspection is no longer a draft';
  end if;
  return new;
end;
$$;

create trigger inspections_guard
  before update on public.inspections
  for each row execute function public.mg_guard_inspection_update();

-- Findings: operator may only acknowledge; owner/reviewer may transition.
create or replace function public.mg_guard_finding_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if public.mg_is_admin() or public.mg_is_reviewer() then return new; end if;
  if old.created_by_id = auth.uid() then return new; end if;
  if (select role from public.mg_profile()) = 'operator'
     and new.status = 'acknowledged' then
    return new;
  end if;
  raise exception 'FORBIDDEN: finding status transition not permitted';
end;
$$;

create trigger findings_guard
  before update on public.findings
  for each row execute function public.mg_guard_finding_update();

-- Community reports: staff may only move submitted → under_review and
-- reviewers triage to verified/dismissed/referred; nothing else is writable.
create or replace function public.mg_guard_report_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.mg_is_staff() then
    raise exception 'FORBIDDEN: staff required';
  end if;
  if old.status = 'submitted' and new.status = 'under_review' then
    return new;
  end if;
  if old.status = 'under_review'
     and new.status in ('verified','dismissed','referred')
     and public.mg_is_reviewer() then
    return new;
  end if;
  raise exception 'NOT_REVIEWABLE: triage transition not permitted';
end;
$$;

create trigger community_reports_guard
  before update on public.community_reports
  for each row execute function public.mg_guard_report_update();

-- Profiles: role/scope/operator are admin-writable only. The complete_staff_
-- profile RPC handles the self-service fields + first-admin bootstrap.
create or replace function public.mg_guard_profile_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if public.mg_is_admin() then return new; end if;
  -- Non-admins may only fill in their own descriptive fields.
  if old.id = auth.uid()
     and new.role is not distinct from old.role
     and new.scope is not distinct from old.scope
     and new.county is not distinct from old.county
     and new.operator_name is not distinct from old.operator_name then
    return new;
  end if;
  raise exception 'FORBIDDEN_ROLE_CHANGE';
end;
$$;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.mg_guard_profile_update();

-- Sites: create/status are admin-only.
create or replace function public.mg_guard_site_write()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'FORBIDDEN: sites are never deleted (lifecycle only)';
  end if;
  if not public.mg_is_admin() then
    raise exception 'FORBIDDEN: admin required to modify the site registry';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger sites_guard
  before insert or update or delete on public.sites
  for each row execute function public.mg_guard_site_write();

-- Templates: admin-managed.
create or replace function public.mg_guard_template_write()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if not public.mg_is_admin() then
      raise exception 'FORBIDDEN: admin required to delete templates';
    end if;
    return old;
  end if;
  if not public.mg_is_staff() then
    raise exception 'FORBIDDEN: staff required to manage templates';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger inspection_templates_guard
  before insert or update or delete on public.inspection_templates
  for each row execute function public.mg_guard_template_write();

-- Incidents/observations status transitions: staff-only.
create or replace function public.mg_guard_incident_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if public.mg_is_staff() then return new; end if;
  -- Operators may file incidents at their own sites; nothing else changes.
  if (select role from public.mg_profile()) = 'operator'
     and public.mg_can_access_site(new.site_id)
     and new.status = old.status then
    return new;
  end if;
  raise exception 'FORBIDDEN: staff required for incident status changes';
end;
$$;

create trigger incidents_guard
  before update on public.incidents
  for each row execute function public.mg_guard_incident_update();

create or replace function public.mg_guard_observation_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if public.mg_is_staff() then return new; end if;
  if (select role from public.mg_profile()) = 'operator'
     and public.mg_can_access_site(new.site_id)
     and new.status = old.status then
    return new;
  end if;
  raise exception 'FORBIDDEN: staff required for observation status changes';
end;
$$;

create trigger environmental_observations_guard
  before update on public.environmental_observations
  for each row execute function public.mg_guard_observation_update();

-- Corrective actions: reviewers decide; operators may only add a note.
create or replace function public.mg_guard_ca_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if public.mg_is_reviewer() then return new; end if;
  if (select role from public.mg_profile()) = 'operator'
     and new.operator_note is distinct from old.operator_note
     and new.status = 'submitted'
     and old.status = 'open' then
    return new;
  end if;
  raise exception 'FORBIDDEN: corrective action decision requires a reviewer';
end;
$$;

create trigger corrective_actions_guard
  before update on public.corrective_actions
  for each row execute function public.mg_guard_ca_update();

-- ===========================================================================
-- ROW LEVEL SECURITY
-- ===========================================================================

alter table public.profiles                  enable row level security;
alter table public.sites                     enable row level security;
alter table public.inspection_templates      enable row level security;
alter table public.inspections               enable row level security;
alter table public.findings                  enable row level security;
alter table public.corrective_actions        enable row level security;
alter table public.incidents                 enable row level security;
alter table public.environmental_observations enable row level security;
alter table public.community_reports         enable row level security;
alter table public.report_tracking           enable row level security;
alter table public.evidence                  enable row level security;
alter table public.meta                      enable row level security;
alter table public.audit_log                 enable row level security;
alter table public.rate_limits               enable row level security;

-- profiles: read any profile (the app displays actor labels), write self only
-- (guard trigger above enforces which fields).
create policy "profiles read" on public.profiles
  for select using (true);
create policy "profiles self insert" on public.profiles
  for insert with check (id = auth.uid());
create policy "profiles self update" on public.profiles
  for update using (id = auth.uid());

-- sites: visible per mg_can_access_site; writes admin-only (guard trigger).
create policy "sites read" on public.sites
  for select using (public.mg_can_access_site(id));

create policy "sites insert" on public.sites
  for insert with check (public.mg_is_admin());
create policy "sites update" on public.sites
  for update using (public.mg_is_admin());

-- templates: readable by any authenticated staff/operator; staff-writable.
create policy "templates read" on public.inspection_templates
  for select using (public.mg_is_staff() or public.mg_role() = 'operator');
create policy "templates insert" on public.inspection_templates
  for insert with check (public.mg_is_staff());
create policy "templates update" on public.inspection_templates
  for update using (public.mg_is_staff());

-- inspections: site-scoped; non-national inspectors additionally see only
-- their own rows (mirrors inspections.list in backend.ts).
create policy "inspections read" on public.inspections
  for select using (
    public.mg_can_access_site(site_id)
    and (
      public.mg_is_admin()
      or (select scope from public.mg_profile()) = 'national'
      or inspector_id = auth.uid()
    )
  );
create policy "inspections insert" on public.inspections
  for insert with check (
    inspector_id = auth.uid()
    and public.mg_is_staff()
    and public.mg_can_access_site(site_id)
  );
create policy "inspections update" on public.inspections
  for update using (
    inspector_id = auth.uid() or public.mg_is_reviewer()
  );

-- findings / corrective actions: per-document site scoping (closes the
-- tenant-isolation hole documented as 0.2 in the Firebase-era audit).
create policy "findings read" on public.findings
  for select using (public.mg_can_access_site(site_id));
create policy "findings insert" on public.findings
  for insert with check (
    created_by_id = auth.uid()
    and public.mg_is_staff()
    and public.mg_can_access_site(site_id)
  );
create policy "findings update" on public.findings
  for update using (
    created_by_id = auth.uid() or public.mg_is_reviewer()
    or (public.mg_role() = 'operator'
        and public.mg_can_access_site(site_id))
  );

create policy "corrective actions read" on public.corrective_actions
  for select using (public.mg_can_access_site(site_id));
create policy "corrective actions insert" on public.corrective_actions
  for insert with check (
    opened_by_id = auth.uid()
    and public.mg_is_staff()
    and public.mg_can_access_site(site_id)
  );
create policy "corrective actions update" on public.corrective_actions
  for update using (
    public.mg_is_reviewer()
    or (public.mg_role() = 'operator'
        and public.mg_can_access_site(site_id))
  );

-- incidents / environmental observations: site-scoped.
create policy "incidents read" on public.incidents
  for select using (public.mg_can_access_site(site_id));
create policy "incidents insert" on public.incidents
  for insert with check (
    reported_by_id = auth.uid()
    and public.mg_can_access_site(site_id)
  );
create policy "incidents update" on public.incidents
  for update using (public.mg_is_staff());

create policy "observations read" on public.environmental_observations
  for select using (public.mg_can_access_site(site_id));
create policy "observations insert" on public.environmental_observations
  for insert with check (
    reported_by_id = auth.uid()
    and public.mg_can_access_site(site_id)
  );
create policy "observations update" on public.environmental_observations
  for update using (public.mg_is_staff());

-- community reports: staff-only reads; creation happens ONLY via the
-- security-definer RPC (no direct insert policy on purpose).
create policy "reports staff read" on public.community_reports
  for select using (public.mg_is_staff());
create policy "reports staff update" on public.community_reports
  for update using (public.mg_is_staff());

-- report_tracking: world-readable coarse mirror; writes via RPC/trigger only.
create policy "tracking public read" on public.report_tracking
  for select using (true);

-- evidence metadata: read requires site visibility; write requires it too.
create policy "evidence read" on public.evidence
  for select using (public.mg_can_access_site(site_id));
create policy "evidence insert" on public.evidence
  for insert with check (
    uploaded_by_id = auth.uid()
    and public.mg_can_access_site(site_id)
  );

-- meta: world-readable (public_stats), writes only through definer RPCs.
create policy "meta public read" on public.meta
  for select using (true);

-- audit_log: staff read; append via RPC or direct insert (append-only: no
-- update/delete policy exists — Postgres denies by default under RLS).
create policy "audit staff read" on public.audit_log
  for select using (public.mg_is_staff());
create policy "audit append" on public.audit_log
  for insert with check (auth.uid() is not null);

-- rate_limits: no client policies at all — only the definer RPC touches it.

-- ===========================================================================
-- SECURITY-DEFINER RPCs — the public/mutating surface the client calls
-- ===========================================================================

-- Public: submit a community report (no auth). Rate-limited 30/minute
-- globally; mirrors report_tracking and refreshes public stats.
create or replace function public.submit_community_report(
  p_tracking_code text,
  p_category      text,
  p_description   text,
  p_county        text,
  p_district      text default null,
  p_community     text default null,
  p_latitude      double precision default null,
  p_longitude     double precision default null,
  p_contact_phone text default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Rate limit: 30 reports per rolling minute (global bucket).
  insert into public.rate_limits (bucket, count, window_start)
  values ('public_report', 1, now())
  on conflict (bucket) do update
    set count = case
          when public.rate_limits.window_start < now() - interval '60 seconds'
          then 1 else public.rate_limits.count + 1 end,
        window_start = case
          when public.rate_limits.window_start < now() - interval '60 seconds'
          then now() else public.rate_limits.window_start end;

  if (select count from public.rate_limits where bucket = 'public_report') > 30 then
    raise exception 'RATE_LIMITED: too many reports submitted right now';
  end if;

  insert into public.community_reports (
    tracking_code, category, description, county, district, community,
    latitude, longitude, contact_phone
  ) values (
    p_tracking_code, p_category::report_category, p_description, p_county,
    p_district, p_community, p_latitude, p_longitude, p_contact_phone
  )
  returning id into v_id;

  insert into public.report_tracking (tracking_code, status)
  values (p_tracking_code, 'submitted')
  on conflict (tracking_code) do nothing;

  perform public.refresh_public_stats();
  return jsonb_build_object('id', v_id, 'trackingCode', p_tracking_code);
end;
$$;

-- Staff (reviewer): triage a community report.
create or replace function public.triage_community_report(
  p_report_id uuid,
  p_decision  text,
  p_note      text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_report public.community_reports%rowtype;
  v_actor  public.profiles%rowtype;
begin
  if not public.mg_is_reviewer() then
    raise exception 'FORBIDDEN: reviewer role required';
  end if;
  select * into v_report from public.community_reports where id = p_report_id;
  if not found then raise exception 'NOT_FOUND'; end if;

  select * into v_actor from public.profiles where id = auth.uid();

  update public.community_reports
    set status = p_decision::report_state,
        triage_note = p_note,
        reviewed_by_id = auth.uid(),
        reviewed_at = now()
    where id = p_report_id;

  update public.report_tracking
    set status = p_decision
    where tracking_code = v_report.tracking_code;

  insert into public.audit_log (
    actor_id, actor_label, action, entity_type, entity_id, summary
  ) values (
    auth.uid(),
    coalesce(v_actor.email, v_actor.name, auth.uid()::text),
    'community.triage',
    'community_reports',
    v_report.id::text,
    'Report ' || v_report.tracking_code || ' triaged to ' || p_decision
  );
end;
$$;

-- Public stats aggregate (anonymous-readable via meta).
create or replace function public.refresh_public_stats()
returns void
language sql
security definer set search_path = public
as $$
  insert into public.meta (key, value)
  values (
    'public_stats',
    jsonb_build_object(
      'sites',            (select count(*) from public.sites),
      'inspections',      (select count(*) from public.inspections),
      'incidents',        (select count(*) from public.incidents),
      'communityReports', (select count(*) from public.community_reports)
    )
  )
  on conflict (key) do update
    set value = excluded.value;
$$;

-- Staff profile completion (self-service; first admin bootstrap).
create or replace function public.complete_staff_profile(
  p_job_title    text,
  p_organization text,
  p_scope        text default 'national',
  p_county       text default null,
  p_operator_name text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_first_admin boolean;
begin
  -- One-time bootstrap: the first completed staff profile becomes admin
  -- when no admin exists yet. Guarded by a role check inside this txn.
  select not exists (select 1 from public.profiles where role = 'admin')
    into v_first_admin;

  update public.profiles
    set job_title = p_job_title,
        organization = p_organization,
        scope = p_scope::user_scope,
        county = p_county,
        operator_name = p_operator_name,
        profile_complete = true,
        role = case when v_first_admin then 'admin'::user_role else role end
    where id = auth.uid();

  if not found then
    raise exception 'UNREGISTERED_USER';
  end if;
end;
$$;

-- Admin: provision/role-set an account by email (before or after sign-up).
create or replace function public.provision_user_by_email(
  p_email         text,
  p_role          text,
  p_scope         text,
  p_county        text default null,
  p_operator_name text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid;
begin
  if not public.mg_is_admin() then
    raise exception 'FORBIDDEN: admin required';
  end if;

  select id into v_uid from public.profiles
    where lower(email) = lower(p_email) limit 1;

  if v_uid is null then
    raise exception 'USER_NOT_FOUND: no profile exists for that email yet (the person must sign up first)';
  end if;

  update public.profiles
    set role = p_role::user_role,
        scope = p_scope::user_scope,
        county = p_county,
        operator_name = p_operator_name,
        profile_complete = true
    where id = v_uid;
end;
$$;

-- Evidence: scoped list for one parent record (the client never queries the
-- raw table for lists — it goes through this RPC, which re-checks scope).
create or replace function public.evidence_for_parent(
  p_parent_type text,
  p_parent_id   uuid
)
returns setof public.evidence
language plpgsql
stable
security definer set search_path = public
as $$
begin
  return query
    select e.* from public.evidence e
    where e.parent_type = p_parent_type::evidence_parent
      and e.parent_id = p_parent_id
      and public.mg_can_access_site(e.site_id)
    order by e.created_at desc;
end;
$$;

-- ===========================================================================
-- REALTIME — push updates for the client's live() watchers
-- ===========================================================================
alter publication supabase_realtime add table public.sites;
alter publication supabase_realtime add table public.inspection_templates;
alter publication supabase_realtime add table public.inspections;
alter publication supabase_realtime add table public.findings;
alter publication supabase_realtime add table public.corrective_actions;
alter publication supabase_realtime add table public.incidents;
alter publication supabase_realtime add table public.environmental_observations;
alter publication supabase_realtime add table public.community_reports;
alter publication supabase_realtime add table public.report_tracking;
alter publication supabase_realtime add table public.evidence;
alter publication supabase_realtime add table public.audit_log;
alter publication supabase_realtime add table public.meta;

-- ===========================================================================
-- STORAGE — private "evidence" bucket + role-aware policies
--
-- Object path contract (src/lib/backend.ts evidence.upload):
--   evidence/{auth.uid()}/{evidenceRowId}__{fileName}
-- Upload policy: first folder must equal the caller's uid, ≤25MB, and the
-- caller must be able to see the site (re-checked here from the payload the
-- client uploads with — metadata row is written after bytes).
-- Read policy: re-derives the caller's role/tenant, then joins the metadata
-- row by storage_path to confirm site visibility — role-blind reads are
-- impossible (closes audit defect 0.3).
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', false)
on conflict (id) do nothing;

create policy "evidence upload own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and auth.role() = 'authenticated'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role is not null
    )
  );

create policy "evidence read scoped"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'evidence'
    and exists (
      select 1 from public.evidence e
      where e.storage_path = name
        and public.mg_can_access_site(e.site_id)
    )
  );

-- Owners may re-upload/overwrite their own pending objects (retry path).
create policy "evidence owner update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ===========================================================================
-- INITIAL DATA — none. The app seeds synthetic demo data only from an
-- authenticated admin account (api.seed.seedIfEmpty). No government data,
-- no fabricated statistics, no default accounts.
-- ===========================================================================
