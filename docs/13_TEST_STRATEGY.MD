# 13 — Test Strategy

**Status:** 7 suites / 82 tests green as of 2026-09-26: the SQL layer runs
against real Postgres (PGlite) applying every migration in
`supabase/migrations/` — `tests/migration-apply.test.ts` (clean-apply,
idempotency, signature parity), `tests/rls.test.ts` (role matrix),
`tests/rate-limit.test.ts` (per-source limiter, migration 0005),
`tests/evidence-url.test.ts` (signed-URL mint gate, migration 0006) — plus
`tests/offline-queue.test.ts`, `tests/offline-evidence.test.ts`, and
`tests/live-anon.test.ts` (probes the live project with the public anon key
only). Run by `bun test`, wired into CI. [PARTIALLY IMPLEMENTED]

## Principles

1. Authorization is tested server-side first — UI tests never substitute.
2. Offline sync is tested across the queue lifecycle, including failure.
3. Tests never depend on seeded demo data.

## Implemented [2026-09-23]

`bun test` (bun:test) — 18 passing, run in CI between typecheck and build:

- `tests/offline-queue.test.ts` — site-code generation, tracking-code format,
  the client authorization mirror (`canAccessSite`), queue persistence +
  `clientRef` dedupe, failure-retry semantics (nothing silently dropped),
  missing-handler handling, and inspection sync ordering.
- `tests/offline-evidence.test.ts` — offline evidence byte queue: persistence,
  per-parent scoping, sync-removes-on-success, sync-keeps-on-failure, removal.
  It runs against the queue's in-memory fallback (Bun has no IndexedDB); the
  browser path uses the same API over IndexedDB.

Authorization rules tests (Firebase Emulator Suite) and the UI smoke layer
remain [PLANNED].

## Priority 1 — Authorization unit tests (highest value)

Target: the authorization helpers in `src/lib/backend.ts` and the security
rules (`firestore.rules`) — the rules are best exercised with the Firebase
Emulator Suite.

- `requireUser` rejects unauthenticated; `requireStaff` rejects operator/none;
  `requireReviewer` rejects inspector; `requireAdmin` rejects everyone else.
- `canAccessSite`: admin all; staff national all; staff county only matching
  county; operator only matching operatorName (case-exact).
- Every public function in sites/inspections/records/stats/evidence throws
  FORBIDDEN/UNAUTHENTICATED for out-of-role callers (rules unit tests via the
  Firebase Emulator Suite; data-layer guards via Vitest with a mocked auth
  module).

## Priority 2 — Compliance-chain state machine

- Inspection lifecycle: draft → under_review → approved/rejected; illegal
  transitions rejected (`NOT_EDITABLE`, `NOT_REVIEWABLE`).
- Draft edits: only owning inspector, only while draft.
- Corrective action flow: open → respond (operator only, own site) →
  verified/closed/escalated (reviewer only).
- Overdue detection matches `dueAt < now` with open statuses.

## Priority 3 — Offline queue integration

- Enqueue persists before any API call (assert store contents before mock
  network).
- clientRef dedupe: two syncs of the same item produce one inspection.
- Failure path: item remains queued with `lastError`; retry succeeds later;
  `deleteDraft` only after confirmed sync.
- Online-event auto-sync triggers exactly once per event.

## Priority 4 — Data integrity

- Server stamps authorship/timestamps (client attempts ignored).
- Verification enum rejects invalid values (validator test).
- Public tracking query returns only coarse fields.
- Audit entries written for every mutating call (mutation → audit row exists).

## Priority 5 — UI smoke (Playwright)

- Landing renders stats or em-dashes (never fabricated numbers).
- Sign-in → portal redirect; RequireAuth bounce preserves returnTo.
- Field form: fill, reload (draft persists), submit while offline (queued),
  reconnect (syncs).
- Map renders sites and distinguishes unverified markers.

## Tooling plan

- `bun test` (bun:test) for the data layer and pure helpers; Firebase Emulator
  Suite for rules.
- Vitest + happy-dom for `offline-queue` and pure UI helpers.
- Playwright for the smoke layer.
- `bun test` runs the current suite; a broader aggregate is added as later
  layers land.
