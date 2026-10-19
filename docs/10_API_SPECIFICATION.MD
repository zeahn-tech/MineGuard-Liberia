# 10 — API Specification

The API is the `api` object in `src/lib/backend.ts` — a function-for-function
mirror of the original Convex surface, now backed by Firebase (Firestore +
Storage). Authorization is enforced by `firestore.rules`/`storage.rules`
(authoritative) and re-derived in each function (fail-fast). Errors are thrown
as short codes (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `NOT_EDITABLE`,
`FILE_TOO_LARGE`, `USER_NOT_FOUND: …`). Queries return a subscribable handle;
the React layer (`src/lib/backend-react.ts`) exposes them with Convex
`useQuery(fn, args)` semantics.

## sites.ts
| Function | Type | Auth | Notes |
|----------|------|------|-------|
| `list` | query | staff | Scope-filtered; includes open action counts |
| `get` | query | staff/operator via access check | Single site |
| `create` | mutation | admin | Generates code; status pending_verification; audit |
| `update` | mutation | admin | Field edit (name/operator/geo/notes); operator change re-points the tenant org; server-written before/after audit diff; no-op writes nothing |
| `setStatus` | mutation | admin | Lifecycle transition; audit |
| `riskScores` | query | staff | Explainable factor breakdown per site |

## inspections.ts
| Function | Type | Auth | Notes |
|----------|------|------|-------|
| `listTemplates` | query | staff | Active templates |
| `list` | query | staff | Scope-filtered summaries |
| `get` | query | staff/operator via ownership/isolation | Full record |
| `createDraft` | mutation | staff | Idempotent on `clientRef`; audit |
| `updateDraft` | mutation | owner inspector | Draft-only; answers/notes/GPS |
| `submit` | mutation | owner inspector | draft → under_review; audit |
| `review` | mutation | reviewer | approve/reject + note; audit |
| `listFindingsForInspection` | query | staff | |
| `addFinding` | mutation | staff | audit |
| `updateFindingStatus` | mutation | owner or reviewer; operator may acknowledge own-site only | audit |
| `listCorrectiveActions` | query | staff | By finding |
| `listSiteCorrectiveActions` | query | access-checked | By site |
| `openCorrectiveAction` | mutation | staff | audit |
| `respondCorrectiveAction` | mutation | matching operator | sets submitted; audit |
| `decideCorrectiveAction` | mutation | reviewer | verify/close/escalate/in_progress; audit |

## records.ts
| Function | Type | Auth | Notes |
|----------|------|------|-------|
| `listIncidents` | query | staff + operators (own sites) | |
| `reportIncident` | mutation | access-checked (staff/operator) | source derived from role; audit |
| `setIncidentStatus` | mutation | staff | audit |
| `listObservations` | query | staff | scope-filtered |
| `reportObservation` | mutation | access-checked | verification enum; audit |
| `setObservationStatus` | mutation | staff | audit |
| `listCommunityReports` | query | staff | Full records for triage |
| `submitCommunityReport` | mutation | **public** | Generates tracking code; audit (actor "public") |
| `trackCommunityReport` | query | **public** | Coarse fields only (code, status, date) |
| `triageCommunityReport` | mutation | reviewer | decision + note; audit |

## stats.ts
| Function | Type | Auth | Notes |
|----------|------|------|-------|
| `commandCenter` | query | staff | All figures computed from data; scope-aware |
| `publicStats` | query | public | Aggregate counts only |
| `recentAuditLog` | query | staff | Last 200 entries |
| `listUsers` | query | admin | |
| `setUserRole` | mutation | admin | audit |
| `provisionByEmail` | mutation | admin | Requires target to have signed in once; audit |
| `completeProfile` | mutation | user (self) | Defaults role to inspector |

## evidence.ts
| Function | Type | Auth | Notes |
|----------|------|------|-------|
| `upload` | mutation | authenticated | Uploads bytes to Cloud Storage then writes metadata; 25MB cap; audit |
| `listForParent` | query | staff | Per-parent listing |
| `getUrl` | mutation | authenticated | Returns a Storage download URL (ACL deep-check planned) |
| `storageFootprint` | query | admin | Governance metric |

## seed.ts
| Function | Type | Auth | Notes |
|----------|------|------|-------|
| `seedIfEmpty` | mutation | admin | Synthetic demo data only when DB empty |
| `checkSeeded` | query | staff | Site count |

## ai-assist (Edge Function) [Session 8 — AI-1]
`POST /functions/v1/ai-assist` — JWT required (verify-JWT on). Body: `{capability, ...params}`.
Response: the AI envelope (`label`, `capability`, `mode`, `abstained`, `abstainReason`, `claims[]`
each with `citations`, `citations[]`, `data`, `notices[]`). Errors: `400 BAD_REQUEST`,
`401 UNAUTHENTICATED`, `403 FORBIDDEN` (no role), `502 QUERY_FAILED`, `503 LOG_UNAVAILABLE`.
| Capability | Params | Auth |
|---|---|---|
| `nl_search` | `query` (≤ 500 chars) | any role; RLS-scoped |
| `site_summary` | `siteId` | any role; out-of-scope ⇒ abstain |
| `trend_notes` | `siteId?`, `months?` (3–24) | any role; RLS-scoped |
| `inspection_priorities` | `limit?` (1–25) | any role; RLS-scoped |
| `executive_briefing` | — | any role; RLS-scoped |
| `document_analysis` | `text` (≤ 20,000 chars) | any role; reads no records |
Client wrapper: `askAiAssistant()` in `src/lib/ai-assist.ts`.
