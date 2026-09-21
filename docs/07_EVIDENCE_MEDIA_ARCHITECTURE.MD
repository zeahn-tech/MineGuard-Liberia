# 07 — Evidence & Media Architecture

**Status:** backend implemented; field-UI attachment flow planned next session.

## Data model [IMPLEMENTED]

`evidence` table: `storageId` (Convex storage), `parentType`
(inspection/incident/observation), `parentId`, optional `siteId`, `kind`
(photo/video/audio/document — derived from MIME), `fileName`, `mimeType`,
`sizeBytes`, `caption`, `capturedAt`, `uploadedById`, `createdAt`.

## Rules [IMPLEMENTED]

1. Bytes are uploaded to Convex storage first (`requestUploadUrl` → POST →
   `storageId`); only then is the metadata record created. A device-local URI is
   never persisted as a media reference.
2. Size limit of 25 MB enforced server-side.
3. Uploads and metadata writes are authenticated; the uploader identity and
   timestamp are stored server-side (provenance).
4. Every evidence write is audit logged.

## Field UI [PLANNED — next session]

Camera/file capture in the inspection and incident forms, including:
- Attach to draft offline (bytes held locally, uploaded on sync).
- Thumbnail rendering with captions in detail views.
- Batch upload with per-file retry.

## Serving and ACL [PARTIAL]

`evidence.getUrl` is an authenticated action that returns a storage URL. Per-site
ACL re-checks at fetch time are planned before pilot (doc 04).

## Retention [PROPOSED — REQUIRES GOVERNMENT CONFIRMATION]

Evidence retention schedules, legal hold, and export-for-proceedings workflows
depend on the adopting institution's records policy and are not implemented.
