# MineGuard Liberia

**National mining oversight, safety, compliance, environmental monitoring & intelligence platform.**

> Not an official Government of Liberia system. Designed for potential government adoption — no government approval, partnership, seal, dataset or statistic is claimed or implied.

MineGuard Liberia gives authorized oversight personnel a unified platform for the mining-site registry, field inspections, incident management, the compliance chain (inspection → finding → corrective action → verification), environmental observations, community reporting with public tracking, an explainable site-risk engine, and a national GIS map. Field operations are **offline-first**: submissions are persisted on-device before any network attempt and sync with idempotent dedupe.

Built with React 19 + Vite + TypeScript, a **Papery** editorial design system (paper `#F0EEE6`, ink accents, serif hierarchy), and **Supabase** (Postgres + Row Level Security, Auth, Storage, Realtime) with RLS policies + guard triggers + security-definer RPCs as the server-side authorization boundary.

---

## Features

| Area | What it does |
|------|--------------|
| Command Center | Live statistics computed from real data — never hardcoded |
| Mining-site registry | Admin-authored sites with codes (`MGL-<COUNTY>-0001`), status lifecycle, explainable risk scores |
| Field inspections | Configurable templates, GPS capture with accuracy, draft → review → approve/reject lifecycle |
| Offline queue | localStorage drafts + submission queue for inspections, incidents and environmental observations; auto-sync on reconnect; server-side `clientRef` dedupe; nothing silently dropped |
| Evidence | Photo/video/audio/document attachments (≤25MB) with thumbnails, captions and access-controlled downloads, on inspection, incident and observation detail pages; **offline attach** queues bytes on-device (IndexedDB) and uploads on reconnect |
| Incidents | Configurable types (fatality, injury, near-miss, environmental, …), severity, status workflow |
| Environment | Observations with explicit verification states: observed / measured / verified / unverified / alleged |
| Community reports | Public submission (no account), tracking code, human triage workflow — a report is never an automatic accusation |
| Audit log | Append-only trail of every consequential action, visible in-app |
| Access control | 4 roles (admin / supervisor / inspector / operator), geographic scope, operator tenant isolation — enforced by Firestore rules (including per-document list scoping) *and* re-derived per call |
| PWA | Installable, offline app shell, theme-colored, maskable icons |

## Quick start

```bash
bun install          # or npm install / pnpm install
bun run dev          # local dev server on :5173
bun run typecheck    # tsc -b --noEmit
bun test             # run the automated test suite (bun:test)
bun run build        # typecheck + production build to dist/
```

### Supabase setup (one-time, project owner)

1. Project URL + anon key are already configured in `src/lib/supabase.ts` (public client identifiers by design — authorization lives in the database, not in secret config)
2. Run **`supabase/migrations/0001_initial_schema.sql`** in the Supabase SQL editor (Dashboard → SQL Editor → paste → Run). It creates every table, enum, RLS policy, guard trigger, security-definer RPC, the private `evidence` storage bucket, and the realtime publication in one pass
3. Enable **Email** sign-in (Authentication → Providers) and **Anonymous** sign-in (for the public guest mode)
4. First email account to complete a staff profile becomes the **administrator** (one-time bootstrap inside `complete_staff_profile`; only when no admin exists)
5. Never share the service-role key — the client uses only the anon key

## Deployment

Static hosting anywhere (Netlify, Vercel, Cloudflare Pages, any web server):

```bash
bun run build        # output in dist/
```

**GitHub Pages** — a workflow is included at `.github/workflows/deploy-pages.yml`:

1. Push the repository to GitHub
2. **Settings → Pages → Source: GitHub Actions** (not "Deploy from a branch")
3. Push to `main` (or `master`) — the site builds and deploys to `https://<user>.github.io/<repo>/`

The build is repository-aware: on GitHub Pages it automatically serves from `/<repo>/` (override with `PUBLIC_PATH=/custom/base/`). Routing uses `HashRouter`, so deep links work with zero server configuration. A service worker provides the offline app shell.

> **Blank screen / 404s for `manifest.webmanifest` after deploying?** GitHub
> Pages is serving the repository source instead of the built app. Check:
> 1. **Settings → Pages → Source** must be **GitHub Actions**. If it says
>    "Deploy from a branch", Pages publishes raw repo files (the raw
>    `index.html` references `/src/main.tsx`, which only exists in dev → blank
>    screen; `manifest.webmanifest` 404s because it lives in `public/`).
> 2. The workflow triggers on pushes to `main`/`master` — confirm the
>    workflow ran under the **Actions** tab and check its error logs.
> 3. After fixing the source setting, push again (or use *Actions → Deploy to
>    GitHub Pages → Run workflow*) and hard-refresh (Ctrl+Shift+R).

## Project structure

```
src/
  lib/
    supabase.ts        Supabase client + auth state store
    backend.ts         Data layer: the whole API surface, authz re-derived per call
    backend-react.ts   Convex-style useQuery/useMutation hooks over Supabase
    types.ts           Domain types + client-side authorization mirror
    compat-types.ts    Id<T>/Doc<T> compatibility shims
    offline-queue.ts   Field queue: local persistence, retry, idempotent sync
    offline-evidence.ts Evidence byte queue (IndexedDB) for offline attachments
  pages/               Landing, Auth, Portal (Command Center, Sites, Map,
                       Inspections, Incidents, Environment, Community, Audit)
  components/ui/       shadcn/ui primitives
supabase/migrations/   Postgres schema: tables, RLS policies, guard triggers,
                       security-definer RPCs, storage policies
docs/00–16             Full engineering documentation set
scripts/               Icon generator (dev-only)
```

## Documentation

The `docs/` directory is the authoritative engineering record (master directive, product spec, system/database/security/GIS/evidence architecture, AI governance, design system, API spec, implementation status, ADRs, test strategy, deployment, data governance, pilot readiness). Requirement classifications are explicit: `IMPLEMENTED` / `PARTIALLY IMPLEMENTED` / `PLANNED` / `REQUIRES GOVERNMENT CONFIRMATION`. Documentation is kept synchronized with the implementation; functionality is never documented that does not exist.

## Security notes

- Supabase URL + anon key are public client identifiers by design; **all access control lives in Postgres RLS policies, guard triggers and security-definer RPCs** (`supabase/migrations/0001_initial_schema.sql`), never in config secrecy
- Role/scope live in `public.profiles` and are admin-writable only; self-elevation is impossible (profile guard trigger + data layer both enforce)
- Audit log is append-only (insert policy exists; no update/delete policy — Postgres denies by default under RLS)
- Community report submissions are rate-limited server-side inside the `submit_community_report` RPC (30/minute global bucket); a report is a concern, never an accusation of guilt
- Evidence bytes sit in a **private** storage bucket; the read policy re-derives role/tenant from `profiles` and joins the metadata row by path before any read

## License

See [LICENSE](./LICENSE).
