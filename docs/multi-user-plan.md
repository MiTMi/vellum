# Vellum multi-user plan

*Drafted 2026-08-08; quotas and open questions resolved with Michael
2026-08-09. Status: **Phase 1 built and verified locally 2026-08-09**
(schema, invite-code sign-up, per-user scoping, quotas, isolation test
suite, owner CLI tools) — awaiting the two-push deploy + migration below.*

## Phase 1 deploy runbook (two pushes, backfill between)

1. **Push A** — schema only (additive `ownerId`, new tables, indexes).
   Zero behavior change; Vercel deploys it.
2. `npx convex export --path backup-pre-tenancy.zip --include-file-storage`
   — the rollback artifact, per the migration runbook in CLAUDE.md.
3. **Push B** — the scoped functions, invite auth, quotas, client.
4. Immediately: `npx convex run admin:backfillOwnerBatch '{}' --prod` in a
   loop until `{done: true}` — stamps every pre-existing row as Michael's.
   (Order note: between push B's deploy and backfill completion Michael's
   client sees an empty workspace for a minute; nothing is lost, and no
   other accounts exist yet. Run the backfill promptly.)
5. Re-run the backfill once more (closes the window for rows written
   mid-deploy), then gate: `admin:migrationGate` must read all zeros, and
   the hosted app must show the full workspace, search, and history.
6. Record the owner userId (`admin:ownerUserId`) for CLI impersonation —
   update the `vellum-auth-setup` and `vellum-progress-note` memories.
7. Only then: `admin:mintInvite` per friend.

**Dev deployment:** `friendly-jellyfish-107` (the frozen pre-migration
copy) gets the scoped functions on its next `npx convex dev` push — and
its rows have no `ownerId`, so signing in there shows an **empty
workspace until its own `backfillOwnerBatch` loop runs**. Not data loss;
by design. `e2e-offline.mjs` needs that push + backfill before it can run
(it calls `admin:ownerUserId`).

Goal (Michael, 2026-08-08): open Vellum beyond a single user — friends and
family first, possibly scale later. This document is the phased path from
today's single-tenant architecture to that goal, with the security work and
migration each phase needs.

## Where we start

The single-user assumption is a design premise, not a flag:

- **Auth** — sign-up is rejected for any address but the `OWNER_EMAIL` env
  var (`convex/auth.ts` `profile()`); `convex/account.ts` reads the same
  var for display and password re-verification.
- **Data** — no ownership column anywhere. `pages`, `pageVersions`,
  `comments` are workspace-global; `pages.syncIndex` hands the entire
  table to any authenticated client, and the offline replica mirrors all
  of it.
- **Functions** — `requireUser(ctx)` answers "is someone signed in", never
  "does this user own this row". (It already *returns* the userId — the
  plumbing exists; nothing consumes it yet.)
- **Conflict policy** — page-level last-writer-wins. Right for one person
  on two devices; lossy for two people in one page.
- **Account deletion** — `wipeEverything` factory-resets the deployment.

None of this blocks the goal; it just defines the order of work.

---

## Phase 1 — Multi-tenant private workspaces

Everyone gets their own isolated Vellum on the existing prod deployment —
like separate Notion accounts. No sharing between users yet. This phase is
the security-critical one: after it, a bug isn't "my data is odd", it's
"my sister sees my pages".

### Auth

- Replace the `OWNER_EMAIL` check in `profile()` with **invite codes**: an
  `invites` table (code, optional email lock, redeemedBy, expiresAt).
  Sign-up requires a valid unredeemed code; fail closed when the table is
  empty. Keeps growth friends-and-family without an approval queue.
- Keep the password policy exactly as is.
- `account.ts`: `me` returns the signed-in user's own email from the
  `users` table (not the env var); `changePassword`/`deleteAccount`
  re-verify against the *user's* email. Touch ID (per-device keychain)
  carries over unchanged.
- New: a tiny admin surface for Michael to mint codes (CLI-only at first:
  an `internalMutation` driven by `npx convex run`).

