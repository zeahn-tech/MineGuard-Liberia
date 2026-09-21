# 13 — Test Strategy

**Status:** no automated tests exist yet in this repository. This document fixes
the strategy and priority order. [PLANNED]

## Principles

1. Authorization is tested server-side first — UI tests never substitute.
2. Offline sync is tested across the queue lifecycle, including failure.
3. Tests never depend on seeded demo data.

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

- `bun test` + Vitest for the data layer; Firebase Emulator Suite for rules.
- Vitest + happy-dom for `offline-queue` and pure UI helpers.
- Playwright for the smoke layer.
- A `bun run test` aggregate script once the first suite lands.
