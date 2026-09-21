# 03 — Database Architecture

**Status:** implemented as Cloud Firestore collections (migrated from Convex).
Collections mirror the former Convex tables 1:1; documents carry the same
fields plus the document ID as `_id` when surfaced through the data layer.

## Collections

| Collection | Purpose | Key fields | Notes |
|-------|---------|-----------|---------|
| users | Accounts + MineGuard profile (doc ID = Firebase UID) | role, scope, county, operatorName, profileComplete, emailLower | role admin-writable only; `meta/hasStaff` guards first-admin bootstrap |
| sites | Mining site registry | code, name, operatorName, county, status, lat/lng | never deleted |
| inspectionTemplates | Configurable inspection structure | sections[] { title, questions[] { label, answerType, options, required } } | admin-managed |
| inspections | Field inspections | siteId, templateId, inspectorId, status, answers, GPS, clientRef | clientRef dedupe via query |
| findings | Inspection findings | inspectionId, siteId, title, severity, status | |
| correctiveActions | Compliance chain | findingId, siteId, description, status, dueAt, operatorNote | |
| incidents | Incident records | siteId, type, severity, occurredAt, fatalities, injured, reportSource | |
| evidence | Media metadata | storagePath (Cloud Storage), parentType, parentId, siteId, kind, mime, size | bytes in Storage |
| environmentalObservations | Environmental monitoring | siteId, category, verification, observedAt, lat/lng | verification = observed/measured/verified/unverified/alleged |
| communityReports | Public reports | trackingCode, category, county, status, contactPhone | |
| reportTracking | Public tracking mirror | trackingCode, status, createdAt | world-readable coarse status by code |
| meta | Sentinels + aggregates | hasStaff, publicStats | publicStats = landing-page counts |
| auditLog | Append-only trail | actorId, actorLabel, action, entityType, entityId, summary | create-only under rules |

## Data integrity rules [IMPLEMENTED]

1. **Authorship and timestamps.** All domain records store creator ID and
   `createdAt` server-side; the client cannot set them.
2. **Lifecycle over deletion.** Sites, inspections, findings, corrective actions,
   incidents and observations use status transitions. No delete endpoints exist
   for domain records. (Draft discard on-device only removes unsynced local data.)
3. **Idempotency.** `inspections.clientRef` powers server-side dedupe of offline
   submissions (queried by equality on sync).
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
