# 05 — Offline Sync Architecture

**Status:** IMPLEMENTED for field submissions, drafts, corrective-action
responses and evidence uploads (Session 4, OFF-1…7 completed the general
queue framework).

## Rules (non-negotiable)

1. **Persist before network — durably, or fail loudly.** Drafts and queued
   submissions are written through `src/lib/offline-store.ts` (IndexedDB in
   browsers; localStorage fallback elsewhere). Every write is **read back and
   compared** before it is accepted; anything less throws `NotSavedError`
   (`NOT_SAVED`). Callers await every enqueue — a NOT_SAVED rejection blocks
   every "saved" UI path (no success toast, no navigation, the draft form
   keeps a persistent banner until the next good write).
2. **Nothing is silently dropped.** Failed syncs stay in the queue with
   `lastError`, `attempts`, a classification (`retryable` / `permanent` /
   `conflict`) and a `nextRetryAt` backoff window; permanent and max-attempt
   items park as `dead` where a human can retry, export or discard them.
3. **No device URIs as references.** A `blob:`/`content://` path is never
   stored as a media reference. Evidence requires uploaded bytes (storageId)
   before the record exists.
4. **Idempotent sync.** Every queued item carries a `clientRef` (UUID). The
   server dedupes on `clientRef` (`inspections.createDraft`,
   `records.reportIncident`, `records.reportObservation`), so replays after
   crashes, lost responses or retries cannot create duplicates.
5. **Conflicts are human decisions.** Updates that carry `row_version`
   (currently the corrective-action response) answer HTTP 409 with a server
   snapshot; the item parks as `conflict` and only the queue manager's
   resolution screen (keep server / apply mine) moves it. Never automatic
   last-write-wins on a row a human may have edited.
6. **Integrity before upload.** Queued evidence bytes are re-hashed against
   their recorded SHA-256 before every replay; a mismatch parks the item
   (`EVIDENCE_CORRUPT`) instead of uploading bytes the record no longer
   describes (doc 07).

## Data stores on device

| Store | Backend | Contents |
|-------|---------|----------|
| `mg.offline.queue.v1` | IndexedDB `mg.offline.store` (kv) | Submission queue items: status, attempts, backoff, errors, conflict snapshots |
| `mg.offline.drafts.v1` | same | In-progress inspection drafts (answers, notes, GPS) |
| `mg.offline.refs.v1` | same | Local parent refs — `clientRef → { table, server id }` (OFF-6) |
| `mg.offline.evidence` (object store `pending`) | IndexedDB | Queued evidence Blobs + metadata (sha256, parentRef, attempts) |

Legacy `localStorage` keys with these names migrate into IndexedDB on first
load, copy-verified before the localStorage copy is removed. All queue
mutations are read-modify-write against the freshest stored value, so two
tabs (or a tab and the scheduler) cannot clobber each other through a stale
mirror.

## Flow

```
Inspector fills form ── autosave ──► durable draft (awaited; NOT_SAVED surfaces)
        │ submit
        ▼
enqueueSubmission (durable FIRST)   ← data is now safe — or the UI says it isn't
        │
        ▼
sync scheduler (one per portal shell)
  triggers: startup · 'online' · visibilitychange · backoff timer
  single-flight · skipped while the platform reports offline
        │
        ├─ success → remove item + draft; record clientRef → server id
        ├─ retryable → status failed + jittered exponential backoff
        │              (2^n s, cap 5 min; 8 attempts → parked "dead")
        ├─ permanent → parked "dead" immediately (no wasted retries)
        └─ 409 row_version → status "conflict" + server snapshot
                             → queue manager resolution screen (human)
```

Evidence follows the same scheduler, after the field queue in each pass:
an item whose parent was created offline **waits** until the parent's
server id exists, then uploads against it.

## Status surfacing [IMPLEMENTED]

- Header shows the queued count with a tap-to-sync action in both portals;
  background toasts narrate syncs, conflicts and parked items.
- **Queue manager** (`QueueManager.tsx`, both shells): inspect every item
  (status, attempts, error, next retry), retry now, export JSON, discard
  with confirmation, and the conflict-resolution screen. A `memory`
  storage backend (no persistence at all) is called out explicitly.
- Command Center banner while items are queued; the inspections page lists
  on-device drafts separately from synced records.
- Evidence sections show per-file states: "Saved on device" only when the
  durable write verified; a refused write shows the error instead.

## Known limitations [PLANNED / accepted]

- Multi-device draft visibility (same user, two devices) is out of scope v1.0.
- Conflict detection currently covers the corrective-action response (the
  only queued update). Queued items are creates — they dedupe on clientRef
  rather than conflict; extend `row_version` gating to other updates when
  offline editing of submitted records is introduced.
- Cross-tab freshness: mirrors refresh on store events + a slow interval in
  the Command Center; a second tab's writes are picked up through the
  read-modify-write (no clobbering) but badge counts may lag a second.
