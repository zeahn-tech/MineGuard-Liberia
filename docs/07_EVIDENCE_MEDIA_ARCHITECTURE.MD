# 07 — Evidence & Media Architecture

**Status:** backend + field attachment UI implemented (2026-09-23); offline
attach implemented (on-device queue, 2026-09-23); camera capture and batch
upload remain planned.

## Data model [IMPLEMENTED — extended 2026-10-06, EVD-1]

`evidence` collection: `storagePath` (Supabase Storage private bucket
`evidence`, path `{uid}/{evidenceRowId}__{fileName}`), `parentType`
(**inspection / incident / observation / community_report /
corrective_action** — the last two added by migration 0013), `parentId`,
`siteId` (**mandatory except community-report attachments**, which belong
to no site — migration 0013 made the column nullable for that staff-only
triage case), `kind` (photo/video/audio/document — derived from MIME),
`fileName`, `mimeType`, `sizeBytes`, `caption`, `capturedAt`,
`uploadedById`, **`sha256`** (lowercase-hex digest of the uploaded bytes,
CHECK-pinned format; null only for pre-0013 rows), `createdAt`.

The digest is computed twice independently — once when capture enters the
offline queue (recorded on the queued item), once by the data layer at
upload — and a mismatch is refused (`EVIDENCE_HASH_MISMATCH`) rather than
stored; queued replays re-hash their bytes first and refuse corruption
(`EVIDENCE_CORRUPT`, parked, never uploaded).

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
   device-local URI is never persisted as a media reference. Offline captures
   are held in an on-device IndexedDB queue and only become evidence records
   after the real upload succeeds (see Field UI).
2. Size limit of 25 MB enforced in the data layer *and* server-side.
3. Uploads and metadata writes are authenticated; the uploader identity and
   timestamp are stored server-side (provenance).
4. Every evidence write is audit logged.
5. Storage reads re-derive the caller's role/tenant from `/users/{uid}` and
   join the object to its metadata doc (no role-blind reads).

## Field UI [IMPLEMENTED 2026-09-23]

`src/components/EvidenceSection.tsx`, wired into all three record detail
pages — inspection (`/portal/inspections/:id`), incident
(`/portal/incidents/:id`) and environmental observation
(`/portal/environment/:id`):
- Attach photo/video/audio/document (max 25MB) with optional caption.
- Thumbnail grid with kind, size, timestamp, caption; click-to-open via
  `evidence.getUrl`.
- Visible to staff and to operators on their own sites' records; upload
  hidden for unassigned accounts (server still re-checks).
- **Offline attach [IMPLEMENTED 2026-09-23 — extended 2026-10-06]** —
  when offline, or on a connectivity failure (never on a policy denial),
  the file bytes are saved in the on-device IndexedDB queue
  (`src/lib/offline-evidence.ts`) and rendered as "queued for upload".
  Session 4: every enqueue computes + records the SHA-256 (verified before
  each replay), failures are classified with jittered exponential backoff
  up to a max attempt count (then parked, never dropped), a file whose
  parent was created offline waits on its `parentRef` and uploads once the
  parent receives its server id, and a device that cannot persist the bytes
  raises `NotSavedError` so the file shows FAILED instead of "saved on
  device". The queue manager (doc 05) lists, retries, exports and discards
  queued files with confirmation. Because the evidence list rule is
  parent-joined and cannot be watched safely by a generic collection
  listener, the section refreshes via a post-upload nonce rather than a
  live watcher.

## Serving and ACL [IMPLEMENTED — mint gate, 2026-09-26]

`evidence.getUrl` requires authentication and now mints through the
`evidence_url` SECURITY DEFINER RPC (migration 0006): the server re-derives
the caller's CURRENT role/tenant (`mg_can_access_site`) at every mint, clamps
the TTL server-side (client requests 120s; hard bounds 30–300s), logs the
mint to the definer-only `evidence_url_audit` table, and only then returns
the storage path for signing. The storage-layer read policy (metadata join +
`mg_can_access_site`) remains the second, independent layer. Since migration
0013 the mint gate, the storage read policy AND the metadata read policy all
admit **site-less** rows for staff accounts only — one predicate across every
evidence read path. A leaked link
expires in ≤120s; a permission change refuses the next mint immediately.
Full rationale and residuals: doc 04, "File access"; test coverage:
`tests/evidence-url.test.ts`.

## Retention [PROPOSED — REQUIRES GOVERNMENT CONFIRMATION]

Evidence retention schedules, legal hold, and export-for-proceedings workflows
depend on the adopting institution's records policy and are not implemented.
