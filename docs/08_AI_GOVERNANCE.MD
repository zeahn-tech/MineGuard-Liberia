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
