# 08 — AI Governance

**Status:** no AI features ship in v1.0. This document fixes the rules before any
AI capability is added.

## Permitted assistance (future) [PROPOSED — risk explanation IMPLEMENTED
2026-09-27, see below]

Summarization of inspection history; trend identification; natural-language
search over records the user is already authorized to see; risk explanation
(walkthrough of the explainable factor breakdown) **[IMPLEMENTED — the only
capability built; the others remain their own gaps with their own gates**];
executive briefing drafts; document triage.

## First capability: risk-score explanation [IMPLEMENTED 2026-09-27]

The recommended first capability, chosen because it requires no new data
ingestion and cannot fabricate records: `api.ai.explainRiskScore` walks
through the existing explainable weighted factors (`sites.riskScores`), with
the weight table extracted to `src/lib/risk-model.ts` so the computation and
its explanation share one source of truth.

Design constraints, as implemented and tested (`tests/ai-risk-explanation.test.ts`):

- **Server-side scoping** — inputs are assembled by the data layer from the
  same scoped queries as `riskScores`; identity is re-derived server-side and
  site access goes through the authorization core (`canAccessSite`). No
  prompt-time privilege, no client-supplied content. Out-of-scope sites null-mask.
- **Cite-or-abstain** — every factor carries the record IDs behind it and
  every explanation sentence cites them; citations are verified against real
  in-scope records. With no recorded factors the explainer abstains (states
  the empty factor set) rather than inventing narrative. Nothing is
  synthesized beyond the weight arithmetic (sentence points are asserted to
  match `RISK_WEIGHTS` exactly).
- **Human confirmation** — structurally stronger than a confirmation flow:
  the capability is read-only. There is no mutation, no draft, no write path
  — the authoritative record cannot be touched (asserted by a byte-identical
  DB snapshot after explanations, and a source contract forbidding
  insert/update/delete in the `ai` section).
- **Provider keys server-side only** — satisfied structurally: this
  capability needs no provider model at all (deterministic walkthrough), so
  there is no key, SDK, or network call anywhere in the path (source-contract
  asserted). When a provider-backed capability is later proposed, the key
  rule applies to it at design time.

UI: the explanation renders on the site detail page behind an unconditional
"AI-assisted" badge and a fixed disclaimer shipped in the payload itself.
Summarization, NL search, and briefing drafts were deliberately NOT built in
this session — each is its own gap with its own verification gate.

## Hard prohibitions (always)

1. AI must never fabricate records, statistics, laws, or regulatory references.
2. AI must never declare guilt, violation, or legal status of any party.
3. AI must never make or trigger enforcement decisions autonomously.
4. AI must never bypass, relax, or substitute authorization. Retrieval is scoped
   to the requesting user's server-verified access — no prompt-time privilege.
5. AI must never reveal data outside the caller's scope, including in summaries.
6. AI output is labeled as assistance, never merged into the authoritative record
   without human attribution and review.

## Design constraints when introduced

- Server-side scoping: any AI retrieval path runs inside the same
  authorization core (doc 04), not against raw tables.
- Cite-or-abstain: summaries must cite record IDs or state uncertainty.
- Human confirmation: any AI-suggested action requires an explicit,
  audit-logged user action before taking effect.
- Provider keys live server-side only (e.g. Cloud Functions environment config).

## Rationale

The platform's credibility rests on records being attributable to accountable
humans. AI assistance must strengthen, never dilute, that chain of
responsibility.

### Update (Session 7)

The explainer now reads the published risk configuration (`mg_risk_explanation`,
migration 0019) instead of the `RISK_WEIGHTS` constant, and reports the `configVersion`
it was built under. Its points are the database-built factors, so explanation, score and
config cannot drift; cite-or-abstain and the no-write rule are unchanged.

## Session 8 — AI-1: AI assistance (server-side) [IMPLEMENTED deterministic · PROVIDER REQUIRES OWNER DECISION]

