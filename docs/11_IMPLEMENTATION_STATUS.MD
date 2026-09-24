# 11 — Implementation Status

**Session:** Supabase backend migration (Firebase → Supabase, storage-upgrade
constraint) + authoritative database schema
**Date:** 2026-09-24
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) — schema applied manually
in the Supabase SQL editor by the project owner (see setup steps below)

## This session [IMPLEMENTED 2026-09-24]

- **Why:** Cloud Storage rules deployment remained blocked on the Firebase
  Blaze plan (prior gap 6). The project owner supplied a Supabase project
  (URL + anon key); the entire backend was re-platformed onto Postgres.
- **`src/lib/supabase.ts`** — client init, auth state store (mirrors the
  former `onAuthStateChanged` semantics), error-shaping to the stable UI
  message tokens (FORBIDDEN / NOT_FOUND / RATE_LIMITED / …).
- **`src/lib/backend.ts`** — the entire API surface mirrored
  function-for-function on Supabase: sites (list/get/create/setStatus/
  riskScores), inspections (templates, list, get, drafts, submit, review,
  findings, corrective actions), records (incidents, observations, community
  submit/track/triage), stats (command center, publicStats, audit log, role
  management, provisioning, profile completion), evidence (upload to private
  bucket + metadata row, scoped list RPC, signed URLs, footprint), seed.
  Timestamp contract: epoch-ms in the UI ↔ timestamptz in Postgres, mapped at
  this edge. Column contract: snake_case rows ↔ camelCase domain types.
- **`src/lib/backend-react.ts`** — Convex-compatible `useQuery`/`useMutation`
  hooks retained; subscriptions now push-refresh via Postgres realtime
  (`postgres_changes`) with the same debounce/keepalive perf contract.
- **`supabase/migrations/0001_initial_schema.sql`** [NEW — authoritative
  boundary] — every table + Postgres enum, RLS policies on all 14 tables,
  guard triggers (profile role-writes, site registry admin-only, inspection
  lifecycle, finding transitions, CA decisions, report triage),
  `mg_can_access_site()` as the single site-visibility function used by every
  scoped policy, scope-stamp triggers (county/operator_name denormalized at
  write time, refreshed on site updates — the RLS equivalent of rules-level
  list scoping), security-definer RPCs (`submit_community_report` with a
  30/min `rate_limits` bucket, `triage_community_report`,
  `complete_staff_profile` with first-admin bootstrap,
  `provision_user_by_email`, `evidence_for_parent`, `refresh_public_stats`),
  append-only `audit_log` (insert policy only), private `evidence` bucket with
  uid-folder upload policy and a read policy that joins metadata by path and
  re-checks site visibility (structurally closes the prior 0.2/0.3 defect
  classes), realtime publication for all watched tables, and UNIQUE
  constraints on `sites.code` + all `client_ref` columns (database-level
  offline dedupe).
- **Docs synchronized:** 02 (stack/topology), 03 (tables/integrity),
  04 (principles/file access/gaps), 11 (this entry), README.

## Setup required from the project owner (one-time)

1. Run `supabase/migrations/0001_initial_schema.sql` in the Supabase SQL
   editor (Dashboard → SQL Editor → paste → Run).
2. Authentication → Providers → Email: enabled. Anonymous sign-in: enabled
   (public guest mode).
3. Sign up → complete a staff profile → first account becomes admin
   (bootstrap inside `complete_staff_profile`, only when no admin exists).
4. Optional: run the in-app seed (Command Center → admin controls) to insert
   synthetic demo records.

## Remaining known gaps (honest)

1. The prior Firebase-era `.env.keys` rotation/history scrub remains an owner
   action for that repository history (no Supabase equivalent exists; nothing
   sensitive ships in this codebase).
2. Public-report rate limiting is a global 30/minute bucket (server-time
   keyed) inside the RPC; a per-source limiter (edge function + proxy IP) is
   planned.
3. Camera capture UX and batch evidence upload with per-file progress.
4. Operator experience remains a reduced staff surface, not a dedicated portal.
5. `refresh_public_stats()` is invoked by the data layer after consequential
   writes; a scheduled/cron variant is planned so externally-written rows are
   also counted.
6. A leaked 1h signed evidence URL remains valid until expiry.

---

# Prior session log

**Session:** Rules-level list scoping + evidence detail surfaces + offline evidence attach + public-report rate-limit handshake
**Date:** 2026-09-23
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (18 passing)

## This session [IMPLEMENTED 2026-09-23]

