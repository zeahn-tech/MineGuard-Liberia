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
