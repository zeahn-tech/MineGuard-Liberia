# 08 — AI Governance

**Status:** no AI features ship in v1.0. This document fixes the rules before any
AI capability is added.

## Permitted assistance (future) [PROPOSED]

Summarization of inspection history; trend identification; natural-language
search over records the user is already authorized to see; risk explanation
(walkthrough of the explainable factor breakdown); executive briefing drafts;
document triage.

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