- **Rules-level county/operator list scoping (closes doc 04 gap 5).** Every
  site-scoped record now carries denormalized `county` + `operatorName`
  (`siteScopeStamp`) at write time, and `list` rules check them per document
  via `siteVisible()`. The data layer mirrors the exact constraint
  (`scopeConstraintForUser` → `scopedAll` / `scopedWhereAll`) so Firestore
  accepts scoped queries and rejects unscoped ones — authorization moved from
  client-side filtering to the server rules. Applied to every read that touches
  a scoped collection: list/aggregate readers (`sites.list`, `riskScores`,
  `commandCenter`) and child/dedupe reads (findings, corrective actions, and
  `clientRef` dedupe in inspections/incidents/observations). The generic `live`
  watcher is now scope-constrained and established only after the first fetch
  (so the caller's scope is known) — an unconstrained collection watcher is
  rejected by the rules for county/operator callers. Evidence is the documented
  exception (append-only metadata): its list rule joins `parentType`+`parentId`
  to the parent record (`parentEvidenceVisible`).
- **Evidence UI on incident and observation detail surfaces.** New
  `/portal/incidents/:id` and `/portal/environment/:id` pages
  (`IncidentDetail`, `ObservationDetail`) with provenance, lifecycle actions,
  and the shared `EvidenceSection`. New `records.getIncident` /
  `records.getObservation` getters; list rows now link into the detail pages.
- **Offline evidence attach.** New IndexedDB-backed queue
  (`src/lib/offline-evidence.ts`). `EvidenceSection` queues file bytes when
  offline, or on a connectivity failure (never on a policy denial), shows them
  as "queued for upload", and replays automatically on the `online` event and
  on mount. Failed replays stay queued with retry info; nothing is dropped.
- **Public-report rate-limit handshake.** The `/rateLimits` rule guard was
  previously unsatisfiable from the client (the submission never created the
  bucket nor stamped `rateBucket`, so every public report would have been
  DENIED). `records.submitCommunityReport` now performs the matching
  create-or-increment handshake and fails fast at the per-minute cap; the
  submit page surfaces that message.
- **Tests:** `tests/offline-evidence.test.ts` (5 tests) — queue persistence,
  per-parent scoping, sync-removes-on-success, sync-keeps-on-failure, delete.
  Suite total: 18 passing.

## Security defects fixed [IMPLEMENTED 2026-09-23]

- **0.1 Committed secret** — `.env.keys` added to `.gitignore`. The key value
  must still be rotated by the project owner and scrubbed from git history
  (owner action; the repo cannot do this retroactively).
- **0.2 Tenant-isolation hole** — `firestore.rules` single-document reads
  (`get`) on `findings`, `correctiveActions` and `evidence` now re-check site
  visibility via `siteVisibleAt()`, the same per-document join `incidents` and
  `environmentalObservations` already used. Operators can no longer read other
  organizations' records by id. (List scoping was later hardened to per-document
  rules — see "This session".)
- **0.3 Role-blind storage reads** — `storage.rules` re-derive the caller's
  role/tenant from `/users/{uid}` and join the evidence object to its metadata
  doc (`{docId}__{fileName}`) before allowing any read. Unassigned/anonymous
  accounts are denied.

## Evidence capture [IMPLEMENTED 2026-09-23]

- **Upload flow re-contracted** (`src/lib/backend.ts` `evidence.upload`) to
  match `storage.rules`: metadata doc id generated first, storage object named
  `evidence/{uid}/{docId}__{fileName}`, single `setDoc` create (rules forbid
  updates), `siteId` mandatory, site visibility re-derived before write.
- **`listForParent` made role-aware** — per-record tenant re-check via
  `getSite` + `canAccessSite`; operators see only their sites' evidence;
  unassigned accounts get an empty list.
- **Field UI** (`src/components/EvidenceSection.tsx`) attached to all record
  detail pages (inspection/incident/observation): attach
  photo/video/audio/document ≤25MB with caption, thumbnail grid, click-to-open
  download URL, and offline queueing (see "This session"). Upload hidden for
  role-less accounts.

## Offline field operations expanded [IMPLEMENTED 2026-09-23]

The offline queue (doc 05) now covers three of four field workflows:

- **Incidents** — the report dialog persists to the queue BEFORE any network
  attempt; syncs immediately when online, or on reconnect. Server-side
  `clientRef` dedupe added to `records.reportIncident`.
- **Environmental observations** — same pattern; `records.reportObservation`
  gained `clientRef` dedupe.
- **Inspections** — unchanged (already offline).
- Queue header/indicator in the portal covers all queue kinds (existing).
- **Community reports (public)** remain online-only by design (public
  unauthenticated flow; anti-abuse constraints in rules).
- New tests cover queue persistence, dedupe, failure retry, and handler
  routing (see below).

