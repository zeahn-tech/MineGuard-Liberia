# 03 — Database Architecture

**Status:** implemented as PostgreSQL on Supabase (migrated Convex → Firebase →
Supabase). Tables mirror the former Convex tables 1:1 in snake_case; rows are
mapped to camelCase domain types (with `_id` for the primary key) at the
`src/lib/backend.ts` edge. Timestamps are `timestamptz` in the database and
epoch-ms numbers in the UI (mapped at the same edge).

The authoritative schema, RLS policies, guard triggers and RPCs live in
`supabase/migrations/0001_initial_schema.sql`.

## Tables

| Table | Purpose | Key fields | Notes |
|-------|---------|-----------|---------|
| profiles | Accounts + MineGuard profile (id = auth.uid()) | role, scope, county, operator_name, profile_complete, email | role admin-writable only (`profiles_guard` trigger); first-admin bootstrap inside `complete_staff_profile` |
| sites | Mining site registry | code (unique), name, operator_name, county, status, lat/lng | never deleted (trigger-enforced) |
| inspection_templates | Configurable inspection structure | sections (jsonb) { title, questions[] { label, answerType, options, required } } | staff-managed |
| inspections | Field inspections | site_id, template_id, inspector_id, status, answers, GPS, client_ref | client_ref UNIQUE = server-side offline dedupe |
| findings | Inspection findings | inspection_id, site_id, title, severity, status + county/operator_name stamp | |
| corrective_actions | Compliance chain | finding_id, site_id, description, status, due_at, operator_note + stamp | |
| incidents | Incident records | site_id, type, severity, occurred_at, fatalities, injured, report_source, client_ref (unique) | |
| evidence | Media metadata | storage_path (unique), parent_type, parent_id, site_id, kind, mime, size + stamp | bytes in the private `evidence` bucket; 25MB check constraint |
| environmental_observations | Environmental monitoring | site_id, category, verification, observed_at, lat/lng, client_ref (unique) | verification = observed/measured/verified/unverified/alleged |
| community_reports | Public reports | tracking_code (unique), category, county, status, contact_phone | insert ONLY via `submit_community_report` RPC |
| report_tracking | Public tracking mirror | tracking_code (pk), status, created_at | world-readable coarse status by code |
| meta | Sentinels + aggregates (jsonb) | public_stats | refreshed by `refresh_public_stats()` |
| audit_log | Append-only trail | actor_id, actor_label, action, entity_type, entity_id, summary | insert policy only — no update/delete policy |
| rate_limits | Public-report limiter | bucket (pk), count, window_start | touched only by the definer RPC; since 0005 the bucket key is `report:<salted sha-256 of client IP>` per source (first x-forwarded-for hop), or `report:global` when no forwardable IP exists — no raw address is ever stored |

State unions are Postgres enums (user_role, site_status, inspection_state,
finding_severity, finding_state, ca_status, incident_type, incident_state,
env_category, verification, env_state, report_category, report_state,
evidence_parent, evidence_kind) — the closed unions the UI speaks.

Site-scoped tables (findings, corrective_actions, incidents,
environmental_observations, evidence) carry denormalized `county` +
`operator_name` columns stamped from the site row by triggers at write time,
and kept fresh by `sites_rescope` if a site's county/operator changes — this
is the rules-level list-scoping equivalent (doc 04 gap 5) under RLS.

## Data integrity rules [IMPLEMENTED]

1. **Authorship and timestamps.** All domain records store creator ID and
   `created_at` server-side (`default now()`); the client cannot set them.
2. **Lifecycle over deletion.** Sites, inspections, findings, corrective actions,
   incidents and observations use status transitions. No delete endpoints exist
   for domain records. (Draft discard on-device only removes unsynced local data.)
3. **Idempotency.** `inspections.client_ref`, `incidents.client_ref` and
   `environmental_observations.client_ref` carry UNIQUE constraints — the
   database itself rejects duplicate offline replays; the data layer's
   pre-check just returns the existing id.
4. **Verification states.** `environmental_observations.verification` is a
   Postgres enum: observed / measured / verified / unverified / alleged.
5. **Tenant isolation.** Operator access is filtered by `operator_name` equality
   with the site, enforced by `mg_can_access_site()` in RLS and mirrored in
   `canAccessSite`.
6. **Audit completeness.** Mutations for registry, inspections, findings,
   corrective actions, incidents, observations, triage, roles, and evidence all
   write audit entries from the data layer.
7. **sites.code is UNIQUE** (constraint, not just generator convention).

## Planned hardening [PLANNED]

- A generated-column or scheduled-job variant of `refresh_public_stats()`
  (currently the data layer calls the RPC after consequential writes).
- Backfill tool for records written outside the data layer (the trigger stamps
  rows on INSERT, so console-written rows are stamped automatically — the
  remaining need is repairing rows whose site later changed county/operator
  before `sites_rescope` existed).
