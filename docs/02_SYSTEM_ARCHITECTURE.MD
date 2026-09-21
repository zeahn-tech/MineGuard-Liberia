# 02 — System Architecture

**Status:** implemented architecture as built; deviations noted.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + Vite + TypeScript |
| Routing | react-router 7 (public / auth / protected /portal/*) |
| Styling | Tailwind CSS 4 + Papery design tokens (`src/index.css`) |
| UI kit | shadcn/ui (Radix primitives) |
| Backend | Convex functions (queries/mutations/actions) |
| Database | Convex document store with typed schema |
| Auth | Convex Auth (email OTP + anonymous), federated Freebuff token support |
| Storage | Convex file storage (evidence) |
| Map | Leaflet + react-leaflet, OpenStreetMap tiles |

## Topology

```
Browser (field laptop / office)
  ├─ React SPA (offline queue in localStorage)
  ├─ ConvexReactClient ⇄ Convex deployment (queries, mutations, actions)
  │                            ├─ schema.ts (typed tables)
  │                            ├─ lib/authz.ts (authorization core)
  │                            ├─ sites / inspections / records / stats / evidence
  │                            └─ auditLog (append-only)
  └─ Leaflet map ⇄ OpenStreetMap tiles
```

## Key architectural rules

1. **One authorization core.** All modules import `requireUser`, `requireStaff`,
   `requireReviewer`, `requireAdmin`, `assertSiteAccess` from
   `src/convex/lib/authz.ts`. No module performs ad-hoc identity checks except
   the action-context identity check in evidence (documented limitation).
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
