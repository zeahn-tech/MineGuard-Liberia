# 11 — Implementation Status

**Session:** Security roadmap Session 2 (scope completion) — admin site edit
API + adversarial isolation suite (SEC-5 / SITE-1, §6)
**Date:** 2026-10-06
**Verification:** `bun tsc -b --noEmit` ✓ · `bun test` **331 pass / 4 skip
(opt-in live) / 0 fail** (335 tests, 21 files) ✓

## This session [2026-10-06 — `api.sites.update` (admin, server-audited)
+ the four adversarial isolation cases proven through the data layer]

**Scope audit first.** The Session 2 schema work had already landed in
migration 0010 (organizations, admin_areas hierarchy, site_assignments, the
six-value `user_scope` incl. the implemented `site`, the permissions
matrix, and the `operator_name → organization_id` backfill with the
compatibility mirror), so no migration was needed here. Two acceptance
items were still open: **the site edit API** and **operator-isolation
test coverage** of the four adversarial cases (they existed only at SQL
level in `tests/rls.test.ts`).

**`api.sites.update` (admin) — `src/lib/backend.ts`.** Edits site fields
(name, operator, county/district/community, mineral type, coordinates,
notes) with the boundary kept server-side: requireAdminUser (client gate) →
RLS "sites update" consumes the permission matrix
(`mg_has_permission('sites.update')`) → `mg_guard_site_write` re-checks
before the row moves → the server's `mg_audit_row` trigger writes the
authoritative before/after diff in the SAME transaction (SEC-1: the client
cannot write audit_log) while `sites_touch` bumps `row_version/updated_by`.
Validation rejects blank name/county/operator and out-of-range
cordinates (`INVALID_*` codes); an edit that changes nothing returns the
row without writing (no row_version bump, no audit noise). Changing the
operator **clears `organization_id` in the same write** so `sites_org`
re-resolves (or mints) the tenant by name — a bare `operator_name` change
on a bound row would be silently re-derived from the old organization,
which is exactly the contract the new rls test pins.

**Tests — suite 328 → 335, all green:**
- `tests/backend-edge.test.ts` +2: authorized path (edit persists,
  row_version +1, `updated_by` = admin, exactly one `sites.update` audit row
  with the before/after diff, no-op leaves both untouched, operator
  re-point binds a minted organization) and denied path (operator / county /
  guest → FORBIDDEN, anon → UNAUTHENTICATED, unknown id → NOT_FOUND,
  blank name / bad latitude → INVALID_*, fixture row unmoved).
- `tests/operator-isolation.test.ts` +4 (NEW adversarial block, through
  `api.*` — the exact path the UI consumes): **renamed operator** (org
  rename cascades display; feed still keyed on the UUID; sibling tenant
  untouched), **same-name operators** (fixture site re-pointed at a
  same-named sibling org — display byte-identical, yet gone from opA's
  feed and detail path while admin still sees it), **site-scoped staff**
  (fresh identity: `scope='site'` sees nothing until assigned, then exactly
  the granted site; writes stay FORBIDDEN), **cross-county** (county
  inspector own-county only; edit API denied for every non-admin).
- `tests/rls.test.ts` +1 (SQL level): the site-edit contract — a same-name
  write on a bound row can never drift the binding to a same-named sibling;
  only a cleared binding re-points the tenant (resolve-or-mint); isolation
  follows the UUID both ways; restoring the binding restores access.

**Harness lessons (pinned here so the next session doesn't relearn them):**
`mg_guard_site_write` and `mg_guard_org_write` refuse DELETE for EVERY
role (owner included) — probe rows are therefore never deleted, only
re-bound/reset, and all cross-file assertions stay membership-based; the
org-rename cascade is SECURITY INVOKER and its scope-stamp backfill fires
child lifecycle guards that read the SESSION JWT, so any statement
touching `operator_name` runs through `adminExec` with an admin-claims
prolog (the same prolog `withRole` uses in rls); the wire bridge hands
jsonb columns back already parsed.

**Honest follow-ups:** unchanged from Session 2 — the owner must push
migrations 0012+0013 live, and the matrix still has no admin UI by design
(granting a capability is a migration). No edit UI yet: the API is
exercised by tests; wiring a SiteDetail edit dialog is product polish,
not part of this directive's acceptance.

---

**Session:** Offline reliability Session 4 — OFF-1…7 / EVD-1
**Date:** 2026-10-06
**Verification:** `bun tsc -b --noEmit` ✓ · `bun test` **324 pass / 4 skip
(opt-in live) / 0 fail** (328 tests, 21 files) ✓

## This session [2026-10-06 — OFF-1…7/EVD-1: durable offline queues,
backoff sync, row_version conflicts, evidence integrity]

**Storage (OFF-1/2) — `src/lib/offline-store.ts`.** The field queue and
inspection drafts moved off localStorage into **IndexedDB**, behind a small
durable key/value layer: every `storeSet` writes, **reads the value back
and compares**, and throws `NotSavedError` (code `NOT_SAVED`) on any
failure — quota aborts, blocked databases, private modes. The synchronous
mirror that render paths read is updated only AFTER the verified write, so
a failed write leaves both storage and UI showing the pre-write state, and
every enqueue/upsert/delete is async + surfaced: pages await it, a
NOT_SAVED rejection blocks any "saved" toast/branch (the local-inspection
draft form additionally keeps a red banner until the next good write).
localStorage remains the fallback backend (Bun/tests); a `memory` backend
is exposed via `storeBackend()` so the queue manager can warn that nothing
survives a reload. Legacy `mg.offline.*` localStorage keys migrate into
IndexedDB copy-verified-first (a crash mid-migration can only leave data
in both places, never neither). Mutations are read-modify-write against
the FRESH stored value, so two tabs (or tab + scheduler) cannot clobber
each other through a stale mirror.

**Sync engine (OFF-3) — `src/lib/offline-retry.ts` + `src/lib/offline-sync.ts`.**
One shared policy classifies every failure: **conflict** (409 / `CONFLICT:`
payload), **permanent** (FORBIDDEN, NOT_FOUND, size/integrity/validation
and raw 4xx except 408/425/429 → item parks as `dead`, no wasted retries),
**retryable** (network, 5xx, rate limits, NO_SYNC_HANDLER) → exponential
backoff with half-window jitter (`2^n` seconds, capped at 5 minutes) until
`MAX_SYNC_ATTEMPTS = 8`, then parked as `dead` — never dropped, always
manually retryable/exportable. `startSyncScheduler()` owns the triggers:
**startup** (loads the durable queue, recovering items stranded in
`syncing` by a crash), **`online`**, **`visibilitychange`**, and a backoff
timer armed from the earliest `nextRetryAt`; runs are single-flight and
skipped while the platform reports offline (a run that cannot leave the
device would only burn retry budget). Both portal shells (staff
`PortalLayout`, operator `OperatorLayout`) run one scheduler each and
replace the old ad-hoc `online` listeners + 1.5 s polling with
`subscribeQueue` mirror refreshes.

**Conflicts (OFF-4) — `row_version` end to end.**
`respondCorrectiveAction` now takes `expectedRowVersion` (the version the
operator was looking at) and performs a CONDITIONAL update (`… and
row_version = …`); zero matched rows means someone changed the action
first, so it fetches the current row and throws `CONFLICT:{json}` with
code 409 carrying a server snapshot (status, note, rowVersion, closedAt).
The queue parks such items as `status: "conflict"` with the snapshot, the
online call sites surface a human explanation, and the **queue manager's
conflict-resolution screen** shows the queued response beside the server's
current row with an explicit choice: *Keep server version* (discard mine)
or *Apply my version* (re-arms `expectedRowVersion` to the server's
version, then retries). Replaying a response whose local removal was
interrupted but whose note already landed is idempotent (early success),
so crashes cannot dead-end on the once-per-action guard.

**Queue manager UI (OFF-5) — `src/components/QueueManager.tsx`.**
Inspect field submissions and queued evidence (status chip, attempts,
last error, next automatic retry), **retry now** (ignores backoff windows;
conflict/dead items move only through their explicit actions), **export
JSON** (queue + drafts + local refs + evidence metadata incl. sha256 —
bytes described, not embedded), and **discard** per item or everything,
every discard behind an AlertDialog confirmation; write failures during a
discard surface instead of pretending the item is gone. Reachable from
both shells via a `Queue` header button (parity).

**Local parent references (OFF-6).** Successful syncs record
`clientRef → server id` in the store (`recordLocalRef`). Evidence queued
against an offline-created record carries only the `parentRef`; its sync
**waits** (a counted `waiting` outcome, not a failure) until the parent
syncs, then uploads against the real id. The operator incident form now
uses this: its offline branch queues the report AND its documents instead
of silently dropping the attachments with the old "report-only" path.

**Evidence integrity + parents (EVD-1).** `enqueuePendingEvidence`
computes a **SHA-256** at enqueue; every replay re-hashes the stored bytes
first and refuses a mismatch (`EVIDENCE_CORRUPT`, parked, bytes kept,
never uploaded). The data layer independently re-hashes on upload and
refuses a client-declared digest that differs (`EVIDENCE_HASH_MISMATCH`);
the digest is stored in the new `evidence.sha256` column (format pinned
by CHECK). **Migration 0013** adds the `community_report` and
`corrective_action` evidence parents, makes `evidence.site_id` nullable
(site-less community-report attachments), guards `mg_stamp_site_scope`
for null-site rows, and widens the evidence read/insert RLS policies, the
storage read policy, `evidence_for_parent` and the `evidence_url` mint
gate with the matching staff-only branch (names and function signatures
unchanged — GAP-0/0011 pins unaffected; `create or replace` preserves the
pinned grants). UI: staff attach evidence to community reports from the
triage list; operators attach **response documents to a corrective action**
(`EvidenceSection parentType="corrective_action"`), completing operator
portal parity (offline CA response queueing + scheduler + queue manager).

**Tests — `tests/offline-reliability.test.ts` (19) + updated suites.** The
five acceptance scenarios run through the real layers: quota exhaustion
(injecting `QuotaExceededError` → `NotSavedError`, queue unchanged,
source-contract scans proving every page awaits its enqueue), mid-sync
crash (strand `syncing` → restart recovery → replay, server sees ONE
record), duplicate replay (lost response after commit → clientRef dedupe →
one record), 409 conflict end to end through the bridge (stale
`row_version` → `CONFLICT` + snapshot → queue parks → resolution → row
lands at version 2 → idempotent replay), and parent-created-offline
evidence (waiting → parent sync → resolve → upload against the server id),
plus sha256 record/mismatch/corruption, both new evidence parents,
backoff/classification units, max-attempts parking, and scheduler/queue
manager source contracts. `tests/migration-apply.test.ts` gained a 0013
describe (idempotency with a normalize-first re-apply — the file's 0002
re-run chain recreates the storage policy from pre-0013 text, a test-order
artifact — plus pins: exactly five enum labels, nullable site_id, sha256
constraint, policy-name surface, staff branch in every qual/with_check,
authenticated-only grants, and a staff-vs-operator site-less RLS/RPC
scenario). Existing suites updated for the async API and backoff windows.

**Live state.** Migration 0012 (SEC-4) and now **0013** both await the
owner's push (order matters: 0012 first); the live `community_reports`
SELECT-grant repair SQL from the SEC-4 session is still pending — until it
runs, the live Command Center stays broken regardless of 0012/0013.

## [2026-10-05 — SEC-4: correct statistics at ANY table size]

**Defect (SEC-4, HIGH).** `allRows()` did a bare PostgREST `select("*")`
with no Range/limit on seven tables — sites, inspections, findings,
corrective actions, incidents, environmental observations, community
reports — feeding the Command Center, risk scores, the §18 AI explainer,
list surfaces and CSV exports; every aggregation ran in the browser.
Hosted PostgREST caps unranged responses at `db-max-rows` (default 1,000
rows): past that size the data arrived **silently truncated** and every
statistic was quietly wrong — a 200 with no error, numbers presented as
fact. The 17× perf baseline (doc 17) measured the DB-side path through an
UNCAPPED harness, so it could not detect the defect either — both halves
of that honesty gap are closed below.

**Fix half 1 — pagination (`src/lib/backend.ts`).** New `pagedRows()`
fetches with an explicit Range (`order("id")` — a total order, so windows
are stable across pages) until a short page returns; any error on any page
THROWS rather than returning a partial set. `allRows()` is now paged, so
every call site (command center, risk scores, explainer, lists, exports,
notifications, feeds, `listUsers`) inherits it. The two registry code
scans (`sites.create` / `runSeed`) page too — a truncated scan would
re-propose an existing site code once a lineage passed the cap — and
`seedIfEmpty` became an explicit `limit(1)` existence probe.

