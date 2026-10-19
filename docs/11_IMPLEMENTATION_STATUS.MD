# 11 — Implementation Status (consolidated)

**Last consolidated:** 2026-10-19 (Session 10 · CLN-2). The full per-session
history (2,800 lines, Sessions 0–9) is preserved verbatim in
[`archive/11_IMPLEMENTATION_STATUS_HISTORY.MD`](archive/11_IMPLEMENTATION_STATUS_HISTORY.MD).
This file holds only what is true **now**. Where a claim needs evidence it points
to the test, drill record or document that carries it; the readiness matrix and the
explicit "not proven" list are in [`16_PILOT_READINESS.MD`](16_PILOT_READINESS.MD).

Status vocabulary (used in every doc): **IMPLEMENTED** (code + test exist) ·
**VERIFIED** (exercised against a real engine/browser, evidence cited) ·
**PROPOSED** (designed, not built) · **REQUIRES GOVERNMENT/OWNER CONFIRMATION**
(a decision only the adopting institution can make).

## 1. Quality gate (re-run 2026-10-19)

| Gate | Result |
|---|---|
| `tsc -b` | 0 errors |
| `eslint .` | 0 errors / 0 warnings |
| `vite build` | OK |
| `bun test` | 688 pass / 4 skip (live-DB, need a real project) / 0 fail — 692 tests, 40 files |
| `bunx playwright test` (stubbed backend) | 124 / 124 pass (28 flow + 96 axe; 4 viewports); Reports fix re-verified separately |
| Restore drill (`scripts/restore-drill-local.sh`, Postgres 16) | PASS — `drills/restore-drill-2026-10-19.txt` |
| Lighthouse 11.7.1 (production build, localhost) | PWA 100 · Accessibility 100 · Best-practices 96 · Performance 80 (simulated mobile; no real network) |

## 2. What exists, by area

| Area | State | Where to look |
|---|---|---|
| Public community report + tracking code | IMPLEMENTED, rate-limited per source (0005) | `src/pages/CommunitySubmit.tsx`, `CommunityTrack.tsx`; e2e F1 |
| Auth, roles, MFA, account recovery | IMPLEMENTED (TOTP, recovery flow) | `src/pages/Auth.tsx`; doc 13 |
| Roles / scopes / permissions / organizations | IMPLEMENTED in Postgres (0010) | `supabase/migrations/0010*`; `tests/rls-*.test.ts` |
| Sites registry + positions with provenance | IMPLEMENTED | `Sites.tsx`, `SiteDetail.tsx`, `SiteLocationPicker` |
| Field inspections, templates, findings, corrective actions | IMPLEMENTED; template editor (§11) | `Inspections*.tsx`, `TemplateEditor.tsx` |
| Evidence capture, batch upload, signed-URL revocation | IMPLEMENTED (0006) | `src/lib/evidence*.ts` |
| Offline queues (inspections, evidence), sync, conflict handling | IMPLEMENTED (0013) | `src/lib/offline-queue.ts`; `tests/offline-*.test.ts` |
| GIS: boundaries, layers, clustering, verification styling, offline tiles | IMPLEMENTED (0015–0018) | `NationalMap.tsx`, `BoundaryLoader.tsx`, `public/sw.js` |
| Configurable risk engine, versioned & effective-dated | IMPLEMENTED (0019) | `RiskConfig.tsx`; `tests/risk-config*.test.ts` |
| Audit trail & integrity (append-only, server-assigned) | IMPLEMENTED (0009) | `Audit.tsx`; `tests/audit-*.test.ts` |
| Command-center stats, trends, summary report | IMPLEMENTED (0012, 0014, 0021) | `CommandCenter.tsx`, `Reports.tsx` |
| Persisted notifications (in-app only) | IMPLEMENTED (0021). Email/push/SMS: NOT IMPLEMENTED — REQUIRES OWNER CONFIRMATION | `NotificationBell.tsx` |
| Operator portal | IMPLEMENTED | `src/pages/operate/*` |
| AI assistance (server-side, cite-or-abstain, read-only) | IMPLEMENTED as interfaces + deterministic fallback (0020, Edge Function `ai-assist`). **No model provider approved → provider path inactive.** | doc 08; `tests/ai-assist.test.ts` |
| PWA shell + service worker | IMPLEMENTED; Lighthouse installable checks pass | `public/sw.js`, `manifest.webmanifest` |
| Backups + weekly restore drill | IMPLEMENTED in `backup.yml`; local rehearsal re-run this session | doc 14; `drills/` |

Database surface (from the 2026-10-19 local drill, Postgres 16, all 21
migrations + boundary seed): 24 public tables · 54 policies · 52 triggers ·
126 routines.

## 3. Migrations (apply in order; all idempotent)