## First automated test suite [IMPLEMENTED 2026-09-23]

`tests/offline-queue.test.ts` (bun:test, `bun test` / `npm test`): 13 tests
covering the site-code generator, tracking codes, the client-side
authorization mirror (`canAccessSite`), queue persistence + clientRef dedupe,
failure retry semantics (nothing silently dropped), missing-handler handling,
and inspection sync ordering. Wired into CI (`.github/workflows/deploy-pages.yml`)
between typecheck and build.

## Remaining known gaps (honest)

1. `.env.keys` secret rotation + git-history scrub (owner action).
2. Records written outside the data layer miss the denormalized scope stamp
   and stay invisible to county/operator callers until an admin backfill
   stamps them (admin/national reads are unaffected) — a backfill tool is
   planned.
3. Public-report limiting is a global per-minute cap keyed on server time; a
   robust per-source limiter (Cloud Function + App Check) needs the Blaze plan.
4. Camera capture UX and batch evidence upload with per-file progress.
5. Operator experience remains a reduced staff surface, not a dedicated portal.
6. Cloud Storage rules deployment requires the Blaze plan (Spark-plan
   limitation documented in doc 14); until upgraded, evidence upload surfaces
   a permission error to the user rather than failing silently.

---

# Prior session log

**Session:** Firebase backend migration + GitHub deployment readiness
**Date:** 2026-09-21
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun run build` ✓ (clean production build)

## Non-staff portal stabilization [IMPLEMENTED 2026-09-22]

Fixes the "loads forever after sign-in" failure for operator and unassigned
accounts (root cause: staff-only queries denied by rules surfaced as a
never-resolving loading state):

- **Rules (`firestore.rules`)** — operator list grants: `/sites` (query must
  filter `operatorName == profile().operatorName` — rules-enforced tenant
  isolation), `/inspections`, `/environmentalObservations` (data-layer
  filtered, same pattern as `/incidents`); `/inspectionTemplates` readable by
  staff + operators (non-sensitive form definitions).
- **Data layer (`src/lib/backend.ts`)** — `sitesForUser` scoping helper;
  `sites.list`/`riskScores`/`commandCenter`/`inspections.list`/
  `listTemplates`/`listFindingsForInspection`/`listCorrectiveActions`/
  `listSiteCorrectiveActions`/`listObservations` are role-aware; unassigned
  accounts receive well-defined empty results instead of denied reads;
  community reports + audit log remain staff-only (empty for non-staff);
  `sites.get`/`inspections.get` return `null` so detail pages render their
  denied state instead of spinning.
- **UI** — `StaffOnly` gate component (audit log, community triage);
  staff-only controls hidden for non-staff (New inspection, record finding,
  resolve finding, open corrective action); profile-completion dialog is now
  dismissable (✕/Escape/backdrop) with a persistent "Complete profile" button
  in the sidebar and mobile drawer to reopen it.
- **Operational note:** a sign-up whose profile completed while
  `meta/hasStaff` already exists remains unassigned (role `null`) until an
  admin provisions them. If no admin exists (e.g. demo users were deleted but
  the sentinel doc remains), delete `meta/hasStaff` in the Firebase console
  (Firestore → `meta` collection) and complete a profile again to re-trigger
  the one-time first-admin bootstrap.

## GitHub deployment readiness [IMPLEMENTED 2026-09]

- **HashRouter** — every deep link works on any static host with zero server
  config (GitHub Pages serves only `index.html`).
- **Repository-aware base path** — `vite.config.ts` derives `base` from
  `GITHUB_REPOSITORY` (set automatically in Actions) or an explicit
  `PUBLIC_PATH`; verified `/mineguard-liberia/assets/…` output and default `/`
  locally.
- **GitHub Actions workflow** `.github/workflows/deploy-pages.yml` — install →
  typecheck → build (`DISABLE_VLY_PLUGIN=1`) → 404.html SPA fallback →
  deploy-pages. Requires Settings → Pages → Source: **GitHub Actions**.
- **Installable PWA** — corrected manifest (real name/description, Papery
  theme colors, `start_url`/`scope` relative), procedurally generated icon set
  (192/512 + maskable + apple-touch + favicon, `bun run icons`), full meta/OG
  tags in `index.html`.
- **Offline app shell** — `public/sw.js` (network-first navigations, cache
  fallback, Firebase traffic never cached) registered in `index.html`.
- **Repository hygiene** — real project README (features, setup, Firebase
  activation, deployment), MIT LICENSE, expanded `.gitignore`,
  `package.json` renamed `mineguard-liberia@1.0.0` with `typecheck`/`icons`
  scripts.

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