**Fix half 2 — aggregation in the database (migration 0012).**
`mg_command_center_stats()` computes the Command Center's 18 figures over
seven tables **in Postgres** (counts, sums, rounds, group-bys — mirroring
the former client aggregation statement for statement) and returns ONE
jsonb row. Deliberately **SECURITY INVOKER**: every SELECT inside runs as
the calling role under the same RLS policies the paginated reads go
through — RLS *is* the authorization, no scope re-derivation to get wrong
(and the GAP-0 definer-self-authorization pin correctly does not apply).
EXECUTE is revoked from PUBLIC and anon immediately after creation (the
built-in `=X` materializes on `CREATE FUNCTION`; 0011's default privileges
cannot express its removal) and granted to `authenticated` only — the anon
surface stays EXACTLY the two public flows. **0011 amended:** its
authenticated allowlist (and lineage-report array) now carries
`mg_command_center_stats`, because 0011 does a full revoke-then-restore on
every idempotent re-run — the 0002/0009 chains re-apply it, so without
that entry the grant would silently disappear.

**commandCenter RPC-first with a correct fallback.** The data layer calls
the RPC; on a lineage that has not applied 0012 (the live project, until
the owner pushes) it logs one console warning and falls back to the
original client-side aggregation — which is exact too, because its inputs
are now paged. Never a truncated number either way.

**Harness fidelity — the cap is now REAL in tests.** The wire bridge
emulates hosted `db-max-rows`: an unranged read stops at exactly 1,000
rows while explicit Range windows page past it; `.order()` accumulates
(supabase-js parity) and the bridge carries the new RPC spec. A regression
to a bare select now FAILS the suite instead of passing against an
uncapped harness.

**Tests — suite 294 → 303, all green.**
- NEW `tests/sec4-pagination.test.ts` (9 tests): the cap bites (exactly
  1,000 of a >1,250-row table) AND Range pages past it; `listIncidents`
  returns all 1,200 seeded rows; risk scores see all 1,250 findings (factor
  label “1250 low finding(s)” — a truncated read would say 1000) with the
  score ≡ Σ points invariant; Command Center figures equal the database's
  own totals past the cap (sites/inspections/findings/incidents/reports)
  with group-by consistency checks; **RPC ≡ client fallback** — identical
  objects over the same data, with the RPC path proven non-vacuous by a
  console-warn spy (fallback-vs-fallback would have passed vacuously);
  anon EXECUTE denied; source contracts (Range paging, RPC call, cap
  emulation in the bridge).
- GAP-0 pins extended: the authenticated surface now equals 18 pinned
  signatures (adds `mg_command_center_stats()`), anon unchanged at 2, zero
  PUBLIC grants, 0011 idempotent with the new entry.