0001 initial schema · 0002 grants/storage · 0003 profile read hardening · 0004
guard parity · 0005 per-source report rate limit · 0006 evidence URL revocation ·
0007 returning/review guards · 0008 template delete policy · 0009 audit integrity ·
0010 organizations/scopes/permissions · 0011 function execute surface ·
0012 command-center stats · 0013 offline reliability · 0014 scale surfaces ·
0015 GIS · 0016 GIS boundary hardening · 0017 demo-site longitude repair ·
0018 realtime boundaries · 0019 risk config · 0020 AI request log ·
0021 notifications/trends/reporting. Do **not** re-apply 0014 after 0019.
Procedure and the read-only state check: doc 14 §Applying migrations safely.

## 4. Session ledger

| Session | Scope | Outcome |
|---|---|---|
| 0–5 | Foundation, security, audit, orgs, offline, scale, operator portal | See the archive (earliest sections) |
| 6 | GIS-1…5 | Boundaries, layers, verification styling, offline tile worker; 0015–0018 |
| 7 | RSK-1/2 | Versioned risk config, server-side scoring; 0019 |
| 8 | AI-1 | Edge Function + fallback; provider decision outstanding; 0020 |
| 9 | NTF-1, §19, §1 | Persisted notifications, trends, summary report; 0021 |
| 10 | CLN-1/2, UX-1 | This consolidation; see §5 |

## 5. Session 10 changes (2026-10-19)

**CLN-1 — dead scaffolding and dev-only code removed from production**
- Deleted: Deno/Hono `main.ts`, `convex.json`, `firebase.json`, `firestore.*`,
  `storage.rules`, `sst-env.d.ts`, `vly-toolbar-readonly.tsx`, `integrations.md`,
  `src/instrumentation.tsx` (an unused dev error-overlay posting to
  `window.parent`), `src/lib/vly-integrations.ts`, the duplicate
  `package-lock.json`; the `vlyPlugin`, the `DISABLE_VLY_PLUGIN` CI env, the
  Freebuff HMR note and eight unused dependencies (`hono`, `@vly-ai/integrations`,
  `@zumer/snapdom`, `framer-motion`, `axios`, `react-intersection-observer`,
  `@oslojs/crypto`, `@jridgewell/trace-mapping`).
- `src/lib/compat-types.ts` → `entity-types.ts` (no platform-migration wording).
- The audit "breadcrumb" `console.debug` (printed entity ids/summaries) is now
  DEV-only. `.env.example` rewritten (it described a Convex deployment).
- **`.env.keys` (a dotenvx private key) was tracked in git** despite being in
  `.gitignore`. It is now untracked. **It remains in git history: rotate it.**
- Guard: `tests/production-cleanliness.test.ts` fails if any of this returns.

**UX-1 — accessibility, responsive, browser evidence**
- Defects found and fixed by the browser run: 320 px horizontal overflow of the
  portal and operator headers and an operator site card; public-page header links
  20 px tall (< WCAG 2.2 target size); the new-inspection dialog lost keyboard
  focus on close; Landing/NotFound had no `<main>` landmark; Auth had no `<h1>`;
  Boundaries tabs referenced a non-existent panel (`aria-controls`); map markers
  had no accessible name; map layer toggles used `opacity-60` (failed contrast).
- Tests: `e2e/core-flows.e2e.ts` (5 flows × 4 viewports),
  `e2e/a11y.e2e.ts` (axe-core WCAG 2.0–2.2 A/AA incl. contrast over 24 routes × 4
  viewports). Run: `bun run build && bunx playwright test`
  (`PW_CHROMIUM=/path/to/chrome` when Playwright's own download is unavailable).
- **The browser suites stub the Supabase network** (`e2e/stub.ts`). They prove the
  shipped bundle renders, navigates, validates and reflows; they do **not** prove
  backend behaviour (the PGlite suites do) and never touch a real project.

## 6. Owner decisions still open

1. AI model provider (doc 08, Session 8). 2. Boundary data licence acceptance
(CC BY 3.0 IGO; doc 16). 3. Email/push/SMS notification channels. 4. Official
report letterhead/seal/reference numbering. 5. Rotation of the leaked
`.env.keys` key (§5). 6. Whether to load the boundary seed into the live project
(not reachable from the build environment).

## 7. Known limits (carried forward, still true)

Risk-score history is reproducible by configuration version, not by rebuilding
historical record state. Trends bucket in UTC; county names are free text, so
spelling variants split rows. The `ai-assist` Deno entry point is not executed by
the suite (no Deno in CI). PITR is a platform capability not exercised here.
Details per session are in the archive.

## 8. Final counts for this session

`bun test` 688 pass / 4 skip / 0 fail (692 tests, 40 files; 27 new in
`production-cleanliness`). Playwright 124 pass. `tsc -b` and `eslint .` clean.
Session ledger references to the archive are by section title, not line number.
