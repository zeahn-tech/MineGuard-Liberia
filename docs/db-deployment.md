# Database deployment (Supabase production)

Production project ref: `ewukneoblhogtreeekqc` (the project **URL** is derived from it; they are not interchangeable).
Migrations reach production only through `.github/workflows/db-migrate.yml`. Nobody runs `supabase db push`, `migration repair` or `db reset` by hand against production.

## What the pipeline does (in order, stops at the first failure)
1. **validate** — main branch only; `scripts/db/cli.mjs validate` (names, unique versions, LF endings, `begin;/commit;`, destructive-statement gate); then only the tests that touch the changed database objects (`select-tests`), plus the structural suites.
2. **plan** — checks secrets and that the project ref is the expected one; pinned Supabase CLI **2.122.0**; `supabase migration list --linked`; `cli.mjs compare` (fails on duplicate versions, remote-only versions, out-of-order versions, or hand-applied versions below `firstManagedVersion`); `supabase db push --linked --dry-run`.
3. **apply** — waits for approval on the `production` GitHub environment; re-checks history; captures the current access layer as an artifact; `supabase db push --linked --yes`; verifies the history shows nothing pending; runs `supabase/checks/security_posture.sql` and `admin_present.sql`.
4. **functions** — only when `supabase/functions/**` changed and the database is at the right version. `worker-voice-push` is deployed with `--no-verify-jwt` (its source documents this); the others keep JWT verification on. All use `--use-api` (no Docker).

Concurrency group `production-db-migrations` (never cancelled mid-apply) means two deployments cannot run at once. `--yes` is used once, with the reason in the workflow: CI is non-interactive and the human decision is the environment approval plus the dry-run output. `--include-all`, `--include-seed`, `migration repair` and `db reset` are not used anywhere.

## Secrets and settings
| Name | Where | Purpose |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | GitHub secret | CLI authentication (a personal access token from Supabase) |
| `SUPABASE_DB_PASSWORD` | GitHub secret | database password for `link` / `db push` |
| `SUPABASE_PROJECT_REF` | GitHub secret | must equal `ewukneoblhogtreeekqc`; the workflow refuses anything else |
| `SUPABASE_DB_URL` | GitHub secret (environment `production`) | Postgres connection string for the read-only verification scripts; must contain the project ref |
| `BACKUP_PASSPHRASE`, backup settings | unchanged | used by the existing `backup.yml`; this pipeline does not touch them |
| function secrets (`VAPID_*`, `WORKER_VOICE_PUSH_SECRET`, `EMERGENCY_SWEEP_SECRET`, `INVITE_ALLOWED_ORIGIN`) | **Supabase** secrets (`supabase secrets set`) | read by the Edge Functions at runtime; not GitHub secrets |

One-time GitHub setup: create environment **production** and add required reviewers; protect `main` (reviewed PRs only); add the secrets above. Nothing is printed: secrets are masked by GitHub and the scripts never echo them.

## Reconciliation: converge in place (chosen) — first production run
Decision: **converge in place**, not rebuild. A rebuild would delete the profile/administrator rows (existing auth users would be left without profiles and no administrator could sign in until `promote_to_admin.sql`), and is unnecessary: production already matches the repo except for the documented items.

What was done in the repo:
1. The duplicate `0046` was removed by renumbering the *unrecorded* files (formerly `0046_worker_voice` … `0054_company_member_discipline`) up by one, to `0047`–`0055`, and the two migrations applied by hand on 2026-11-13 are now `0056`/`0057` (table: `supabase/migration-renumbering.md`). Recorded history (0001–0046) is untouched.
2. `supabase/migration-policy.json`: `firstManagedVersion = 0047`, no pinned duplicates. `compare` now sees exactly 0047–0057 pending against production's history and refuses nothing — verified by `tests/db-pipeline.test.ts`.
3. `tests/migration-replay.test.ts` proves that replaying 0047 onward over a fully built database succeeds and changes nothing (PGlite).
4. The destructive-change gate scans top-level statements and DO blocks (not function bodies) for every migration from 0047; the replayed files contain none.

