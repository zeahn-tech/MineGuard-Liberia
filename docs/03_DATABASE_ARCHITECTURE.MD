# 03 — Database Architecture

**Status:** implemented schema in `src/convex/schema.ts`.

## Tables

| Table | Purpose | Key fields | Indexes |
|-------|---------|-----------|---------|
| users | Accounts + MineGuard profile | role, scope, county, operatorName, profileComplete | email |
| sites | Mining site registry | code, name, operatorName, county, status, lat/lng | by_code, by_county, by_status |
| inspectionTemplates | Configurable inspection structure | sections[] { title, questions[] { label, answerType, options, required } } | by_active |
| inspections | Field inspections | siteId, templateId, inspectorId, status, answers, GPS, clientRef | by_site, by_status, by_inspector, by_client_ref |
| findings | Inspection findings | inspectionId, siteId, title, severity, status | by_site, by_inspection, by_status |
| correctiveActions | Compliance chain | findingId, siteId, description, status, dueAt, operatorNote | by_site, by_finding, by_status |
| incidents | Incident records | siteId, type, severity, occurredAt, fatalities, injured, reportSource | by_site, by_type, by_status |
| evidence | Media metadata | storageId, parentType, parentId, siteId, kind, mime, size | by_parent, by_site |
| environmentalObservations | Environmental monitoring | siteId, category, verification, observedAt, lat/lng | by_site, by_category |
| communityReports | Public reports | trackingCode, category, county, status, contactPhone | by_tracking_code, by_status, by_county |
| auditLog | Append-only trail | actorId, actorLabel, action, entityType, entityId, summary | by_created |

## Data integrity rules [IMPLEMENTED]

1. **Authorship and timestamps.** All domain records store creator ID and
   `createdAt` server-side; the client cannot set them.
2. **Lifecycle over deletion.** Sites, inspections, findings, corrective actions,
   incidents and observations use status transitions. No delete endpoints exist
   for domain records. (Draft discard on-device only removes unsynced local data.)
3. **Idempotency.** `inspections.clientRef` plus the `by_client_ref` index powers
   server-side dedupe of offline submissions.
4. **Verification states.** `environmentalObservations.verification` is a closed
   union: observed / measured / verified / unverified / alleged.
5. **Tenant isolation.** Operator access is filtered by `operatorName` equality
   with the site, enforced in `canAccessSite`.
6. **Audit completeness.** Mutations for registry, inspections, findings,
   corrective actions, incidents, observations, triage, roles, and evidence all
   write audit entries.

## Planned hardening [PLANNED]

- Unique constraint enforcement for `sites.code` via a write-guard (currently
  uniqueness comes from the generator, not a constraint).
- `schemaValidation: true` after migrating the starter schema defaults.
- Mutation-level rate limiting on public report submission.
