# Vellum

A personal Notion-style workspace — pages, rich-text blocks, databases with table & board views, offline-first sync to your own [Convex](https://convex.dev) database. Runs in the browser and as a native macOS app, against the same workspace.

![stack](https://img.shields.io/badge/Electron%20%2B%20React%20%2B%20TypeScript%20%2B%20Convex%20%2B%20BlockNote-2b2b2b)

## Use it

**[vellum-gilt.vercel.app](https://vellum-gilt.vercel.app)** — landing page at `/`, workspace at `/app`. Installable as a PWA; the app shell boots offline and opens your local replica.

For a native Mac app, build one with `npm run dist` (see below) — it talks to the same backend, so the two stay in sync.

## Quick start (one time)

```bash
cd vellum
./setup.sh        # installs deps, logs into Convex, provisions your project
```

`setup.sh` opens a browser for the free Convex login and writes `.env.local` with your deployment URL. Everything after that is automatic.

## Daily use

```bash
npm run dev
```

This starts the Convex function watcher, the Vite dev server, and opens the desktop app window. Close the window (or Ctrl-C the terminal) to stop.

### Build a standalone Mac app

```bash
npm run dist      # produces Vellum.app + .dmg in release/
```

The packaged app talks straight to Convex Cloud — no local processes needed.

It bakes in the URLs from the checked-in `.env.production`, which outranks `.env.local` in build mode — so **every `vite build` targets the production deployment**, the same one the hosted app uses. `npm run dev` still uses `.env.local` and the development deployment.

## What's inside

- **Pages** — infinitely nestable, with emoji icons, cover images, favorites, templates, and full-text search (⌘K).
- **Editor** — Notion-style block editor (BlockNote): type `/` for headings, lists, checklists, quotes, code, tables, images, LaTeX equations, callouts, tables of contents, web bookmarks, live embeds (YouTube, Figma, Spotify, …), and Vellum's own **Sub-page** and **Database** blocks. `@`-mention pages inline; copy deep links to any block.
- **Databases** — typed properties (text, number, select, multi-select, date/date-range, checkbox, URL, relation, rollup, formula), with table, board, calendar, gallery, and timeline views. Every row opens as a full page.
- **🔒 The Vault** — an **end-to-end encrypted** subtree: pages inside are sealed on-device with a passphrase-derived key (AES-GCM) before they sync, so the server only ever stores ciphertext. Auto-locks after 15 minutes and on reload. No recovery by design.
- **Offline-first** — a full local replica plus a durable write outbox; the app works with no connection and replays your edits in order when you're back.
- **Publish to web** — one toggle mints an unguessable public link; unpublishing kills it permanently. (Vault pages can never be published.)
- **History & comments** — server-side version snapshots with one-click restore, and per-page comments.
- **Import / export** — Markdown and HTML import; Markdown, HTML, CSV, and PDF export.
- **Native macOS app** — Electron shell with Touch ID sign-in (credentials sealed in the Keychain) and native PDF export.
- **Automatic image compression** — pasted or uploaded images are downscaled and re-encoded as WebP on-device before they hit storage (typically 5–40× smaller).
- **Hardened sign-up** — the owner account requires a 12+ character password with mixed character classes, enforced server-side.
- **Trash** — deleting moves pages (and their subtrees) to trash; restore or delete forever.
- **Dark mode** — toggle in the top bar, follows through the editor and every view.
- **Sidebar** — drag pages to reorder or nest, resize the sidebar, collapse it (⌘\).

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘K | Search / quick switcher |
| ⌘N | New page |
| ⌘\\ | Toggle sidebar |
| `/` in editor | Insert block menu |

## Architecture

```
electron/          main process (window, external-link handling)
convex/            schema + server functions (pages, files) & unit tests
src/
  data/            data layer: real Convex client + in-memory mock (demo mode)
  components/      sidebar/tree, editor, database views, pickers, modals
  hooks, lib       page index, block text extraction, colors, ranks
scripts/           Playwright E2E suites + Electron smoke test
```

Everything is a **page**: documents, databases, and database rows share one Convex table. A `database` page carries its property schema (`dbProps`); its children are its rows; rows keep property values in `props` and still have full editor content. The sidebar tree, breadcrumbs, and search are driven by one live `pages.list` query, so every change syncs instantly across windows.

Images and cover uploads go to Convex file storage via `generateUploadUrl`.

## Demo mode (no Convex needed)

```bash
VITE_MOCK_CONVEX=1 npx vite
```

runs the whole UI against an in-memory store persisted to localStorage — handy for trying the app offline. The test suites run against this mode.

## Tests

```bash
npx vitest run tests/pages.test.ts     # backend functions (in-memory Convex)
VITE_MOCK_CONVEX=1 npx vite --port 5199 # in one terminal
node scripts/e2e.mjs                    # full UI drive (Playwright)
node scripts/e2e-blocks.mjs             # editor blocks: tables, sub-pages, images
```

## Switching machines / backups

Your data lives in your Convex deployment. To use Vellum on another Mac, copy the project folder (or clone it), run `./setup.sh`, and log into the same Convex account/project. The Convex dashboard (`npx convex dashboard`) gives you a full data browser and one-click exports.
