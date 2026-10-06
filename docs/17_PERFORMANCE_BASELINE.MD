# 17 — Performance Baseline

**Status:** baseline ESTABLISHED 2026-09-28 (§16 marked performance
"unmeasured" — this document closes that). Executed against the real data
layer (`src/lib/backend.ts`) over the RLS-enforcing wire bridge, at a
defined pilot-scale dataset. Re-run any time: `bun test tests/perf-baseline.test.ts`.
**RE-MEASURED 2026-10-05 after SEC-4** (paged reads + the DB-side stats RPC;
the bridge now enforces hosted PostgREST's 1,000-row cap) — see the SEC-4
section below; the original numbers are kept for comparison, marked
pre-SEC-4.

## Why this baseline and not a load test

The platform's performance characteristics at pilot scale are dominated by
the data layer's read pattern (scoped `collect()`-style reads plus client
joins per docs/02) and the per-request authorization re-derivation. A
baseline answers the question that matters for the pilot: **what does each
surface actually cost at the pilot's actual data volume, for each role that
will use it** — measured through the same authorization path production
uses. Concurrency/soak load testing belongs to a deployed environment with
production infrastructure and is [PLANNED]; nothing in this baseline claims
to measure network latency or multi-user contention.

## The scale (realistic pilot, from the program's own numbers)

| Dataset | Volume |
|---|---|
| Counties | 4 (Bomi, Grand Cape Mount, Montserrado, Nimba) |
| Operators | 2 |
| Sites | 40 |
| Staff accounts | 25 (+ operators, county/national identities) |
| Inspections | 320 (mixed approved/submitted/under_review) |
| Findings | 640 (mixed severities) |
| Corrective actions | 320 (mixed open/submitted/verified/closed) |
| Incidents | 80 (incl. fatalities) |
| Environmental observations | 60 |
| Audit log | 4,000 rows |
| Community reports | 200 |

**Budget:** 2,000 ms per interactive call — the "spinner is acceptable"
ceiling for a field tool on rural connectivity. Anything under budget passes;
the deliverable is the NUMBERS.

## Correction 2026-09-29: risk-model score bug fixed before these numbers

CI (bun 1.4.2) caught that the §18 refactor of `src/lib/risk-model.ts` had
broken the risk indicator's total: non-finding factors (overdue CAs,
incidents, environmental alerts, repeat findings) were excluded from
`score` while still listed as factors — then a first fix double-counted
severity points. The invariant **score ≡ Σ factor points** is now asserted
three ways: a synthetic all-factor-kinds oracle test
(`tests/ai-risk-explanation.test.ts`), the data-layer risk test in
`tests/backend-edge.test.ts`, and the AI explanation-consistency test. The
baseline numbers below were measured AFTER the fix. Any site with
overdue CAs or incidents previously showed an understated indicator — the
direction of the error was conservative (understating risk), but it was a
real defect and it is fixed and pinned.

| # | Flow | Surface (identity) | Median | Worst | vs budget |
|---|------|--------------------|-------:|------:|-----------|
| 1 | F3 staff | `stats.commandCenter` (admin, national — reads 7 tables, aggregates everything) | 115 ms | 187 ms | ✅ 17× headroom |
| 2 | F3 staff | `sites.riskScores` (42 site entries, explainable factors, score≡Σfactors) | 111 ms | 130 ms | ✅ 18× |
| 3 | F3 staff | `sites.list` (40 sites + open-action counts) | 16 ms | 19 ms | ✅ 125× |
| 4 | F3 staff | `inspections.list` (321 rows, site join + scope filter) | 25 ms | 50 ms | ✅ 80× |
| 5 | F3 staff | `records.listIncidents` (80) | 8 ms | 10 ms | ✅ 250× |
| 6 | F3 staff | `records.listObservations` (60) | 6 ms | 43 ms | ✅ 333× |
| 7 | F3 staff | `records.listCommunityReports` (200) | 5 ms | 5 ms | ✅ 400× |
| 8 | F3 staff | `stats.recentAuditLog` (last 200 of 4k) | 60 ms | 68 ms | ✅ 33× |
| 9 | F4 field | `inspections.list` (county-scoped inspector, RLS + mirror) | 40 ms | 44 ms | ✅ 50× |
| 10 | F5 operator | `listMyCorrectiveActions` (161-row tenant feed, joined) | 94 ms | 103 ms | ✅ 21× |
| 11 | F5 operator | `records.listNotifications` (derived, deadline math) | 96 ms | 111 ms | ✅ 20× |
| 12 | F5 operator | `records.reportIncident` (full write: auth + dedupe probe + guard + insert + audit + public-stats refresh) | 3 ms | 4 ms | ✅ 666× |
| 13 | F5 operator | `clientRef` dedupe replay (offline reconnect path) | 1 ms | 1 ms | ✅ 2000× |

