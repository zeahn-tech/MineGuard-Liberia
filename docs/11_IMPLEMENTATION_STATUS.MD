# 11 — Implementation Status

**Session:** Gap Closure Directive v1.0, Gap #1 (Priority A) — per-source rate limiting on the public community-report endpoint
**Date:** 2026-09-26
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (71 passing
across 6 files — 57 prior + 11 new per-source limiter behavior tests + 3 new
migration-apply assertions) · 4 live-anon probes unaffected and green · live
hotfix **applied and verified the same day** (fresh owner token; live
submission had been left DOWN by a partial paste — repaired; acceptance proof
executed on the live project inside a rolled-back transaction, zero artifacts)

## This session [2026-09-26 — Gap #1: per-source rate limiting]

**Directive item:** Priority A gap 1 — replace the global 30/min bucket on
`submit_community_report` with a per-source limiter (IP or device-scoped).

**Defect closed:** 0001's `submit_community_report` counted every submission
on Earth into ONE global bucket (`'public_report'` in the repo lineage,
`'cr-<epoch/60>'` on the live lineage): any single source able to POST 31
times a minute — a buggy retry loop, a shared NAT, or an attacker — silenced
community reporting for the entire country until the window rolled over.
Denial of service against a public safety channel, one SQL literal away.

**Acceptance criteria (stated before coding, per directive §3.2):**

1. Source A exhausting its quota does not silence source B (the directive's
   core acceptance), and vice versa.
2. The source key is derived server-side from the PostgREST-injected
   `request.headers` GUC — never from a client-supplied argument.
3. The (N+1)-th submission within the window is refused with a message
   containing `RATE_LIMITED`; the cap stays 30/min per source (partitioned
   capacity, not a 30× loosening).
4. After the fixed 60-second window lapses, the same source may submit again.
5. With no forwardable client IP, the limiter degrades to the existing global
   bucket — fail-closed; there is no unlimited path.
6. No raw address is persisted: the bucket key is a salted SHA-256 digest,
   and `rate_limits` stays definer-only.
7. The public RPC signature is unchanged (0002's EXECUTE grants and
   `src/lib/backend.ts` stay valid untouched).

**Implementation (smallest coherent change):**

- `supabase/migrations/0005_per_source_report_rate_limit.sql` [NEW] —
  recreates ONLY `submit_community_report` with an identical signature and a
  per-source limiter: `mg_client_ip()` (STABLE, SECURITY INVOKER; first
  `x-forwarded-for` hop, `x-real-ip` fallback, empty ⇒ global) feeds the
  bucket key `report:<sha256("mgliberia-v1:" || ip)>`, or `report:global`
  when no forwardable IP exists; same `rate_limits` upsert + rolling-window
  shape as 0001; self-contained explicit EXECUTE grant so the migration does
  not depend on 0002 having run.
