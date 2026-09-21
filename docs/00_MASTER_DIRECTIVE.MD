# 00 — Master Engineering Directive

**Project:** MineGuard Liberia
**Version:** 1.0
**Date:** 2026-09-21
**Status:** Active directive

## 1. Primary objective

MineGuard Liberia is a national mining oversight, safety, compliance, environmental
monitoring and intelligence platform. It is designed for potential government
adoption with government-ready architecture. It is **not** an official Government
of Liberia system, and no government approval, partnership, seal, dataset, or
statistic is claimed or implied anywhere in the product.

## 2. Source of truth

The documents in `docs/` (00–16) are the authoritative engineering record. They must
stay synchronized with the implementation. Never document functionality that does not
exist. `11_IMPLEMENTATION_STATUS.md` is updated at the end of every implementation
session.

## 3. Requirement classification

Every major requirement is classified in the individual documents as one of:

`EXISTING IMPLEMENTED` · `PARTIALLY IMPLEMENTED` · `PLANNED` · `PROPOSED` ·
`UNKNOWN` · `REQUIRES GOVERNMENT CONFIRMATION`

Assumptions are never converted into facts.

## 4. Operating model

The platform supports a configurable administrative hierarchy
(National → Region → County → District → Community → Site) and organizational
scopes (national, regional, county, site, operator). Access is derived
server-side from: user → role → organization → geographic scope → site
assignment → permissions.

## 5. Non-negotiable engineering principles

1. **Server-side authorization.** Frontend hiding is not authorization. Every
   Convex function re-derives permissions in `src/convex/lib/authz.ts`.
2. **Data integrity.** Records carry unique IDs, timestamps, authorship, status
   and audit history. No silent deletion of important records; controlled
   lifecycle states only.
3. **Offline-first field operations.** Field data is persisted locally before any
   network attempt, queued with retry, and deduplicated server-side via
   `clientRef`. Nothing is silently lost. A device-local URI is never treated as
   a permanent media reference.
4. **Verification before assertion.** Environmental records distinguish observed /
   measured / verified / unverified / alleged. Community reports remain concerns
   until a human verifies them; a report is never an automatic accusation.
5. **Explainable risk.** Risk indicators use configurable, documented weights and
   expose their factor breakdown. Scores never determine guilt or trigger
   enforcement autonomously.
6. **AI restraint.** AI may summarize and assist; it must never fabricate records,
   declare guilt, bypass authorization, or make autonomous decisions. (Status:
   planned; no AI features ship in v1.0.)
7. **Honest framing.** No fabricated laws, licenses, statistics, government
   integrations, or official status.
8. **No false completion.** "Production ready" requires evidence across
   functionality, security, offline behavior, sync, media, performance,
   accessibility, deployment, recovery and testing — see doc 16.

## 6. Session discipline

Each implementation session has defined scope, acceptance criteria, tests,
verification, and a documentation update. Broad unrelated changes are avoided.
When session scope completes, work stops; the project owner initiates the next
session.

## 7. Document index

| Doc | Title |
|-----|-------|
| 00 | Master Engineering Directive (this file) |
| 01 | Product Specification |
| 02 | System Architecture |
| 03 | Database Architecture |
| 04 | Security Architecture |
| 05 | Offline Sync Architecture |
| 06 | GIS Architecture |
| 07 | Evidence & Media Architecture |
| 08 | AI Governance |
| 09 | Design System (Papery) |
| 10 | API Specification |
| 11 | Implementation Status |
| 12 | Architectural Decisions |
| 13 | Test Strategy |
| 14 | Deployment & Operations |
| 15 | Data Governance |
| 16 | Pilot Readiness |
