<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Architecture

Vellum is a Notion-style personal workspace: React 19 + Vite, BlockNote
editor, Convex backend, wrapped in Electron for macOS. Everything is one
`pages` table — docs, databases, and rows alike (`convex/schema.ts`).

### Data layer (three modes)

All components go through the `DataApi` interface in `src/data/api.ts` —
never through Convex hooks directly. `src/data/index.ts` picks the
implementation:

- **`offline.ts` (default)** — local replica + outbox synced to Convex.
  The app works fully offline; see below.
- **`real.ts`** (`VITE_DIRECT_CONVEX=1`) — direct Convex queries/mutations,
  no offline support. Escape hatch / debugging.
- **`mock.ts`** (`VITE_MOCK_CONVEX=1`) — in-memory + localStorage, no
  backend. Used by the Playwright e2e scripts. Its page-history sidecar is
  the one sanctioned exception to "edit the reducer, not the wrappers":
  history is a read-only projection that never feeds back into page state.

### Offline sync layer (`src/offline/`)

Local-first: reads always come from an in-memory replica of all pages
(persisted to IndexedDB); writes apply to the replica instantly and queue
in a durable outbox, replayed FIFO against Convex on reconnect.

- `store.ts` — the replica + the single reducer for all page mutations
  (mock mode reuses it; keep the two backends behaviorally identical by
  editing the reducer, not the wrappers).
- `outbox.ts` — durable write queue. Coalesces consecutive absolute-value
  ops per page, but never across order-sensitive ops (create/trash/…) and
  never into the op currently being replayed — both are correctness rules,
  not optimizations.
- `sync.ts` — sync engine: hydration, outbox drain, temp-id → real-id
  remapping, reconcile against the `pages.syncIndex` query. Reconcile only
  runs when the outbox is empty.
- Conflict policy: page-level last-writer-wins via `contentUpdatedAt` /
  `clientUpdatedAt` (see `updateContent`/`rename` in `convex/pages.ts`).
  Offline creates are idempotent via `clientKey`.

Invariants to preserve when touching `convex/pages.ts`:

- Every page-patching mutation must bump `updatedAt` (reconcile diffs on it)
  and null-guard a missing page (replayed ops race deletes).
- Ops replayed from the outbox must be absolute-valued (e.g. the
  `toggleFavorite` / `setTemplate` `value` arg), never relative.
- **Every new `pages` field must also be added to `createWithDoc`'s args.**
  `toCreatePayload` sends the whole doc and the validator rejects unknown
  fields, so a missed field makes offline-created pages fail replay forever.
- `store.remapId` must rewrite temp ids everywhere they can hide, not just
  `parentId`: `pageLink` block props, relation values inside `props`, and
  `dbProps[].targetId`. Missing one leaves the replica pointing at a dead
  temp id after the create syncs (the server side is already covered by
  `mapIdsDeep`).

### Editor (`src/components/Editor.tsx`)

BlockNote with custom block specs registered on one shared `schema`:

