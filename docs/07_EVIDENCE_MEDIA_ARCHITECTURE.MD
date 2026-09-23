# 07 — Evidence & Media Architecture

**Status:** backend + field attachment UI implemented (2026-09-23); offline
attach and batch upload remain planned.

## Data model [IMPLEMENTED]

`evidence` collection: `storagePath` (Cloud Storage for Firebase,
`evidence/{uid}/{evidenceDocId}__{fileName}`), `parentType`
(inspection/incident/observation), `parentId`, **mandatory** `siteId`,
`kind` (photo/video/audio/document — derived from MIME), `fileName`,
`mimeType`, `sizeBytes`, `caption`, `capturedAt`, `uploadedById`,
`createdAt`.

## Upload flow [IMPLEMENTED 2026-09-23]

`src/lib/backend.ts` `evidence.upload`, aligned with the corrected
`storage.rules` join contract:

1. The caller must have a role; the site must exist and be visible to the
   uploader (`canAccessSite`) — evidence can only be attached to records in
   the caller's scope. `siteId` is mandatory.
2. The metadata doc **id is generated first without a write** (`doc(collection(...))`)
   so the storage object name can embed it:
   `evidence/{uid}/{docId}__{fileName}`. `storage.rules` parses the doc id
   from the object name and joins it back to this metadata doc on every read
   to re-derive role + tenant.
3. Bytes upload to that path (25MB cap re-checked server-side by rules).
4. The metadata doc is created exactly once via `setDoc` — rules forbid
   evidence updates (`allow update: if false`), so patching after the fact is
   impossible by design; the create carries the final `storagePath`.
5. The write is audit logged with kind and parent type.

## Rules [IMPLEMENTED]

1. Bytes exist in Cloud Storage before the metadata record is readable; a
   device-local URI is never persisted as a media reference.
2. Size limit of 25 MB enforced in the data layer *and* server-side.
3. Uploads and metadata writes are authenticated; the uploader identity and
   timestamp are stored server-side (provenance).
4. Every evidence write is audit logged.
5. Storage reads re-derive the caller's role/tenant from `/users/{uid}` and
   join the object to its metadata doc (no role-blind reads).

## Field UI [IMPLEMENTED 2026-09-23]

`src/components/EvidenceSection.tsx`, attached to inspection detail pages
(incident and observation detail surfaces reuse the same component next):
- Attach photo/video/audio/document (max 25MB) with optional caption.
- Thumbnail grid with kind, size, timestamp, caption; click-to-open via
  `evidence.getUrl`.
- Visible to staff and to operators on their own sites' records; upload
  hidden for unassigned accounts (server still re-checks).

[PLANNED] Offline attach (bytes held locally, uploaded on sync), camera
capture UX, batch upload with per-file retry.

## Serving and ACL [IMPLEMENTED — interim]

`evidence.getUrl` requires authentication; Firestore rules scope the
metadata `get` via `siteVisibleAt()`, and `storage.rules` re-derives the same
role/tenant check via a `firestore.get()` join before allowing the object
read. This is the documented interim measure pending a Cloud-Function
signed-URL proxy (doc 04, "File access").

## Retention [PROPOSED — REQUIRES GOVERNMENT CONFIRMATION]

Evidence retention schedules, legal hold, and export-for-proceedings workflows
depend on the adopting institution's records policy and are not implemented.
