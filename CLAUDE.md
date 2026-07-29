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
  backend. Used by the Playwright e2e scripts.

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
  `toggleFavorite` `value` arg), never relative.

## Commands

- `npm run dev` — convex + vite + electron. `npm run dev:web` — no electron.
- `npx vitest run` — all tests: Convex function tests (`tests/pages.test.ts`,
  convex-test) and offline-layer unit/integration tests (`tests/offline/`).
- `npm run build` — typecheck + vite build.
- `node scripts/e2e*.mjs` — Playwright UI suites against a mock-mode vite
  server on port 5199 (`VITE_MOCK_CONVEX=1 npx vite --port 5199`).
- `node scripts/e2e-offline.mjs` — offline-sync e2e against the REAL dev
  deployment (vite on port 5201, no mock flag; push functions first with
  `npx convex dev --once`).

**The dev deployment in `.env.local` contains real user data.** Anything
that writes to it (e2e-offline, ad-hoc scripts) must create uniquely-named
pages and delete them afterwards; `e2e-offline.mjs` does this in its
`finally` block.
