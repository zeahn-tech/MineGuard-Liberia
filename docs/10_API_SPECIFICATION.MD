# 10 — API Specification

All endpoints are Convex functions (typed RPC). Authorization is enforced inside
each handler. Errors are thrown as short codes (`UNAUTHENTICATED`, `FORBIDDEN`,
`NOT_FOUND`, `NOT_EDITABLE`, `FILE_TOO_LARGE`, `USER_NOT_FOUND: …`).

## sites.ts
| Function | Type | Auth | Notes |
|----------|------|------|-------|
| `list` | query | staff | Scope-filtered; includes open action counts |
| `get` | query | staff/operator via access check | Single site |
| `create` | mutation | admin | Generates code; status pending_verification; audit |
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
| `requestUploadUrl` | mutation | authenticated | Convex storage upload URL |
| `record` | mutation | authenticated | Metadata after upload; 25MB cap; audit |
| `listForParent` | query | admin | Per-parent listing |
| `getUrl` | action | authenticated | Returns storage URL (ACL deep-check planned) |
| `storageFootprint` | query | admin | Governance metric |

## seed.ts
| Function | Type | Auth | Notes |
|----------|------|------|-------|
| `seedIfEmpty` | mutation | authenticated | Synthetic demo data only when DB empty |
| `checkSeeded` | query | authenticated | Site count |
