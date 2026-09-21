# 02 — System Architecture

**Status:** implemented architecture as built; deviations noted.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite + TypeScript |
| Routing | react-router 7 (public / auth / protected /portal/*) |
| Styling | Tailwind CSS 4 + Papery design tokens (`src/index.css`) |
| UI kit | shadcn/ui (Radix primitives) |
| Backend | Google Firebase (Firestore + Auth + Storage + Security Rules) |
| Database | Cloud Firestore (collections mirror the former Convex tables) |
| Auth | Firebase Authentication (email/password + anonymous) |
| Storage | Cloud Storage for Firebase (evidence, `evidence/{uid}/` namespace) |
| Map | Leaflet + react-leaflet, OpenStreetMap tiles |

> **Migration note (2026-09):** the backend was migrated from Convex to
> Firebase at the project owner's request. `src/lib/backend.ts` mirrors the
> former Convex API function-for-function; `src/lib/backend-react.ts` provides
> Convex-compatible `useQuery`/`useMutation` hooks so page logic is unchanged.
> The old `src/convex/` tree was removed.

## Topology

```
Browser (field laptop / office)
  ├─ React SPA (offline queue in localStorage)
  ├─ Firebase JS SDK ⇄ Firebase project mineguard-liberia
  │      ├─ Firestore  (collections = former tables; security rules authorize)
  │      ├─ Authentication (email/password, anonymous)
  │      └─ Cloud Storage (evidence/{uid}/…)
  ├─ Data layer: src/lib/backend.ts (authorization re-derived per call,
  │               auditLog written on every consequential mutation)
  └─ Leaflet map ⇄ OpenStreetMap tiles
```

## Key architectural rules

1. **Two-layer authorization.** Firestore/Storage security rules
   (`firestore.rules`, `storage.rules`) are the authoritative server-side
   boundary; `src/lib/backend.ts` re-derives the same checks before every
   call (fail-fast, consistent errors). No module performs ad-hoc identity
   checks. The rules read the caller's role/scope from `/users/{uid}`, which
   is admin-writable only (self role-writes are rejected except the one-time
   first-admin bootstrap guarded by the `meta/hasStaff` sentinel).
2. **Scope filtering happens in the query.** County-scoped users receive only
   their county's records because the server filters, not because the UI hides.
3. **Offline writes go through the queue.** The UI never writes field data
   directly; it persists locally first (`src/lib/offline-queue.ts`) then syncs.
4. **Audit writes are part of the mutation.** Every state-changing mutation writes
   an audit entry in the same transaction scope.
5. **Schema validation is on (`schemaValidation: false` only because the starter
   schema ships that way; tightening is tracked in doc 16).**

## Known limitations (honest)

- Operators currently reach the portal with a reduced nav, but the backend
  operator-facing listing endpoints are the same staff endpoints with
  role-based filtering; a dedicated operator portal surface is [PLANNED].
- Evidence file serving uses Convex storage URLs gated by an authenticated
  action; per-record ACLs on file fetch are [PLANNED].
- The site-code generator scans all sites (fine at national registry scale for a
  pilot; a counter table is the planned optimization).