**Every measured surface is within budget with ≥17× headroom.** The seeded
volumes are asserted non-empty before measurement (a baseline over missing
data would be worthless), and result-set sizes are printed with each run
(e.g. riskScores returned exactly 42 entries; the operator feed 161 rows).

## SEC-4 re-measurement 2026-10-05 — the baseline now measures the FIXED wire contract

The 2026-09-28 numbers above were taken through an **unlimited** bridge: the
harness did not emulate hosted PostgREST's `db-max-rows` cap, so a run could
not distinguish "fetched every row" from "silently truncated at 1,000" — and
the Command Center's figure measured a path (ship seven tables to the
browser, sum in JS) that production truncates past the row cap. This is the
honesty gap the 17× headline carried: it was a **DB-side** number measured on
a wire that could not reproduce the defect. SEC-4 closed both halves:

- the wire bridge now caps unranged reads at exactly 1,000 rows, like hosted
  PostgREST (`tests/helpers/backend-edge.ts`) — a regression to a bare
  `select("*")` FAILS the suite instead of passing against an uncapped harness;
- the data layer pages every whole-table read (explicit ordered Range until a
  short page), and the Command Center aggregates through
  `mg_command_center_stats()` (migration 0012, SECURITY INVOKER) returning ONE
  jsonb row.

Same fixture, same budgets, re-run:

| # | Flow | Median | Worst | vs budget | vs 2026-09-28 |
|---|------|-------:|-----:|-----------|---------------|
| 1 | F3 staff | `stats.commandCenter` (admin, national — now the stats RPC) | 195 ms | 245 ms | ✅ ≈10× headroom | 115 ms |
| 2 | F3 staff | `sites.riskScores` (42 site entries, paged inputs) | 154 ms | 185 ms | ✅ ≈13× | 111 ms |
| 3 | F3 staff | `sites.list` (40 sites + open-action counts) | 30 ms | 32 ms | ✅ ≈66× | 16 ms |
| 4 | F3 staff | `inspections.list` (321 rows, paged) | 29 ms | 40 ms | ✅ ≈69× | 25 ms |
| 5 | F3 staff | `records.listIncidents` (81) | 11 ms | 31 ms | ✅ ≈181× | 8 ms |
| 6 | F3 staff | `records.listObservations` (60) | 11 ms | 60 ms | ✅ ≈181× | 6 ms |
| 7 | F3 staff | `records.listCommunityReports` (201) | 8 ms | 9 ms | ✅ 250× | 5 ms |
| 8 | F3 staff | `stats.recentAuditLog` (last 200 of 4k) | 144 ms | 154 ms | ✅ ≈14× | 60 ms |
| 9 | F4 field | `inspections.list` (county-scoped inspector) | 32 ms | 70 ms | ✅ ≈62× | 40 ms |
| 10 | F5 operator | `listMyCorrectiveActions` (161-row tenant feed) | 84 ms | 89 ms | ✅ ≈24× | 94 ms |
| 11 | F5 operator | `records.listNotifications` (deadline math) | 85 ms | 100 ms | ✅ ≈23× | 96 ms |
| 12 | F5 operator | `records.reportIncident` (full write path) | 2 ms | 3 ms | ✅ 1000× | 3 ms |
| 13 | F5 operator | `clientRef` dedupe replay | 1 ms | 1 ms | ✅ 2000× | 1 ms |

**Honest reading of the deltas:**

