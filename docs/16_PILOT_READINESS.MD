# 16 — Pilot Readiness

**Assessment:** NOT production ready. This is a faithful, typed, working v1.0
platform core with honest gaps. Per the master directive, readiness claims
require evidence across the dimensions below.

## Readiness board

| Dimension | State | Evidence / gap |
|-----------|-------|----------------|
| Functionality | 🟡 Substantial | All core modules implemented end-to-end; operator section (§20), template editor (§11), camera/batch evidence (§10), minimal in-app notifications (§1), CSV reporting exports (§9), AI risk explanation (§18, first capability, doc 08) shipped, tested — push/email/SMS channels, PDF export, and further AI capabilities REQUIRES GOVERNMENT/OWNER CONFIRMATION |
| Security — authorization | 🟢 Core solid | Centralized authz core; every function guarded; scope + tenant isolation server-side |
| Security — hardening | 🟡 Gaps | Per-source report rate limiting + evidence signed-URL mint gate (0005/0006) done (repo + live, tested); TOTP MFA + password recovery done in repo (Gap #4, tested) — live project MFA/SMTP configuration + convergence pending |
| Data integrity | 🟢 Core solid | Provenance, lifecycle states, audit log, verification enums; unique-code guard pending |
| Offline behavior | 🟢 Inspections | Local-first, retry, dedupe; media offline queue pending |
| Synchronization | 🟢 Inspections | Idempotent clientRef sync; conflict strategy documented |
| Media | 🟢 Shipped | Storage pipeline + metadata + audit live; field UI with camera capture, batch multi-file byte progress, offline byte queue (§10, tested) |
| Performance | 🟢 Baseline | Pilot-scale baseline established (docs/17): all surfaces ≥17× under the 2 s budget (slowest: command center 115 ms, risk scores 111 ms at 40 sites/320 inspections/12.8k audit rows); bench re-runnable as regression gate — production load test [PLANNED] |
| Accessibility | 🟢 Audited | Five core flows audited 2026-09-28: 7 confirmed defects fixed (contrast token 4.20→≥4.95:1, skip links, keyboard rows/accordion, input labels, disclosure semantics); fixes pinned by `tests/accessibility-audit.test.ts` — live AT pass [PLANNED] |
| Deployment | 🟢 Pipeline live | Dev deploy verified; production workflow implemented (manual gate, forced pre-deploy backup, seed compiled out + CI-verified, deploy verification) — owner prerequisites (project ref/secret, reviewers) pending |
| Recovery | 🟢 Rehearsed | Nightly 03:30 UTC pg_dump (90-day retention, archive-verified, manifest+SHA-256); weekly automated restore drill; **restore-from-backup rehearsal EXECUTED 2026-09-28 — PASS** (point-in-time + RLS/guard integrity proven, docs/drills/) |
| Testing | 🟢 19 suites / 265 tests | SQL layer (PGlite, all migrations), wire-bridge data-layer suites (backend edge, account security, operator portal + isolation, template editor, evidence capture/progress, notifications, CSV exports, AI risk explanation, operational readiness, accessibility audit, performance baseline), offline queues, live anon probes — all green; UI smoke layer [PLANNED] |
| Documentation | 🟢 Current | Docs 00–16 synchronized with this build |

## Definition of done for pilot

1. Priorities 1–3 of the test strategy implemented and green in CI.
2. Evidence attachment UI shipped; media offline queue shipped.
3. Rate limiting on public endpoints (per-source limiter implemented, tested, and converged live — migration 0005); evidence signed-URL revocation path implemented and tested (migration 0006, repo + live).
4. Restore-from-backup rehearsal completed and documented. **[DONE 2026-09-28 —
   executed for real (local clusters, real dump, drift test, RLS/guard
   verification): PASS — see docs/drills/restore-rehearsal-2026-09-28.md and
   docs/14. Must be repeated against the production Supabase project once it
   exists.]**
5. Accessibility pass (keyboard, contrast, screen-reader landmarks) on the five
   core flows. **[Audit EXECUTED 2026-09-28 — 7 defects found and fixed,
   pinned by tests; see docs/09. Live assistive-technology pass [PLANNED]
   before pilot launch.]**
6. First-admin provisioning runbook executed on the production deployment.
7. This board re-scored with evidence links.

## Pre-pilot decision requirements [REQUIRES GOVERNMENT CONFIRMATION]

- Adopting institution's identity, data ownership, and legal basis.
- Regulatory citation set (currently intentionally empty).
- Retention schedule and legal-hold policy.
- Boundary/licensing datasets if map layers are extended.
- Official naming/branding decision (platform must not imply official status
  until adopted).

## Honest framing reminder

The product copy throughout states: designed for potential government adoption;
not an official Government of Liberia system. This framing must persist until
formal authorization exists.