**What the first run does to production:** applies 0047–0057 (11 migrations) through `supabase db push`, each in its own transaction, so the history records them naturally. The objects mostly exist already; the replay also converges nine worker-voice functions whose live text differs from the repo and re-applies 0056/0057.

**Required before approving that first run (rehearsal).** The replay test uses a database built from the repo; production has a different base schema, so rehearse on a copy of production's schema first. The staging project is `MineGuard Liberia Staging` (ref `iwmgrcfmgqldrdkplbtr`).
1. Staging secrets (repository secrets, never the production values): `STAGING_PROJECT_REF` = `iwmgrcfmgqldrdkplbtr`; `STAGING_DB_PASSWORD` = the staging database password (Supabase dashboard → staging project → Settings → Database → Reset database password, then store it); `STAGING_DB_URL` = the staging connection string with that password (Connect → Session pooler or Direct; it must contain the staging ref).
2. Push the pull-request branch, then Actions → **Database rehearsal (staging)** → Run workflow on that branch, typing `STAGING` to confirm.
3. It (read-only on production, writes staging only): refuses if the target is production; dumps production's `public` schema (no data) and migration history; replaces staging's `public` schema with it; compares histories (must show exactly 0047 onward pending); dry-runs; applies; requires nothing pending afterwards; runs `security_posture.sql`; and reports a schema fingerprint of staging against a clean build of the repo.
4. Read the report (job summary). `DIFFERS` or `MISSING-LIVE` entries after the replay mean the replay did not converge that object — investigate before touching production. `LIVE-ONLY` entries are legacy objects no migration creates (known: the legacy functions, `inspections.county/operator_name`, the public mirror policies); they are not changed by this migration set and need their own review.
Only when the rehearsal is green, merge to `main` and approve the `production` environment for the first run. Never use `migration repair` to mark these as applied: the Phase 1 comparison showed production does not contain exactly their effect. The workflow has not been run yet; its first run is itself part of the rehearsal.

## Already applied by hand (2026-11-13)
Former `0055`/`0056` (now `0056`/`0057`) were applied to production directly, unrecorded (see docs/db-forensics/phase1-findings.md).
Recovery script: `supabase/maintenance/restore_pre_0055_production.sql` (reinstates the legacy behaviour; untested, review first).
The pipeline re-applies them idempotently as part of the first run.

## Local testing without Docker
- Static: `node scripts/db/cli.mjs validate`.
- Engine tests (clean build of every migration in PGlite; no Docker, no network): `bun test tests/migration-apply.test.ts tests/phase-e-legacy-access-retirement.test.ts tests/db-pipeline.test.ts` or the full `bun test --timeout 60000`. These prove behaviour in an *emulated* Supabase; they do not prove a migration executes on real Supabase.
- Integration/security on real Supabase: create a separate **staging** project, link it with `supabase link --project-ref <staging-ref>` and run the same pipeline steps against it before production.
- Post-deployment (production): `psql "$SUPABASE_DB_URL" -f supabase/checks/security_posture.sql`, `supabase/checks/admin_present.sql`, `supabase/checks/migration_state.sql`.

## Writing a migration
Next number only; `NNNN_snake_case.sql`; LF line endings; `begin;` … `commit;`; idempotent (`if not exists`, `or replace`, `drop … if exists`). Anything that drops a table/column/type/schema, truncates, deletes rows or changes a column type must contain `-- destructive-approved: <reason and recovery plan>`. Never edit an applied migration; ship a new one.

## Recovery
- Failed migration: each file is one transaction, so it rolls back atomically; fix forward with a new migration.
- Bad access-layer change: the `pre-apply-capture` artifact from the apply job holds the previous policies and access functions as restorable SQL.
- Data loss risk (drops/rewrites): take and verify a backup first. Supabase automatic backups depend on the plan (check the project's Database → Backups page); the existing `backup.yml` is a separate, encrypted, opt-in backup. This pipeline does **not** claim a backup exists and has no automatic rollback; a destructive migration needs a written recovery plan in its approval marker.
- No administrator: `supabase/maintenance/promote_to_admin.sql`.
