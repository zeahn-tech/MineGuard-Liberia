# 01 — Product Specification

**Status:** v1.0 implemented scope documented below. Classifications in brackets.

## Product thesis

Authorized oversight personnel need one place to register mining sites, document
field work, track compliance to resolution, monitor environmental conditions,
receive community concerns, and produce trustworthy figures — including where
connectivity is unreliable.

## Users and roles [IMPLEMENTED]

| Role | Purpose | Scope |
|------|---------|-------|
| Admin | National administrator: registry, status lifecycle, role assignment | All data |
| Supervisor | Review and approval authority: inspections, corrective actions, community triage | National or county |
| Inspector | Field officer: inspections, findings, incidents, observations | Own work + county/national visibility |
| Operator | Mining company user: own sites only, respond to corrective actions | Strict tenant isolation by operator name |

Roles are assigned by an admin (audit logged) or self-declared at first sign-in and
correctable by an admin. Authorization is enforced server-side per request.

## Modules

### Mining site registry [IMPLEMENTED]
Code generation (e.g. `MGL-NIMBA-0007`), operator, county/district/community,
mineral type, coordinates, lifecycle status (pending verification → active →
suspended / closed). Create and status change are admin-only and audit logged.

### Inspections [IMPLEMENTED]
Configurable templates (sections → questions; boolean/text/number/select answer
types). Lifecycle: draft → under_review → approved / rejected. Drafts are created
on-device and sync idempotently (offline queue). GPS capture with accuracy.
Reviewer approve/reject with note. Findings with severity, and the compliance
chain: inspection → finding → corrective action → deadline → response →
verification → closed/escalated [IMPLEMENTED, verification UI basic].

### Incidents [IMPLEMENTED]
Configurable types (fatality, injury, near miss, equipment, vehicle, fire,
structural, chemical exposure, environmental, other). Operational categories only —
explicitly not legal classifications. Staff status transitions: reported →
investigating → closed.

### Environmental monitoring [IMPLEMENTED]
Ten categories (water pollution, river disturbance/diversion, deforestation, soil
degradation, waste, tailings, chemical handling, rehabilitation, land impact) each
carrying an explicit verification state: observed / measured / verified /
unverified / alleged.

### Community reporting [IMPLEMENTED]
Public form (no account), tracking code, public status tracking with coarse fields
only. Staff triage: under review → verified / dismissed / referred, with note and
reviewer attribution. A report never automatically becomes an accusation.

### National map [IMPLEMENTED]
Registry sites (verified data) and open environmental observations as filled
markers; community reports as dashed unverified markers. Verified vs reported are
visually distinct. Administrative boundaries not depicted [PLANNED — requires
authoritative boundary data].

### Command center [IMPLEMENTED]
All statistics computed live from stored data: sites, inspections, findings,
corrective actions (open/overdue), incidents, fatalities, environmental alerts,
community reports, inspection coverage %. Priority sites from the risk indicator.

### Risk indicator [IMPLEMENTED]
Explainable, weighted factors (findings by severity, repeat findings, overdue
corrective actions, fatalities, serious incidents, verified environmental alerts).
Configurable weights in `src/lib/backend.ts` (sites.riskScores). Decision-support only.

### Evidence & media [PARTIALLY IMPLEMENTED]
Storage-backed uploads with kind detection, size limit, metadata, and provenance.
Backend exists (`evidence.upload` in `src/lib/backend.ts`); field UI attachment flow is not
wired into the inspection form yet [PLANNED next session].

### Offline operations [IMPLEMENTED for inspections]
Local draft persistence, submission queue with retry, server-side clientRef
dedupe, sync status indicator, auto-sync on reconnect.

### Notifications, AI assistance, government reporting exports [PROPOSED]
Not implemented in v1.0. See docs 08 and 14.

## Explicit non-goals (v1.0)

- No enforcement actions or legal determinations.
- No fabricated regulatory references. Regulatory citation fields are
  configurable and left empty pending government confirmation.
- No official government identity, seals, or integrations.
