# 14 — Deployment & Operations

**Status:** development deployment operational; production hardening planned.

## Current topology

- Vite SPA (Freebuff-managed dev server, HMR disabled by platform policy).
- Convex deployment: functions pushed with `bun convex dev --once` in this
  environment; production would use `bun convex deploy` from CI.
- No standalone API servers; no containers to manage.

## Environments

| Environment | Purpose | Data |
|-------------|---------|------|
| Development | Feature work; demo seed allowed | Synthetic only |
| Production (future) | Pilot operations | Real records; seed prohibited |

## Deployment checklist (pilot) [PLANNED]

1. `bun run build` + typecheck green in CI.
2. Convex functions deployed; schema validation tightened.
3. First admin account provisioned via `provisionByEmail` after signup; then
   all other roles assigned through the admin UI.
4. Demo seeder disabled/removed in production builds.
5. Custom domain + HTTPS (platform-managed).
6. Backups: Convex deployment snapshots scheduled; restore tested.
7. Tile source reviewed (self-host or vendor) for reliability.

## Operational runbook notes

- **Seeded demo data:** clearly stamped "Synthetic demonstration record" in site
  notes; audit entry `system.seed` records the run. Never run in production.
- **Role provisioning:** requires the target email to sign in once; audit logged
  as `user.role.set`.
- **Sync incidents:** field users can force sync from the topbar; queued items
  persist across sessions; check `mg.offline.queue.v1` contents when supporting
  a field device.
- **Audit review:** `/portal/audit` shows the last 200 entries; longer retention
  requires an export job [PLANNED].

## Monitoring [PLANNED]

- Convex dashboard function error rates.
- Client-side error boundary reporting (currently console-only).
- Uptime probe on the SPA and Convex endpoint.

## Known operational limits

- Evidence storage growth unbounded except the 25 MB/file cap; footprint metric
  exists (`storageFootprint`), retention policy needs government confirmation.
- Single-region deployment (platform default); disaster recovery = platform
  snapshots + documented restore test.