**Owner decision still open:** no model provider has been approved. As instructed,
Session 8 implements the interfaces and a **deterministic fallback**; every
provider-backed behaviour below is marked **PROPOSED / REQUIRES GOVERNMENT
CONFIRMATION** and is *not* active. Nothing in the repository calls a model, holds
a key, or makes an outbound request.

### What exists

One Supabase Edge Function, `supabase/functions/ai-assist`, with its logic in
`supabase/functions/_shared/ai/` (pure TypeScript, tested under bun). Six
capabilities, each running on the **caller's own JWT** (RLS-bound client; the
function has no service-role key):

| Capability | Deterministic behaviour today |
|---|---|
| `nl_search` | Question → structured filter (closed allowlist of entities/fields/operators/enum values) → executed by the Supabase query builder under RLS. Never raw SQL. Contact phones and free text are not selectable. |
| `site_summary` | Counts and dates of inspections, findings, corrective actions, incidents, observations for one in-scope site. |
| `trend_notes` | Month-over-month counts (last two complete months) for incidents, findings, observations; abstains on an empty window. |
| `inspection_priorities` | Ranks open sites by the **published risk indicator** (migration 0019), then overdue corrective actions, then time since last inspection — no new weights are invented. |
| `executive_briefing` | Scoped headline figures + top three priorities, flagged as a draft for a human author. |
| `document_analysis` | Mechanical extraction from caller-supplied text (≤ 20,000 chars): dates, quantities, safety/environment terms, each cited to a verified character span. No accuracy, authenticity or compliance judgement. |

### How the governance rules are met

- **Scoping (prohibitions 4, 5):** identity is the verified JWT; role from the caller's
  own `profiles` row; all reads go through the caller's client. Not-found and
  out-of-scope produce the same abstention. Tested with operator-vs-operator,
  county-vs-county and role-less callers across every capability.
- **Cite-or-abstain:** each statement carries the record IDs it is built from; a
  statement whose citations are not all in the set *this request retrieved* (or that
  mentions a foreign UUID in prose) is dropped whole. Nothing surviving ⇒ abstain.
- **No write path (prohibitions 3, 6):** the AI code writes exactly one table,
  `ai_request_log`. Domain tables and `audit_log` are asserted byte-identical after
  every capability is exercised as every role; a source contract pins the write set.
- **No legal conclusions (prohibition 2):** wording is counts and dates; legal-conclusion
  language is also a hard reject in the provider narration gate.
- **Label (prohibition 6):** `label = "AI assistance — not an official determination"`
  is a field of every payload, abstentions included.
- **Prompt injection:** (1) authority never comes from text — scope is the JWT/RLS;
  (2) a provider could only *reword* already-computed claims — it cannot add a record,
  number, citation or legal conclusion (`narrate()` gate), and its search filter goes
  through the same allowlist validator; (3) untrusted text is fenced/sanitised and
  instruction-like text is **detected and logged** (`injection_flagged`) — detection is
  a reviewer signal, not the control; flagged questions bypass any provider.
  Tested with attack strings, DDL/UNION text, and a **hostile stub provider** that obeys
  the injection (it gains nothing).
- **Request logging:** migration `0020_ai_request_log.sql` — one append-only row per
  request (user from session, capability, mode, outcome, query **hash and length** — not
  the text — validated filters, counts of records/citations/dropped citations, flag,
  latency). If the row cannot be written, the answer is **withheld**.
- **Keys server-side only:** none exist. When a provider is approved its settings are
  Edge Function secrets (`AI_PROVIDER_APPROVED=owner-approved`, `AI_PROVIDER_ID`,
  `AI_PROVIDER_API_KEY`); they are read only in `ai-assist/index.ts`, and the browser
  bundle is asserted never to name them.

### PROPOSED — REQUIRES GOVERNMENT CONFIRMATION (not built, not active)

1. Provider choice, hosting jurisdiction, and a data-processing agreement for
   Liberian government records.
2. A reviewed adapter registered in `ADAPTERS` (`_shared/ai/provider.ts`) — none ships.
3. An accuracy/bias evaluation (English and the community languages used in reports)
   before `narrate()` / provider-assisted translation is enabled.
