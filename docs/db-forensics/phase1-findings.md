# Phase 1 findings — production database vs repository (read-only investigation)

Method: clone of the repository; clean build of 0001–0054 in PGlite; read-only fingerprint (functions, policies, triggers, constraints, RLS flags) and targeted probes run against production by the owner; nothing was applied or changed.

| Sev | Finding | Evidence | Status |
|---|---|---|---|
| CRITICAL | Git root was the Windows user profile (`C:/Users/EmmanuelZeahn`), MineGuard at `Downloads/MineGuard-Liberia/` | `git rev-parse --show-toplevel/--show-prefix` | **open — local action**: work from a fresh clone of the real repo; leave the parent `.git` untouched until inspected |
| CRITICAL | Production's site access check and policies on sites/incidents/inspections/findings/evidence/corrective_actions/observations use the legacy county/operator-name model; 0025/0027 rules (company approval, membership, site assignment) are not enforced there | live bodies of `mg_can_access_site(uuid)` (the 0007 version) and `* select scoped` policies | **fixed in code (0055), proven in the engine, not yet applied** |
| HIGH | Production base schema predates the repo's `0001`: legacy policies/functions/triggers no migration creates; 12 repo policies absent | fingerprint diff | 0055 retires the legacy policies; legacy functions/columns left for a reviewed follow-up |
| HIGH | 0046b and 0047–0054 are applied (objects present) but unrecorded; second `0046` only proven by object presence | `migration list`, `migration_state.sql`, probe | **open — needs the reconciliation decision** (docs/db-deployment.md) |
| HIGH | Applied migrations were edited afterwards (e.g. 0011 ≈7 times) | `git log` | process fixed: validator + policy file; history of past edits unrecoverable |
| HIGH | No migration pipeline; `deploy-account-delete.yml` unpinned CLI, `--yes`, unverified `--remote` flag | workflows | pipeline added; old workflow left untouched, superseded |
| MEDIUM | `authenticated` held TRUNCATE on 21 tables incl. `audit_log` (REST API cannot issue TRUNCATE) | grants probe | fixed in code (0056), not yet applied |
| MEDIUM | Nine worker-voice functions and `mg_guard_finding_update` differ in text from the repo | CRLF-normalised fingerprint | open — live bodies needed to judge behaviour; replay of 0052 on staging will show |
| MEDIUM | `supabase/.temp` tracked in git; no `config.toml` | `git ls-files` | `.temp` untracked and ignored; `config.toml` not needed by the pipeline (`--linked`, `--use-api`); required only for local `supabase start`/`functions serve` |
| LOW | Audit forgery via REST is **not** possible (no INSERT grant); the stray `audit insert authenticated` policy is inert (dropped by 0055) | grants probe | closed |
| LOW | CRLF line endings inside some live function bodies (applied from Windows files) | probe | validator now rejects CRLF in migrations |

## Status update 2026-11-13 — migrations 0055 and 0056 applied directly to production
Applied through the Supabase connection (not via the pipeline, which cannot run yet — see docs/db-deployment.md), after:
- a read-only capture of every object changed, saved as `supabase/maintenance/restore_pre_0055_production.sql`;
- a rollback-only dry run on production's real state (migration ran cleanly; resulting policy sets as intended).

The two migrations were run as single atomic statement batches with the body of the repo files (comments and
begin/commit removed). **Neither is recorded in `supabase_migrations.schema_migrations`** — recording 0055/0056 while
0046b and 0047-0054 are unrecorded would make the history out of order. The pipeline will later find them pending and
re-apply them; both are idempotent.

Verified live afterwards:
- `supabase/checks/security_posture.sql` passes (RLS on every table, no legacy policies, organisation-aware
  `mg_can_access_site(uuid)`, no client TRUNCATE, no client writes to audit_log).
- Read-only session check per account (rolled back): each company user sees exactly their own company's sites
  (1 of 1, 1 of 1, 2 of 2); Ministry administrators and the national supervisor see all 8; a revoked member and an
  account with no role see none.

Not verified live: a site manager assigned to *part* of a multi-site company (production's data has no such case;
covered by tests/phase-e-legacy-access-retirement.test.ts on a rebuilt legacy state).
Still open: the duplicate `0046`, the unrecorded `0047_worker_voice`/`0047`-`0054`, 9 worker-voice functions whose text
differs from the repo, legacy functions still callable over RPC, leaked-password protection disabled (Auth setting).