- `tests/rate-limit.test.ts` [NEW] — 11 tests: source derivation (XFF first
  hop, x-real-ip fallback, empty ⇒ global); the core isolation proof (A
  exhausts its quota → A is refused → B still submits in the SAME window → A
  is still refused); the exact cap boundary (30 pass, 31st refused with
  `RATE_LIMITED`); window reset via harness clock surgery; degraded global
  mode; digest-only bucket keys with the digest recomputed independently in
  node (not by trusting the SQL's own crypto); anon's zero-row visibility of
  `rate_limits`.
- `tests/migration-apply.test.ts` [EXTENDED] — 0005 discovered in order,
  idempotent (create-or-replace ⇒ no duplicate functions), identity
  signature asserted equal to the one 0002 grants and the client calls,
  helper asserted STABLE and not SECURITY DEFINER.
- No client change: `src/lib/backend.ts` already maps the `RATE_LIMITED`
  token to friendly text, and the RPC signature is unchanged.

**Test-harness lessons encoded in the suite (first-draft defects removed):**
`withRole` transactions ALWAYS roll back, so the multi-step isolation proofs
run inside a single transaction — which is also a stronger proof (same
instant, same wall-clock window); and anon has no SELECT policy on
`community_reports`/`rate_limits`, so those reads return ZERO ROWS silently —
success is therefore confirmed through the world-readable `report_tracking`
mirror, and bucket rows are introspected from postgres sessions.

**Test results:** 71/71 pass, 242 expect() calls across 6 files.

**Live deployment (applied and verified 2026-09-26, fresh owner token):** the
live project has converged onto the per-source limiter. What was found live
was worse than a missing hotfix: the owner had pasted the repo 0005 function
into the live project but never migrated the live `rate_limits` table, leaving
**live public report submission DOWN** (42703 `column "window_start" does not
exist`) — caught and repaired in the same session. Three live defects were
closed:

1. `rate_limits` gained a `window_start timestamptz` column (backfill: the one
   legacy `'cr-<epoch/60>'` row's epoch-derived window was recovered honestly;
   default `now()` added; the legacy `updated_at` column retained for the old
   overload — see 3).
2. The function's `search_path` is now `public, extensions`: hosted Supabase
   installs pgcrypto's `digest()` in `extensions`, so the original body died
   with 42883 `digest(text, unknown) does not exist` on live (the PGlite
   harness masked this — its digest() lives in `public`). Repo 0005 updated
   identically; the harness could not catch a hosted-only schema layout, which
   is an honest limit of the test environment.
3. Live retains an old **enum-typed overload** of `submit_community_report`
   (still using the legacy `updated_at` scheme) alongside the text-typed one.
   PostgREST resolves string-literal callers to the text-typed overload — the
   per-source one — so every client path uses the fixed function. The legacy
   overload + `updated_at` column are retained residue; dropping them is a
   separate cleanup decision (documented in 0005's lineage note), not silently
   taken.

**Live verification (all inside one rolled-back transaction — zero
artifacts):** attempts 1–30 from source A accepted; #31 refused with
`RATE_LIMITED`; source B accepted in the same window while A was exhausted; A
still refused afterwards; bucket keys equaled the salted digests computed
independently in node (`f254d843eabe…` for A, `72b7ef1b46dd…` for B).
`community_reports.rate_bucket` remains a nullable, unused-by-this-body
residue column, retained like the overload above.

### Directive §5 classification (this session's scope)

- Per-source rate limiting, repository lineage — **IMPLEMENTED, verified by
  test** (isolation, boundary, window reset, degraded mode, privacy).
- Per-source rate limiting, live deployment — **IMPLEMENTED, verified live**
  (isolation proof executed on the live project inside a rolled-back
  transaction; zero artifacts left).
- Evidence URL revocation (gap 2), `backend.ts` HTTP-edge suite (gap 3),
  account recovery/MFA (gap 4) — **PLANNED** (untouched; one gap per
  session per directive §22–26).

### Remaining known gaps (honest, this session's delta)

1. Live convergence is complete, with retained residue: the live project
   still carries the legacy enum-typed overload of `submit_community_report`,
   the `rate_limits.updated_at` column and the unused
   `community_reports.rate_bucket` column. All are inert for client traffic;
   dropping them is a separate maintenance decision (docs/14 candidate).
2. The `x-forwarded-for` first hop is only as trustworthy as the edge that
   sets it: hosted Supabase overwrites/normalizes the chain, but a client
   that bypasses the platform proxy on a self-hosted or misrouted deployment
   could present a fresh spoofed hop per request. Header-derived identity is
   the best signal available inside Postgres; an edge-function limiter would
   be strictly stronger and remains future work (doc 04 updated).
3. Per-source buckets accumulate one `rate_limits` row per distinct source
   (salted-hash-keyed). Growth is bounded by real traffic and the table
   stays definer-only, but a periodic sweep of stale rows belongs in doc 14's
   maintenance schedule rather than in this change (smallest coherent
   change).
4. All previously listed gaps not closed by this item remain open (evidence
   URL revocation, `backend.ts` test coverage, account recovery/MFA, camera
   UX, operator portal, scheduled stats refresh).

## Prior session [2026-09-25 — live hotfix: profile completion failing]

**Session:** Live hotfix — `complete_staff_profile` WHERE-less UPDATE (profile
completion `[object Object]` error)
**Date:** 2026-09-25
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (57 passing
across 5 files, including 4 probes against the live Supabase project using only
the public anon key) · live function verified by Management API query after the
fix, and end-to-end as a signed-in test account (HTTP 204 on the exact RPC
payload the app sends); test artifacts fully reverted (see below)

**Reported defect:** completing the staff profile in the portal showed
`[object Object]` and the profile never saved.

**Root cause (live deployment, confirmed by reproduction):** the live
`public.complete_staff_profile` function (a divergent version of the one in
0001) performed its `update public.profiles set …` with **no WHERE clause**,
relying on the caller's RLS visibility to target the row. The project database
has the `safeupdate` extension enabled, which rejects any UPDATE without a
WHERE clause with SQLSTATE `21000` ("UPDATE requires a WHERE clause"). The
defect lived entirely in the live function body — the repository lineage
(0001, and the corrected version now applied live) always had `where id =
auth.uid()`. It reproduced exactly with the client's own payload
(`p_job_title/p_organization/p_scope/p_county/p_operator_name`), signed in.

**Fix applied to the live project** (Management API SQL endpoint, token from
the owner): function recreated with identical signature and behavior — same
guest-account refusal, same first-admin bootstrap via the `role is not null`
probe, same audit entry — plus two hardening changes:

1. `where id = auth.uid()` on the UPDATE (the fix; satisfies safeupdate and
   makes the row target explicit rather than RLS-incidental);
2. `if not found then raise exception 'UNREGISTERED_USER' end if;` after the
   UPDATE, so a signed-in account without a profile row fails loudly with the
   message the UI already maps to friendly text, instead of silently doing
   nothing.

A mechanical scan of **all 23 functions in schema public** for other
WHERE-less UPDATE/DELETE statements found none — this was the only instance
of the defect class (`provision_user_by_email` uses `ON CONFLICT DO UPDATE`
and `triage_community_report` targets rows explicitly; neither is subject to
safeupdate).

**Verification:** after the hotfix the exact RPC call returned HTTP 204 and
the profile row showed `profile_complete = true`. The signed-in test account
used for verification claimed the one-time first-admin bootstrap as a side
effect; both diagnostic auth users and their audit_log entry were then
deleted from the live project, restoring the pre-test state (the real
account, which has not yet completed its profile, will bootstrap as first
admin on its first completion, as documented).

**Client hardening (same session):** `ProfileForm` in
`src/pages/PortalLayout.tsx` now filters `[object Object]`/empty messages to
a generic fallback and maps the `UNREGISTERED_USER` and `GUEST_ACCOUNT`
tokens to friendly text, so no backend rejection can render the literal
string `[object Object]` in the profile toast again.

**Known limitation of this fix:** the repository migrations and the live
project remain two lineages (see the 2026-09-24/25 audit notes below). This
hotfix was applied directly to the live function; the repository lineage was
already correct, so no migration file is added. If the live project is ever
rebuilt from migrations, the corrected body is the one in
0001 + this session's `not found` guard semantics.

---

**Prior session:** Forensic re-audit remediation + mechanical verification (clean-apply
migration suite, RLS role matrix, always-on live anon probe)
**Date:** 2026-09-25
## This session [2026-09-25 — audit verification, remediation, and one new defect]

The 2026-09-24 forensic re-audit (preserved below) found two CRITICAL defects.
This session closed them, verified the closure at BOTH schema lineages
(repository migrations and the divergent live project), and found one further
defect while doing so. Per §23 (No False Completion), the honest bottom line is
unchanged: the platform is materially closer to deployable, but still requires
the owner-side steps listed under "Remaining known gaps" before real government
or operator data goes anywhere near it.

### Verification of the two CRITICAL findings

- **§0.1 world-readable `profiles` — CONFIRMED live, NOW CLOSED.** The live
  project originally carried `"profiles read" … for select using (true)` with
  no role restriction: with the published anon key, zero-authentication REST
  calls returned the full staff/operator directory (emails, roles, counties).
  Fixed in the repository lineage by **`0003_profiles_read_hardening.sql`**
  (canonical self-or-admin SELECT, self INSERT, self-or-admin UPDATE, all `to
  authenticated`, plus a hard `REVOKE ALL … FROM anon` so a future permissive
  policy cannot re-expose the directory). **Verified applied on the live
  project** via Management API probe (exactly the three canonical policies,
  all role-restricted) and by `tests/live-anon.test.ts` (anonymous REST probe:
  profiles is privilege-denied 401, not merely filtered; every sensitive
  table returns zero rows; the public meta/report_tracking mirrors the landing
  and tracking pages need stay readable).
- **§0.2 broken `0002_grants_and_storage.sql` — CONFIRMED, NOW CORRECTED.**
  The original file referenced types and signatures that do not exist in 0001
  (`report_status`, `evidence_parent_type`, enum-typed RPC params, a
  two-argument `mg_can_access_site` in the storage read policy) and ran
  without a transaction — a clean apply would halt mid-file and silently skip
  the storage section. The corrected file runs in one atomic transaction,
  matches 0001's actual signatures, drops stale policy variants before
  recreating them, and is idempotent. The repository lineage is now verified
  mechanically: **`tests/migration-apply.test.ts` applies every file under
  `supabase/migrations/` against a completely empty real Postgres** (PGlite,
  with Supabase platform objects stubbed) and fails on any statement error.
- **Live-database remediation status.** The live project had already received
  the §0.1 policy fix and the profile-guard parity fix (0004) before this
  session's audit pass; the Management API probe confirmed both (policies
  above; `mg_guard_profile_update` SECURITY INVOKER + definer
  `mg_any_profile_role` bootstrap probe present). `0002`'s grants/storage
  section is equivalently satisfied on the live project through Supabase's
  default privilege wiring plus ad-hoc fixes; repository migrations remain the
  authoritative lineage for fresh deployments.

### New defect found and fixed this session

- **[FIXED] PUBLIC EXECUTE fallback made anon revokes toothless on the
  repository lineage (ADR-11).** Vanilla Postgres grants `EXECUTE` on every
  new function to `PUBLIC` by default; hosted Supabase revokes that
  platform-wide, and the old `0002` only revoked from `anon` — so on the repo
  lineage anon kept a PUBLIC-based grant and the revokes never bit (an anon
  caller reached the body of `complete_staff_profile`, surfacing
  `UNREGISTERED_USER` instead of a denial; caught by the new suite). Every
  definer body re-checks authorization internally, so no live exposure
  resulted — but the documented intent is that privileged RPCs are not
  callable without a session at all. `0002` now revokes `EXECUTE … FROM
  PUBLIC` schema-wide before granting to `anon, authenticated`, and sets
  default privileges so future functions never silently re-acquire the
  default. Which layer refuses remains lineage-dependent; the tested
  invariant is that anon calls never succeed.
- **[FIXED, found by the new suite] First-admin bootstrap dead-end on the
  repository lineage.** Repo-lineage 0001's `mg_guard_profile_update`
  rejected every role/scope transition by a non-admin — including the
  documented first-admin claim — so a fresh install could never create an
  administrator. **`0004_profile_guard_parity.sql`** brings the repo lineage
  to the live-proven design: SECURITY INVOKER guard (so the `current_user`
  check genuinely distinguishes direct updates from definer-RPC updates) plus
  a first-run bootstrap allowance (while no profile holds a role, the first
  signed-in account may claim admin, via the RLS-immune definer probe
  `mg_any_profile_role`). Regression tests assert both the bootstrap path and
  that later self-escalation still raises `FORBIDDEN_ROLE_CHANGE`.

### Verification infrastructure (new)

- **`tests/helpers/pglite-db.ts`** — a real in-process Postgres (PGlite) with
  Supabase platform stubs (roles, `auth.uid()`/`auth.role()` reading the JWT
  GUC, storage schema + `foldername()`, realtime publication), auto-discovery
  and ordered application of every migration file, a deterministic six-account
  fixture (admin, two operators, every-scoped staff, role-less guest), and a
  `withRole()` helper that impersonates any role with any JWT claims inside a
  transaction that always rolls back.
- **`tests/migration-apply.test.ts`** (14 tests) — clean-apply of all
  migrations, idempotency of 0002/0003, atomic-transaction and signature
  assertions (matched against executable SQL only, not comments), storage
  bucket/policy surface, first-admin bootstrap, §0.1 regression hygiene
  (including a sensitivity proof that re-introducing the 0001 defect is
  detected), and the anon-RPC never-succeeds invariant.
- **`tests/rls.test.ts`** (21 tests) — the per-role allow/deny matrix from doc
  04: anonymous, guest (authenticated, unassigned), operator (tenant-locked,
  cross-tenant reads/writes denied), county inspector, national supervisor,
  admin, and the evidence storage policies (own-namespace upload, tenant-checked
  reads, owner-only update, no delete path anywhere).
- **`tests/live-anon.test.ts`** (4 tests) — the always-on regression net for
  §0.1, running against the real project with only the public anon key.
- **Test-harness defects fixed en route** (honest log): `count()` crashed on
  legitimately-empty `UPDATE/DELETE … RETURNING` results (a correct RLS denial
  looks like zero rows — new `affectedRows()` helper); idempotency tests
  asserted `exec()` resolves to `undefined` (it resolves to per-statement
  results); a signature assertion false-positived on 0002's explanatory header
  comment (assertions now run on executable SQL only); redundant test-issued
  `ROLLBACK`s inside `withRole` corrupted transaction state (harness owns the
  transaction); `countOrDenied` mishandled bare row queries with empty
  results.

### Directive §5 classification (this session's scope)

- Database/RLS authorization model, evidence storage policies, audit-log
  append-only, community-report rate limit, public stats mirror, offline
  queue, tenant isolation — **IMPLEMENTED** (verified by test where noted).
- First-admin bootstrap — **IMPLEMENTED** (repo lineage via 0004; live lineage
  pre-existing), with regression tests.
- Scheduled `refresh_public_stats`, per-source rate limiting, camera-capture
  UX, operator portal, evidence URL revocation — **PLANNED** (unchanged).
- Government adoption, official datasets/integrations — **REQUIRES GOVERNMENT
  CONFIRMATION** (unchanged; nothing fabricated).

### Remaining known gaps (honest, this session's delta)

1. The live project was provisioned from a divergent, earlier lineage. It is
   verified hardened where it matters (profiles policies, guard design), but a
   fresh deployment from `supabase/migrations/*.sql` remains the canonical,
   fully-tested path (docs/03, docs/14). Running the full migration set
   against the live project is an owner decision for a maintenance window.
2. Test coverage of the app data layer (`src/lib/backend.ts`) still lags the
   database layer: the suites verify SQL/RLS deeply, not the HTTP edge's
   error-shaping (doc 13 planned next step).
3. Everything previously listed under the 2026-09-24 entry's gaps that has not
   been closed above remains open (per-source rate limiting, camera UX,
   operator portal, scheduled stats refresh, signed-URL revocation).

# Prior session log

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

# Forensic re-audit [2026-09-24 — as drafted; findings verified and closed 2026-09-25]

**Audit date:** 2026-09-24 (second-pass forensic audit)
**Prior audit:** 2026-09-22, against the Firebase-backed codebase.
**What changed between audits:** the project owner (or a prior session)
re-platformed the entire backend from Firebase to **Supabase** (Postgres +
RLS), added `supabase/migrations/0001_initial_schema.sql` and
`0002_grants_and_storage.sql`, wired evidence attachment into all three detail
pages, extended the offline queue to incidents/observations, and added the
project's first real test files (`bun:test`). This audit verifies those claims
line-by-line against the actual code and SQL rather than against the project's
own changelog, and classifies every Master Directive clause per §5
(IMPLEMENTED / PARTIALLY IMPLEMENTED / PLANNED / PROPOSED / UNKNOWN /
REQUIRES GOVERNMENT CONFIRMATION).

**Overall verdict at audit time: NOT PRODUCTION READY — and two
new/undocumented CRITICAL defects were found that the project's own docs and
README did not mention.** Real progress had been made (tenant isolation on
findings/corrective actions/evidence was genuinely fixed at the RLS layer;
evidence upload finally had field UI; a first test suite existed). But that
session had also shipped a second migration file (`0002_grants_and_storage.sql`)
that was not mentioned anywhere in the documentation, contained SQL referencing
non-existent types and function signatures, and the schema had a publicly
world-readable `profiles` table that no prior document flagged. Per Directive
§23 ("No False Completion"), the honest position was: a materially better
codebase than the Firebase-era one, and still not something to deploy against
real government or operator data. (Both CRITICAL defects are now closed and
verified — see the 2026-09-25 entry at the top of this document.)

## 0. CRITICAL — verify/fix before anything else

### 0.1 [NEW, UNDOCUMENTED] `profiles` table is readable by anyone on the internet, no login required

`supabase/migrations/0001_initial_schema.sql` defined:

```sql
create policy "profiles read" on public.profiles
  for select using (true);
```

with no `to authenticated` role restriction. Postgres RLS policies with no
role list apply to **`PUBLIC`**, which includes the `anon` role, and the
grants required for the REST API to function made the combination fully
exposed: **anyone with the published, public `anon` key — embedded in the
client bundle by design and not a secret — could run
`supabase.from('profiles').select('*')` from a browser console with zero
authentication and receive every user's `email`, `name`, `role`, `job_title`,
`organization`, `county`, and `operator_name`.** On a platform explicitly
designed for "potential government adoption" and national mining oversight, a
public directory of every inspector, supervisor, admin, and mining-operator
contact's name and email is a real information-security and personal-safety
concern (Directive §7 least privilege and §15 data governance both apply
squarely here). This was not mentioned in the "remaining known gaps" list of
any prior document.

**Remediation (2026-09-25):** `0003_profiles_read_hardening.sql` — canonical
policy set all pinned `to authenticated` (self-or-admin SELECT, self INSERT,
self-or-admin UPDATE) plus a hard `REVOKE ALL ON profiles FROM anon`; verified
applied on the live project by Management API probe and the always-on
`tests/live-anon.test.ts` anon-key suite (profiles is privilege-denied 401,
not merely filtered). Considered-but-not-adopted narrowing (name+role-only
view) is documented as a future hardening option for the directory.

### 0.2 [NEW, UNDOCUMENTED] `0002_grants_and_storage.sql` referenced types and function signatures that do not exist

The migration's own header said its purpose was to fix a live
"permission denied for table" failure mode, but the file itself referenced
`public.report_status`, `public.evidence_parent_type`, enum-typed parameters
on `provision_user_by_email`/`submit_community_report`, and a two-argument
`mg_can_access_site(county, operator)` in the storage read policy — none of
which exist in `0001_initial_schema.sql` — and ran without a transaction, so a
clean apply would halt at the first bad statement and silently skip the
storage section it existed to deliver.

**Remediation (2026-09-25):** corrected in place — one atomic transaction,
0001-exact signatures, stale policy variants dropped before recreation,
idempotent — and now verified mechanically by
`tests/migration-apply.test.ts`, which applies every file under
`supabase/migrations/` against a completely empty real Postgres and fails on
any statement error. See ADR-11 for the PUBLIC-EXECUTE parity defect the
suite then caught inside the corrected file.

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