4. Provider-backed summarisation of free-text record bodies (descriptions, notes) —
   today's summaries state only counts and dates.
5. Document analysis of stored evidence files (today: caller-supplied text only).
6. A rate limit per user for the function (the log makes abuse visible; it does not
   throttle) and a retention period for `ai_request_log`.
7. UI surfaces for the capabilities (the client wrapper `src/lib/ai-assist.ts` exists;
   no page was added in this session).

## Implementation Phase 3 — incident insights [IMPLEMENTED, deterministic]

Extends the Session 8 `ai-assist` function (same handler, log, label, cite-or-abstain and
no-write guarantees); no competing integration was added.

| Capability | Behaviour |
|---|---|
| `incident_trend_summary` | For a chosen period (7–365 days, default 90), optionally one site: incident count versus the preceding equal period (no percentage when there is no baseline; no change figure if a list was capped), categories, severity, findings with the same title recorded two or more times at a site, and corrective actions not yet closed/verified with how many are past due. |
| `risk_patterns` | Recurrence (same site and category, 3 or more incidents inside 90 days) and rising volume (last 90 days at least double the preceding 90, at least 3, with a non-zero baseline). Requires 10 incidents spanning 90 days within the caller's access, otherwise it abstains with the numbers. Each pattern carries evidence ids, period, limitations, why a review may be appropriate, and "This is not a prediction of an accident." No score is produced. |

Controls: all figures are computed in `_shared/ai/insights.ts`; **no model is called** and
`narrate()` is not applied to these capabilities, so no incident text leaves the platform.
Only non-sensitive columns are read (no incident description, reporter, contact or
anonymous community report). Per-user hourly rate limit counted from `ai_request_log`
(default 60, `AI_RATE_LIMIT_PER_HOUR`; fails closed if the log cannot be read); request bodies
are capped at 32,000 characters. Migration 0042 only widens the log's capability CHECK.

## Implementation Phase 3b — safety guidance assistant and JSA assistance [IMPLEMENTED, deterministic]

Follows the owner's clarification (screenshots of the MineGuard field app: Glossary, PPE guide,
JSA form, Emergency screen). Same `ai-assist` handler, log, label, rate limit and no-write rules.

| Capability | Behaviour |
|---|---|
| `safety_guidance` | Retrieval over the bundled reference content: 229 glossary terms, 12 PPE items, 6 first-aid guides, the 5 immediate-action steps and 3 contacts from the field app. Every statement is a verbatim excerpt that cites its entry id. Each carries a provenance `kind`. No match: it abstains and guesses nothing. Asked whether a mine/site/area is safe: it refuses. Legal/regulatory questions: flagged as needing a qualified safety professional; the content states no regulation. Emergency questions return the immediate actions and say that site procedures apply. |
| `jsa_suggestions` | Matches the task description against a fixed library of 11 hazard categories and returns possible hazards, consequences, controls to consider, further-assessment questions and PPE ids (checked against the PPE guide), plus general questions for every task. Always `needs_verification`; never approved. No match: abstains and says that does not mean the task is hazard free. |

**Provenance (`kind`):** `approved_source` only when `REVIEW.approvedBy` in
`guidance-content.ts` names a person; `needs_verification` otherwise; `general_explanation`
exists in the contract for a future approved provider and is never produced today. **As shipped
the repository records no sign-off, so every statement is shown as needing verification** and the
UI says why. Filling in `REVIEW` after a qualified person has reviewed the content flips the label
(regenerate the two copies with `scripts/gen-guidance-content.mjs`; a test fails if they drift).
The hazard library in `jsa-assist.ts` is general knowledge written for this feature, not reviewed
content, and is never labelled approved.

**No model, no network.** Neither capability calls a provider, `narrate()` is not applied (safety
text is not reworded), the task text is matched against a fixed library and never forwarded. The
request log keeps a hash and length of the question only (asserted).

