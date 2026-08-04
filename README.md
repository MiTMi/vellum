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

- **Pages** — infinitely nestable, with emoji icons, cover images (gradients or your own uploads), favorites, and full-text search (⌘K).
- **Editor** — Notion-style block editor (BlockNote): type `/` for headings, lists, checklists, quotes, code, tables, images, and Vellum's own **Sub-page** and **Database** blocks. Drag handles, nesting, markdown shortcuts — all included.
- **Databases** — typed properties (text, number, select, multi-select, date, checkbox, URL), editable table view with column resize/sort, kanban board grouped by any select property with drag-and-drop, and every row opens as a full page with a property panel.
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
