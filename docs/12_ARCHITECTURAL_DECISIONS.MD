# 12 — Architectural Decisions

Short records of the significant choices made in this build, with rationale.

## ADR-11 — Explicit `EXECUTE` management on the public schema (no PUBLIC fallback) [2026-09-25]
**Decision:** `0002_grants_and_storage.sql` revokes `EXECUTE` on all functions
in schema `public` from `PUBLIC` before granting it to `anon`/`authenticated`,
and sets default privileges so future functions never silently re-acquire the
Postgres default `EXECUTE … TO PUBLIC` grant. Privileged RPCs additionally
revoke from `anon`.
**Rationale:** Hosted Supabase revokes the Postgres-wide `EXECUTE TO PUBLIC`
default platform-wide; vanilla Postgres (the repository migration lineage,
tested via PGlite) does not. Without the explicit revoke, an anon caller
reached the body of `complete_staff_profile` instead of being privilege-denied
— caught by the clean-apply suite; every definer body re-checks authorization
internally, so the exposure was defense-in-depth-only, but the documented
intent is that privileged RPCs are not callable without a session at all.
Which layer refuses is lineage-dependent (privilege layer vs. body check);
the tested invariant is that anon calls **never succeed**.

## ADR-10 — Forensic remediation verified at both lineages [2026-09-25]
**Decision:** The two CRITICAL defects from the 2026-09-24 forensic re-audit
(docs/11 §0.1 world-readable `profiles`, §0.2 broken migration 0002) are fixed
in the repository lineage (`0003`, corrected `0002`) and were verified as
already applied to the live Supabase project (Management API policy probe +
the always-on live anon-key probe suite `tests/live-anon.test.ts`).
**Rationale:** The repository migrations describe the schema lineage; the live
project was provisioned earlier and diverged. Fixing only one lineage would
leave the other exploitable; verifying both closes the gap. The live probe
suite re-runs on every test pass, so regression detection does not depend on
manual audits.

## ADR-09 — Backend migrated from Convex to Firebase [2026-09]
**Decision:** Replace Convex with Firebase (Firestore + Firebase Auth + Cloud
Storage + Security Rules) at the project owner's request; the project
`mineguard-liberia` was provided by the owner.
**Rationale:** Owner-managed infrastructure. The migration preserved the entire
API surface (`src/lib/backend.ts` mirrors every former Convex function) and the
authorization model (now enforced by `firestore.rules`/`storage.rules`, with
identical checks re-derived in the data layer). Page logic was untouched via
Convex-compatible React hooks. Trade-offs accepted: rules cannot express some
per-county list filters (doc 04 gap 5); multi-step mutations are no longer
single transactions (the audit write is best-effort ordered after the business
write; a Cloud Functions hardening pass can restore atomicity).

## ADR-01 — Backend consolidated in one managed platform (superseded detail: now Firebase)
**Decision:** All server logic in the managed backend; no second API layer.
**Rationale:** Originally Convex (template default); migrated to Firebase per
ADR-09. Reactive subscriptions are preserved via Firestore listeners; rejected:
Express/Postgres stack (duplicated auth, more deployment surface for a pilot).

## ADR-02 — Authorization centralized (two layers after ADR-09)
**Decision:** Originally `src/convex/lib/authz.ts`; now the security rules own
authorization authoritatively and `src/lib/backend.ts` re-derives the same
checks per call.
**Rationale:** One place to review the security model per layer; modules cannot
drift. Every backend function calls a `require*` helper — no ad-hoc identity
checks.

## ADR-03 — Roles + scope + operatorName (not a generic RBAC matrix)
**Decision:** Four roles; geographic scope on staff; `operatorName` equality for
tenant isolation.
**Rationale:** Matches the operating model (National → County → Site; operator
org) without a permission matrix that no one can audit. Extensible: adding a
scope or role is a schema + authz change.

## ADR-04 — Offline queue in localStorage, idempotent server dedupe
**Decision:** Field writes persist locally first; submissions carry a `clientRef`;
the server dedupes on it.
**Rationale:** Inspectors work where connectivity fails; the simplest durable
store that survives refresh and offline periods is localStorage; server-side
dedupe makes retries safe without distributed locks. Rejected: IndexedDB now
(add when media bytes need queueing), ServiceWorker sync (platform complexity).

## ADR-05 — Verification-state enum on environmental data
**Decision:** Every observation carries observed/measured/verified/unverified/alleged.
**Rationale:** The master directive requires distinguishing data strength;
modeling it in the record (not prose) lets analysis filter honestly.

## ADR-06 — Community reports never auto-escalate
**Decision:** Public reports enter a human triage workflow; no automatic linkage
to enforcement, sites, or risk scores.
**Rationale:** A report is a concern, not an accusation. Human verification is
recorded with reviewer identity in the audit log.

## ADR-07 — Explainable, configurable risk weights
**Decision:** Weights live in `sites.ts` as a plain, documented object; scores
return their factor breakdown.
**Rationale:** Auditable and tunable by the program owner; avoids a black-box
score that would be indefensible in oversight proceedings.

## ADR-08 — No invented legal references
**Decision:** No law/section numbers anywhere in the data model or UI; regulatory
citation is a future configurable field.
**Rationale:** Fabricating Liberian legislation would be worse than omitting it;
citation fields require government confirmation.

## ADR-09 — Leaflet + OSM for v1 mapping
**Decision:** Raster OSM tiles with a Papery filter; no boundary or license
polygons until authoritative data exists.
**Rationale:** Zero vendor lock, works offline-friendly in the field later,
honest about what the map can claim. Rejected: Mapbox (key management + cost),
GeoJSON boundaries (none verified).

## ADR-10 — Papery theme
**Decision:** Newspaper/editorial system: paper `#F0EEE6`, ink foreground, serif
headings, hairline rules, stamps for statuses.
**Rationale:** Government-facing oversight reads like a record, not an app store
product; the paper metaphor keeps the interface calm, credible, and printable.

## ADR-11 — Dev seed gated on empty database
**Decision:** `seedIfEmpty` runs only when no sites exist; provenance is the
authenticated runner.
**Rationale:** Demo data is clearly synthetic and can never overwrite real
records; every seeded row still has a truthful author.