- **commandCenter 115 → ≈195 ms (still ≈10× headroom).** In-process PGlite has
  **no network to save**: the old path's seven parallel table fetches were
  cheap in-process, while the stats statement pays SQL planning for ~20
  scalar aggregates per call. What changed is the *wire* shape, which this
  bench structurally cannot measure: ONE jsonb row instead of ≈1,660 rows
  (42 sites + 320 inspections + 640 findings + 320 CAs + 80 incidents +
  60 observations + 201 reports) plus zero browser-side aggregation. RTT and
  payload savings are NOT claimed as benchmark numbers; on rural LTE
  (20–80 ms RTT per round trip, Honest limits #2) fewer rows and one request
  dominate the user-visible cost.
- **Row-level lists** moved within noise: at pilot scale every table still
  fits in a single ≤1,000-row Range request, so paging costs nothing yet —
  it is the guarantee that correctness no longer depends on that luck.
- **The bench now asserts completeness** (every seeded row counted; the
  inspections list whole), so a truncated run FAILS instead of printing a
  number. The bench file's stale volume header was corrected in the same
  pass (it claimed 3,200/4,800/12,800 rows; the fixture is 320 inspections /
  640 findings / 320 CAs / 80 incidents / 60 observations / 4,000 audit rows —
  the scale table above was already right).

## What the numbers say

- The **heaviest surfaces are the aggregators**: command center (115 ms) and
  risk scores (111 ms) — both read every domain table and compute. These are
  also the two surfaces with pagination/limiting potential if the dataset
  grows ~10× (the projected END of pilot scale is ≈ this dataset; 10× would
  still sit ≈ 10× on the O(n) portions ≈ 1.1 s, inside budget but without
  headroom — the first place to optimize, with per-table aggregate SQL or
  maintained counters). *[2026-10-05, SEC-4: done for the command center —
  per-table aggregate SQL via `mg_command_center_stats()` returns one row;
  risk scores still aggregate client-side, now over paged inputs (exact at
  any size), and remain the next candidate if the dataset grows. Post-SEC-4
  numbers in the re-measurement section below.]*
- **Scoped reads are cheap**: the operator's tenant feed (94 ms for 161
  joined rows) and the county inspector's list (40 ms) confirm the
  authorization mirror adds negligible cost.
- **Writes are dominated by fixed per-request overhead**, not data volume
  (3 ms median) — the dedupe probe, guard triggers, audit write, and public
  stats refresh together cost less than 1% of budget.
- `clientRef` dedupe replay at 1 ms confirms the offline guarantee holds at
  zero meaningful cost — the reconnect storm scenario (many queued items
  replaying) is bounded by this per-item cost.

## Method notes (what is and isn't measured)

- **Real path**: `src/lib/backend.ts` exactly as shipped, over the RLS
  bridge (per-request `SET LOCAL role` + JWT claims, real guard triggers,
  real RLS policies, real `backendError` mapping). Warm-up run per surface
  before timing; median and worst of 5.
- **PGlite (in-process Postgres)** — same engine family as production
  Postgres, but no network hop and no concurrent load. Real-deployment
  numbers will include network RTT and multi-tenant contention; the
  relative costs between surfaces and the headroom conclusion are the
  transferable findings.
- **Seeding** is deterministic, idempotent (guarded by a `meta` marker), and
  asserts its own completeness (seed-sanity check inside the suite).
- The bench doubles as a **regression harness**: re-run
  `bun test tests/perf-baseline.test.ts` after data-layer changes; a surface
  exceeding its 2 s budget fails the run.

## Honest limits

1. **No concurrency** — single-session measurements; a multi-user load test
   on the deployed production database is [PLANNED] and requires the
   production project (owner prerequisite).
2. **No network** — in-process engine; RTT will add a fixed per-call cost
   (typically 20–80 ms per round trip on rural LTE) on top of these figures.
   Surfaces making 1 request per call are unaffected in shape; any surface
   making N requests scales with N × RTT. Since SEC-4, whole-table reads
   page deliberately: ceil(rows ÷ 1,000) serial Range requests per table —
   **1 request per table at pilot scale**, N×RTT only beyond the 1,000-row
   mark where the alternative is silent truncation.
3. **Volumes are projections**, not observed production data; the scale is
   set from the program's pilot planning numbers and is re-runnable at any
   scale by editing `SCALE` in the bench file.
4. **5 runs per surface** is enough to establish a baseline, not a
   distribution; tails beyond the worst-of-5 are uncharacterized.