### Schema

- `ownerId: v.id("users")` on `pages`, `pageVersions`, `comments`.
  Optional during migration, treated as required by all code afterwards.
- Indexes: `pages.by_owner`, and `by_owner_parent` replacing `by_parent`
  where listing happens; `pageVersions`/`comments` keep their `by_page`
  index (ownership checked through the page).
- Search index gains `filterFields: ["ownerId"]` — full-text search must
  filter server-side, not post-hoc.
- `publicSlug` stays globally unique (published links are cross-tenant by
  nature). `clientKey` lookups add an ownership check.

### Function scoping (the heart of it)

- New helper in `convex/lib/auth.ts`:
  `getOwnedPage(ctx, id)` → fetches the page, throws unless
  `page.ownerId === userId`. **Every** mutation/query that takes a page id
  goes through it — one choke point, like `wrapVaultMutations`.
- List-shaped queries (`list`, `syncIndex`, `trashed`, `search`,
  `backlinks`, `getMany`) filter by `by_owner` / search filter field.
- `bootstrap` seeds per user (first login of each account gets the welcome
  page). `emptyTrash`, `wipeEverything` scope to the caller's rows only —
  account deletion stops being a deployment reset.
- AI (`convex/ai.ts`): retrieval already goes through `search` (inherits
  scoping). Add per-user daily rate limits (counter table) — the
  OpenRouter key is shared and paid by Michael.
- File storage: upload URLs are already per-request; stored file URLs are
  unguessable but not ownership-checked on read. Acceptable for Phase 1
  (same model as published-page slugs); revisit if scaling.

### Quotas (decided 2026-08-09)

Michael's account (`OWNER_EMAIL`) is exempt from every quota — the env
var's meaning changes from "the only allowed account" to "the unlimited
account". Everyone else:

- **File storage: 50 MB per user.** New `files` table (storageId, ownerId,
  size, pageId?) written by the upload path; the upload mutation refuses
  once the user's total would pass 50 MB, with a clear "storage full"
  error (client shows usage; deleting files frees space). Hard block, no
  soft-degrade. Existing image compression makes 50 MB generous.
- **Database: 2,000 pages per user** (protects the shared ~0.5 GiB DB
  storage; search storage follows automatically).
- **AI: $0.10 per user per calendar month, and a $0.85/month global pool
  for all non-owner users combined.** `aiUsage` table accumulates the
  actual cost OpenRouter reports per call; both checks run before each
  call; exhausted budget → friendly refusal until the 1st. Known
  tradeoff: the pool is first-come-first-served within a month.
- **No per-user bandwidth/function-call metering** — instead a small
  owner-only usage overview (per-user storage, page count, AI spend) so
  Michael can spot problems.

**Free-tier ceiling, faced deliberately** (numbers from Michael's Convex
pricing screenshot, 2026-08-09): included on Free & Starter — 0.5 GB
database storage, 1 GB file storage, 0.5 GB search storage, 1 GB database
I/O, 3,000 query-GBs search, 1 GB data egress. At 50 MB/user file quota,
the included 1 GB fits **~15–20 active users**. Decision: stay on the
free tier and let invite codes cap growth.

Two refinements from the actual pricing sheet:

- **Overage is cents, not a $25 cliff.** Additional file storage is
  $0.033/GB and database $0.22/GB — so if growth ever passes the included
  amounts, adding a card (Starter, usage-based) costs pennies per month.
  Convex Pro only matters much later. This de-risks the whole plan.
- **The tightest resource is likely data egress (1 GB/mo), not storage** —
  every device hydrates a full offline replica and re-downloads images.
  Cheap to exceed ($0.132/GB) but worth watching on the owner usage
  overview once real users join.

### Client

Almost nothing: the login screen re-enables sign-up with an invite-code
field; "this workspace belongs to someone else" copy goes away. The
offline replica needs no changes — the server simply never returns rows
that aren't yours. Per-device state (visits, view tabs, vault session)
is naturally per-user already.

