# MineGuard Liberia

**National mining oversight, safety, compliance, environmental monitoring & intelligence platform.**

> Not an official Government of Liberia system. Designed for potential government adoption — no government approval, partnership, seal, dataset or statistic is claimed or implied.

MineGuard Liberia gives authorized oversight personnel a unified platform for the mining-site registry, field inspections, incident management, the compliance chain (inspection → finding → corrective action → verification), environmental observations, community reporting with public tracking, an explainable site-risk engine, and a national GIS map. Field operations are **offline-first**: submissions are persisted on-device before any network attempt and sync with idempotent dedupe.

Built with React 19 + Vite + TypeScript, a **Papery** editorial design system (paper `#F0EEE6`, ink accents, serif hierarchy), and **Google Firebase** (Firestore, Authentication, Cloud Storage) with security rules as the server-side authorization boundary.

---

## Features

| Area | What it does |
|------|--------------|
| Command Center | Live statistics computed from real data — never hardcoded |
| Mining-site registry | Admin-authored sites with codes (`MGL-<COUNTY>-0001`), status lifecycle, explainable risk scores |
| Field inspections | Configurable templates, GPS capture with accuracy, draft → review → approve/reject lifecycle |
| Offline queue | localStorage drafts + submission queue for inspections, incidents and environmental observations; auto-sync on reconnect; server-side `clientRef` dedupe; nothing silently dropped |
| Evidence | Photo/video/audio/document attachments (≤25MB) on inspections with thumbnails, captions and access-controlled downloads |
| Incidents | Configurable types (fatality, injury, near-miss, environmental, …), severity, status workflow |
| Environment | Observations with explicit verification states: observed / measured / verified / unverified / alleged |
| Community reports | Public submission (no account), tracking code, human triage workflow — a report is never an automatic accusation |
| Audit log | Append-only trail of every consequential action, visible in-app |
| Access control | 4 roles (admin / supervisor / inspector / operator), geographic scope, operator tenant isolation — enforced by Firestore rules *and* re-derived per call |
| PWA | Installable, offline app shell, theme-colored, maskable icons |

## Quick start

```bash
bun install          # or npm install / pnpm install
bun run dev          # local dev server on :5173
bun run typecheck    # tsc -b --noEmit
bun test             # run the automated test suite (bun:test)
bun run build        # typecheck + production build to dist/
```

### Firebase setup (one-time, project owner)

1. Create a Firebase project, then **Firestore Database** (Build → Firestore Database)
2. Enable **Email/Password** and **Anonymous** sign-in (Build → Authentication)
3. Publish `firestore.rules` into Firestore → Rules, and `storage.rules` into Storage → Rules (or `npx firebase deploy --only firestore:rules,storage`)
4. Set the web config in `src/lib/firebase.ts`
5. First email account to complete a staff profile becomes the **administrator** (one-time bootstrap, guarded by `meta/hasStaff`)

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
    firebase.ts        Firebase init (Auth, Firestore, Storage)
    backend.ts         Data layer: the whole API surface, authz re-derived per call
    backend-react.ts   Convex-style useQuery/useMutation hooks over Firestore
    types.ts           Domain types + client-side authorization mirror
    compat-types.ts    Id<T>/Doc<T> compatibility shims
    offline-queue.ts   Field queue: local persistence, retry, idempotent sync
  pages/               Landing, Auth, Portal (Command Center, Sites, Map,
                       Inspections, Incidents, Environment, Community, Audit)
  components/ui/       shadcn/ui primitives
firestore.rules        Server-side authorization (authoritative)
storage.rules          Evidence media rules
docs/00–16             Full engineering documentation set
scripts/               Icon generator (dev-only)
```

## Documentation

The `docs/` directory is the authoritative engineering record (master directive, product spec, system/database/security/GIS/evidence architecture, AI governance, design system, API spec, implementation status, ADRs, test strategy, deployment, data governance, pilot readiness). Requirement classifications are explicit: `IMPLEMENTED` / `PARTIALLY IMPLEMENTED` / `PLANNED` / `REQUIRES GOVERNMENT CONFIRMATION`. Documentation is kept synchronized with the implementation; functionality is never documented that does not exist.

## Security notes

- Firebase web config is a public client identifier by design; **all access control lives in the security rules**, never in config secrecy
- Role/scope live in `/users/{uid}` and are admin-writable only; self-elevation is impossible (rules + data layer both enforce)
- Audit log is append-only (create permitted, update/delete denied)
- Community report submissions are rate-guarded at the rule level; a report is a concern, never an accusation of guilt

## License

See [LICENSE](./LICENSE).
