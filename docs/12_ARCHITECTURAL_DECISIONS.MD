# 12 — Architectural Decisions

Short records of the significant choices made in this build, with rationale.

## ADR-01 — Convex as the single backend
**Decision:** All server logic in Convex functions; no second API layer.
**Rationale:** The template already runs Convex Auth + Convex; queries are
reactive (fresh command-center data with no polling); mutations give
transactional audit-log writes. Rejected: Express/Postgres stack (duplicated
auth, more deployment surface for a pilot).

## ADR-02 — Authorization centralized in one module
**Decision:** `src/convex/lib/authz.ts` owns identity, roles, scopes, operator
isolation, and audit helper.
**Rationale:** One place to review the security model; modules cannot drift.
Every handler calls a `require*` helper — no ad-hoc identity checks outside
evidence's action-context identity gate.

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
