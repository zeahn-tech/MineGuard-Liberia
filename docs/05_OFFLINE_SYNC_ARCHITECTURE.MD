# 05 — Offline Sync Architecture

**Status:** implemented for inspections; generalized queue framework in place.

## Rules (non-negotiable)

1. **Persist before network.** Drafts and queued submissions are written to
   `localStorage` before any connectivity attempt.
2. **Nothing is silently dropped.** Failed syncs stay in the queue with
   `lastError`, `attempts`, and are retried on reconnect or manual sync.
3. **No device URIs as references.** A `blob:`/`content://` path is never stored
   as a media reference. Evidence requires uploaded bytes (storageId) before the
   record exists.
4. **Idempotent sync.** Every queued item carries a `clientRef` (UUID). The
   server's `inspections.createDraft` dedupes on `clientRef`, so replays after
   crashes or retries cannot create duplicates.

## Data stores on device

| Key | Contents |
|-----|----------|
| `mg.offline.drafts.v1` | In-progress inspection drafts (answers, notes, GPS) |
| `mg.offline.queue.v1` | Submission queue items with status and retry info |

## Flow

```
Inspector fills form ── autosave ──► localStorage draft
        │ submit
        ▼
enqueueSubmission (persisted)          ← data is now safe
        │
        ├─ online: syncQueue()
        │    createDraft(clientRef) → updateDraft → submit
        │    success → remove queue item + draft
        │    failure → mark failed, keep, retry later
        │
        └─ offline: item waits; 'online' event triggers auto-sync
```

## Status surfacing [IMPLEMENTED]

- Topbar shows queued count and sync state; manual "sync now" available.
- Command center shows a banner while items are queued.
- Inspections page lists on-device drafts separately from synced records.

## Known limitations [PLANNED]

- Conflict handling: last-write-wins per item; a server-authoritative merge
  strategy for concurrently edited drafts is planned (server rejects edits to
  non-draft records, so window is narrow).
- Media is not yet queued offline; attachments require connectivity until the
  evidence upload queue lands (doc 07).
- Multi-device draft visibility (same user, two devices) is out of scope v1.0.
