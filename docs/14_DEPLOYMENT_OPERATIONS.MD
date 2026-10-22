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
  (`public/sw.js`), installable PWA manifest with the MineGuard Liberia
  brand icons (`public/icons/`; SVG masters and export steps in `branding/`). GitHub Pages deployment
  ships via `.github/workflows/deploy-pages.yml` (Settings → Pages → Source:
  GitHub Actions). Other static hosts: `bun run build` → serve `dist/`.
  **`.nojekyll` ships in `public/` and is also forced into `dist/` by both
  deploy workflows (added 2026-09-29): without it, GitHub Pages runs Jekyll
  over the bundle and 404s `manifest.webmanifest` (observed live).**
- Supabase project (Postgres + Auth + Storage under the Supabase project;
  migrations in `supabase/migrations/` are the schema source of truth):
  - **Postgres** — all domain data (tables per doc 03), RLS-enforced.
    **Migration state [2026-10-06, offline-reliability Session 4]:** repo
    carries 0001–0013. The live project runs 0001–0011 (the owner applied
    0009–0011 through the SQL Editor; probe-verified — doc 11). **0012
    (`mg_command_center_stats`, doc 11 SEC-4) and 0013 (offline reliability:
    evidence parents, sha256, site-less evidence — doc 11 Session 4) both
    still need `supabase db push` — or SQL-Editor runs of the two files, in
    filename order — by the owner.**
    Until 0012 lands, the live Command Center serves from the client-side
    fallback: paged reads aggregated in the browser (exact at any table
    size, heavier on the wire, one console warning saying so). Every other
    SEC-4 guarantee is client code and already live: whole-table reads page
    with an explicit Range past PostgREST's 1,000-row `db-max-rows` cap,
    so no statistic, risk score or export is silently truncated. Do not
    assume the 0012 RPC exists on the live project until it is pushed.
    Until 0013 lands, the two NEW evidence parents fail server-side (enum
    values absent) and their UI should stay untested live; the existing
    three parents degrade gracefully — the data layer's sha256 insert
    retries without the digest when the column is missing (one console
    warning), so inspection/incident/observation evidence keeps working on
    the pre-0013 schema. Push 0012 then 0013 together.
    **2026-10-06 — first live 0013 attempt aborted with 42704
    (`type "public.evidence_parent" does not exist`):** the live lineage
    has no such enum and the original label-only guard failed open. 0013
    is now lineage-adaptive — labels resolve from the
    `evidence.parent_type` column itself (enum anywhere → schema-qualified
    ADD VALUE; text → NOTICE), `evidence_for_parent` matches parent types
    as text, and evidence policies converge to the canonical two names
    before recreate. The failed run was transactional (SQL Editor applies
    each file in one transaction — nothing landed); re-run the fixed 0013
    file whole, then verify: labels/policies/functions below.
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

## Making someone an administrator [ADDED 2026-10-13]