### Migration (one-time, ordered)

1. Deploy schema with optional `ownerId` (additive, safe).
2. `internalMutation` backfill: stamp every existing row with Michael's
   userId (batched, cursor loop — same shape as `rewriteHostBatch`).
3. Deploy the scoped functions (they now require `ownerId`).
4. Gate: row counts per owner, a known page still opens, search returns
   only owned pages, sign-up without invite fails.
5. Only then mint the first invite codes.

Rollback: the export zip taken before step 2, per the migration runbook
in CLAUDE.md.

### Security tests (must exist before invites go out)

- convex-test with **two identities**: user B cannot `get`, `rename`,
  `move`, `trash`, `duplicate`, `search`-hit, `syncIndex`-see, or comment
  on user A's pages — one test per public function, the same way
  `tests/pages.test.ts` asserts anonymous rejection today.
- Sign-up: invalid/redeemed/missing invite codes all fail closed.
- E2E: two accounts on the dev deployment; assert full isolation of
  sidebar, search, trash, and publish lists.

**Estimated effort:** 2–3 sessions (one for schema+scoping+migration, one
for auth/invites+tests, buffer for the security pass). Frontend work is
minimal.

---

## Phase 2 — Sharing & permissions

What makes multi-user *useful* for a family rather than just hosted:

- `shares` table: pageId (subtree root), userId, role (`viewer`/`editor`).
- Invite-by-email UI on the Share menu (which already exists for publish).
- Read/write paths honor shares: `getOwnedPage` grows into
  `getAccessiblePage(ctx, id, needed: "read" | "write")`, walking to the
  shared root. Sync index unions "owned + shared-with-me".
- Sidebar "Shared" section; Library gets a **Shared tab and a Created-by
  column** (this is where that Notion column earns its place).
- `@`-mentions of people, page-level activity ("edited by Dana, 2h ago"
  in the top bar) — `updatedBy` on writes.
- Vault explicitly excluded from sharing, ever.
- Conflict story stays page-level LWW **plus** the existing version
  history as the safety net; acceptable while co-editing is rare.

**Estimated effort:** 3–5 sessions. Design decisions (subtree semantics,
role granularity) deserve their own review before starting.

## Phase 3 — Real-time co-editing

Only needed once two people actually live in the same pages: BlockNote
has first-class Yjs collaboration, and Convex can carry the sync (or
Convex's own components for presence). Replaces page-level LWW with CRDT
merging *for shared pages only*; solo pages keep the current, simpler
offline path. Presence cursors, avatars. Hardest phase, most deferrable.

**Estimated effort:** unknown until Phase 2 is real; likely the largest.

---

## Operational reality (before the first invite)

- **Convex tier**: prod is on the free plan — check limits (function
  calls, storage, bandwidth) against ~5–10 users; the paid tier is the
  likely landing spot. Same question for Vercel.
- **AI budget**: shared OpenRouter key → per-user rate limits are part of
  Phase 1, not optional.
- **Backups**: `npx convex export` stops being "my data" and becomes
  everyone's — schedule it (cron) rather than ad-hoc.
- **Trust boundary honesty**: server-side data is readable by the
  deployment owner (Michael). Fine for family; say it plainly somewhere.
  The Vault is the exception — that guarantee already holds per-user.

## Open questions for Michael

1. ~~Invite codes or manual account creation?~~ **Answered 2026-08-09:
   invite codes.**
2. Is Phase 1 (separate private workspaces) valuable on its own for your
   first users, or is sharing (Phase 2) the actual point — i.e., should
   Phase 2 design start immediately after Phase 1 ships?
3. ~~Budget comfort for paid tiers?~~ **Answered 2026-08-09: stay
   free-tier, invite codes cap growth (~15–20 users); revisit Pro only if
   it takes off. AI quotas: $0.10/user/mo, $0.85/mo global non-owner
   pool, owner unlimited.**
4. Custom domain before inviting people, or is vellum-gilt.vercel.app fine?
