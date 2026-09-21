# 11 — Implementation Status

**Session:** Initial platform build (v1.0 scope)
**Date:** 2026-09-21
**Verification:** `bun convex dev --once` ✓ (functions ready) · `bun tsc -b --noEmit` ✓ (0 errors)

## Completed this session

### Backend (Convex)
- Full domain schema: users(+profile), sites, inspectionTemplates, inspections,
  findings, correctiveActions, incidents, evidence, environmentalObservations,
  communityReports, auditLog.
- Authorization core `src/convex/lib/authz.ts` (roles, scopes, operator
  isolation, site access, audit helper, site-code generator).
- Modules: sites, inspections (lifecycle + findings + corrective actions),
  records (incidents / observations / community reports incl. public endpoints),
  stats (command center, public stats, audit read, role management), evidence,
  seed.
- Server-side clientRef dedupe for offline submissions.

### Frontend
- Papery design system applied globally (`src/index.css`), dark variant included.
- Public: landing page, community report form + tracking, restyled auth, 404.
- Portal shell: role-aware sidebar, offline queue sync indicator + manual sync,
  admin role provisioning, profile completion, demo-data seeder.
- Pages: Command Center, Sites registry + detail (with explainable risk
  breakdown, admin status control), National Map (Leaflet, verified vs reported
  layers), Inspections list, offline-capable field form (GPS capture, local
  autosave, queued submit), Inspection detail (review, findings, corrective
  actions), Incidents, Environment, Community triage, Audit log.
- Router restructured: public `/`, `/report`, `/report/track`, `/auth`; protected
  `/portal/*` with RequireAuth; auth fallback destination `/portal`.

### Offline
- `src/lib/offline-queue.ts`: local draft store + submission queue with retry,
  failure capture, idempotent sync; auto-sync on `online` event; nothing
  silently dropped.

### Documentation
- `docs/00`–`docs/16` authored to match the implementation, with explicit
  requirement classifications.

## Files changed / created (summary)

Backend: `src/convex/{schema,authz→lib/authz,sites,inspections,records,stats,evidence,seed}.ts`
Frontend: `src/main.tsx`, `src/index.css`, `src/pages/{Landing,Auth,PortalLayout,
CommandCenter,Sites,SiteDetail,NationalMap,Inspections,InspectionDetail,Incidents,
Environment,Community,CommunitySubmit,CommunityTrack,Audit,NotFound}.tsx`,
`src/lib/offline-queue.ts`
Removed: `src/pages/Dashboard.tsx`, `src/components/LogoDropdown.tsx` (starter
placeholders superseded by the portal).
Docs: `docs/00`–`docs/16`.

## Migrations

None required (fresh schema on an empty starter database). The dev seed inserts
synthetic demo data only when the database is empty.

## Tests

No automated test suite exists in the repository yet (none was present at
session start). Manual verification performed: Convex codegen + full TypeScript
typecheck pass. Test strategy and first suites are the next recommended task
(doc 13).

## Build result

- `bun convex dev --once`: functions deployed, no errors.
- `bun tsc -b --noEmit`: clean.

## Unresolved issues / known risks

1. Evidence attachment UI not yet wired into field forms (backend ready).
2. Evidence fetch ACL is authentication-only at the URL layer (doc 04).
3. Public report endpoint lacks dedicated rate limiting.
4. No automated tests yet.
5. `schemaValidation: false` retained from starter; tightening planned.
6. Operator experience is a reduced staff surface, not a dedicated portal.
7. Seed template/inspection `answers` shape assumes `si:qi` keys — template
   editing UI does not exist yet.

## Next recommended task

Evidence attachment flow in the field forms (doc 07 "Field UI"), followed by the
first automated test suites (doc 13) and rate limiting on public endpoints.