- `pageLink` (`PageLinkBlock.tsx`) — inline link to another page. Inserted
  via the `/` menu ("Sub-page"/"Database") and the `@` mention menu ("Link
  to page"). Stores only `pageId`; title/icon are looked up live from the
  page registry.
- `callout` (`CalloutBlock.tsx`) — tinted box with an emoji + color popover.
- `toc` (`TocBlock.tsx`) — auto-updating table of contents; reads heading
  blocks via `editor.onChange` and scrolls to `[data-id]` targets.
- `bookmark` (`BookmarkBlock.tsx`) — Notion-style web bookmark card. All
  state lives in block props, so it persists through the normal
  `updateContent` path (no schema change, no outbox op). Metadata comes from
  the `linkPreview.fetchMeta` action — the renderer can't fetch other origins
  — but the card never depends on it: a failed/offline fetch still renders a
  hostname card with a retry.

Custom blocks render outside the main React tree and **can't use React
context** — they reach the app through module-level registries
(`pageRegistry.ts`, `editorRegistry.ts`, `linkPreviewRegistry.ts`).

Two `SuggestionMenuController`s (`/` and `@`) share
`suggestionMenuFloatingOptions` — custom floating-UI middleware enforcing a
min menu height so the popover flips above the caret near the viewport
bottom instead of clipping. Keep the `@floating-ui/react` dependency pinned
to the version BlockNote resolves.

### Backlinks

`extractPageLinks` (`convex/lib/pageLinks.ts`) is shared by the server
`pages.backlinks` query (direct mode) and the client replica hooks
(`storeHooks.ts`, offline/mock modes) so both agree on what counts as a
link. `PageView.tsx` renders the "Linked mentions" section from it.

### Databases (`src/components/database/`)

Four views off one `activeView` field: table, board, calendar, gallery.
`BoardView`/`GalleryView` share card rendering via `CardProps.tsx`. Filters,
sorts and search are local-only (`lib/dbviews.ts` + localStorage).

`relation` properties store an **array of row page-ids** in `props`, with the
target database on `dbProp.targetId`. `targetId` is `v.string()`, not
`v.id("pages")` — offline clients hold temp ids until their create replays,
and `dbProps` rides through `createWithDoc`. Chips resolve titles live from
the page index, so renames propagate and deleted targets just drop out.

### Templates

`isTemplate` marks a page as a template: `usePagesIndex` pulls those roots
out of the tree into `index.templates` (their children stay in `children` so
the subtree still renders). Instantiating is `duplicate` with
`{ asInstance: true }` — clears the flag on the root copy only.

### Page history

Server-side snapshots in a separate `pageVersions` table, captured by
`updateContent` before it overwrites (throttled by
`convex/lib/versions.ts`, pruned to `MAX_VERSIONS_PER_PAGE`). Deliberately
outside the replica: no sync-index entry, no reconcile, no outbox op — so
it's online-only, like Notion's. `HistoryModal.tsx` restores through the
ordinary `updateContent` mutation, which makes the restore itself undoable.

Restoring must also repaint the open editor via
`getActiveEditorFor(pageId)`. BlockNote owns its document once mounted and
never re-reads the replica, so persisting alone leaves stale text on screen
*and* lets the editor's next debounced save undo the restore.

Because offline mode has no `ConvexProvider`, server-only reads (history,
link previews) are plain callbacks through `convexClient()` — never
`useQuery`. See `useVersionHistory` / `useLinkPreview` in `src/data/`.

### Command palette

`QuickSwitcher.tsx` (⌘K) mixes page search/create with an Actions section
(new page/database, theme toggle, open trash, new-from-template). Actions are
plain rows with a `run()` callback.

## Commands

- `npm run dev` — convex + vite + electron. `npm run dev:web` — no electron.
- `npx vitest run` — all tests: Convex function tests (`tests/pages.test.ts`,
  convex-test), pure-helper tests (`tests/linkMeta.test.ts`) and
  offline-layer unit/integration tests (`tests/offline/`).
- `npm run build` — typecheck + vite build.
- `node scripts/e2e*.mjs` — Playwright UI suites against a mock-mode vite
  server on port 5199 (`VITE_MOCK_CONVEX=1 npx vite --port 5199`).
  The scripts default to `/opt/pw-browsers/chromium`; set `CHROMIUM_PATH` if
  your Playwright browsers live elsewhere (e.g.
  `~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/…`).
- `node scripts/e2e-offline.mjs` — offline-sync e2e against the REAL dev
  deployment (vite on port 5201, no mock flag; push functions first with
  `npx convex dev --once`).

**The dev deployment in `.env.local` contains real user data.** Anything
that writes to it (e2e-offline, ad-hoc scripts) must create uniquely-named
pages and delete them afterwards; `e2e-offline.mjs` does this in its
`finally` block.