- Perf bench gained exactness assertions (every seeded row counted;
  complete inspections list past the seed) and its stale volume header was
  corrected (320 inspections / 640 findings / 320 CAs / 80 incidents / 60
  observations / 4,000 audit rows — doc 17's table was already right).

**Perf + honesty (doc 17 re-measured).** Same fixture, same budgets, all
surfaces PASS (command center ≈195 ms median, ≈10× headroom; risk scores
≈154 ms; lists unchanged within noise). Honest reading: in-process PGlite
has **no network to save**, so the RPC path is not faster *there* — it pays
SQL planning for ~20 aggregates where the old path paid seven cheap
in-process fetches; what changed is the WIRE shape: ONE jsonb row instead
of ≈1,660 rows plus browser-side summation, and exactness at any size.
RTT/payload savings cannot be measured in-process and are not claimed.
The harness now caps unranged reads, so a truncated baseline run fails
instead of printing a number.

**Honest follow-ups:** (a) the owner must push **0012** to the live
project (doc 14) — until then the fallback serves the dashboard (correct,
heavier wire); (b) single-parent child reads (`.eq()` lists such as
findings-per-inspection) remain single-request and bounded by that parent —
they would need the same paging treatment beyond pilot scale; (c) risk
scores and the AI explainer still aggregate in the browser — exact now,
over paged reads — pushing the risk model into SQL is the next scale step
if the dataset grows ~10×.

**Live incident [2026-10-05, after deploy]: Command Center 403s on the
admin screen.** Console showed `POST /rest/v1/rpc/mg_command_center_stats`
403 plus `GET /rest/v1/community_reports?…offset=0&limit=1000` 403
(repeated). Diagnosis via publishable-key probes + `RUN_LIVE_TESTS=1`
live suite (4/4 still green — that suite only probes ANON and
intentionally tolerates 401/42501 on domain tables, so it cannot see this):
- the function **exists** on live (anon gets
  `permission denied for function mg_command_center_stats`, not 404
  PGRST202), and anon stays correctly closed (0012 by design);
- the other six command-center tables read fine as the authenticated admin
  — only `community_reports` is privilege-denied (42501 → 403). Since
  `mg_command_center_stats` is SECURITY INVOKER, its `community_reports`
  sub-select fails the same way, so the RPC 403 and the fallback's table
  403 share ONE root cause: **on the live (divergent) lineage,
  `authenticated` never received (or lost) SELECT on `community_reports`** —
  repo 0002 issues grants `on all tables` but live was provisioned before
  that sweep covered this table. This is very likely the true root cause of
  the ORIGINAL “Command Center loads forever” report — client-side fixes in
  the previous session only bounded the symptom.
- Why the suite missed it: PGlite runs the repo migrations (grants present),
  and the live suite is anon-only by design (no credentials in CI).

**Repair (owner, SQL Editor — idempotent, repo-0002/0012 intent):**

```sql
grant select on public.community_reports to authenticated;
grant execute on function public.mg_command_center_stats() to authenticated;
-- verify: both true
select has_table_privilege('authenticated','public.community_reports','select') as reports_select,
       has_function_privilege('authenticated','public.mg_command_center_stats()','execute') as rpc_exec;
-- sweep: any domain table listed = same-class gap elsewhere
select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r'
   and not has_table_privilege('authenticated', c.oid, 'select');
```

RLS remains the boundary (`reports staff read` = `mg_is_staff()`), so the
SELECT grant exposes nothing to non-staff; anon stays revoked (0009
posture). Verification: admin reloads Command Center — figures render from
the RPC with no 403s. If the sweep lists other domain tables, run
`grant select on all tables in schema public to authenticated;` (repo-0002
posture; RLS unchanged).

**Amendment [2026-10-06 — the owner's first live 0013 run failed with
42704].** The live lineage has NO `public.evidence_parent` (its base
schema predates the repo's 0001), and 0013's original label guard only
checked for the LABEL, never the TYPE — it failed open, ran `alter type
public.evidence_parent add value …`, and the SQL Editor's
single-transaction run rolled the ENTIRE file back (live unchanged).
0013 is now lineage-adaptive: the guard resolves the type from the
`evidence.parent_type` COLUMN (enum → schema-qualified ADD VALUE wherever
that enum lives; plain text → NOTICE, no ALTER needed), a CHECK constraint
that would veto the labels is surfaced by NOTICE instead of at the first
upload, the recreated `evidence_for_parent` matches parent types as
`::text` (identical semantics for the enum column; correct where
parent_type is plain text — a `::evidence_parent` cast would throw at
every call on live), and any non-canonical SELECT/INSERT evidence policy
is dropped before recreate so a divergent lineage cannot silently OR an
old policy with ours (no-op on the repo lineage — the canonical two names
are the whole surface). A `pg_policies.polname` typo was caught by the
harness on first re-apply (correct column: `policyname`). Repo suite
re-verified 331/4/0; the owner re-runs the fixed file whole.

---

**Session:** UI defect fix — HashRouter anchors (404) + bounded query
loading (eternal spinner)
**Date:** 2026-10-05
**Verification:** `bun tsc -b --noEmit` ✓ · `bun test` **290 pass / 4 skip
(opt-in live) / 0 fail** (294 tests, 19 files) ✓

## This session [2026-10-05 — landing "Principles" 404 + Command Center
loads forever]

**Reported:** (1) the landing-page "Principles" nav item rendered "Page not
found (404)"; (2) the Command Center screen loaded forever.

**(1) 404 — raw `#anchor` links under HashRouter.** The app routes on
`location.hash`, so clicking `href="#principles"` REWROTE the hash and the
router parsed the fragment as a ROUTE — path `principles` matched the `*`
catch-all and rendered NotFound (identically for `#capabilities` and both
shells' `#main-content` skip links). Fix: `sectionJump()` in
`src/lib/utils.ts` — `preventDefault` keeps the router's hash intact, then
scrolls (and focuses: `tabIndex={-1}` added to both `<main id="main-content">`
targets so skip-link focus actually lands). All four anchors wired through
it, and a new source-scan test pins it: EVERY `href="#…"` anchor in
`src/**/*.tsx` must carry `sectionJump(` (plus a non-vacuity floor of 4).

**(2) loads forever — one failed fetch bricked the screen.** `live()` /
`liveDoc()` fetch once on subscribe; on error the shared cache reads the
emitted `undefined` as "still loading" and NOTHING re-ran the fetcher — a
single failed request left Command Center on "Loading…" permanently.
`liveDoc`'s error path was worse: it emitted `null`, mislabeling a transient
failure as "signed in but no profile" (the "No portal role assigned" screen).
Fix in `src/lib/backend.ts`: both helpers retry with capped exponential
backoff (1s → 30s, reset on success, cleared on unsubscribe — the suites'
`first()` helpers resolve on first emission, so no test semantics changed);
`liveDoc` never emits `null` on error (`null` now means only "verified no
row"). Bounded, honest UI instead of endless spinners: RequireAuth's gate
goes from spinner to "Still loading your account" + retry after 12s (all
three gates), and Command Center shows an error panel with a working Try
again (fresh subscription via a query-key bump) after 8s.

**Diagnostics ruling the database out:** live probes with the public anon
key showed 0009–0011 fully applied and grants intact on project
`ewukneoblhogtreeekqc` (`mg_has_permission` → 42501 as designed,
`refresh_public_stats` → 204 proving 0011's allowlist, `organizations` /
`audit_log` exist but anon-closed), and the opt-in live suite passes 4/4 —
the defects were client-side only.

**Tests — suite 292 → 294, all green:** two source-scan regressions added to
`tests/accessibility-audit.test.ts` (anchor/sectionJump pair).

---

**Session:** Security roadmap Session 3 — deny-by-default function execute
surface (docs/04 Gap 0)
**Date:** 2026-10-05
**Verification:** `bun tsc -b --noEmit` ✓ · `bun test` **288 pass / 4 skip
(opt-in live) / 0 fail** (292 tests, 19 files) ✓

## This session [2026-10-05 — Gap 0: function execute surface]

**Directive item:** derive Session 3 from the repository's documented gaps.
The highest-value repo-side item is docs/04 "Known gaps" item 0 — privileged
surfaces were INTENT, not guarantee: every RPC must keep its internal
authorization check because the EXECUTE privilege layer cannot be trusted
everywhere. Auditing the harness showed the privilege layer was weaker than
the docs assumed (probe-verified against the test database):

1. 0002's `grant execute on all functions … to anon, authenticated` gave
   BOTH client roles the entire surface — 37 non-extension functions, against
   a documented client surface of seven RPCs.
2. Functions created after 0002's `revoke … from public` materialize the
   built-in PUBLIC grant (`=X`) on creation — and on this PostgreSQL that
   grant CANNOT be removed by `ALTER DEFAULT PRIVILEGES` (probe: the default
   ACL never records it). Consequence: 0009's and 0010's per-function
   `revoke … from anon` were VAIN — `has_function_privilege('anon',
   triage_community_report…)` stayed true through the PUBLIC fallback, and
   anon could execute `mg_resolve_organization` (the tenant-minting helper
   0010 explicitly closed) the same way.
3. 0002's default privileges still re-grant every FUTURE function to both
   client roles (0009's rewrite covered tables and sequences only).

**Migration `supabase/migrations/0011_function_execute_surface.sql`**
(single transaction, idempotent):

- **A — default privileges reversed for client roles**; the PUBLIC revoke is
  re-asserted for lineages where it bites (hosted Supabase revokes the PUBLIC
  default platform-wide — 0002's parity note). On this harness PUBLIC
  survives for new objects regardless, so THE GUARANTEE IS THE PINNED TESTS,
  not the default ACL: any future migration that creates a function without
  an explicit revoke fails the suite.
- **B — full reset:** `revoke execute on all functions in schema public` from
  public, anon and authenticated (the owner keeps its privileges — definer
  bodies and the migration itself are unaffected).
- **C — extension members restored exactly** to both client roles (pgcrypto/
  pg_trgm planner support such as `gin_extract_query_trgm` must stay callable
  or index/ILIKE scans fail for every role; on hosted Supabase these live in
  `extensions`, outside this surface).
- **D — anon allowlist = the two public flows** (`submit_community_report`,
  `refresh_public_stats`). The public mirrors' policies are `using (true)`
  and call no functions, so anon needs no authorization helpers at all.
- **E — authenticated allowlist = the seven documented RPCs + the
  authorization-helper class** (`mg_profile`, `mg_role`, `mg_operator_name`,
  `mg_is_admin/staff/reviewer`, `mg_has_permission`, `mg_any_profile_role`,
  `mg_can_access_site(_row)`) — pure reads over claims/matrix that policies
  and SECURITY INVOKER guards evaluate IN THE CALLING ROLE's context, hence
  the caller needs EXECUTE. Machinery (`mg_resolve_organization`,
  `mg_client_ip`) and trigger functions get no client grant: triggers fire
  without an EXECUTE check, and definer bodies run as their owner.
**Tests — suite 286 → 292, all green:**
- NEW GAP-0 block in `tests/migration-apply.test.ts` (six tests): 0011
  idempotent (re-runs leave the matrix byte-identical); anon executes
  EXACTLY the two public flows — `has_function_privilege` accounts for the
  PUBLIC fallback, so a recreated `=X` function fails this pin; zero PUBLIC
  grants across every non-extension function (the enforcement that forces
  future migrations to revoke explicitly); the authenticated surface equals
  the pinned 17; default privileges grant future functions to neither client
  role; and every client-reachable SECURITY DEFINER function carries an
  internal authorization pattern (`mg_is_admin`/`mg_is_staff`/`mg_is_reviewer`/
  `mg_has_permission`/`mg_profile`/`auth.uid`/`mg_can_access_site`) or is a
  reviewed helper/public flow — Gap 0's core requirement, now mechanical,
  with a non-vacuity floor on the reachable set.
- 0002's and 0009's idempotency re-runs now re-apply 0011 afterwards (both
  blanket-re-grant or drop/recreate functions; the hardened surface must
  survive them for every later suite).
- `tests/rate-limit.test.ts`: the four `mg_client_ip` parsing tests moved
  from the anon role to postgres — 0011 gives that server-side derivation
  machinery no client callable surface (it runs inside
  `submit_community_report`'s definer body as the owner), while the anon path
  through it stays proven by the submit/rate-limit tests.

**Honest follow-ups:** the live project still runs migrations 0001–0008 —
**the owner must `supabase db push` for 0009–0011**; until then the live
lineage keeps the blanket function grants, and docs/04 Gap 0's original
wording (internal checks as the only backstop) remains accurate THERE.
Post-0011 the repo closes the "intent" half of Gap 0: a future function
without an explicit revoke fails the suite. Residuals: (a) extension
functions in the harness's `public` schema keep client execute — platform
difference, hosted Supabase places them in `extensions`; (b) an event trigger
that auto-revoked PUBLIC on every `CREATE FUNCTION` was rejected (requires
superuser — unavailable on hosted Supabase); the pinned-surface test is the
enforcement instead.

**Live application [2026-10-05]:** the owner applied 0009–0011 through the
Supabase SQL Editor. 0011's first run aborted with SQLSTATE 42883 —
`function public.evidence_for_parent(text, uuid) does not exist` — because
the live project runs a pre-repository lineage that does not carry that
signature. Grants were rewritten to issue per function NAME over whichever
overloads the applying lineage has, skipping absent names with a NOTICE
(migration header bullet F); on the repository lineage the outcome is
byte-identical and all GAP-0 pins stay green (suite 288/4/0 re-verified
after the change).

---

**Session:** Security roadmap Session 2 — tenancy on organization UUIDs +
the role → permission matrix (SEC-5 / SITE-1, §6)
**Date:** 2026-10-05
**Verification:** `bun tsc -b --noEmit` ✓ · `bun test` **282 pass / 4 skip
(opt-in live) / 0 fail** (286 tests, 19 files) ✓

## This session [2026-10-05 — SEC-5/SITE-1 organizations, scopes & permissions]

**Directive item:** Session 2 of the security roadmap: tenancy keyed on a
stable organization UUID instead of a mutable display string; implement the
previously unimplemented `site` scope; move the role → capability mapping out
of inline policy text into an inspectable, migration-managed permission matrix.
Acceptance: renamed operator → isolation unchanged (display follows);
same-name operators → distinct tenants; site-scoped staff → exactly the
assigned sites; cross-county/cross-tenant writes denied; no behaviour
regression for any pre-0010 persona.

**Migration `supabase/migrations/0010_organizations_scopes_permissions.sql`**
(single transaction, idempotent — re-run now pinned by a dedicated block in
`tests/migration-apply.test.ts`):

- **A/B — `user_scope` grows to six values** (`national, regional, county,
  district, site, operator`). `ALTER TYPE ADD VALUE` cannot be *used* in the
  same transaction on an existing column (probe-verified on this harness), so
  the enum is renamed aside, recreated canonically, repointed, and the
  predecessor dropped once nothing depends on it (the "inspections read"
  policy expression pins `profiles.scope` in pg_depend, so that policy is
  dropped and recreated verbatim — same count, same behaviour). Operator
  accounts provisioned with the old, unimplemented `site` scope move to
  `operator`; `site` now means staff bound through `site_assignments`.
- **C — `permissions(role, permission)`** seeds the matrix for all four roles
  (18 rows) and `mg_has_permission()` (SECURITY DEFINER, stable) becomes the
  single gate: sites insert/update, organizations, admin_areas,
  site_assignments and the audit-read policy consume it instead of inline
  role tests. Clients hold SELECT only — there is deliberately no write
  policy: the matrix changes by migration, never by client write.
- **D — `admin_areas`**: configurable national → region → county → district →
  community hierarchy (self-referencing `parent_id`, `level` as a checked text
  column so the level set stays configurable), backfilled from the geography
  already in the data; regional and district scopes resolve through it.
- **E/F — `organizations` + `site_assignments`**: the operator registry,
  keyed by UUID with `name` deliberately NOT unique, and explicit staff↔site
  grants (the implemented `site` scope). Both tables join 0009's audit trail
  and carry the integrity stamps.
- **G/H — `organization_id` becomes the tenant key** on sites and profiles;
  `operator_name` survives as a compatibility/display mirror maintained by
  sync triggers. A name-only insert (the existing `api.sites.create`
  contract) resolves or creates the organization by name; once bound,
  `operator_name` is re-derived from the organization on every write; an
  organization rename cascades the display name onto sites and profiles under
  a transaction-local flag so a same-named sibling can never be re-resolved
  by mistake.
- **I — `mg_can_access_site_row(id, county, district, operator, org)`**: the
  scope matrix computed over the row's OWN columns (keeps 0007's
  INSERT…RETURNING fix): admin/national → all; county → own county;
  regional/district → through admin_areas; any staff scope + an explicit
  assignment → that site; operator → organization UUID, with name equality
  only as the legacy fallback for profiles not yet bound. The uuid form, the
  sites policies, and the guards are rebuilt on it; the obsolete two-argument
  row form is dropped so no caller can silently use the pre-0010 matrix.
  `mg_guard_site_write` moves to SECURITY INVOKER + `current_user` (the
  0004-proven discrimination) so this migration's backfill and ops scripts
  pass while client sessions stay permission-gated (the DELETE refusal is
  unchanged — belt behind SEC-3's revoke). "audit staff read" reads the
  permission set too (same roles the old `mg_is_staff()` granted).
- **J — profile guard parity**: `organization_id` and `scope_area_id` join the
  admin-only column list — a self-service profile edit can never move its own
  tenant key.
- **K/L — backfill and privileges**: geography → one organization per
  distinct operator name → sites/profiles bound (every statement
  `where not exists`, so re-runs are no-ops); EXECUTE on the policy helpers
  for client roles, and REVOKE EXECUTE on `mg_resolve_organization` plus the
  sync/guard triggers from anon and authenticated — no callable surface to
  mint organizations or bypass the guards.
**Client (`src/lib/types.ts`, `src/lib/backend.ts`):** `Scope` grows to the
six values; `organizationId` on `UserProfile`/`Site` documented as the tenant
key (display string is a mirror); `canAccessSite` keys operator tenancy on the
UUID (name compare only as legacy fallback) and lets regional/district/site
scopes pass client-side — RLS already filtered every row that reaches the
client; profile/site mappers expose `organization_id`.

**Tests — suite 277 → 286, all green:**
- `tests/rls.test.ts` new SEC-5/SITE-1 block: org rename cascades to sites
  and profiles (siblings untouched) with the server-written audit diff;
  same-name organizations remain distinct tenants; `scope='site'` sees
  nothing until assigned, then exactly the granted sites (the unique index
  refuses duplicate pairs); cross-county and cross-tenant writes stay denied
  under the UUID matrix; the seeded matrix is what the policies consume; every
  pre-0010 persona keeps its access.
- The adversarial permission-revocation case as drafted could not pass and
  was corrected this session: it revoked only `sites.update` yet also demanded
  the subsequent INSERT be refused (the two grants are independent gates),
  and it expected `row-level security` in the error while — probe-verified on
  this harness — the site guard raises `FORBIDDEN` *before* the WITH CHECK
  expression is evaluated on INSERT. It now revokes each grant in turn and
  pins both gates: helper → false, USING filters the update to 0 rows, the
  sibling insert still lands, then the `sites.insert` row goes and inserts are
  refused outright. No migration change was needed.
- `tests/migration-apply.test.ts`: 0010 auto-discovered and counted (19
  tables, all RLS-enabled); its re-run restores the hardened grant surface
  after 0002's re-run; NEW 0010 block — idempotent re-runs mint no duplicate
  organizations/admin_areas/matrix rows, the matrix stays at 18 rows, the
  scope enum stays at six values, and the policy surface is recreated not
  duplicated (3 organizations / 3 site_assignments / 3 admin_areas / 1
  permissions).

**Honest follow-ups:** the live project still runs migrations 0001–0008 —
**the owner must `supabase db push` for BOTH 0009 and 0010** before the
deployed database matches this posture; until then live tenancy is still the
display-string model, `site` scope remains unimplemented, and no permission
matrix exists there. The matrix has no admin UI by design (granting a
capability is a migration). The client-side list constraint
(`scopeConstraintForUser`) still keys operators on `operatorName` — server
RLS is authoritative for row visibility, so an organization-UUID list
constraint is an optional efficiency follow-up. ADR-03 amended accordingly.

---

**Session:** Security roadmap Session 1 — audit & integrity foundation
(SEC-1 / SEC-2 / SEC-3)
**Date:** 2026-10-02
**Verification:** `bun tsc -b --noEmit` ✓ · `bun test` **273 pass / 4 skip
(opt-in live) / 0 fail** (277 tests, 19 files) ✓

## This session [2026-10-02 — SEC-1/2/3 audit & integrity foundation]

**Directive item:** SECURITY DEFINER audit triggers on every mutable table
(actor from the session, never client-supplied; before/after diff; entity;
timestamp), REVOKE client writes on `audit_log`, demote client `logAudit`,
integrity columns via trigger, archive instead of DELETE, REVOKE DELETE,
trim anon grants to the minimum. Acceptance: forged audit insert fails for
every role; every mutation produces exactly one server-written audit row
(even if the client crashes); no DELETE for any client role; row_version
increments; tests added to the rls/migration suites.

**Migration `supabase/migrations/0009_audit_integrity.sql`** (one
transaction, idempotent, re-runnable):

- **SEC-1 — the audit trail is written only by the server.** New
  `mg_audit_row()` SECURITY DEFINER trigger, attached `AFTER INSERT OR
  UPDATE` to all ten domain tables (one trigger ⇒ exactly one row per
  mutation). Each row carries `actor_id = auth.uid()` derived from the
  SESSION and filtered through `profiles` (FK-safe; definer/system writes
  land as `system` / `unregistered:<sub>`), `entity_type` = table,
  `entity_id` = row id, server `created_at`, and a structured before/after
  diff in the new `audit_log.details` jsonb (full row on insert; changed
  business columns only on update — stamp columns excluded), with a human
  summary incl. `status: old -> new` transitions. Written in the same
  transaction as the mutation ⇒ a client crash can neither drop nor forge
  a row. The `"audit append"` policy (0001) is dropped and
  `INSERT/UPDATE/DELETE on audit_log` is revoked from anon +
  authenticated (SELECT stays: `"audit staff read"` is the row filter).
  `triage_community_report()` was re-created WITHOUT its hand-rolled audit
  INSERT (identity signature unchanged) so triggers are the single writer.
- **SEC-2 — integrity columns + lifecycle.** `updated_at` / `updated_by` /
  `row_version` on all ten domain tables, stamped by `mg_touch_row()`
  BEFORE INSERT/UPDATE which OVERWRITES any client-supplied value (insert
  ⇒ version 1; update ⇒ old+1, actor = session). Templates gain
  `archived_at`: `deleteTemplate` → `archiveTemplate` in the data layer,
  the guard now raises `ARCHIVE_ONLY` on DELETE, and 0008's
  `"templates delete"` policy is dropped — archive (UPDATE, audited) is
  the only retirement path, and archived rows leave every list.
- **SEC-3 — least privilege.** `REVOKE DELETE` on every public table from
  anon + authenticated; anon trimmed to `SELECT` on the two public mirrors
  (`meta`, `report_tracking`) plus its documented RPC execute surface
  (public flows go through SECURITY DEFINER RPCs and need no table
  grants); `alter default privileges` rewritten so FUTURE tables start
  closed (authenticated select/insert/update, anon nothing, no anon
  sequence grants).

**Client (`src/lib/backend.ts`, `src/pages/Templates.tsx`):** `logAudit()`
is now a non-authoritative console breadcrumb (no DB write — all 24 call
sites unchanged); the seed's direct audit insert was removed (the triggers
already audit every seeded row); template lists filter `archived_at`;
the Templates page archives (Archive icon, aria-label, updated copy).

**Tests — 11 net-new (suite 266 → 277), existing assertions retargeted:**
- `tests/rls.test.ts` new SEC-1/2/3 block: forged audit insert denied for
  anon + all five personas (`permission denied for table audit_log`);
  exactly one audit row per mutation with actor = session user and
  full before/after details; spoofed `row_version = 77` / foreign
  `updated_by` overwritten (version 1 → 2 → 3); status transition lands in
  the diff; DELETE refused at the privilege layer for every client role ×
  14 tables; even an admin cannot DELETE a template (archive via UPDATE
  works). Older silent-0 delete/append-only expectations were rewritten as
  privilege denials — that is the state 0009 actually creates.
- `tests/migration-apply.test.ts`: 0009 auto-discovered + idempotent
  (re-run ×2 with stable trigger/policy counts: 10 `_touch`, 10 `_audit`,
  audit_log policy count 1, no template DELETE policy); grant-matrix
  assertions (no client DELETE anywhere; anon SELECT exactly
  {meta, report_tracking}; audit_log read-only for clients); 30 integrity
  columns + `details` + `archived_at`; trigger functions SECURITY DEFINER;
  triage carries no manual audit INSERT; default-privilege probe table
  starts closed. The 0002 idempotency test now re-applies 0009 after its
  own re-run — re-running the historical grants file was re-opening the
  client surface inside the shared test database.
- Action-name assertions moved to server naming: `sites.insert`,
  `corrective_actions.update`, `environmental_observations.insert`,
  `inspection_templates.insert/update`.
- Cross-suite isolation fixes surfaced by a test-file order flip:
  `backend-edge` now cleans up its overdue-CA and high-severity finding
  probes (they leaked into the AI explanation suite's exact-weight
  assertions), and `rate-limit`'s anon contract is now "refused outright"
  rather than "zero rows".

**Honest follow-ups:** the live project still runs migrations 0001–0008 —
**owner must apply `supabase db push` (0009) before the deployed database
matches this posture**; until then the live audit log remains
client-appendable. Anonymous REST reads of trimmed tables now return
privilege errors instead of `200 []` (the opt-in live suite accepts both;
the public mirrors `meta` / `report_tracking` stay `200`).

---

**Session:** Mobile visibility pass — AI feature + admin notifications on
phones
**Date:** 2026-09-29
**Verification:** `bun tsc -b --noEmit` ✓ · `bun test tests/backend-edge.test.ts`
46/46 ✓

## This session [2026-09-29 — mobile visibility]

**Directive item:** ensure the §18 AI feature and the §1 admin notification
surface are visible on a mobile phone.

**Audit findings:**
- **Admin notifications (§1) invisible on phones** — in the staff portal
  (`PortalLayout`) `NotificationBell` was rendered ONLY in the desktop
  sidebar footer (`hidden … md:flex`); below `md` the whole aside is hidden,
  so staff/admins on a phone had no notification entry point at all. (The
  operator portal already did this correctly — bell in the mobile header.)
- **AI panel (§18) narrow-width hazards** — the panel rendered full-width
  block content, but the per-sentence citation record-IDs are a single
  unbroken `font-mono` token that overflows a phone viewport, and the panel
  header row could not wrap.

**Fixes:**
- `PortalLayout` — mobile-only bell added to the sticky header
  (`md:hidden` wrapper; desktop keeps the sidebar bell — no duplicate
  mount, one live() subscription still drives both). Sync chip label is
  compacted below `sm` so the bell isn't crowded out.
- `NotificationBell` — dropdown width `w-72 → sm:w-80` with
  `max-w-[calc(100vw-2rem)]` so it never clips a 320 px viewport; the same
  component now serves both shells at any width.
- `RiskAiPanel` — header row `flex-wrap`; citations get `break-all` so UUID
  tokens wrap within a phone width instead of overflowing.

**Verification:** typecheck clean; backend-edge suite 46/46 (the
notifications query + admin scopes exercise the bell's data path).

---

**Session:** Load/performance baseline — established at realistic pilot scale
(§16 "unmeasured" closed)
**Date:** 2026-09-28
**Verification:** baseline measured — every surface ≥17× under the 2 s
interactive budget (record: `docs/17_PERFORMANCE_BASELINE.MD`; bench:
`tests/perf-baseline.test.ts`, 12 tests) · `bun tsc -b --noEmit` ✓

## This session [2026-09-28 — performance baseline]

**Directive item:** §16 marks Performance as explicitly blank ("No load
testing; queries are collect()-based"). Establish a baseline at realistic
pilot scale before claiming any performance characteristic.

**Scale (from the program's pilot planning numbers):** 40 sites across 4
counties and 2 operators, 25 staff, 320 inspections, 640 findings, 320
corrective actions, 80 incidents (incl. fatalities), 60 observations, 4,000
audit rows, 200 community reports.

**Method:** the REAL data layer over the RLS-enforcing wire bridge (same
harness as the backend-edge suite — real RLS policies, real guard triggers,
real error mapping, per-request identity). The seed is deterministic,
idempotent, and asserts its own completeness (a baseline over silently-
missing data would be worthless — three seed defects were caught exactly
this way and fixed: enum-value mismatches, a UUID collision with the edge
seed, and a trigger-created stub profile). Each surface is warmed, then
measured 5× (median + worst); in-surface result-set sizes are printed.

**Results (median, budget 2,000 ms):** command center 115 ms (slowest —
reads 7 tables and aggregates), riskScores 111 ms (42 entries), operator
compliance feed 94 ms (161 joined rows), notifications 96 ms, county-scoped
inspections list 40 ms, full inspections list 25 ms, audit log 60 ms of 4k,
sites list 16 ms, incidents 8 ms, **full write path 3 ms** (auth + dedupe
probe + guard + insert + audit + public-stats refresh), clientRef dedupe
replay 1 ms. Every surface ≥17× under budget.

**Analysis (recorded in docs/17):** aggregators dominate (O(n) over domain
tables) and are the first optimization site at ~10× growth; scoped reads add
negligible cost over unscoped; writes are fixed-overhead-dominated, and the
offline replay guarantee costs effectively nothing per item.

**Honest limits (docs/17):** single-session, in-process engine (no network
RTT, no concurrent contention); volumes are projections, re-runnable at any
scale via the SCALE constant; production load testing remains [PLANNED] and
requires the production project. The bench doubles as a regression gate: a
surface exceeding its budget fails `bun test`.

---

## Prior session [2026-09-28 — accessibility audit, five core flows]

**Directive item:** audit keyboard navigation, contrast, and screen-reader
landmarks on the five core flows; document findings and fix confirmed
defects — do not merely assert compliance.

**Method:** static source audit of every interactive element, dialog, form
control, image, and landmark across the five flows (F1 public report, F2
sign-in, F3 staff sites, F4 field inspections, F5 operator compliance), plus
programmatic WCAG contrast computation over the real design-token values.
No simulator was trusted; each defect was confirmed in source before fixing.

**Confirmed defects — 7 found, 7 fixed:**

1. **Contrast WCAG AA failure** — `--muted-foreground` #6b6558 on `--accent`
   = 4.20:1. Fixed at the token: darkened to #5d5648 (≥4.95:1 on every
   surface it appears against). The failing pair's ratio is asserted
   `< 4.5` in the test so the regression cannot return silently.
2. **No skip navigation** — both portal shells now render a skip link to
   `#main-content` (visually hidden until focused).
3. **Keyboard-unreachable table navigation** — Inspections and Sites rows
   (click-to-navigate) are now focusable with Enter/Space activation,
   focus-visible outlines, and aria-labels.
4. **Keyboard-unreachable accordion** — template editor section headers now
   `role="button"` + `tabIndex` + `aria-expanded` + key handling.
5. **Placeholder-only inputs (7)** — every Auth page input (sign-in,
   sign-up, MFA code, recovery, new-password) gained an `aria-label`.
6. **Unassociated labels** — new-inspection dialog selects and the draft
   form's per-question controls (id `q-si:qi`) are now label-associated.
7. **Notification bell disclosure** — `aria-expanded`/`aria-haspopup`,
   Escape-to-close, click-away layer `aria-hidden`.

**Verified compliant without change:** Radix dialog semantics (trap, Escape,
titles — all audited dialogs have one), native selects, existing aria-labels
on icon-only buttons, image alt text, evidence opener as a real button.

**Tests** (`tests/accessibility-audit.test.ts`, 20): the contrast table is
COMPUTED from hex values (WCAG relative-luminance math, not eyeballed);
landmarks/skip links, keyboard handlers, label associations, and disclosure
semantics are pinned per file — any regression fails CI with the exact
defect named.

**Honest limits:** static + token-mathematics audit; a live assistive-
technology pass (NVDA/VoiceOver on the deployed app) is [PLANNED] and
recommended before pilot launch. Touch-target rule enforced by the design
system, not per-element measured.

---

## Prior session [2026-09-28 — restore rehearsal executed]

**Directive item:** perform and document an ACTUAL restore test — a
rehearsal, not a document.

**What was actually executed** (real PostgreSQL 14.24 clusters on the build
machine, not a mock):

1. **Source database built**: fresh cluster; all 8 migrations applied
   cleanly (after stubbing the Supabase-provided surface from the test
   harness: platform roles, `auth` schema incl. MFA tables, `storage`
   schema, `supabase_realtime` publication); representative data seeded
   (6 auth users/profiles across admin, two operators, county, national,
   guest; 2 sites; template; inspection/finding/CA; incident; evidence;
   community report; 1 MFA factor). Baseline recorded: 15 tables,
   33 RLS policies, 19 guard triggers, 96 routines.
2. **Backup executed** with the exact `scripts/backup-supabase.sh` logic:
   `pg_dump -Fc` (144,876 bytes), SHA-256 + size manifest, archive verified
   via `pg_restore --list`.
3. **Post-backup drift injected into the source** (site `LB-BOM-099`, a
   profile, an audit `drift.marker` row) — deliberately, so the restore can
   be proven to land at the backup's point in time rather than "now".
4. **Restore executed** via `pg_restore --clean --if-exists --no-owner
   --no-privileges` into a fresh `initdb` scratch cluster. Zero errors after
   pre-creating the three Supabase platform roles (cluster-level objects
   pg_dump does not emit; Supabase provisions these in production).
5. **Verification — ALL PASS**:
   - schema identical (15/33/19/96) and all 14 data-table row counts
     identical to baseline;
   - drift rows ABSENT from the restore while present in the live source
     (point-in-time invariant proven both ways);
   - RLS live on the restored DB: anon sees 0 sites; the AgriLib operator
     sees exactly `LB-BOM-001`; admin sees both;
   - guard triggers enforce on the restored copy: operator site-write →
     `FORBIDDEN: admin required to modify the site registry`;
   - a real INSERT round-trips (the restored DB is live, not just readable);
   - migration 0008's template-delete policy present.
6. **Teardown**: both drill clusters stopped and removed; only the record
   remains.

**Runbook knowledge gained (now in docs/14):** on a non-Supabase target a
restore needs (a) platform roles pre-created and (b) grants re-applied
before RLS behaves; on the real platform both are provisioned by Supabase.
Also documented: GoTrue credentials (password hashes, MFA secrets) are
platform-managed — after a database-level restore, auth users must be
re-synced via Supabase auth admin tooling before sign-in works.

**Honest scope:** the drill ran against a locally-reconstructed source
database (the production Supabase project does not exist yet — owner
prerequisite). The rehearsal validates the TOOLING and the restore/verify
procedure end-to-end; it must be repeated against the production project
once it exists, and the weekly automated drill in `backup.yml` then keeps it
standing.

## Prior session [2026-09-27 — Priority D: production deploy + backups]

**Directive item:** production deployment pipeline + backup schedule — dev
deployment verified, production was not. Define and implement a backup
schedule and a documented production deploy path (doc 14). No feature work.

- **Production deploy path** (`deploy-production.yml`, new) — manual
  `workflow_dispatch` with a typed confirmation phrase plus the protected
  GitHub `production` environment (required reviewers): production deploys
  are deliberate acts, never push side effects. The `guard` job runs
  typecheck + the full test suite, then takes a FRESH backup
  (`scripts/backup-supabase.sh`, 90-day artifact) — the deploy job
  `needs: guard`, so no production deploy proceeds on a stale recovery
  point. The build runs `VITE_MINEGUARD_ENV=production` and the workflow
  FAILS if the compiled bundle contains the demo-seed UI or if the deployed
  endpoint does not answer HTTP 200.
- **Production seed guard (checklist item 4, now enforced)** —
  `VITE_MINEGUARD_ENV` typed in `src/vite-env.d.ts`; the seed button is not
  rendered under `production` and the call site refuses the action (defense
  in depth), with the bundle-level CI check as the third layer.
- **Backup schedule** (`backup.yml`, new) — nightly 03:30 UTC `pg_dump -Fc`
  via `scripts/backup-supabase.sh`: archive verified in-run
  (`pg_restore --list`), SHA-256 + size manifest per backup, 90-day artifact
  retention, weekly prune job so the retention promise matches reality,
  missing-dump fails loudly. Rationale for the slot: 03:30 UTC is inside the
  Bomi/Grand Cape Mount quiet window and after end-of-day offline-queue
  replays.
- **Weekly automated restore drill** — Sunday runs restore the newest dump
  into a throwaway Postgres 16 container and print `sites`/`inspections`/
  `audit_log` row counts: doc 14's "restore tested" is a standing scheduled
  proof, not a one-time promise.
- **Restore tooling** (`scripts/restore-supabase.sh`, new) — requires
  `TARGET_DB_URL` + typed `restore` confirmation, warns against production
  targets, prints the drill sanity checks to record.
- **Tests** (`tests/operational-readiness.test.ts`, 14) — pin the
  operational contracts so they cannot rot: seed guard in BOTH layers;
  prod workflow manual-only with typed gate + environment protection;
  backup-before-deploy job ordering; production flag + bundle sanity +
  deploy verification steps; nightly cron + 90-day retention + archive
  verification + weekly drill; restore script's explicit-target and typed-
  confirmation requirements.

**Owner prerequisites before first production deploy (docs/14):** production
Supabase project + migrations; repository variable `SUPABASE_PROJECT_REF` +
secret `SUPABASE_DB_PASSWORD`; GitHub environment `production` with required
reviewers. **Owner decisions:** object-storage offload of dumps (cost/
residency) and Supabase PITR tier upgrade are PROPOSED, not assumed.

**Honest limits:** backup artifacts live in the repository's Actions storage
(acceptable for pilot; offload is the owner decision); a standing uptime
probe and load testing remain PLANNED; the restore drill has not yet executed
against a real production database (it runs automatically once the owner
prerequisites exist).

---

## Prior session [2026-09-27 — §18: AI risk-score explanation]

**Directive item:** Priority C — AI (§18), only after A and B are stable.
Exactly ONE capability from doc 08's permitted list, recommended first:
risk-score explanation. Constraints check done before writing any AI code.

**Constraints check (doc 08), conclusion recorded:** all four constraints
are implementable as stated — and for THIS capability the strongest form is
available. Because the recommended first capability is a deterministic
walkthrough of the existing weighted factors, no provider model is needed:
"provider keys server-side only" is satisfied structurally (no key, SDK, or
network call anywhere — source-contract asserted); "human confirmation" is
exceeded (read-only, no write path exists at all, so nothing can reach the
authoritative record even with a confirmation flow); "cite-or-abstain" and
"server-side scoping" are implemented and tested. Conclusion: rules
tolerated as written; doc 08 updated with the implementation record, rules
not revised.

- **`src/lib/risk-model.ts`** (new, pure) — `RISK_WEIGHTS` and
  `computeRiskFactors` extracted from `sites.riskScores` so the computation
  and its explanation share one source of truth (the AI layer cannot
  describe anything but the real computation). Each factor now carries the
  record IDs grounding it — the cite-or-abstain anchors. `riskScores`
  refactored onto the shared module; behavior verified identical by the
  existing suites (all prior risk tests green unchanged).
- **`api.ai.explainRiskScore`** — new data-layer section with the four
  constraints documented in its header. Inputs assembled by the same scoped
  queries as `riskScores`; identity re-derived server-side; site access via
  `canAccessSite`; out-of-scope sites null-mask (not found OR denied → same
  null, no existence leak). With zero factors it abstains (empty summary,
  states the empty factor set) rather than inventing narrative; otherwise
  each sentence names its factor, computed points, and record IDs, and the
  payload carries a fixed disclaimer shipped in the data itself.
- **UI** (`src/components/RiskAiPanel.tsx` on SiteDetail) — renders only
  server payloads behind an unconditional "AI-assisted" badge + Sparkles
  marker + the payload disclaimer. No mutation hook exists in the component.
- **Tests** (`tests/ai-risk-explanation.test.ts`, 8) — no-leak: operator
  explanations cite only records verifiably existing in their scope (each
  citation checked against the DB), cross-tenant site null-masks, unassigned
  callers get null; consistency: explanation points sum exactly to the
  caller's own `riskScores` entry (no second data path); no-fabrication:
  sentence points match `RISK_WEIGHTS` exactly for seeded high-finding +
  overdue-CA cases, and citations include the seeded record IDs; abstention
  for a factor-free site; read-only: DB byte-identical after explanations;
  source contracts: the `ai` section contains no insert/update/delete, no
  audit write, no provider/network references, and the panel has no
  mutation hook and renders the label unconditionally.

**Honest limits:** the explainer narrates the indicator only — it does not
compare sites, project trends, or recommend actions (that is trend
identification's gate); abstention text is fixed wording, not generated;
the "AI-assisted" label describes a deterministic computation honestly —
no LLM is involved anywhere, which is the point of the first capability.

---

## Prior session [2026-09-27 — §9: CSV reporting exports]

**Directive item:** §1/§9 — no export capability existed. Scope a first
format scoped by the requesting user's existing authorization — do not
build a new unscoped data path.

**Scope decision (the core of the session):** exports are serialized IN THE
BROWSER from rows the caller's existing authorization already returned.
There is no export endpoint, service role, or RPC — the acceptance criterion
("scoped by existing authorization, no new unscoped data path") holds by
construction: an export can only ever contain rows the caller's feeds
returned. Verified by test, not assertion (below).

- **`src/lib/export-csv.ts`** (new) — RFC 4180 serializer (quoting of
  comma/quote/newline, doubled embedded quotes, CRLF, UTF-8 BOM so Excel
  opens non-ASCII county/operator names correctly), dated filenames
  (`mineguard-inspections-YYYY-MM-DD.csv`), and two export builders over
  already-authorized row shapes: `exportInspections` (the
  `inspections.list` shape — staff see their scope, operators their sites'
  inspections) and `exportComplianceObligations` (the
  `listMyCorrectiveActions` shape — finding, site, deadline state, operator
  response). The DOM anchor download lives inside an injectable default
  trigger (non-DOM tests). No dependencies added.
- **UI** — "Export CSV" on the Inspections list (all roles; disabled while
  the feed is empty) and on the operator Corrective Actions page; each
  serializes exactly the feed variable already on screen (what you see is
  what you export), with a toast naming the file and row count.
- **Tests** — `tests/export-csv.test.ts` (11): the pure format contract
  (BOM bytes asserted on the File's ArrayBuffer — Bun's text() strips a
  leading BOM when decoding, so string checks would lie; quoting/escaping;
  dated filename; empty cells; deadline-state derivation
  resolved/overdue/open) and the authorization invariant over the RLS wire
  bridge: operator compliance export is strictly own-tenant (a cross-tenant
  CA is seeded, proven absent from the serialization, then removed);
  county-scoped staff export contains their county row but never the
  Grand Cape Mount row; national staff export covers both counties;
  unassigned callers export a header-only file. A source-contract test
  asserts the lib contains no network/DB client at all and the pages feed
  it only the authorized list variables — wiring anything else into the
  exports fails this suite.

**Classification (docs/01):** CSV IMPLEMENTED; PDF rendering PROPOSED
(REQUIRES GOVERNMENT/OWNER CONFIRMATION — letterhead/format is the adopting
institution's decision). No new data path, table, or infrastructure.

**Honest limits:** exports reflect the live feed at click time (no
server-side archival or signed report artifacts); date filtering is
"filter the list, then export" — no date-range picker in v1; serialized
JSON-free CSV means answer-level detail of a specific inspection is not in
the v1 column set.

---

## Prior session [2026-09-27 — §1: minimal in-app notifications]

**Directive item:** §8/§1 — notifications not implemented at all; scope a
minimal version first (e.g. corrective-action deadlines, community report
status changes) before considering push/email/SMS. Classify delivery-channel
decisions as REQUIRES GOVERNMENT/OWNER CONFIRMATION where they imply new
infrastructure or cost.

**Scope decision (stated before coding):** v1 notifications are DERIVED at
request time from records the caller can already see — no notifications
table, no delivery infrastructure, no provider accounts, no cost, no new
retention question. Rationale: every event worth notifying about is already
visible in the caller's scoped record set; computing the list per request
inherits RLS/tenant scoping for free and cannot leak what the caller cannot
read. The two directive-named event classes plus one operator-specific
class:

1. Corrective-action DEADLINES — open/in_progress CAs in the caller's
   scope: due-soon (≤3 days) → warning; overdue → urgent; far-future →
   silent; decided CAs → no deadline noise.
2. Community-report STATUS CHANGES — staff queue only (RLS): triaged
   (under_review/verified/dismissed/referred) reports from the last 7 days;
   untouched "submitted" reports are not news. A reporter-facing variant is
   impossible without knowing who the anonymous reporter was — the public
   tracking page remains the reporter's channel by design.
3. Reviewer DECISIONS for operators — verified/closed/escalated on CAs the
   operator opened (matched by opened_by_id); escalated is urgent; links
   point into the operator section.

**Implementation:**

- `src/lib/backend.ts` [EXTENDED] — `records.listNotifications()`: the
  derived service (kinds ca_deadline / ca_decision / report_status, each
  with severity, body, in-app deep link into the caller's own section, and
  a timestamp). Sorting: urgent first, then newest. Unassigned/anonymous
  callers get empty/no-data (live() contract), never an error.
- `src/components/NotificationBell.tsx` [NEW] — bell + dropdown list used
  by BOTH portal shells (staff PortalLayout sidebar; operator section's
  top bar and desktop strip). Urgent count colors the badge. The panel
  footer states the in-app-only scope to the user, verbatim.
- `tests/notifications.test.ts` [NEW] — 12 tests: deadline thresholds
  (overdue→urgent, ≤3d→warning, 30d→silent, closed→silent); decisions
  addressed to the CA opener only (verified info, escalated urgent,
  /operate links); report status (triaged surfaces, submitted silent,
  operators get none); scoping/no-leak (cross-tenant CA invisible to the
  other operator; role-less empty; anonymous undefined-or-empty; links
  stay inside the caller's section); and a v1 SCOPE GUARD — a source-level
  assertion that no delivery channel (sendEmail/sendSms/push/fcm/sendgrid/
  twilio) is wired into the product and that no notifications table exists,
  so the confirmed-only boundary cannot erode silently.

**Delivery-channel classification (docs/01, binding):**

| Channel | Status | Why gated |
|---|---|---|
| In-app (derived) | **IMPLEMENTED** | No new infrastructure; RLS-inherited scoping |
| Email (SMTP) | REQUIRES GOVERNMENT/OWNER CONFIRMATION | Provider account + cost; recipient PII beyond current scope; delivery-log retention; government-adjacent sender abuse surface |
| Push (FCM/web-push) | REQUIRES GOVERNMENT/OWNER CONFIRMATION | Device-token registry = new personal-data class; provider cost |
| SMS | REQUIRES GOVERNMENT/OWNER CONFIRMATION | Per-message cost; phone-number PII; strongest sender-impersonation concerns |
| Reporter-facing notify | NOT POSSIBLE by design | Reports are anonymous; tracking page is the channel |
| Persisted notifications table | PROPOSED | Read receipts/dismissal need storage + retention decisions |

**Honest limits of this session:**

1. Derived notifications have no read-state: the badge reflects the current
   event set, not "unread since you last looked". A dismissed/read marker
   requires the persisted-table PROPOSED path above.
2. The due-soon window is fixed at 3 days in code, not per-user
   configurable.
3. Events exist only while their source rows do; deleting a CA removes its
   notification — correct for deadlines, but decision history is served by
   the audit log, not notifications.
4. Test-suite note: the notification tests initially failed because a seed
   helper leaked the admin identity into the assertion context (and one
   test depended on another suite's triage mutation) — both were test bugs,
   fixed by restoring identity after admin-context seeding and by seeding
   independent fixtures.

**Directive §5 classification:** In-app notifications — **IMPLEMENTED
(minimal v1, repo + tests)**. Email/push/SMS — **REQUIRES GOVERNMENT/OWNER
CONFIRMATION** (new infrastructure + cost); reporter-facing channel —
impossible by design (anonymous reporting). Remaining docs/16 functionality
items: accessibility, performance, deployment pipeline, restore rehearsal.

## Prior session [2026-09-27 — §10: camera capture + batch evidence upload]

**Session:** §10 — camera capture + batch evidence upload with per-file progress
**Date:** 2026-09-27
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (188 passing
across 13 files — 178 prior + 10 new evidence-capture tests) · the
never-silently-drop offline guarantee re-proven across both new features ·
no schema migration required

**Directive item:** §10 — EvidenceSection supported file attach and offline
queueing but had no camera-capture flow and no per-file progress on
multi-file upload. Implement both; preserve the never-silently-drop
offline-queue guarantee.

**Honest starting point:** the prior EvidenceSection header COMMENT claimed
"batch upload with per-file progress rows" and a camera input — the camera
input existed as a bare `<input capture="environment">` row (usable, but not
a flow), and the "progress" rows showed only coarse status transitions with
no byte-level progress whatsoever. This session made the claims true.

**Implementation:**

- `src/lib/supabase.ts` [EXTENDED] — `uploadWithProgress()`: the Storage
  REST wire path (`POST {url}/storage/v1/object/{bucket}/{path}` with the
  session JWT) over XMLHttpRequest — the only browser primitive with real
  upload progress events. Same bucket/key format as supabase-js, so objects
  are identical and the storage RLS policies apply unchanged. Every
  progress update is a real XHR event; nothing is polled or fabricated.
- `src/lib/backend.ts` [EXTENDED] — `evidence.upload` accepts an optional
  `onProgress` callback: with it AND a browser environment, bytes go up the
  XHR path; otherwise (tests, exotic environments) the supabase-js path is
  used unchanged. Same object, same policies, same audit row either way.
- `src/components/CameraCapture.tsx` [NEW] — primary path: getUserMedia
  environment-facing viewfinder with shutter, retake, front/rear switch,
  mirrored preview; the captured canvas frame becomes a JPEG Blob
  indistinguishable downstream from a picked file. Fallback path: when the
  API or permission is unavailable (desktop, denied prompt, insecure
  context), a `capture="environment"` file input answered by the native
  camera app. The stream is ALWAYS stopped on close/unmount.
- `src/components/EvidenceSection.tsx` [REWORKED] — a "Take a photo" button
  opens CameraCapture inside the attach dialog; captured frames join the
  batch (`pendingFilesRef`) exactly like picked files. Batch upload now
  passes `onProgress` per file and renders a real per-file byte progress
  bar (percent + KB sent) for in-flight files; queued files show "saved on
  device" instead — bytes resting on the phone have no progress to report,
  and a fabricated bar would violate the honesty rules.
- `tests/evidence-capture.test.ts` [NEW] — 10 tests: batch upload with
  progress callbacks lands all files (kinds correct); per-file failure
  isolation (one oversized file FILE_TOO_LARGE does not abort the others);
  the offline guarantee across both features (camera frame and picked file
  queue identically, replay syncs each exactly once; network-class failure
  queues; policy denial FORBIDDEN is NOT queued — it must surface, not
  retry forever; sync failure keeps the item with attempts + lastError
  retry info); the camera contract (getUserMedia + environment facing +
  toBlob; capture=environment fallback; stream always stopped; camera
  output routed into the same batch/queue; XHR progress path gated on the
  browser environment).

**The guarantee, restated precisely:** a file entering the attach dialog is
uploaded (metadata row + storage object + audit) OR queued with its bytes
(IndexedDB; replayed with dedupe-by-removal on reconnect) OR surfaced as an
explicit per-file failure the user sees. There is no fourth path — no code
route drops bytes silently, and the tests exercise all three outcomes.

**Honest limits of this session:**

1. getUserMedia cannot run in a test process — the camera tests assert the
   component's contract from source (API detection, fallback input, stream
   teardown, capture math) rather than driving a live stream. A Playwright
   run with fake media streams (docs/13 Priority 5) would close that gap.
2. XHR upload progress measures bytes SENT, not bytes confirmed stored —
   the request completing (HTTP 200) is the success signal; the bar reaching
   100% means "handed to the network", briefly ahead of confirmation. The
   row flips to Uploaded only on confirmation.
3. Insecure contexts (plain HTTP, non-localhost) never get getUserMedia —
   the fallback file input is the designed path there, not a defect.
4. No EXIF stripping or orientation normalization: captured frames are
   canvas-encoded JPEGs (orientation already normalized by the canvas
   draw); picked HEIC files from iOS remain dependent on browser
   transcoding support.

**Directive §5 classification:** Camera capture + batch byte progress —
**IMPLEMENTED (repo + tests)**. docs/16's functionality board now lists only
the accessibility, performance, deployment and restore rows as open.

## Prior session [2026-09-27 — §11: inspection template editor]

**Session:** §11 — inspection template editor (admin UI)
**Date:** 2026-09-27
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (178 passing
across 12 files — 168 prior + 10 new template-editor tests) · one production
defect found by the suite and fixed (migration 0008: missing templates DELETE
policy — admin deletion silently deleted nothing) · live convergence for 0008
NOT yet run (see honest limits)

**Directive item:** §11 — templates must be authorable in the product, not
only in the data layer: "inspection design is configurable without a code
change."

**Acceptance criteria (stated before coding):** an admin can create and edit
a template (sections → questions, the four answer types, required flags,
select options), publish/unpublish it, and delete an unused one — from the
UI; a template saved in the editor is immediately offered to the field draft
flow (including offline devices, since templates are read through the same
query); a malformed template can never be persisted (the field flow keys
answers `si:qi` and renders controls from answerType, so shape IS a
contract); non-admin identities cannot save/publish/delete; every change is
audit logged.

**Implementation:**

- `src/lib/template-schema.ts` [NEW] — `validateTemplateSections()`, the
  single shape authority shared by the editor (live feedback) and the data
  layer (authoritative re-check). Refusal tokens name the offending row
  (`TEMPLATE_Q_1_2_LABEL_REQUIRED`). Selects must carry options; required
  flags must be real booleans; labels/titles bounded. Unknown extra JSON
  fields stay permitted (jsonb storage; future question types need no
  migration).
- `src/lib/backend.ts` [EXTENDED] — `listTemplatesAll()` (editor list,
  including unpublished), `saveTemplate()` (create or update; admin-only;
  re-validates server-side; audit `template.create`/`template.update`),
  `setTemplateActive()` (publish/unpublish; audit), `deleteTemplate()`
  (admin-only; refuses `TEMPLATE_IN_USE` when inspections reference the
  template so history keeps its shape; audit `template.delete`).
- `src/pages/Templates.tsx` [NEW] — `/portal/templates` list (status chip,
  section/question counts, publish toggle, delete) and the editor:
  sections with reorder/remove, questions with answer-type selector,
  conditional options field for selects, required checkboxes, live
  validation banner, dirty-state gating of the save button.
- `src/main.tsx` / `src/pages/PortalLayout.tsx` [EXTENDED] — routes
  (`templates`, `templates/new`, `templates/:templateId`) + nav entry.
- `tests/helpers/backend-edge.ts` [EXTENDED] — the bridge's query builder
  gains the `.delete()` verb (the `__delete__` exec path already existed;
  only the supabase-js-shaped method was missing).
- `tests/template-editor.test.ts` [NEW] — 10 tests: the shape contract
  (accepted field-flow shape; every refusal token; indices in tokens); the
  admin workflow over the bridge (create → publish → appears in the field
  flow's `listTemplates`; edit → inspectors receive the edited shape;
  malformed refused server-side with nothing persisted; unpublish hides
  from the field flow while the row survives; delete refused `IN_USE` for
  the seeded referenced template, allowed for an unused one; inspector,
  supervisor and operator all FORBIDDEN on save/publish/delete while still
  able to READ templates).

**Production defect found (migration 0008):** `mg_guard_template_write()`
carries an admin-only DELETE branch and `deleteTemplate()` exists — but 0001
defined **no** "templates delete" RLS policy. Under RLS, rows invisible to a
DELETE are silently skipped: Postgres deleted zero rows WITHOUT error (the
BEFORE DELETE guard never fired — triggers run only on rows that pass the
policy filter). Admin template deletion was a silent no-op on every lineage
with this schema. 0008 adds `create policy "templates delete" … using
(mg_is_admin())`. Verified by test: unreferenced template deleted (row gone,
audit row present); referenced template refused `TEMPLATE_IN_USE` by the
data layer.

**Honest limits of this session:**

1. Migration 0008 is repo-lineage only; the live convergence pass has NOT
   been run (owner token, separate explicit step). Until converged, live
   admin deletion of templates silently no-ops exactly as described.
2. Editing a template that existing inspections reference changes the
   TEMPLATE, not the historical answers (answers were captured at submission
   time and remain keyed to the section/question indices of their era).
   The editor does not warn when editing a referenced template — if a
   changed question order would make historical answers ambiguous to
   render, that is a known interpretive limit of index-keyed answers,
   documented here rather than hidden.
3. No template versioning/draft-revision history: an edit overwrites. The
   audit trail records who changed what and when, but not a full diff.
4. The editor covers the four shipped answer types only; adding a type
   requires code (renderer + validator), though not a migration.

**Directive §5 classification:** Template editor — **IMPLEMENTED (repo +
tests)**; 0008 live convergence outstanding. Remaining functionality row in
docs/16: evidence field UI polish (camera capture, batch upload) —
**PLANNED**.

## Prior session [2026-09-27 — Priority B §20 rework: structural operator section]

**Session:** Gap Closure Directive v1.0, Priority B item 5 (rework) — structural operator section with route-level isolation
**Date:** 2026-09-27
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (168 passing
across 11 files — 147 prior + 21 new operator-isolation tests) · acceptance
criterion verified by test: an operator account cannot reach any staff-only
route or query · no schema migration required

**Directive item (owner feedback):** the prior §20 build reduced operators to
a filtered staff view inside the staff portal — conditionally-hidden nav plus
a root redirect. The directive requires a DEDICATED operator experience with
strict tenant isolation, as its own routed section. Acceptance: an operator
account cannot reach any staff-only route or query, verified by test.

**What changed structurally:**

- `src/components/RequireAuth.tsx` [REWORKED] — three gates:
  `RequireAuth` (signed-in with any role; role-less accounts get an explicit
  no-role notice instead of an empty portal), `RequireStaff` (admin /
  supervisor / inspector; an operator hitting any staff route is redirected
  to `/operate`, not to sign-in — redirect-to-auth would loop), and
  `RequireOperator` (operator only; any other identity is redirected to the
  staff portal root).
- `src/main.tsx` [REWORKED] — `/operate/*` is its own routed subtree with
  `OperatorLayout` as the element (the gate lives in the layout, so every
  nested route inherits it); `/portal/*` is wrapped in `RequireStaff`. No
  staff component is routable inside `/operate` and vice versa.
- `src/pages/PortalLayout.tsx` [SIMPLIFIED] — all operator branching removed
  (OPERATOR_NAV, root redirect, role filters): the staff portal is staff-only
  by gate, not by nav filtering.
- `src/pages/operate/` [NEW SECTION] — `OperatorLayout` (own shell, own nav,
  offline sync strip), `OperatorOverview` (counters + do-next obligations +
  own sites), `OperatorSites`/`OperatorSiteDetail`, `OperatorFindings`,
  `OperatorCorrectiveActions` (the respond flow), `OperatorIncidents`
  (submission with offline queueing + document upload), `OperatorSecurity`
  (the Gap #4 MFA/password surface inside the operator shell).
- `src/pages/Auth.tsx` [EXTENDED] — sign-in without an explicit returnTo
  lands each identity in its OWN section (operator → `/operate`, staff →
  `/portal`).
- `src/lib/backend.ts` [EXTENDED] — `listMyFindings()` (findings feed joined
  with site identity; RLS + mirror scoped) alongside the prior
  `listMyCorrectiveActions()`.

**Isolation proof — `tests/operator-isolation.test.ts` [NEW, 21 tests]:**

- Route layer (structural assertions against the shipped source): the
  `/portal` element is wrapped in `RequireStaff`; `/operate` is its own
  subtree with `OperatorLayout`; no staff page component is routable inside
  the operator subtree; `RequireOperator` wraps the operator shell;
  PortalLayout no longer contains operator branching; sign-in routes by
  role.
- Query layer (operator identity through the real data layer): command
  center equals own-tenant figures (site count == own sites.list length;
  community-report queue 0); audit log empty with the RLS denial logged;
  user directory undefined-with-FORBIDDEN-log; provisioning, role
  assignment, site create/status, triage, observation status, incident
  status, review, finding resolution, seed, storage footprint all FORBIDDEN;
  risk scores exactly the own-tenant set.
- Operator surfaces: sites/findings/obligations/incidents strictly
  own-tenant (cross-tenant rows seeded then proven absent); site detail of
  another tenant null-masked; end-to-end incident submission + document
  upload authorized on the OWN site (kind `document` in the evidence row)
  and FORBIDDEN against the other tenant's site.

**Honest limits of this session:**

1. Route-gate tests assert the shipped router/guard source (structure), not
   a live browser navigation — the Playwright smoke layer (docs/13 Priority
   5) is the place for click-through navigation proofs.
2. Operators have no surface for environmental observations or community
   triage (not operator duties in the spec); the incident list is read-only
   status-wise (staff set investigation status).
3. The respond flow remains single-shot (open → submitted; no amend path —
   reopening is a reviewer capability the guard does not currently allow).
4. Findings are read-only for operators by design; acknowledging is an
   operator capability server-side (guard allows `acknowledged`) but no
   operator UI exposes it — findings say "respond via the corrective
   action", which is the spec's channel. If acknowledgement in the operator
   UI is wanted, it is a small addition.

**Directive §5 classification:** Operator section — **IMPLEMENTED
(structural, repo + tests)**; the §20 item now meets the directive's
"dedicated experience, strict isolation, verified by test" bar. Remaining
functionality rows in docs/16: evidence field UI polish (camera capture,
batch upload) and the template editor — **PLANNED**.

## Prior session [2026-09-27 — Priority B §20: Mining Operator Portal]

**Session:** Gap Closure Directive v1.0, Priority B item 5 — Mining Operator Portal (§20)
**Date:** 2026-09-27
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (147 passing
across 10 files — 140 prior + 7 new operator-portal tests) · no schema
migration required (all server machinery existed; this session surfaced and
wired it)

**Directive item:** Priority B item 5 — the dedicated operator portal surface
(docs/02 listed it [PLANNED]: "operators currently reach the portal with a
reduced nav"). The product spec defines the role's whole scope: *own sites
only, respond to corrective actions*.

**Acceptance criteria (stated before coding):** an operator signing in lands
on their own compliance surface — not the staff command center; the surface
shows their licensed sites and every corrective action on them with deadlines
and status; the respond flow works for the owning operator while the action
is open and is audit logged; cross-tenant obligations are invisible (RLS, not
UI filtering); staff surfaces stay staff-only; staff see the same obligation
feed over their own scope; every claim pinned by tests through the unmodified
data layer.

**What was found before coding:** `respondCorrectiveAction` — the operator
role's entire stated purpose — existed in the backend with ZERO UI surface:
no screen in the product could call it. Operators could read that they were
obliged to respond (in records seeded for staff views) but had no way to
respond. That made this less a "new portal" build than surfacing an already-
authorized but unreachable capability.

**Implementation:**

- `src/lib/backend.ts` [EXTENDED] — `listMyCorrectiveActions()`: the
  obligation feed — every corrective action on sites the caller can access,
  joined with finding title/severity and site code/name/county, sorted
  openest-first then by soonest deadline. Scoping is RLS + the client
  `canAccessSite` mirror (same as every list); operators are strictly
  tenant-scoped by operatorName, staff by their own scope. No new server
  privileges.
- `src/pages/OperatorPortal.tsx` [NEW] — `/portal/operate` under
  RequireAuth: open / overdue / awaiting-verification counters, the
  obligation list (severity chip, site identity, deadline countdown,
  overdue emphasis, prior response shown) with the respond form, and the
  own-sites grid linking into existing site detail pages. The page renders
  only what the server already scoped and states the isolation honestly.
- `src/pages/PortalLayout.tsx` [EXTENDED] — an `OPERATOR_NAV` (Compliance,
  My Incidents, Account Security) replaces the old reduced-staff-nav filter
  for operators; operators opening `/portal` (exact root only — deep links
  like `/portal/incidents/:id` stay valid) are redirected to
  `/portal/operate`. Staff and unassigned behaviour unchanged.
- `src/main.tsx` [EXTENDED] — the route.
- `tests/operator-portal.test.ts` [NEW] — 7 tests through the wire bridge:
  operator feed contains only own-tenant rows with the join populated;
  cross-tenant obligations invisible to the feed (seeded CA on the other
  tenant proves it is RLS, not UI filtering); staff see the same feed over
  their scope; unassigned callers get an empty feed; owning operator
  responds while open (row → `submitted`, `ca.respond` audit row present);
  second respond FORBIDDEN (one response per action); cross-tenant respond
  NOT_FOUND (existence masking) and staff respond FORBIDDEN.

**Honest limits of this session:**

1. Operators see incidents on their own sites (existing RLS-scoped list) but
   cannot file new ones from the operator portal itself — the incident form
   lives on the shared Incidents page, which operators keep in their nav.
   Environmental observations remain staff-surface only (operators have no
   observation duties in the spec).
2. The respond flow is single-shot by design (guard: open → submitted only,
   reviewer decides). An operator cannot amend a submitted response — a
   correction path would need a reviewer reopening action, which the guard
   does not currently allow and this session did not add.
3. Risk scores, command-center aggregates and the national map remain
   staff-only surfaces; the operator portal deliberately does not mirror
   them (decision-support belongs to the oversight authority).
4. No migration, so no live-convergence SQL is required; the feature is
   client-surface only over existing, already-live server machinery.

**Directive §5 classification:** Operator portal surface — **IMPLEMENTED
(repo, tested)**. Remaining functionality rows in docs/16: evidence field UI
polish (camera capture, batch upload) and the template editor — **PLANNED**.

## Prior session [2026-09-27 — Gap #4: account recovery + MFA]

**Session:** Gap Closure Directive v1.0, Gap #4 (Priority A) — account recovery + MFA
**Date:** 2026-09-27
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (140 passing
across 9 files — 128 prior + 12 new account-security tests) · no schema
migration required (MFA state lives in GoTrue, not `public.*`) · live
project MFA/SMTP configuration and convergence NOT done (see honest limits)

**Directive item:** Priority A gap 4 — account recovery and MFA beyond
password sign-in (docs/04 gap 2, "configuration pending").

**Acceptance criteria (stated before coding):** a user can request a
password-reset email and set a new password from the emailed link; a user can
enroll a TOTP authenticator, verify it with a REAL code, and unenroll; once a
verified factor exists, a fresh password sign-in requires the authenticator
code before the portal opens; anonymous callers can neither enumerate factors
nor enroll; no cross-account factor access; the UI never fabricates delivery
(or removal) of the lost-authenticator path — it states the administrative
process; every claim is pinned by tests through the unmodified data layer.

**Implementation:**

- `src/lib/supabase.ts` [EXTENDED] — typed GoTrue MFA wrappers
  (`mfaAal`, `mfaListFactors`, `mfaEnrollStart`, `mfaEnrollVerify`,
  `mfaUnenroll`) with stable-token error mapping (MFA_INVALID_CODE /
  MFA_NOT_FOUND / TOO_MANY_ATTEMPTS…); `detectSessionInUrl` turned ON so the
  recovery email link can restore its session before the hash router claims
  the URL.
- `src/lib/backend.ts` [EXTENDED] — `resetPasswordEmail` (request; redirect
  lands on the app root, never a user-controlled target), `updatePassword`
  (set, requires the recovery/privileged session), `signInEmailMfaAware`
  (returns `mfaRequired` when the account requires aal2 and the fresh session
  hasn't proven it — the GoTrue assurance contract), MFA re-exports.
- `src/pages/Auth.tsx` [EXTENDED] — three flows added to the existing card:
  the MFA challenge step (code entry after password, back-to-sign-in), the
  forgot-password request panel (with the no-enumeration notice), and the
  recovery-link "set new password" panel (`/auth?mode=reset`).
- `src/pages/Security.tsx` [NEW] — `/portal/security` under RequireAuth:
  TOTP enrollment (secret for manual authenticator entry, QR when GoTrue
  supplies one, verify-then-activate), factor list + remove, password
  change, and the lost-authenticator administrative-recovery statement.
- `src/main.tsx` / `src/pages/PortalLayout.tsx` [EXTENDED] — route + nav.
- `tests/helpers/pglite-db.ts` [EXTENDED] — stub `auth.mfa_factors` /
  `auth.mfa_challenges` tables (plaintext secrets; stub proves the CLIENT
  contract, not GoTrue's storage).
- `tests/helpers/backend-edge.ts` [EXTENDED] — GoTrue fake gains
  `mfa.getAuthenticatorAssuranceLevel / listFactors / enroll / challenge /
  verify / unenroll` over those tables, `resetPasswordForEmail`,
  `updateUser`, `getSession`; TOTP verification is REAL RFC 6238
  (HMAC-SHA1, 30s step, dynamic truncation) and tests compute the
  "authenticator app" side with the same math via the exported `edgeTotp`.
  Seed adds one verified factor for the county inspector.
- `tests/account-security.test.ts` [NEW] — 12 tests: AAL reporting;
  wrong-code enrollment rejected (factor stays unverified, next stays aal1);
  real-code enrollment verifies (next becomes aal2); unenroll; cross-account
  factor access refused; anonymous enumerate/enroll refused; MFA sign-in
  reports MFA_CHALLENGE_REQUIRED (and non-MFA sign-in does not);
  challenge + wrong code fails, right code proves aal2; reset request does
  not leak account existence; updatePassword requires a session and succeeds
  with one; duplicate-email signup still EMAIL_IN_USE.

**No migration was needed:** factors, challenges and assurance live in
GoTrue's own schema, which the client reaches only through the official API.
The `public.*` schema, RLS and guard triggers are untouched.

**Honest limits of this session:**

1. The live Supabase project must have MFA enabled (Auth → Multi-factor) and
   SMTP configured for recovery emails before either feature works on live.
   Both are project configuration requiring owner access — NOT confirmed;
   the code is ready but unproven on live, and no live convergence was run
   this session.
2. TOTP only. Recovery codes, WebAuthn and phone/SMS factors are NOT
   implemented; the Security page says so. A lost authenticator is recovered
   administratively through the program office (an admin would need a
   GoTrue admin API path or dashboard access to drop the factor — itself not
   built; documented as the operational procedure).
3. MFA enrollment/verification events are GoTrue-side and do NOT reach
   `audit_log`. If the audit trail must show them, an auth hook (e.g.
   `mfa.factor_activated`) writing to a table the RPC layer can read is
   PROPOSED — requires owner confirmation (new infrastructure).
4. `signInEmail` (the legacy entry point) still exists for compatibility and
   does NOT run the MFA check; the Auth page now uses `signInEmailMfaAware`.
   Any future call site must use the MFA-aware variant or MFA is bypassable
   at that door.
5. The bridge's `updateUser` accepts a password change without checking the
   credential (the stub stores none) — the REAL GoTrue enforces the current
   password/privileged-session rules; that part of the contract is GoTrue's
   and is not re-proven here.

**Directive §5 classification:** Account recovery + MFA — **IMPLEMENTED
(repo, tested); live project configuration pending owner action**. Gap #3's
0007 live convergence remains outstanding (see prior session). No further
Priority A gaps remain in docs/16's board; remaining readiness items are the
non-security rows (restore rehearsal, media field UI, performance,
accessibility, deployment pipeline).

## Prior session [2026-09-27 — Gap #3: data-layer/HTTP-edge test coverage]

**Session:** Gap Closure Directive v1.0, Gap #3 (Priority A) — data-layer/HTTP-edge test coverage
**Date:** 2026-09-27
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (128 passing
across 8 files — 82 prior + 46 new backend-edge tests) · two production
defects found by the new suite and fixed with probe-proven migrations/code
(migration 0007; `backendError` ordering) · live convergence for 0007 NOT yet
run (see honest limits)

**Directive item:** Priority A gap 3 — the data layer (`src/lib/backend.ts`,
the HTTP edge) had zero test coverage: error shaping (`backendError`),
authorization re-derivation (`requireAuthed/Staff/Admin/Reviewer`), row
mapping, the offline-dedupe contract and audit writes were exercised only
indirectly through SQL suites. Acceptance: every exported surface gets at
least one authorized-path and one denied-path test, driven through the real
module UNMODIFIED.

**What was built:**

- `tests/helpers/backend-edge.ts` [NEW] — a wire-protocol bridge: translates
  supabase-js vocabulary (`.from().select().eq().insert().update()…`, `.rpc()`,
  GoTrue auth calls, storage upload) into RLS-enforced SQL on a dedicated
  PGlite that applies the stub auth/storage schema, every
  `supabase/migrations/*.sql` in order, and a compact EDGE_SEED mirroring the
  shared fixture's identity/tenant shape (two operators, county inspector,
  national supervisor, admin, role-less guest; no findingB — a deliberate
  compaction caught two test bugs before they became false confidence).
  Per-request identity exactly like PostgREST: each request is one bundled
  `begin; set local role authenticated; set local request.jwt.claims = '<jwt>';
  <payload>; commit;` script (separate execs lose identity for RLS WITH
  CHECK — probe-proven); a request mutex serializes; RPCs go through a
  whitelist with named-notation calls; GoTrue is faked over `auth.users`;
  storage rides `storage.objects`.
- `tests/backend-edge.test.ts` [NEW] — 46 tests in 8 blocks: `backendError`
  contract (the literal `[object Object]` bug pinned), auth gate (anon /
  role-less guest / orphan uid / signUp trigger / credential-error mapping),
  sites (create + audit + generated code, status, tenant/county scoping,
  openActions, risk factors), inspections lifecycle (draft → submit →
  supervisor review, ownership guard, NOT_EDITABLE / NOT_REVIEWABLE,
  findings acknowledge-vs-resolve, corrective actions open → respond →
  close), records (incidents, clientRef dedupe = one row, observations,
  community report submit/track/triage), stats/users (admin-only surfaces,
  setUserRole + audit, provisionByEmail, completeProfile bootstrap-free,
  recentAuditLog), evidence (upload path contract + audit, tenant gate,
  scoped list RPC, signed URL, admin-only footprint), seed refusal,
  ensureProfileDoc idempotency. Mutations commit; post-conditions are then
  verified in SQL as admin.

**Production defects found by the suite (all fixed):**

1. `backendError()` token ordering (`src/lib/supabase.ts`) — `USER_NOT_FOUND`
   contains the substring `NOT_FOUND`, so the generic mapping swallowed the
   specific token. Fixed: specific tokens first, plus `code`-field capture
   (42501 → FORBIDDEN; guard tokens NOT_EDITABLE / NOT_REVIEWABLE /
   FORBIDDEN mapped out of P0001 messages).
2. Sites INSERT … RETURNING 42501 (migration 0007) — the "sites read" policy
   called `mg_can_access_site(id)`, which re-queries `public.sites`; Postgres
   evaluates the SELECT policy on RETURNING rows, but the new row is not yet
   visible to the INSERT's own command snapshot → every
   `.insert().select("id")` failed 42501 even for admins, i.e. **admin site
   creation from the app was impossible on the repo lineage** (seed-style
   inserts without RETURNING worked, which is why the clean-apply suite never
   caught it). Fix: `mg_can_access_site_row(county, operator_name)` — the
   same role matrix over the row's OWN columns, no inner SELECT — now backs
   the policy; the uuid form delegates to it for callers that reference rows
   which already exist (storage policies, evidence RPC, scope stamps).
   Probe-verified: admin INSERT … RETURNING succeeds; per-role visibility
   unchanged (operator own tenant, county staff own county, guest nothing).
3. `mg_guard_inspection_update()` order (migration 0007) — the ownership
   check preceded the reviewer branch, contradicting the "inspections update"
   RLS policy: a supervisor approving an inspector's submission always hit
   FORBIDDEN, so the review workflow could never complete for inspections the
   reviewer did not own. Fix: reviewer allowance (under_review →
   approved/rejected) precedes ownership; admin bypass, owner submission and
   NOT_EDITABLE / reviewer-required denials preserved.

**Test-only learnings (documented in-suite, no production change):**
`live()` queries swallow fetcher errors by design (log + resolve undefined so
a bad subscription never hangs the UI) — denied-path assertions capture
`console.error`; `evidence.upload`'s client-side site check does NOT mask
existence (cross-tenant → FORBIDDEN) while `respondCorrectiveAction` does
(invisible row → NOT_FOUND); the generated site-code prefix is
`MGL-<COUNTY>-####` from the county string (e.g. MGL-BOMI-). Two PGlite
authoring notes are in the bridge header: the one-bundled-exec identity rule
above, and setof-RPC shaping via `proretset`.

**Honest limits of this session:**

1. The bridge is a high-fidelity PostgREST emulation, not PostgREST: the
   query-shape vocabulary is a curated subset, realtime is faked as
   immediate re-query, signed URLs are bridge-local. Wire quirks outside the
   subset would not be caught here.
2. Migration 0007 is repo-lineage only. The live project already converged on
   the two-argument `(county, operator_name)` access predicate (docs/11 Gap
   #2 session), so its sites-read policy is likely already immune to defect 2
   — unverified. Defect 3 (guard order) on live: status unknown. The 0007
   live-convergence pass has NOT been run; it needs an owner token and is a
   separate, explicit step.
3. 46 tests give every exported surface ≥1 authorized + ≥1 denied path, but
   not every branch; offline-queue replay paths remain covered by the offline
   suites, not this one.

**Directive §5 classification:** Gap #3 — **IMPLEMENTED (repo + tests
green)**. Gap #4 (account recovery/MFA) — **PLANNED** (untouched).

## Prior session, part 2 [2026-09-26 — Gap #2: evidence URL revocation]

**Session:** Gap Closure Directive v1.0, Gap #2 (Priority A) — evidence signed-URL revocation path
**Date:** 2026-09-26
**Verification:** `bun tsc -b --noEmit` ✓ (0 errors) · `bun test` ✓ (82 passing
across 7 files — 71 prior + 10 new evidence-URL mint-gate tests + 1 new
migration-apply 0006 assertion) · 4 live-anon probes green · live convergence
applied and verified with the same-session token (acceptance proof executed on
the live project inside one rolled-back transaction; zero artifacts)

**Directive item:** Priority A gap 2 — signed evidence URLs were valid 1 hour
with no revocation; add a mechanism to invalidate a signed URL early.

**Acceptance criteria (stated before coding):** the mint gate returns NULL
(not the path) when the caller's CURRENT site access fails or the row is
missing; refuses role-less accounts; clamps TTL server-side (30–300s); logs
every accepted mint to a definer-only audit table storing no URL material;
the client mints through the gate with a 120s TTL; repo migration applies
cleanly and idempotently; live convergence verified with zero artifacts.

**Design (revocation-at-mint + short TTL — the directive's first suggested
mechanism, no new infrastructure):** permission-bound revocation instead of
pure clock-bound revocation. `evidence_url(p_evidence_id, p_ttl_seconds)`
(SECURITY DEFINER, VOLATILE — it writes audit rows) re-derives the caller's
current access via the same `mg_can_access_site` predicate the storage read
policy uses, then returns the storage path for the client to sign. Losing
site access refuses the next mint immediately; the TTL drop 3600s → 120s
caps any in-flight exposure at two minutes. A revocation-at-fetch proxy would
close the ≤120s residual but requires edge infrastructure and is explicitly
NOT added (documented as PROPOSED in docs/04).

**Implementation:**

- `supabase/migrations/0006_evidence_url_revocation.sql` [NEW] — the RPC
  (TTL clamp, guest refusal, NULL-not-found, gate, audit append), the
  definer-only `evidence_url_audit` table (RLS on, deliberately zero
  policies), explicit signature-auditable grants (execute to authenticated,
  revoked from anon/public).
- `src/lib/backend.ts` — `evidence.getUrl` now calls `evidence_url` and signs
  the returned path with `createSignedUrl(path, 120)`; NOT_FOUND preserved;
  TTL_SECONDS=120 is the only client-side TTL in the codebase.
- `tests/evidence-url.test.ts` [NEW] — 10 tests: authorized mint returns the
  path; cross-tenant NULL with no audit row; **permission change ⇒ next mint
  refused (the revocation proof)**; missing-id NULL without existence leak;
  guest FORBIDDEN; anon denied; TTL clamp (3600-ask logs 300, 1s-ask logs
  30, nothing outside bounds); one audit row per accepted mint carrying the
  real actor; audit table invisible to authenticated (definer-only); RPC is
  volatile + definer.
- `tests/migration-apply.test.ts` [EXTENDED] — 0006 idempotency, exact
  signature, audit table RLS-on with zero policies; table counts 14 → 15.
- Docs: 03 (new table row), 04 (File access rewritten; gap 6 closed with
  honest residual), 07 (Serving/ACL rewritten), 13 (suite inventory), 16
  (board + definition-of-done).

**Live convergence (same session, owner token):** live's divergent lineage
required two adaptations, both recorded in 0006's lineage note: (1) the live
`mg_can_access_site` is the two-argument `(county, operator_name)` form, so
the live function body differs in exactly that predicate line (matching the
live storage read policy, which uses the identical two-arg call); (2) the
live `evidence` table carries denormalized `county`/`operator_name` columns
the repo lineage derives via `site_id`. Table + grants applied from 0006
as-is; the function applied as the live-predicate variant.

**Live verification (one rolled-back transaction, zero artifacts — confirmed
afterwards: audit 0 rows, profiles 2, evidence 2, probe users 0, auth trigger
intact):** an ephemeral probe user (auto-removed by rollback; profile-trigger
suppressed and restored within the same transaction) exercised the real
live data: admin minted for real evidence ✓ (path returned, audit row with
TTL 120); missing id → NULL ✓; probe operator tenant-matched → mint ✓; the
same probe renamed (access revoked) → NULL with no new audit row ✓; role-less
→ FORBIDDEN ✓; 3600s ask → audit logged 300 ✓.

**Honest limits of this item:**

1. In-flight ≤120s URLs outlive a permission change by at most two minutes —
   accepted residual; the fetch-time proxy that would eliminate it is
   PROPOSED (docs/04), REQUIRES OWNER CONFIRMATION, not silently dropped.
2. The mint gate's protection is authorization-consistency, not URL secrecy:
   anyone who can see a record can mint; anyone whose access is revoked
   cannot. It does not watermark, fingerprint, or prevent re-sharing of a
   URL while valid.
3. `evidence_url_audit` grows unbounded by design (append-only); a retention
   sweep belongs to docs/14's maintenance schedule, not this change.
4. The live project keeps lineage residue (two-arg access predicate,
   enum-typed RPC overload, legacy columns) — inert for client traffic,
   cleanup is a separate decision.

**Directive §5 classification:** Evidence URL revocation — **IMPLEMENTED
(repo + live), verified by test and live probe**. In-flight ≤120s residual
and fetch-time proxy — **PROPOSED**. Gap #3 (`backend.ts` HTTP-edge test
coverage), gap #4 (account recovery/MFA) — **PLANNED** (untouched).

## Prior session, part 1 [2026-09-26 — Gap #1: per-source rate limiting]

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
