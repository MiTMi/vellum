# Phase 2 design — sharing & permissions (core sharing first)

*Drafted 2026-08-11 for review before any code. Decisions taken with
Michael 2026-08-11: roles are **Viewer + Editor** only; **core sharing
first** (no people-mentions, no "edited by X" activity — those follow in
a later pass once sharing is proven); staying on vellum-gilt.vercel.app.*

Goal: a user can share a page — meaning that page **and its whole
subtree** — with another account on the deployment, as read-only
(viewer) or read-write (editor). Shared pages appear in the recipient's
sidebar under a "Shared" section, sync into their offline replica, and
disappear everywhere when the share is revoked.

## Schema (purely additive — no migration, no backfill)

```ts
shares: defineTable({
  pageId: v.id("pages"),        // the subtree root being shared
  ownerId: v.id("users"),       // denormalized page owner (the sharer)
  userId: v.id("users"),        // the recipient
  role: v.union(v.literal("viewer"), v.literal("editor")),
  createdAt: v.number(),
})
  .index("by_page", ["pageId"])
  .index("by_user", ["userId"])
  .index("by_page_user", ["pageId", "userId"]) // upsert/remove lookups
```

One row per (page, recipient). Sharing the same page twice updates the
role. Overlapping shares (an ancestor and a descendant both shared with
the same person) are legal; the **highest role along the ancestor chain
wins**.

No other schema changes. `pages` is untouched — a share never moves,
copies, or re-stamps ownership. The parent-ownership invariant (a
subtree is single-owner) is what makes subtree sharing sound: granting
access at a root grants a subtree that provably belongs to one person.

## Access resolution (the heart of it)

`convex/lib/auth.ts` gains one function, the Phase-2 analogue of
`readOwnedPage`/`writeOwnedPage`:

```ts
getAccessiblePage(ctx, userId, id, need: "read" | "write")
  → { page, role: "owner" | "editor" | "viewer" } | null
```

- Owner (`page.ownerId === userId`) → full access, exactly as today.
- Otherwise walk the parent chain (same bounded walk as `pathTo`,
  guard-capped) collecting `by_page_user` share hits; best role wins.
- **Vault pages are never accessible to non-owners**, full stop —
  checked on the *target* page (`page.vault`) before any walk.
- Trashed pages: readable by sharees only via sync (so the replica can
  mark them), never writable.
- `need: "write"` with role `viewer` → **throws "Not authorized"**, the
  same loud failure as `writeOwnedPage`, so the outbox drops the op
  deterministically and isolation tests stay loud. `need: "read"` misses
  return null (indistinguishable from missing — no id probing).

`readOwnedPage`/`writeOwnedPage` stay for owner-only paths; functions
that gain sharing switch to `getAccessiblePage` explicitly. Nothing
changes by default — **every function is owner-only until deliberately
opened**, so the Phase 1 security posture is the baseline, not the
exception.

### What each role may do