**JSA workflow (migration 0043; none existed).** `job_safety_analyses`, closed to client writes;
RPCs `mg_jsa_save` / `mg_jsa_submit` / `mg_jsa_review`. Lifecycle draft -> submitted -> approved |
rejected. Approval requires a *different* person who is company_admin, or a site_manager /
safety_officer assigned to the site, and the typed word APPROVE; a CHECK constraint refuses an
approved row without a distinct reviewer, a trigger freezes submitted/approved content and bans
deletion, and `ai_assisted` is derived from hazard sources (never settable). No function accepts AI
as an approver. Approval records review; it does **not** authorise the task. The table stores no
worker names (profile ids only); Ministry roles get read access via `jsa.read` within their scope.
"Qualified" is approximated by organisation role: the database cannot verify competence.

**Rollback.** Revert the Phase 3b commit. Migration 0043 is additive: to remove it, drop
`job_safety_analyses` and the `mg_jsa_*` / `mg_can_*_jsa` functions, delete the `jsa.read`
permission rows, and restore the previous `ai_request_log_capability_check` (list in 0042) after
deleting any `safety_guidance` / `jsa_suggestions` log rows (the log is append-only; do this as the
database owner). Removing only the UI: delete the `safety` and `jsa` routes in `src/main.tsx`.

## Phase 3c — role authority, JSA approval matrix, emergency contacts [IMPLEMENTED]

Migration 0044. Modelled on common practice in safety-management software: the people who do
the work prepare and submit; a safety authority independent of the preparer reviews; role
elevation is an administrator act. "Qualified" remains an organisational-role approximation.

| Role (company) | Assign roles | Prepare + submit JSA | Review / approve JSA | Maintain emergency contacts |
|---|---|---|---|---|
| Company administrator | **Yes — the only role that can** (site manager, safety officer, worker, onboarding officer); change roles; approve join requests | Yes | Yes, any site of the company, never their own | Whole company and every site |
| Site manager (assigned to the site) | No | Yes | **Yes**, that site, never their own | That site |
| Safety officer (assigned to the site) | No | Yes | **Yes**, that site, never their own | That site |
| Worker (assigned to the site) | No | Yes | No | No (reads) |
| Onboarding officer | Adds **workers only** (bulk import keeps working) | No | No | No |
| Ministry staff | No (the registrar still appoints the company administrator) | No | No (read-only via `jsa.read`) | No (reads via `emergency.read`) |

Decision to confirm: an onboarding officer may still add `worker`, the lowest role, which carries
no approval authority. To make assignment strictly administrator-only, remove the `worker` line in
`mg_create_org_invitation_core` (0044); bulk worker import would then need an administrator.

Role changes: `mg_set_member_role` is administrator-only, never on yourself, never on an
administrator. Approving a join request is administrator-only; rejecting is unchanged. Site
assignment is not a role change and is unchanged (an assigned manager/officer is what makes
them a reviewer for that site).

**Emergency contacts** are rows in `emergency_contacts` (company-wide or per site), not constants
in the app. Nothing is seeded; an empty list says so. Members read company-wide plus their
sites' contacts; the assistant reads them under the caller's own row-level security, only for
emergency questions (another company's contacts cannot appear; asserted). Removal archives
(audited) rather than deletes. Numbers are format-checked only; they are not verified as
reachable, and the UI tells people to confirm they are current.

### Not built, and why
- **Sign-off of the reference content.** Needs a named qualified safety professional to review `guidance-content.ts` and record `REVIEW.approvedBy`; until then nothing is labelled approved.
- **French content.** The field app is bilingual; only English was imported.
- **Contact verification.** No check that a stored number rings; maintenance is a human duty.
- **Live model provider.** Still no approved provider, adapter or credential (see Session 8
  list above). Enabling one for narration would send aggregate claim text to that provider and
  needs the data-processing decision recorded there first.
- **Retention of `ai_request_log`.** Still an owner decision. The log is append-only and holds
  hashes, counts and validated arguments only.
