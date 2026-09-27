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
types) — designed in an admin template editor at `/portal/templates`
(§11: inspection design is data, not code; shape validated live in the editor
and re-validated server-side; publish/unpublish; delete refused while
inspections reference the template — migration 0008 completed the missing
DELETE policy). Lifecycle: draft → under_review → approved / rejected. Drafts are created
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

### Operator portal [IMPLEMENTED 2026-09-27 — structural]
A dedicated routed section for the Operator role (spec §20) at `/operate/*` —
not a conditionally-hidden staff view: its own layout shell and nav
(Overview · My Sites · Findings · Corrective Actions · Incidents · Account
Security), entered by route gate (`RequireOperator`) with the staff portal
separately gated (`RequireStaff`). Surfaces: the operator's own licensed
sites; findings recorded on them (read-only — response flows through
corrective actions); compliance obligations with the respond flow (a
described action taken, submitted once, verified and closed by the reviewing
authority); incident submission with offline queueing (persist-first,
clientRef dedupe on reconnect) and supporting-document upload (photos/PDFs →
evidence vault with metadata + audit). Strict tenant isolation is enforced
server-side (RLS + `mg_can_access_site` + respond/upload guards); the section
renders only what the server already scoped, and an operator account cannot
reach any staff-only route or query — verified by
`tests/operator-isolation.test.ts` (route structure asserted; every staff
surface fails closed for the operator identity; every operator feed is
strictly own-tenant).

### Command center [IMPLEMENTED]
All statistics computed live from stored data: sites, inspections, findings,
corrective actions (open/overdue), incidents, fatalities, environmental alerts,
community reports, inspection coverage %. Priority sites from the risk indicator.

### Risk indicator [IMPLEMENTED]
Explainable, weighted factors (findings by severity, repeat findings, overdue
corrective actions, fatalities, serious incidents, verified environmental alerts).
Configurable weights in `src/lib/backend.ts` (sites.riskScores). Decision-support only.

### Evidence & media [IMPLEMENTED]
Storage-backed uploads with kind detection, size limit, metadata, and provenance.
The field attachment UI (`EvidenceSection`) is wired into inspection, incident
and observation detail pages. Offline attach queues file bytes on-device
(IndexedDB) and uploads on reconnect; a failed replay stays queued with retry
info — nothing is silently dropped. Camera capture (§10): a real getUserMedia
viewfinder with shutter/retake/switch and a capture="environment" file-input
fallback where the API or permission is unavailable — captured frames join the
batch exactly like picked files. Batch upload (§10): per-file BYTE progress
bars driven by real XHR progress events (no polling, no fabricated indicators);
offline files show "saved on device" instead of a bar, because bytes resting
on the phone have no progress to report.

### Offline operations [IMPLEMENTED]
Local draft persistence, submission queue with retry, server-side clientRef
dedupe, sync status indicator, auto-sync on reconnect. Covers inspections,
incidents and environmental observations, plus offline evidence byte queuing
(IndexedDB) for attachments.

### Notifications [PARTIALLY IMPLEMENTED — minimal in-app v1, 2026-09-27]
In-app notifications derived at request time from records the caller can
already see — no notifications table, no delivery infrastructure, no cost.
Two v1 event classes: corrective-action deadlines in the caller's scope
(due-soon ≤3 days → warning; overdue → urgent; far-future silent) and
community-report status changes for staff (triaged reports from the last 7
days; untouched reports are not news). Operators additionally see reviewer
decisions (verified/closed/escalated) on corrective actions they opened.
Everything is role- and tenant-scoped by the same server rules as the
underlying records; notifications cannot leak what the caller cannot read.
Rendered in a bell dropdown in both portal shells.

Delivery channels — CLASSIFICATION:
- In-app (this feature): IMPLEMENTED. No new infrastructure.
- Email (SMTP), push (FCM/web-push), SMS: NOT IMPLEMENTED — **REQUIRES
  GOVERNMENT/OWNER CONFIRMATION**. Each implies a provider account and cost,
  personal-data handling beyond the current in-app scope (recipient
  addresses/device tokens), a retention question for delivery logs, and an
  abuse surface from a government-adjacent sender. The reporter-facing
  channel is additionally constrained: community reports are anonymous by
  design, so there is no reporter address to notify — the public tracking
  page remains their status channel.
- A future persisted-notification table (read receipts, per-user dismissal)
  is PROPOSED, same confirmation gate.

AI assistance, government reporting exports [PROPOSED]
Not implemented in v1.0. See docs 08 and 14.

## Explicit non-goals (v1.0)

- No enforcement actions or legal determinations.
- No fabricated regulatory references. Regulatory citation fields are
  configurable and left empty pending government confirmation.
- No official government identity, seals, or integrations.
