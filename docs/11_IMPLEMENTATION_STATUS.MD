# 11 — Implementation Status

**Session:** Firebase backend migration (v1.0 scope carried over from Convex)
**Date:** 2026-09-21
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · Convex removed from the dependency tree

## Completed this session

### Backend migration Convex → Firebase [IMPLEMENTED]
- **`src/lib/firebase.ts`** — Firebase app/auth/Firestore/Storage init for
  project `mineguard-liberia` (config values are public client identifiers by
  design; authorization lives in the security rules).
- **`src/lib/backend.ts`** — the entire former Convex API surface mirrored
  function-for-function: sites (list/get/create/setStatus/riskScores),
  inspections (templates, list, get, createDraft, updateDraft, submit, review,
  findings, corrective actions), records (incidents, environmental
  observations, community reports incl. public submit/track), stats (command
  center, publicStats, audit log, role management, profile completion),
  evidence (Storage upload, metadata, download URL, footprint), seed.
  Every mutating function re-derives authorization and appends to `auditLog`.
- **`src/lib/backend-react.ts`** — Convex-compatible `useQuery(fn, args)` /
  `useMutation(fn)` hooks (including the `"skip"` sentinel and auth-state
  re-subscription) so all page logic is unchanged.
- **`src/lib/types.ts`** — domain types + client-side authorization mirror.
- **`src/lib/compat-types.ts`** — `Id<T>` / `Doc<T>` shims replacing Convex
  branded types (both are the domain interfaces now; `Id` is a string).
- **`firestore.rules` / `storage.rules`** — authoritative server-side
  authorization: role/scope model, operator tenant isolation, public report
  submission + tracking, append-only audit log, evidence size cap, admin-only
  role writes, first-admin bootstrap guarded by `meta/hasStaff`.
- **`firebase.json` / `firestore.indexes.json`** — project config.

### Frontend
- All 14 pages + hooks re-pointed from `convex/react` → `@/lib/backend-react`,
  `@/convex/_generated/api` → `@/lib/backend`; types from `@/lib/compat-types`.
- `src/main.tsx`: Convex providers removed (Firebase needs no provider).
- `src/pages/Auth.tsx`: rewritten for Firebase email/password sign-in +
  account creation + anonymous guest, with Firebase error-code mapping.
- `src/hooks/use-auth.ts`: Firebase auth state + profile doc subscription.

### Removed
- `src/convex/` (entire tree incl. `_generated`), `convex` and
  `@convex-dev/auth` dependencies, Convex environment variables.

## Files changed / created (summary)

Added: `src/lib/{firebase,backend,backend-react,types,compat-types}.ts`,
`firestore.rules`, `storage.rules`, `firebase.json`, `firestore.indexes.json`.
Modified: `src/main.tsx`, `src/pages/Auth.tsx`, `src/hooks/use-auth.ts`,
import lines in 14 pages, `docs/02` `03` `04` `10` `12` `14`.
Removed: `src/convex/**`, deps `convex`, `@convex-dev/auth`.

## Migrations

Data migration from the previous Convex deployment is NOT performed in this
session (the Convex deployment contained seed/demo data only; no production
records existed). Fresh Firebase project starts empty; the demo seeder runs
only when `sites` is empty.

## Tests

No automated test suite exists yet. Manual verification: full TypeScript
typecheck passes; Firebase project reachability verified (project exists, API
key valid). Firestore and Auth require one-time console activation by the
project owner (documented in doc 14).

## Build result

- `bun tsc -b --noEmit`: clean.
- Convex codegen/push: no longer applicable (backend removed).

## Unresolved issues / known risks

1. **Firebase activation status (2026-09-21):** Firestore database created ✓;
   Email/Password + Anonymous providers enabled ✓; Firestore rules published and
   verified live via probes (public report submission creates a document,
   staff-only reads deny anonymous access) ✓. **Cloud Storage rules NOT
   deployed** — the project is on the no-cost Spark plan, and Storage security
   rules require the Blaze plan. Evidence upload stays disabled in-app (no UI
   wired) until the owner either upgrades to Blaze or adopts a rule-free
   approach; `evidence.upload` will fail with a rules/permission error if
   invoked, and that failure is surfaced to the user, never silent (doc 05).
2. Evidence attachment UI not yet wired into field forms (backend ready).
3. Rules cannot fully express county-scoped list filters; enforced in the data
   layer, re-checked on single-doc gets (doc 04 gap 5).
4. Public report endpoint lacks dedicated rate limiting (rule-level length
   guard only).
5. No automated tests yet.
6. Operator experience remains a reduced staff surface, not a dedicated portal.

## Next recommended task

Activate the Firebase project (Firestore + auth providers + rules deploy), run
the first-admin bootstrap, then proceed to the evidence attachment UI (doc 07)
and first test suites (doc 13).