| Capability | Viewer | Editor | Owner only |
|---|---|---|---|
| `get`, `getMany`, sync pull (within the shared subtree) | ✓ | ✓ | |
| `updateContent`, `rename`, `setIcon`, `setCover`, `setPageOptions` | | ✓ | |
| `setRowProp`, `updateDbProps`, `setViews`, `setView` | | ✓ | |
| `create` / `createWithDoc` **inside** the shared subtree | | ✓ | |
| `duplicate`, `move`, `trash`, `restore`, `deleteForever` | | | ✓ |
| `toggleFavorite`, `setTemplate` (stored on the page row = the owner's data) | | | ✓ |
| `setPublished`, share management, history restore | | | ✓ |
| AI `transform` on selection (client-side text, no page access needed) | ✓ | ✓ | |
| AI `fillProperty` (writes a row prop) | | ✓ | |

Notes on the sharp edges:

- **Creates inside a shared subtree**: the new page is stamped with the
  *parent's* `ownerId` (preserving the subtree invariant), and counts
  against the **owner's** 2,000-page quota. The sharee's `clientKey`
  idempotency lookup must therefore check *accessibility*, not
  ownership, or offline creates in shared subtrees would fail replay.
- **Editors cannot move or trash** — including pages they created. v1
  simplification; "delete a row I just added" arrives with the
  follow-up pass if it stings in practice. The owner can always trash.
- **Favorites/templates stay owner-only** because both live as flags on
  the page row itself — a sharee toggling them would write the owner's
  data. Per-user favorites of shared pages need a side table; deferred.
- **File uploads** by an editor count against the *uploader's* 50 MB
  quota (the `files` table already stamps the uploader).
- **Search**: server `pages.search` stays owner-scoped — the search
  index filters by `ownerId` and cannot see shares. In offline mode
  (the default), ⌘K search runs against the local replica, which
  includes shared pages, so sharees still find them by title/content.
  Server-side shared search is a follow-up.
- **Backlinks stay scoped to the caller's own workspace**: `backlinks`
  iterates the caller's pages, so a sharee sees their own links to a
  shared page, never the owner's. Unchanged from today; noted so the
  table above isn't misread as cross-workspace.
- **`duplicate` stays owner-only.** Duplicating a shared subtree into
  the sharee's workspace would mean re-stamping ownership on a copy —
  quota target, vault fencing, and relation `targetId`s pointing back
  into the owner's workspace all need answers. Deferred.
- **Comments and page history for sharees are deferred** with the
  people-awareness pass — both need author attribution to make sense.
- **`search`, `list`, `trashed`, `emptyTrash`, `wipeUser`** stay
  owner-scoped exactly as they are.

## Sync (how shared pages reach the recipient)

`syncIndex` returns the union of:

1. all owned pages (today's behavior), and
2. for each `shares.by_user` row: the shared root plus its subtree
   (`by_parent` BFS — safe without per-row checks because the subtree is
   single-owner), **excluding vault pages** defensively, each entry
   carrying `role: "viewer" | "editor"`.

- The per-row `role` rides on the index entry (not the page doc), so a
  role change or revocation is visible on the next reconcile **without
  touching any page's `updatedAt`**. Reconcile's staleness check must
  compare **`(updatedAt, role)`, not `updatedAt` alone** — otherwise a
  role change never re-pulls. Absence means deletion — which makes
  **revocation automatic**: rows vanish from the index, the replica
  deletes them locally. No push notification needed.
- `getMany` switches to `getAccessiblePage(read)` so the pull path can
  fetch shared docs; foreign-and-unshared ids still silently drop.
  Since `role` is viewer-relative (not stored on the page), `getMany`
  must **compute and stamp `role` on each returned doc**, which is what
  the replica persists.
- The replica stores `role` on each cached doc. The client disables
  editing chrome for `viewer` (same read-only rendering path as
  `locked` pages) and hides owner-only menu items for both roles.
- **LWW stays page-level.** Two editors in one page → last writer wins,
  version history is the safety net (owner can restore). Documented,
  accepted; real merging is Phase 3.
- A viewer's client never queues writes (UI is read-only), but a
  *stale* client whose role was downgraded might: the server's loud
  throw makes the outbox drop the op — same recovery as Phase 1's
  foreign-write story. Rare, self-healing, an accepted edge.

## Client

- **Share menu** (`TopBar.tsx` `SharePopover`): a "People" section above
  "Share to web": email input + role picker → `shares.add`; list of
  current shares with role dropdown and remove. Lookup is **exact email
  match only** (no autocomplete/enumeration; "no account with that
  email" is acceptable to reveal at family scale). Server-only, like
  publish: `useShares()` goes through `convexClient()`, reports
  `available: false` offline. Vault pages: section replaced by the same
  "can't be shared" note publish shows.
- **Sidebar**: a "Shared" section listing shared *roots* — pages whose
  doc carries a `role` (usePagesIndex already skips orphan-parented
  pages, so today they'd be invisible; the new section is where they
  root). Subtrees expand normally under them. Library gets a Shared tab
  reading the same set (Created-by column deferred to the
  people-awareness pass).
- **Breadcrumbs/`pathTo`** naturally stop at the shared root (its
  parent isn't in the replica) — correct behavior for free.
- **TemplatePrompt is hidden on shared pages** (any doc carrying a
  `role`): it applies templates by composing `duplicate` per child,
  which is owner-only — an editor on a blank shared page would hit a
  throwing path.
- **Direct mode (`real.ts`, `VITE_DIRECT_CONVEX=1`) won't show the
  Shared section** — its list comes from owner-scoped `pages.list`,
  and the Shared sidebar is fed by the replica. Deliberate gap in the
  debugging escape hatch, not a bug.
- **Mock mode**: `mock.ts` seeds a second fake user + one shared
  subtree so e2e can drive the UI without a backend.

## Server API surface (new `convex/shares.ts`)

- `add({pageId, email, role})` — owner-only, rejects vault pages,
  rejects self, rejects unknown email, upserts by `by_page_user`.
- `remove({pageId, userId})`, `setRole({pageId, userId, role})` — owner-only.
- `listForPage({pageId})` — owner-only (emails of recipients).
- `listSharedWithMe({})` — the recipient's share list (for the Library
  Shared tab; sidebar reads the replica instead).

## Security tests (gate before shipping — extends `tests/isolation.test.ts`)

Three identities now: owner A, sharee B, stranger C.

- B with **viewer**: can `get`/`getMany`/sync-see the subtree; every
  write mutation throws; C still sees nothing (all Phase 1 assertions
  re-run unchanged).
- B with **editor**: content writes succeed *inside* the subtree; a
  create inside inherits A's ownerId; `move`/`trash`/`setPublished`/
  share management still throw; writes *outside* the subtree throw.
- **Vault**: sharing a vault page is refused; a share on an ancestor of
  the vault root does **not** expose vault pages through sync or `get`.
- **Revocation**: after `remove`, B's reads return null, writes throw,
  and `syncIndex` no longer lists the subtree.
- **Move-out**: A moves a page out of the shared subtree → B loses
  access to it on the next check (the ancestor walk finds no share).
- Role downgrade editor→viewer: previously legal write now throws.
- `clientKey` replay by B of a create inside A's subtree stays
  idempotent (no duplicate rows).

## Rollout

0. New `convex/shares.ts` must be added to the `import.meta.glob` list
   in `tests/pages.test.ts`, or convex-test can't resolve it (standing
   rule from CLAUDE.md — noted here so it isn't rediscovered as a
   mystery failure).
1. Schema push (additive `shares` table) — zero behavior change.
2. Functions + client in one push (no data migration, so no two-push
   dance needed; the Phase 1 runbook's backfill machinery is not
   involved). Dev first, full test suite + new isolation cases green,
   then prod via normal Vercel deploy.
3. Smoke on prod with a second real account (mint an invite for a test
   account of Michael's own) before telling anyone.

Estimated effort: 2–3 sessions — one for schema + `getAccessiblePage` +
scoped functions + tests, one for sync + client UI, buffer for the e2e
pass and prod smoke.

## Deferred to the people-awareness pass (explicitly out of scope now)

@-mentions of people; "edited by X" activity and `updatedBy` stamps;
comments and page history for sharees; Created-by column; per-user
favorites on shared pages; server-side search across shared pages;
editor rights to trash pages they created; editor `duplicate` of shared
pages into their own workspace; share notifications.