## Staging rehearsal result 2026-11-14 (production schema + 0047-0057, no data)
Migrations 0047-0057 applied to staging's copy of production's schema without error; history comparison clean before and after.
Fingerprint against a clean build of the repo: equal 1525, differs 11, missing-live 20, live-only 30. Reviewed:
- **Differs (11)** — all cosmetic: five identity helpers (`mg_is_admin`, `mg_is_staff`, `mg_is_reviewer`, `mg_profile`, `mg_role`) differ only in text; three policies differ only in an older column-alias list; `community_reports_len_chk` is `NOT VALID` in production; `rate_limits.window_start` is nullable in production; `mg_guard_finding_update` in production is STRICTER (open -> acknowledged, own company only).
- **Missing-live (20)** — 15 triggers + 4 functions + 1 FK. Legacy-named equivalents exist for the stamp/guard triggers on incidents, observations, evidence, findings, corrective actions, inspections and profiles (production's incident/observation guard `mg_guard_staff_update` is stricter than the repo's). **Four had no equivalent:** `community_reports_guard`, `inspection_templates_guard`, `sites_guard`, `sites_rescope` (the report guard protects ownership, tracking code and status transitions) — fixed by migration 0058. Not fixed: `audit_log_actor_id_fkey` (integrity only; existing rows may violate it).
- **Live-only (30)** — legacy functions (`mg_is_operator`, `mg_can_access_site(text,text)`, `mg_can_access_site_row(text,text)`, `mg_can_read_county_rows`, `mg_guard_staff_update`, `mg_stamp_site`, `rls_auto_enable`), the public mirror and seed policies, legacy-named triggers, `inspections.county/operator_name`. No migration creates them and none grants access now that the legacy policies are gone; they need their own cleanup review.
0058 was dry-run on production's real state in a rolled-back transaction (all four triggers attach).

## Cleanup 2026-11-15 — what survived in production, what was fixed, what was kept
After the pipeline went live, a read-only inventory (pg_depend, policy/function text, app and edge-function code, grants) of the 30 live-only objects found three more things the earlier `public`-schema-only comparison could not see:
- **Storage:** policy `evidence storage read` on `storage.objects` still read evidence FILES by the legacy county/operator-name match (migration 0002 explicitly drops it). **Fixed in 0060.** The fingerprint and posture check now cover the `storage` schema.
- **Tracking codes:** `tracking select public` (USING true) let any signed-in account list every tracking code and status, defeating the rate-limited `track_community_report()` lookup. The app only reads the table directly as a fallback when that function is missing. **Dropped in 0060.**
- **Function execute rights:** `anon` could execute `mg_backfill_scope_stamps()`, `mg_guard_report_update()` and `mg_operator_name()` (the first two are trigger functions and not callable as RPC, but the repo grants none). The first and third were created by 0058 without the repo's revokes. **Fixed in 0060**; the posture check now fails if the anonymous surface differs from the 12 intended public RPCs.

Also in 0060 (convergence): the legacy `guard_*`/`stamp_site_*` triggers and `mg_guard_staff_update`, `mg_stamp_site`, `mg_is_operator`, `mg_can_access_site(text,text)`, `mg_can_access_site_row(text,text)`, `mg_can_read_county_rows` are replaced by the repo's triggers and functions; `inspections.county/operator_name` and their indexes are dropped (no reader anywhere); the five identity helpers and three policies take the repo's text.
Behaviour differences to know: operators can no longer acknowledge only from `open` (the repo's tested rule is "can acknowledge, cannot resolve"); incident/observation updates by non-staff are now allowed for an operator with site access when status is unchanged (the RLS update policies still require staff).

**Kept on purpose** (reviewed, listed in the 0060 header): `rls_auto_enable()` and its `ensure_rls` event trigger (Supabase's own); `meta select public` (aggregated public statistics only); the `admin seed` write policies and `tracking update` (they back the app's demo-seeding feature); `community_reports.rate_bucket`, `meta.updated_at`, `rate_limits.updated_at`, `rate_limits.window_start` nullability; `community_reports_description_check` and the NOT VALID `len_chk`; `audit_log_actor_id_fkey` (4 of 160 audit rows reference deleted accounts and audit rows are immutable — adding the FK would need a deliberate decision about those rows).
Verification: 0060 was dry-run on production's real state in a rolled-back transaction; `tests/phase-e-legacy-cleanup.test.ts` rebuilds production's captured legacy layer on a clean build and requires the full fingerprint (now including storage policies and function execute rights) to equal the clean build after 0060.
