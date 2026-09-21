# 16 — Pilot Readiness

**Assessment:** NOT production ready. This is a faithful, typed, working v1.0
platform core with honest gaps. Per the master directive, readiness claims
require evidence across the dimensions below.

## Readiness board

| Dimension | State | Evidence / gap |
|-----------|-------|----------------|
| Functionality | 🟡 Substantial | All core modules implemented end-to-end; evidence UI, operator portal surface, template editor outstanding |
| Security — authorization | 🟢 Core solid | Centralized authz core; every function guarded; scope + tenant isolation server-side |
| Security — hardening | 🟡 Gaps | Public endpoint rate limiting, evidence fetch ACL deep-check, MFA/recovery |
| Data integrity | 🟢 Core solid | Provenance, lifecycle states, audit log, verification enums; unique-code guard pending |
| Offline behavior | 🟢 Inspections | Local-first, retry, dedupe; media offline queue pending |
| Synchronization | 🟢 Inspections | Idempotent clientRef sync; conflict strategy documented |
| Media | 🟡 Backend ready | Storage pipeline + metadata + audit live; field UI pending |
| Performance | ⚪ Unmeasured | No load testing; queries are collect()-based (fine for pilot scale) |
| Accessibility | 🟡 Partial | Tokens chosen for contrast; audit of flows not yet done |
| Deployment | 🟢 Dev only | Dev deployment verified; prod pipeline + backups pending |
| Recovery | ⚪ Unplanned | Restore test not yet performed |
| Testing | 🔴 None yet | Strategy documented (doc 13); no suites written |
| Documentation | 🟢 Current | Docs 00–16 synchronized with this build |

## Definition of done for pilot

1. Priorities 1–3 of the test strategy implemented and green in CI.
2. Evidence attachment UI shipped; media offline queue shipped.
3. Rate limiting on public endpoints; evidence ACL re-check at fetch.
4. Restore-from-backup rehearsal completed and documented.
5. Accessibility pass (keyboard, contrast, screen-reader landmarks) on the five
   core flows.
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