**Symptom:** an account that should be an administrator opens the **operator**
screen. **Cause:** the app routes by `public.profiles.role`; a profile whose role
is `operator` goes to `#/operate`, an `admin` goes to `#/portal` (confirmed in
the real app). MineGuard has no `users.system_role` / `platform_admin` — SQL
written for another application's schema (e.g. `update public.users set
system_role = 'platform_admin' …`) changes nothing here, and, run in a different
Supabase project, changes *that* project's data instead. Always confirm the
dashboard URL contains the project ref from `src/lib/supabase.ts`
(`ewukneoblhogtreeekqc`) before running anything.

Procedure:

1. The person signs in to MineGuard once — **Create account** on the Staff
   sign-in page if they have none. That creates their row in `public.profiles`.
2. In the SQL Editor of the **MineGuard project**, check the current state:
   ```sql
   select id, email, role, scope, county, operator_name, profile_complete
     from public.profiles
    where lower(email) = lower('person@example.org');
   ```
   No row = step 1 was not done (or this is the wrong project).
3. Run `supabase/maintenance/promote_to_admin.sql` after editing its single
   email line (or via `bun scripts/db-sql.ts supabase/maintenance/promote_to_admin.sql`).
   It sets `role = 'admin'`, `scope = 'national'`, clears `county` /
   `operator_name` (which also removes an operator's organisation link), and
   marks the profile complete. It returns the updated row; **zero rows means no
   profile matched** and nothing changed. It is recorded in the audit trail and
   is safe to run twice. (`tests/admin-promotion.test.ts` runs it against the real
   schema.)
4. The person **signs out and back in** (the role is read at sign-in).

After the first admin exists, further roles are managed in the app itself
(Users page → set role), not in SQL.

## Phones, weak connections, and "Still loading your account" [HARDENED 2026-10-13]

**Reproduced** in a real browser (headless Chromium, phone viewport, the built
app with its network answered locally). Two defects, both fixed:

1. **A stalled request waited forever.** When the profile read neither succeeded
   nor failed (mobile data, captive Wi-Fi, a tab waking from the background) the
   app made *one* request in 17 s and never retried — the retry loop only ran
   after a thrown error. Every read now has a time limit (15 s for a single row,
   30 s for lists, 60 s for the map's multi-table feed), the stalled request is
   **cancelled**, and it retries with backoff. When the tab becomes visible or
   the connection returns, a failed or stale read re-runs immediately, and a
   read that has been stalled for several seconds is replaced instead of awaited.
2. **The real reason was only in a console.** Phones have none. The screen now
   shows "What we found: …" with the actual message and the table it concerned,
   and a **Sign out and start over** button (drops this device's sign-in only —
   queued offline work is untouched), because **Try again** just reloads into
   the same state.

Reading the message:

| "What we found" | Meaning | Do |
|---|---|---|
| *The server did not answer within N seconds.* | Network stall, or the Supabase project is **paused** (free projects pause when idle) | Check the project is *Active*; it keeps retrying and continues by itself when reachable |
| *Load failed* / *Failed to fetch* | The device cannot reach the server (offline, blocked, wrong URL/key) | Check the connection; verify `src/lib/supabase.ts` points at the right project |
| *JWT expired* / *Invalid Refresh Token* / auth messages | A stale or poisoned session on this device | **Sign out and start over** |
| *permission denied for table …* / *relation … does not exist* | Database side: policies or migrations | Run `supabase/checks/migration_state.sql`, apply what is missing |
| *The server returned an error page instead of data.* | A gateway/CDN error (HTML) in front of Supabase | Check Supabase status; retry later |
| *(no message yet)* | Nothing has come back yet | Wait; the screen updates by itself |

Other phone-specific protections added with it:

* **Service worker navigation is bounded.** It stays network-first, but a page
  request that has not answered within 5 s now shows the cached shell (and keeps
  refreshing the cache in the background) instead of leaving a blank page. The
  worker version is `v1.2.0`; older shell caches are purged on activate.
* **Stale app shell after a deploy.** A phone holding the old shell asks for page
  chunks that no longer exist (blank screen). One automatic reload per session
  fetches the new shell (`vite:preloadError`, `src/lib/chunk-recovery.ts`); it
  never loops.

## Applying migrations safely [INCIDENT 2026-10-11 → HARDENED]

**The only database this app uses is Supabase project ref
`ewukneoblhogtreeekqc`** (`src/lib/supabase.ts`; `scripts/db-sql.ts` is wired to
the same ref). **Incident:** migrations 0015–0018 were pasted into the SQL Editor
of a *different* project in the same account (an unrelated application) and
failed with `relation "public.sites" does not exist`. A read-only inspection
confirmed the failed runs left nothing behind (each run is one transaction).
Since then 0015–0018 begin with a precondition that stops with a plain
explanation ("base schema is missing — wrong project, or earlier migrations not
applied"), covered by `tests/migration-guards.test.ts`.

Procedure — every time:

1. **Check what is applied** in the right project: run
   `supabase/checks/migration_state.sql` (read-only; one row per migration,
   `true`/`false`). In the SQL Editor, first confirm the dashboard URL contains
   `…/project/ewukneoblhogtreeekqc`. Or:
   `SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts supabase/checks/migration_state.sql`
2. **Apply every migration that shows `false`, in filename order**, with the
   runner (it cannot reach another project, stops at the first failure and runs
   the files strictly in the order given):
   `SUPABASE_ACCESS_TOKEN=<token> bun scripts/db-sql.ts supabase/migrations/0012_*.sql supabase/migrations/0013_*.sql …`
   (SQL-Editor alternative: one file at a time, in the right project.)
3. **Re-run the check** until every row is `true`, then reload the app.
4. **Optional data seed:** the official county/district boundaries
   (`supabase/seeds/liberia_boundaries_geoboundaries.sql`, see doc 06) — only
   after step 3 shows 0015/0016 as `true`. Same runner, same project.

Note the state recorded above (live project at 0001–0011 as of 2026-10-06):
0012–0014 may still be pending there, and 0015 requires them to be applied
first. Never skip a migration to reach a later one.

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

- **Source**: local PostgreSQL 14.24 with all 12 migrations applied plus the
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

## Incident 2026-09-29: blank screen + manifest 404 on GitHub Pages [ROOT-CAUSED]

**Symptom:** the Pages site rendered a blank screen; `manifest.webmanifest`
and every asset 404'd.

**Diagnosis (from the served HTML):** the live page contained the raw dev
template (`<script src="/src/main.tsx">`) and **zero** built assets — GitHub
Pages was serving the repository's `index.html` (i.e. the branch), not the
workflow's `dist/` artifact. A raw `.tsx` entry cannot execute in a browser,
hence the blank screen; the manifest 404 was the same plumbing failure, not
a missing file (`dist/manifest.webmanifest` is verified present by the
workflow's sanity check).

**Contributing cause:** the workflow's `bun test` step exited 1 (the
risk-model regression + AI-test order sensitivity, fixed 2026-09-29), so the
deploy job never ran and the broken state persisted.

**Fixes applied in-repo:**
1. Test failures fixed (see docs/11 — risk-model score invariant +
   order-tolerant AI suite).
2. `deploy-pages.yml` now verifies post-deploy that the served page contains
   the built bundle (`/assets/index-…`) **and** `manifest.webmanifest`
   answers 200 — a stale/wrong-source deployment fails loudly instead of
   showing a blank screen.
3. Build sanity check rejects an `index.html` that still references
   `/src/main.tsx` or lacks the `/<repo>/assets/` base path.

**Owner action required (cannot be done from the repo):**
- GitHub **Settings → Pages → Build and deployment → Source** must be
  **"GitHub Actions"** (not "Deploy from a branch"). With the wrong source,
  the workflow's artifact is ignored and the branch is served — exactly the
  observed failure.
- After switching, run the workflow once (push or *Actions → Deploy to
  GitHub Pages → Run workflow*); the new verification step then proves the
  bundle + manifest are live.

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

## Deploying the AI assistant [Session 8 — AI-1]
1. Apply `supabase/migrations/0020_ai_request_log.sql` (idempotent; needs 0010 and 0009).
2. `supabase functions deploy ai-assist` — keep **verify JWT on** (the default). The
   function needs only `SUPABASE_URL` and `SUPABASE_ANON_KEY`, which the platform injects.
   Do **not** give it a service-role key.
3. Optional: `AI_ALLOWED_ORIGIN` secret to restrict CORS to the deployed site origin.
4. Provider secrets (`AI_PROVIDER_APPROVED`, `AI_PROVIDER_ID`, `AI_PROVIDER_API_KEY`) are
   **not to be set** until the owner approves a provider and a reviewed adapter is added.
   With them unset the function is fully functional on its deterministic path.
5. Review `select * from ai_request_log order by created_at desc` (administrators see
   all rows; others see their own). `injection_flagged = true` rows deserve a look.

## Deploying notifications, trends and the summary report [Session 9]
1. Apply `supabase/migrations/0021_notifications_trends_reporting.sql` (idempotent; needs
   0010, 0012 and 0019). Re-running 0011 afterwards is safe — its allowlist carries the
   new functions.
2. Verify with `supabase/checks/migration_state.sql` (row `0021 …` reads `true`).
3. No secrets, Edge Functions or provider accounts are involved. Notification rows hold
   in-app text only; retention/purge of old rows is an open owner decision (run as the
   migration owner — clients cannot delete).
