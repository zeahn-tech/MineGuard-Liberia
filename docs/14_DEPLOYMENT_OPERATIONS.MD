# 14 — Deployment & Operations

**Status:** dev deployment verified (GitHub Pages via `deploy-pages.yml`, all
gates green). PRODUCTION deploy path + backup schedule IMPLEMENTED 2026-09-27
(Priority D): `.github/workflows/deploy-production.yml`,
`.github/workflows/backup.yml`, `scripts/backup-supabase.sh`,
`scripts/restore-supabase.sh`. Owner prerequisites below remain (project ref +
DB password as repository variables/secrets; GitHub environment `production`
with required reviewers).

## Current topology

- Vite SPA (Freebuff-managed dev server, HMR disabled by platform policy).
- **Static-hosting ready** (added 2026-09): `HashRouter` (deep links work on
  any static host), repository-aware `base` path, offline service worker
  (`public/sw.js`), installable PWA manifest with generated Papery icons
  (`public/icons/`, regenerate via `bun run icons`). GitHub Pages deployment
  ships via `.github/workflows/deploy-pages.yml` (Settings → Pages → Source:
  GitHub Actions). Other static hosts: `bun run build` → serve `dist/`.
- Supabase project (Postgres + Auth + Storage under the Supabase project;
  migrations in `supabase/migrations/` are the schema source of truth):
  - **Postgres** — all domain data (tables per doc 03), RLS-enforced.
  - **Auth (GoTrue)** — email/password; TOTP MFA supported (doc 04, Gap #4).
  - **Storage** — evidence media under the uid-first-folder contract.
- No standalone API servers; no containers to manage.
- Environment identity: public client identifiers by design; security is in
  RLS + the authorization core, not config secrecy.

## Environments

| Environment | Purpose | Data | Deploy mechanism |
|-------------|---------|------|------------------|
| Development | Feature work; demo seed allowed | Synthetic only | push to main → `deploy-pages.yml` |
| Production | Pilot operations; seed disabled | Real records | manual `deploy-production.yml` |

## Production deploy path [IMPLEMENTED 2026-09-27]

**One-time owner prerequisites:**

1. Create the Supabase **production project**; run all migrations
   (`supabase/migrations/*.sql`) against it.
2. GitHub repository **variable** `SUPABASE_PROJECT_REF` (production ref) and
   **secret** `SUPABASE_DB_PASSWORD` (production DB password).
3. GitHub **environment** `production` with **required reviewers** — the
   human approval gate for every production deploy.
4. GitHub Pages enabled with Source: GitHub Actions.

**The deploy workflow (`deploy-production.yml`) — differences from dev, by
design:**

1. **Manual gate only.** `workflow_dispatch` with a typed confirmation phrase
   (`deploy-production`) plus the `production` environment's required
   reviewers. Production deploys are deliberate acts, never a push side
   effect.
2. **Forced fresh backup first.** The `guard` job runs
   `scripts/backup-supabase.sh` and uploads the dump (90-day retention) — the
   deploy job `needs: guard`, so **no production deploy ever proceeds without
   a current recovery point**. Typecheck + full test suite must also pass
   before any deploy step.
3. **Production build flags.** `VITE_MINEGUARD_ENV=production` — the demo
   seed button is compiled out of the UI and the seed call site refuses the
   action (defense in depth; item 4 of the deploy checklist).
4. **Deploy verification.** Post-deploy, the workflow requires the production
   endpoint to answer HTTP 200 or FAILS — a half-shipped deploy is loud, not
   silent. A bundle sanity check also fails the build if the demo-seed UI
   ever reappears in a production artifact.

Rollback: redeploy the previous known-good artifact (Pages keeps deployment
history) and, for data-level incidents, the restore path below.

## Backup schedule [IMPLEMENTED 2026-09-27]

| Property | Value |
|---|---|
| Schedule | **Nightly 03:30 UTC** (`cron: "30 3 * * *"`) |
| Rationale | Field ops run ~08:00–17:00 GMT; 03:30 UTC is inside the local quiet window and after end-of-day offline-queue replays have synced |
| Method | `pg_dump -Fc` (custom format) via `scripts/backup-supabase.sh` |
| Integrity | Every archive verified with `pg_restore --list` in-run; SHA-256 checksum + size recorded in a per-backup `MANIFEST.txt` |
| Storage | GitHub Actions artifact, **90-day retention**; weekly prune job deletes stale `db-backup-*` artifacts so the retention promise matches reality |
| Verification | **Weekly restore drill** (Sunday run): the newest dump is restored into a throwaway Postgres 16 container inside the job, and `sites`/`inspections`/`audit_log` row counts are printed as the drill record |
| Failure mode | Missing dump (`if-no-files-found: error`) or corrupt archive fails the run loudly — backups never stop silently |
| Pre-deploy | A fresh backup is also forced before EVERY production deploy |

**Owner decision (not yet taken):** copying dumps to object storage
(off-GitHub residency/cost) is left to the owner; the script intentionally
performs no third-party upload. A higher-frequency schedule (e.g. hourly
WAL/PITR via Supabase) is a PROPOSED upgrade requiring owner confirmation.

## Restore path & drill [IMPLEMENTED 2026-09-27 · REHEARSAL EXECUTED 2026-09-28 — PASS]

`scripts/restore-supabase.sh <path/to/db.dump>`:

- Requires `TARGET_DB_URL` and a **typed `restore` confirmation** — an
  accidental bare invocation cannot overwrite a database, and the script
  warns to confirm the target is not production.
- Restores with `pg_restore --clean --if-exists --no-owner --no-privileges`.
- Prints the drill sanity checks to record: row counts for `sites`,
  `inspections`, `audit_log`, and the newest `audit_log.created_at` (must be
  inside the backup window).

**The drill** (repeatable, and automated weekly in `backup.yml`): restore the
latest dump into a throwaway target (scratch Postgres container or scratch
Supabase project), record the sanity-check output, delete the target. Never
restore over live production without an explicit, dated incident decision.

### Rehearsal record [EXECUTED 2026-09-28 — PASS]

Full record: `docs/drills/restore-rehearsal-2026-09-28.md`. Summary of the
executed rehearsal (real clusters, real dump, not a simulation):

- **Source**: local PostgreSQL 14.24 with all 8 migrations applied plus the
  Supabase platform surface (roles, auth schema incl. MFA tables, storage
  schema) and representative seed data (14 data tables populated).
- **Backup executed**: `pg_dump -Fc` (144,876 bytes), sha256 recorded in
  manifest, archive verified with `pg_restore --list` — the exact
  `scripts/backup-supabase.sh` logic.
- **Post-backup drift test**: new rows (a site, a profile, an audit
  `drift.marker` row) were written to the source AFTER the backup. The
  restored copy must not contain them.
- **Restore executed**: `pg_restore --clean --if-exists` into a fresh
  `initdb` scratch cluster — zero errors after pre-creating the three
  Supabase platform roles (cluster-level objects that `pg_dump` does not
  emit; Supabase provisions them in production).
- **Verification (all PASS)**: schema identical (15 tables / 33 policies /
  19 triggers / 96 routines); all 14 row counts identical to baseline; drift
  rows ABSENT from the restore while present in the live source (point-in-
  time invariant proven); RLS live on the restored copy (anon 0 rows,
  operator only own-tenant `LB-BOM-001`, admin 2 rows); guard trigger intact
  (operator site-write → `FORBIDDEN: admin required to modify the site
  registry`); a real INSERT round-trips; 0008's delete policy present.

**Runbook additions learned from the rehearsal** (real-Supabase restore
procedure): (1) pre-create the platform roles `anon`, `authenticated`,
`service_role` on the target before `pg_restore`; (2) re-apply schema grants
for those roles after restore on a non-Supabase target (on Supabase the
platform re-provisions them); (3) GoTrue credential data (password hashes,
MFA secrets) is platform-managed — after a database-level restore, re-sync
auth users via Supabase's auth admin tooling (`supabase auth export/import`)
before sign-in works.

## One-time activation checklist [REQUIRED — project owner]

1. **Create the production Supabase project** and apply all migrations.
2. **Deploy security posture**: RLS is schema-defined via migrations; verify
   `pg_restore --list` output includes the RLS policies and `mg_guard_*`
   triggers after a restore.
3. **First admin bootstrap** — sign in on the app with an email/password
   account and complete the staff profile; the first profile becomes the
   platform administrator (guarded bootstrap; audit logged). All further
   roles are assigned through *Assign roles*.
4. Configure the repository variable/secret + environment `production` (see
   deploy path above).

## Environment variables

No backend keys are required in the client. Public client identifiers live in
the repo by design — authorization never depends on their secrecy. Server
credentials (production DB password) live ONLY in GitHub Actions secrets and
Supabase; they never enter the client bundle.

Build-time flag: `VITE_MINEGUARD_ENV=production` disables demo seeding
(button + call site + bundle-level CI check).

## Deployment checklist (pilot)

1. Typecheck + tests green in CI (both workflows enforce this).
2. Production Supabase project live with all migrations applied.
3. First admin account bootstrapped; then all other roles assigned through
   the admin UI (`provisionByEmail` requires the target to have signed in
   once).
4. **Demo seeder disabled in production builds** — implemented + CI-verified
   (`VITE_MINEGUARD_ENV=production`).
5. Custom domain added to Supabase Auth allowed domains (and to the hosting
   provider if not using the platform domain).
6. **Backups: nightly schedule live; restore drill recorded** — implemented;
   owner completes the prerequisites so the first scheduled run executes.
7. Tile source reviewed (self-host or vendor) for reliability.

## Operational runbook notes

- **Seeded demo data:** clearly stamped "Synthetic demonstration record" in
  site notes; audit entry `system.seed` records the run. Impossible in
  production builds (see deploy path).
- **Role provisioning:** requires the target email to sign in once; audit
  logged as `user.role.set`.
- **Sync incidents:** field users can force sync from the topbar; queued
  items persist across sessions; check `mg.offline.queue.v1` contents when
  supporting a field device.
- **Audit review:** `/portal/audit` shows the last 200 entries; longer
  retention requires an export job [PLANNED]. The audit log IS included in
  every nightly backup.

## Monitoring [PLANNED]

- Supabase dashboard: DB usage, auth events, RLS denial signals.
- Client-side error boundary reporting (currently console-only).
- Uptime probe on the SPA (the deploy workflow probes once at deploy; a
  standing probe is PLANNED).

## Known operational limits

- Evidence storage growth unbounded except the 25 MB/file cap; footprint
  metric exists (`storageFootprint`), retention policy needs government
  confirmation.
- Single-region deployment (Supabase default); disaster recovery = nightly
  dumps + weekly restore drills + documented restore path. PITR (point-in-
  time) is a Supabase plan-tier upgrade [PROPOSED].
- Security rules cannot fully express county-scoped list filters; enforced in
  the data layer (see doc 04, gap 5).
- Backup artifacts live in the repository's Actions storage — acceptable for
  pilot; object-storage offload is the owner decision noted above.
