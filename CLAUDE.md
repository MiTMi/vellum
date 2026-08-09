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
editor, Convex backend, wrapped in Electron for macOS, and hosted on Vercel.
Everything is one `pages` table — docs, databases, and rows alike
(`convex/schema.ts`).

### Three build entries

The Vite build has **three HTML entries** (`rollupOptions.input` in
`vite.config.ts`), and confusing them is the most common way to break things:

- **`app.html`** — the workspace (`#root` + `src/main.tsx`). This is the old
  `index.html`; it was renamed, not deleted. Served at `/app` in production
  (Vercel `cleanUrls`), at `/app.html` on the dev server, and loaded directly
  by Electron via `loadFile(dist/app.html)`.
- **`index.html`** — the marketing landing page at `/`. Plain semantic HTML
  plus `src/landing/{landing.css,landing.ts}`; no React, so `/` stays small.
- **`help.html`** — the Help Center at `/help`. Same shape as the landing
  page and *extends* its stylesheet rather than restating it (see below).

`vite.config.ts`'s dev middleware maps both clean URLs (`/app`, `/help`) to
their `.html` files, and the PWA plugin's `CANONICAL` map precaches them under
those same clean URLs — a new HTML entry must be added to **both** or it will
404 in dev and break the offline shell in production.

`public/` is copied to `dist/` verbatim and holds the PWA manifest, the
`icons/` set and `favicon.png` (all generated from `build/icon.png` with
`sips`). All three HTML entries reference them **relatively**
(`./favicon.png`), so the same markup resolves under Electron's `file://` as
well as over http.

Consequences to remember:

- **Every Playwright script that drives the workspace must navigate to
  `${BASE}/app.html`**, not the server root — the root is the landing page now.
  `scripts/e2e-landing.mjs` is the one suite that deliberately hits `/`.
- `base: "./"` stays. One `dist/` has to resolve from Electron's `file://`,
  from `/`, from `/app.html` and from `/app`. The only broken case is `/app/`,
  which `trailingSlash: false` in `vercel.json` rules out, and a dev-server
  middleware in `vite.config.ts` mirrors for local work.
- Block anchors need no special handling: `anchorUrl()` builds from
  `origin + pathname`, so it picks up whichever entry is loaded.

### Deployments and env files

Two Convex deployments, both in EU West, in the same `vellum` project:

- **prod `gregarious-schnauzer-219`** — **the system of record.** Serves the
  hosted app at `vellum-gilt.vercel.app` and any packaged Mac app. Ad-hoc CLI
  calls against the real workspace need `--prod`:
  `npx convex run pages:list '{}' --identity '{"subject":"owner|cli"}' --prod`.
- **dev `friendly-jellyfish-107`** — `.env.local` (gitignored), used by
  `npm run dev` / `npm run dev:web`. Since the migration this holds a **frozen
  pre-migration copy**, not live data: safe to experiment in, and edits here
  never reach the real workspace. It is also the rollback target — point
  `.env.production` back at it and rebuild.

A deployment's **region can never be changed**. Production was first
provisioned in US East by `npx convex deploy`; fixing it meant deleting that
deployment and running `npx convex deployment create production --type prod
--region eu --default`. Never pass `--select` to that command — it rewrites
`.env.local`.

`.env.production` is **checked in** (deployment URLs are public, not secrets).
Vite loads `.env` → `.env.local` → `.env.[mode]`, so in build mode
`.env.production` wins: **every `vite build` — `npm run build`, `npm run dist`,
and Vercel — targets prod.** Only the dev server still uses `.env.local`. On
Vercel the build command passes `--cmd-url-env-var-name VITE_CONVEX_URL`, and
a real `VITE_*` process env var overrides the file, so there the deploy key is
the source of truth for which backend the frontend talks to.

Published links are minted from **`VITE_PUBLIC_SITE_URL`** (the Vercel origin;
`vercel.json` proxies `/p/*` through to Convex, so shared links live on the
app's own domain), falling back to `VITE_CONVEX_SITE_URL`.

That extra variable is not redundant — **do not collapse it back**.
`npx convex deploy --cmd` injects *both* `VITE_CONVEX_URL` and
`VITE_CONVEX_SITE_URL` into the build environment, derived from the deployment.
A real process env var outranks `.env.production` in Vite, so anything written
there under the Convex name works in every local build and is silently reverted
on every Vercel build. `tests/publicUrl.test.ts` guards this. Whichever
variable is used, it must be Vercel's stable alias, never a per-deployment URL.

### Hosting (Vercel)

`vellum-gilt.vercel.app`, auto-deploying from `main`. Config lives in
`vercel.json` and in the Vercel project settings:

- **Build command** (overridden in the dashboard, not in `package.json`):
  `npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name VITE_CONVEX_URL`.
  Convex functions are pushed *first*, then the frontend is built against the
  deployment that was just pushed to — so the two can't drift.
- **`CONVEX_DEPLOY_KEY`** is set on the **Production environment only**. This
  is a security boundary, not tidiness: a preview branch holding a production
  key would push its functions and schema straight into prod.
- **Deploy keys need index-creation rights** (learned 2026-08-09): the
  original key lacked `deployment:data:view`, so any deploy that had to
  **create an index** (which reads data to backfill it) failed on Vercel,
  while field-only schema changes and function pushes sailed through — the
  multi-tenancy migration was completed via a local `npx convex deploy`
  (full admin; `expect` TTY wrapper) + `npx vercel redeploy`. **Fixed
  2026-08-09**: Michael rotated in a full-permission production key and an
  index-creating deploy was proven green end-to-end. If this error ever
  reappears, the key was likely regenerated too narrow again.
- **Preview builds therefore fail** at the `convex deploy` step — no key, and
  no `.env.local` in CI to fall back on. That is the safe failure. Give Preview
  its own *preview* deploy key if you want them green; Convex spins up throwaway
  preview deployments for those.
- `cleanUrls: true` serves `dist/app.html` at `/app` and 308s `/app.html` → `/app`.
  `trailingSlash: false` kills `/app/`, which is the one URL that would break
  relative asset resolution under `base: "./"`.
- The `/p/:path*` rewrite proxies published pages to the deployment's
  `.convex.site`. Filesystem wins before rewrites, so it can't shadow real files.
- Cache headers: `/assets/*` immutable for a year (content-hashed), `sw.js` and
  the manifest `no-cache` — a cached service worker would pin users to an old
  shell.

Old `…convex.site/p/<slug>` links keep working; Convex serves that route
directly, so proxying is additive rather than a cutover.

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

### Vault (end-to-end encryption)

One `vault: true` subtree whose pages are E2E encrypted: `title` is a
`"venc1:<iv>:<data>"` string, `content` a `{ __venc: 1, iv, data }` envelope
(AES-GCM-256, key = PBKDF2 of a passphrase that never leaves the device).
The vault **root** is exempt — its content is the plaintext `vaultMeta`
(salt + encrypted sentinel) and it renders `VaultView`, not an editor.

Layering (keep these boundaries):

- `src/lib/vaultCrypto.ts` — pure WebCrypto, no app imports, unit-tested.
- `src/lib/vaultSession.ts` — module-level session (like pageRegistry): the
  in-memory key (reload always locks; 15-min idle auto-lock), the vault-id
  set mirrored from the index, and the decrypted-title cache. React
  subscribes via `useVaultVersion()`.
- **Encryption happens only in `wrapVaultMutations`** (`src/data/index.ts`),
  wrapping whichever DataApi impl is active — so editor saves, renames,
  template application and history restore all encrypt at one choke point,
  and mock/offline/real behave identically. Reads stay ciphertext;
  `PageView`'s `VaultPageGate` decrypts per page (and refuses to mount an
  editor over content it couldn't decrypt — a save would clobber it).
- The server re-derives everything it enforces: `create`/`createWithDoc`
  inherit the flag from the parent, search fields are forced empty for
  vault pages, `setPublished` throws, `move`/`duplicate` fence the boundary
  (root stays movable), and `search` filters `vault` defensively.

Known v1 limits (all deliberate): no databases inside the vault, no
moving pages into/out of it (old plaintext history would leak; create
inside instead), no comments, no cross-boundary mentions, trashed vault
pages list as "Locked page", and `pageVersions` snapshots are ciphertext
(HistoryModal decrypts, and must keep decrypting before restore or the
wrapper would double-encrypt).

Leak checklist when touching UI that shows titles: go through
`displayTitle()` from vaultSession (breadcrumbs, trash, exports, registry
in `App.tsx`) and exclude vault pages from recents/⌘K/mention pickers.

### Image upload compression

`useFileUpload` in `src/data/index.ts` runs every upload through
`maybeCompressImage` (`src/lib/imageCompress.ts`): raster images get
downscaled to ≤1600px long edge and re-encoded as WebP q0.8 (~5–40×
smaller); GIFs/SVGs/non-images and already-small files pass through, and
any failure falls back to the original file. Decision helpers are pure and
unit-tested; the end-to-end path is covered by `e2e-vault.mjs` (paste).

### Multi-tenancy (Phase 1, 2026-08-09 — docs/multi-user-plan.md)

Every workspace row (`pages`, `pageVersions`, `comments`) carries an
`ownerId`, and **every function scopes to the signed-in user** through the
choke points in `convex/lib/auth.ts`:

- `readOwnedPage` — null for missing AND foreign (reads can't probe ids);
  `writeOwnedPage` — null for missing, **throws "Not authorized"** for
  foreign (isolation tests assert loudly; the outbox drops the op);
  `pagesOf` — the `by_owner` index behind every list-shaped query.
- **Parent-ownership invariant:** create/createWithDoc/move/duplicate all
  reject foreign parents, so a subtree is single-owner and the `by_parent`
  walks need no per-row checks. `tests/isolation.test.ts` pins all of this
  — two users, every function attacked with the other's ids. Keep it green
  before anything ships.
- Search (and AI `_retrieve`) filter via the search index's
  `filterFields: ["ownerId"]`. Internal functions taking client-supplied
  ids (`_rowForFill`, `_retrieve`) take and enforce `userId`.
- `ownerId` is stamped server-side only; `createWithDoc` accepts-and-drops
  a client-sent one (same treatment as `publicSlug`).

**Quotas** (`convex/lib/quotas.ts`; the OWNER_EMAIL account is exempt):
50 MB files per user (enforced in `files.getFileUrl`, which returns a
`{url, error}` object rather than throwing — **a throwing mutation would
roll back the `storage.delete` reclaiming the refused file**); 2,000
pages; AI $0.10/user/month + $0.85/month non-owner pool, metered in
`ai.meteredChat` from OpenRouter's `usage.cost` (requested via
`usage: {include: true}`; conservative estimate + console.warn when
absent). Known v1 limitation: `files` rows are never reclaimed when pages
are deleted — quota counts lifetime uploads.

**Owner CLI tools** (`convex/admin.ts`, all internal — unreachable from
clients): `mintInvite`, `listInvites`, `usageOverview`,
`backfillOwnerBatch` (migration; loop until `{done: true}`),
`migrationGate` (all-zeros before minting invites), `ownerUserId`.

**CLI impersonation changed:** `--identity '{"subject":"owner|cli"}'` now
reads as a user with no pages. Resolve the real id first
(`npx convex run admin:ownerUserId '{}' --prod`) and use
`'{"subject":"<thatId>|cli"}'`. `scripts/e2e-offline.mjs` does exactly
this.

**Tests** use real `users` rows (`tests/helpers.ts`): identities are
`${userId}|session` because functions compare `Id<"users">` — a made-up
subject fails id validation. `process.env.OWNER_EMAIL` is set by helpers.

### Auth

Convex Auth with a single Password provider (`convex/auth.ts`). Sign-up
is **invite-code gated** (Phase 1): the code rides the sign-up form as a
transient `inviteCode` user field (declared on the overridden `users`
table) and is validated + redeemed in `callbacks.afterUserCreatedOrUpdated`
— transactional with user creation, so a bad code aborts the sign-up and a
raced code admits exactly one account. The logic lives in
`convex/lib/invites.ts` (the callback isn't reachable from convex-test).
`OWNER_EMAIL` no longer gates sign-in; it now marks the account that is
quota-exempt, invite-exempt, and admin. Password policy runs in
`authorize` *before* any write, so a weak password can't burn a code.
Account deletion (`account.wipeUser`) erases one user's data; the owner is
refused while other accounts exist, and factory-resets when alone.

`OWNER_EMAIL`, `SITE_URL`, `JWT_PRIVATE_KEY` and `JWKS` are **per-deployment**
env vars, so a new deployment needs all four before anyone can sign in. The dev
set was written by `npx @convex-dev/auth`; prod's were generated with the
`jose` snippet from the Convex Auth docs and set via `--from-file` (see the
CLI gotchas below). `SITE_URL` must be the hosted origin, not `.convex.site`.

- **Every public function in `convex/` must start with
  `await requireUser(ctx)`** (`convex/lib/auth.ts`). The convex-test suites
  bind an identity with `.withIdentity({ subject: "owner|test" })`;
  `tests/pages.test.ts` has a regression test asserting anonymous calls are
  rejected.
- **Password policy** (2026-08-05): `convex/lib/passwordPolicy.ts` — 12+
  chars with lower/upper/digit/symbol — is shared by the server (wired as
  the Password provider's `validatePasswordRequirements`, which Convex Auth
  runs on **signUp/reset flows only, never signIn** — the existing owner
  password keeps working) and by the login screen's live checklist, so the
  UI can't drift from what the server enforces. `tests/passwordPolicy.test.ts`.
- **Login screen** (redesigned 2026-08-05): split layout — a constant
  ink-dark brand panel echoing the landing identity (Newsreader serif,
  loaded in the *app* entry via `@fontsource` imports in `Auth.tsx`) beside
  a form pane that follows the app theme. The sign-up flow disables submit
  until the checklist passes and the confirm field matches. Selector
  contract: `e2e-offline.mjs` pins `.login-card`, `input[name=email]`,
  `input[name=password]`, `.login-submit`; `e2e-landing.mjs` accepts
  `.login-screen` — keep all of them through any restyle.
- Client wiring is `ConvexAuthProvider` + `AuthGate` (`main.tsx`,
  `src/components/Auth.tsx`). Offline rule: a machine with a prior session
  (localStorage `vellum:hasSession`) may open its local replica while
  unauthenticated, but the sync engine's transport stays gated —
  `setSyncAuthorized` in `src/offline/runtime.ts` — because `drainOutbox`
  treats server rejections as deterministic and would otherwise DROP queued
  edits while logged out. Mock mode bypasses auth entirely.
- Ad-hoc/scripted calls need an impersonated identity (any subject works;
  the CLI already holds the admin key):
  `npx convex run pages:list '{}' --identity '{"subject": "owner|cli"}'`.
  `scripts/e2e-offline.mjs` uses exactly this for its server-side checks
  and cleanup, and signs into the real UI with `VELLUM_E2E_PASSWORD`
  (email defaults to the deployment's `OWNER_EMAIL`).

### Settings & account management (2026-08-05)

`SettingsModal.tsx` (sidebar gear, ⌘, or the ⌘K "Settings" action):
Account (email, change password), Security (sign out everywhere, Touch ID
credential removal, Vault lock), Appearance (theme), and a danger zone
(delete account + erase workspace). Server side is `convex/account.ts`:

- Every credentialed operation re-verifies the password with
  `retrieveAccount` — the same scrypt check `signIn` uses — so an open
  session alone can't change or destroy the account. Wrong passwords
  surface as a readable ConvexError.
- `changePassword` also runs `assertPasswordPolicy` (a change can't weaken
  the sign-up policy) and the client re-seals Touch ID credentials after a
  successful change so the biometric button doesn't go stale.
- `deleteAccount` → `wipeEverything` (**must stay `internalMutation`**):
  one transaction deleting pages, pageVersions, comments, every `_storage`
  file, and all auth tables — after it, the deployment is factory-fresh
  and the sign-up flow works again. The client then clears the Touch ID
  keychain entry, the session flag, and the IndexedDB replica.
- Account calls flow through `useAccount()` on the DataApi (offline mode:
  `convexClient()` + connected gate; mock: `available: false`, Settings
  shows a demo note and hides the auth-provider-dependent sections — they
  can't mount without `ConvexAuthProvider`).
- `scripts/e2e-settings.mjs` covers the UI; `wipeEverything` and
  `account.me` are convex-tested. The changePassword failure path can be
  exercised non-destructively against prod:
  `npx convex run account:changePassword '{"currentPassword":"wrong…","newPassword":"…"}' --identity '{"subject":"owner|cli"}' --prod`
  must throw "current password is incorrect" and change nothing.

### Editor (`src/components/Editor.tsx`)

BlockNote with custom block specs registered on one shared `schema`:

- `pageLink` (`PageLinkBlock.tsx`) — *block-level* link to another page,
  inserted by the `/` menu's "Sub-page"/"Database" items. Stores only
  `pageId`; title/icon are looked up live from the page registry.
- `pageMention` (`PageMentionInline.tsx`) — the `@` menu's *inline* chip
  (custom inline content, not a block), so a mention sits mid-sentence.
  Note `createReactInlineContentSpec` returns the spec itself, unlike
  `createReactBlockSpec`, which returns a factory.
- `equation` (`EquationBlock.tsx`) — KaTeX display math; LaTeX lives in
  block props.
- `callout` (`CalloutBlock.tsx`) — tinted box with an emoji + color popover.
- `toc` (`TocBlock.tsx`) — auto-updating table of contents; reads heading
  blocks via `editor.onChange` and scrolls to `[data-id]` targets.
- `embed` (`EmbedBlock.tsx`) — live iframe player for YouTube, Vimeo, Loom,
  Spotify, Figma, CodePen, Google Drive/Maps, or any framable URL. The
  URL→iframe-src resolution is a pure helper (`src/lib/embeds.ts`, tested in
  `tests/embeds.test.ts`) — add providers there, not in the component.
  BlockNote's built-in `video` block renders a raw `<video>` element and
  therefore *cannot* play provider URLs; that's why this block exists. The
  iframe is sandboxed and the original URL always stays reachable in the
  footer, because sites that refuse framing render blank with no detectable
  error. Note the slash menu ranks title matches above alias-only ones
  (`getSlashItems`) — without that, BlockNote's "File" item (whose aliases
  include "embed") wins the Enter key on `/embed`.
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

Two overlays float over the editor rather than injecting DOM into
ProseMirror (fragile): `CodeCopyOverlay` (copy code, block's top-right) and
`BlockAnchorOverlay` ("Copy link to block", right-hand margin). **Keep the
anchor button out of the left gutter** — BlockNote's drag handle and "+" sit
there and swallow the click.

### Backlinks

`extractPageLinks` (`convex/lib/pageLinks.ts`) is shared by the server
`pages.backlinks` query (direct mode) and the client replica hooks
(`storeHooks.ts`, offline/mock modes) so both agree on what counts as a
link. It walks `PAGE_REF_TYPES` — exported from the same file and reused by
`store.ts`'s `rewriteContentIds`, so a new reference type can't be taught to
one and forgotten in the other. `PageView.tsx` renders the "Linked mentions"
section from it.

### Block anchor links

"Copy link to block" yields `…#/page/<pageId>/block/<blockId>` — a URL hash,
not a custom scheme, so the same string works in the browser build and in
Electron. `App.tsx` parses it on load and on `hashchange`, navigates, then
`scrollToBlock` polls for the target (the editor mounts asynchronously) and
flashes it. See `src/lib/anchors.ts`.

### Databases (`src/components/database/`)

**Saved views** (2026-08-08): a database carries `views: DbView[]` — each
view is a named tab with its own layout (`kind`: table/board/calendar/
gallery/timeline), compound filter, multi-sort, and grouping config. The
whole array syncs via the absolute-valued `setViews` mutation (coalesces in
the outbox like `updateDbProps`). `BoardView`/`GalleryView` share card
rendering via `CardProps.tsx`.

- **Legacy derivation:** a database with no `views` renders five derived
  tabs (ids `__table`…) seeded from `activeView`/`boardGroupBy`/`calendarBy`
  and any pre-saved-views localStorage filter/sort (`derivedViews` in
  `lib/dbviews.ts`). The first view-config edit materializes the array;
  after that the legacy trio is a **read-only fallback — never dual-write
  it**. Mock-mode seeds still use `activeView` and need no migration.
- **Filters** are compound: one `FilterGroup` per view — a single And/Or
  over rules plus at most **one** level of nested groups, the cap the
  schema validator enforces (Convex validators can't recurse). Every
  property type filters; evaluation is client-side (`matchFilterGroup`).
  **Relation filters are presence-only on purpose**: page ids inside
  `views` would need temp-id remapping (`store.remapId` doesn't walk it).
  A rule with an unfilled operand matches everything, so adding a filter
  never blanks the view. Text/number operands commit on blur/Enter — every
  commit is a synced mutation.
- **Per-device, not synced:** the selected tab (`activeViewId`),
  collapsed table groups, and the in-database search term
  (`loadViewState`, which must default any newly added key: state
  persisted by an older build won't have it).

`relation` properties store an **array of row page-ids** in `props`, with the
target database on `dbProp.targetId`. `targetId` is `v.string()`, not
`v.id("pages")` — offline clients hold temp ids until their create replays,
and `dbProps` rides through `createWithDoc`. Chips resolve titles live from
the page index, so renames propagate and deleted targets just drop out.

Three property types are **computed at render and never stored**:
`createdTime` / `lastEditedTime` (read `_creationTime` / `updatedAt` off the
row) and `rollup` (aggregates a property of the rows reached through a
relation column — see `computeRollup` in `lib/dbviews.ts`). Because they
read the row rather than `props`, `Cell` takes the whole `row` plus its
sibling `dbProps`; rollups additionally need `index.byId`, and unresolvable
ids (deleted row, unsynced temp id) drop out rather than erroring. Adding a
type to `PropType` forces updates in `PROP_TYPE_META`, `Cell`, `CardProps`
and `sortValue` — let the typechecker find them.

Date properties hold **either** a bare `"YYYY-MM-DD"` string (everything
written before ranges existed) **or** `{ start, end }`. Nothing reads the raw
value — go through `parseDateValue` / `makeDateValue` / `formatDateValue` in
`lib/dbviews.ts`, which keeps both shapes interchangeable and means no
migration was needed. `makeDateValue` deliberately stores the narrower
string when there is no end date.

The **timeline** view (`TimelineView.tsx`) is a Gantt chart over that
property; it reads the view's `calendarBy` (same field the calendar layout
uses) rather than adding a second "which date column" field. Undated rows
are listed under the chart instead of being dropped.

**Formula** properties (`formula` on `dbProp`) are computed at render like
rollups — never stored. The language lives in `src/lib/formula.ts`: a
hand-written tokenizer + precedence-climbing parser, deliberately **not**
`eval`/`Function`, because the expression is user input evaluated on every
render. `computeFormula` (`lib/dbviews.ts`) bridges it to a row, flattening
each referenced property to a scalar and passing a `seen` set so two
formulas referencing each other terminate instead of recursing forever.

### Row peek (`PeekModal.tsx`)

Database rows open in a centered overlay rather than navigating. It reuses
`PageView` wholesale and is triggered by a `vellum:peek` window event
(`requestPeek` in `state.tsx`), the same indirection as `vellum:navigate`.

Two editors can therefore be mounted at once. `Editor` unregisters via
`clearActiveEditor(editor)`, which is a no-op unless that editor is still the
active one — an unconditional `setActiveEditor(null)` lets a closing peek
wipe the registration of the page still on screen.

### Templates

`isTemplate` marks a page as a template: `usePagesIndex` pulls those roots
out of the tree into `index.templates` (their children stay in `children` so
the subtree still renders). Instantiating is `duplicate` with
`{ asInstance: true }` — clears the flag on the root copy only.

`TemplatePrompt` in `PageView.tsx` offers templates on an empty page and
applies one by *composing existing mutations* (`updateContent` + `setIcon` /
`setCover` + one `duplicate` per child) — no new mutation, so it works
offline. It must bump the `<Editor>` key afterwards: `initialContent` is
memoized on `page._id`, so a mounted editor won't show content written
underneath it.

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

### Comments

Same shape as page history: its own `comments` table, never mirrored by the
replica, so it stays out of `syncIndex`, reconcile and the outbox. Comment
mutations deliberately **do not bump the page's `updatedAt`** — a comment
isn't an edit, and churning that timestamp would confuse reconcile and LWW.
Offline, `useComments().available` is false; it's also inert for a page whose
id is still a temp id (nothing to attach to server-side yet).

Because offline mode has no `ConvexProvider`, server-only reads (history,
comments, link previews) are plain callbacks through `convexClient()` —
never `useQuery`. See `useVersionHistory` / `useComments` / `useLinkPreview`
in `src/data/`. They're not reactive, so callers refetch after each write.

### Export / import

`src/lib/exporters.ts`, driven from `PageMenu`. Markdown/HTML/CSV export,
Markdown+HTML import, and PDF. They act on the *mounted editor* through
`editorRegistry`, so they only work for the page on screen.

`printableHtml` is the one document template shared by HTML export and PDF —
BlockNote's `blocksToHTMLLossy` emits unstyled semantic HTML, so that
stylesheet is the entire appearance of an exported file. PDF has two paths:
Electron renders it in the main process (`vellum:export-pdf` → hidden window
with `javascript: false` → `printToPDF` → native save dialog), while the
browser build can only hand the same HTML to the print dialog — hence the
distinct `"saved"` vs `"printed"` results.

### Publish to web

`pages.setPublished` mints an unguessable `publicSlug`; the HTTP action at
`/p/<slug>` (`convex/http.ts`) serves that page to anyone, with no auth. It
is the **only** unauthenticated route in the backend, so treat its
invariants as security-critical:

- **The slug is the access control.** Unpublishing clears it (rather than
  setting a flag), which permanently kills the old URL. Publishing an
  already-published page keeps the slug so a double-click can't invalidate a
  link that's been shared.
- `pages.bySlug` is an `internalQuery` precisely because it skips
  `requireUser` — it must stay unreachable from any client.
- A trashed page stops being served even while it holds a slug.
- HTML comes from `convex/lib/publicHtml.ts` (BlockNote can't run
  server-side). Everything is escaped, `href`/`src` are restricted to
  http(s), and **links to other pages render as plain titles, never URLs or
  ids** — a published page must not leak the existence of private ones.
  `tests/publicHtml.test.ts` covers each of those.
- `publicSlug`/`publishedAt` are stripped in `toCreatePayload` *and* accepted
  (then dropped) by `createWithDoc`, so a slug can never ride along on an
  offline create and permanently break that page's replay.

Publishing is server-only, like history and comments: `usePublish()` goes
through `convexClient()` and reports `available: false` while offline.

The URL the user is shown comes from `publicUrlFor()` and points at the Vercel
origin, which proxies `/p/*` back to this action — see "Hosting" above. Convex
still serves `…convex.site/p/<slug>` directly, so links minted before the proxy
existed keep working; the slug is what matters, not the host. The service
worker must never cache either form (a cached page would outlive an unpublish).

### Landing page (`index.html`, `src/landing/`)

Static markup + one stylesheet + ~35 lines of vanilla TS. `landing.ts` only
does three things: swap `[data-cta]` copy to "Open Vellum" when localStorage
`vellum:hasSession` is set (the same flag `Auth.tsx` writes), toggle the nav's
scroll border, and fill the footer year.

Design system (2026-08-05 redesign): "ink on vellum" — warm paper-white
ground, near-black ink, one vermilion accent used as *rubrication* (pilcrows,
eyebrows, the caret, primary buttons). Headlines are Newsreader, bundled the
same way as Inter via `@fontsource-variable/newsreader` imports in
`landing.ts` (never a CDN `<link>` — the PWA precache picks the woff2 files
up from the bundle). The hero is a hand-built fake Vellum document (the
`.sheet`) whose page title *is* the `<h1>`; its load animation, checkbox
ticks and caret are pure CSS and all disabled under
`prefers-reduced-motion`. The e2e suite pins the skeleton — `.hero h1` copy,
6 `.feature` cards, 5 `.deep .row`s, `#features/#vault/#sync/#publish`
anchors, `[data-cta]` hrefs — so structural edits must update
`scripts/e2e-landing.mjs` in the same commit. (`e2e-pwa.mjs` also asserts the
`.hero h1` copy for its offline check; a headline rewrite has to touch that
one too.) The nav and footer both carry a `/help` link — `e2e-help.mjs`
checks the nav one, so don't drop it in a restyle. `assets/hero.png` is currently
unreferenced (the sheet replaced it) but still written by
`capture-landing.mjs`.

### Help Center (`help.html`, `src/help/`)

Nineteen guides covering every feature, at `/help`, linked from the landing
nav and footer. Static markup plus ~90 lines of vanilla TS; **`help.ts`
imports `landing.css` before `help.css`**, so the design system (tokens, nav,
buttons, eyebrows, `kbd`, footer) is inherited rather than duplicated — a
landing restyle restyles the Help Center with it.

- One `<article class="guide" id="…">` per guide; `help.ts` shows exactly one
  at a time from the URL hash, so `/help#formulas` is a real link and the
  back button works. Prev/next footers are **generated from the index order**
  — adding a guide means adding one index link and one article, nothing else.
- Search filters the index against each guide's full text, not just titles.
- `scripts/e2e-help.mjs` pins the skeleton (19 index links ↔ 19 articles, no
  orphans either way, hash routing, search, CTA hrefs), the same way
  `e2e-landing.mjs` pins the landing page.
- **The guides' claims are themselves tested**: `scripts/e2e-guide-*.mjs`
  (basics, writing, organizing, databases, sharing) drive the real UI in mock
  mode and assert each documented step, and `tests/publishFlow.test.ts` covers
  the publish/unpublish lifecycle the sharing guide describes (mock mode can't
  — its `usePublish` returns a slug without storing one). Re-run them after
  changing behaviour the guides describe, or the documentation silently rots.
- `sw.js`'s `offlineFallbackFor` maps `/help` to its own precached entry, so
  the guides are readable offline instead of falling back to the workspace.

Screenshots in `src/landing/assets/` are generated by
`scripts/capture-landing.mjs` against a **mock-mode** server and committed —
mock mode so the shots can never contain real notes. Re-run it when the UI
changes; it seeds its own workspace and needs no arguments.

### PWA (`src/pwa/`)

Hand-rolled service worker, emitted as `dist/sw.js` by the `vellumPWA()`
plugin in `vite.config.ts` (it hashes the shell file list into the cache name
so each build evicts the last). `registerSW()` is called from all three
entries and no-ops unless `import.meta.env.PROD` on an http(s) origin outside
Electron.

`sw.js` has three rules that are correctness, not performance:

- **Cross-origin requests are never touched.** This is what keeps every
  Convex request — websocket, HTTP actions, file storage — off the worker. A
  cached mutation response would be a data-correctness bug.
- **`/p/*` is never cached.** A cached published page could outlive an
  unpublish, which is a privacy leak.
- Non-GET is never cached.

`scripts/e2e-pwa.mjs` asserts all three plus offline boot. It needs a built app
over http, so `vite preview` rather than the dev server — but **preview is not
sufficient**: it serves `/app.html` as a plain 200 where Vercel 308s it, which
is precisely how the offline shell shipped broken once. Re-run with
`E2E_URL=https://vellum-gilt.vercel.app` after deploying.

A second preview-only difference, worth knowing before chasing a phantom bug:
**preview answers `/assets/*` with `Vary: Origin`**, and no cached response can
satisfy that, so a page whose assets are only in the Cache API renders bare
offline. Vercel sends no `Vary` there. The suite sidesteps it by visiting each
entry online before the offline pass.

The precache list is built from the emitted bundle, but the three HTML entries
are mapped to their **canonical URLs** (`/`, `/app` and `/help`) rather than
their filenames. A cached *redirected* response cannot answer a navigation
request (those carry `redirect: "manual"`), so caching `/app.html` behind
`cleanUrls` silently breaks offline boot. Landing screenshots and the
`.ttf`/`.woff` font fallbacks are excluded from the precache and left to the
runtime cache.

`offlineFallbackFor` decides which of those three a failed navigation falls
back to (`/` for the root, `/help` for the guides, `/app` for everything
else). A new entry that isn't taught to it is precached but unreachable
offline — the navigation lands on the workspace shell instead.

### One-off migrations (`convex/migrate.ts`)

`rewriteHostBatch` / `rewriteVersionHostBatch` swap a deployment origin inside
stored `content`, `cover`, `props`, the derived text fields and history
snapshots. `useFileUpload` stores whatever absolute URL `ctx.storage.getUrl()
` returned, so a workspace with uploaded images or covers would strand all of
them when it changes deployment.

Both **must stay `internalMutation`**: they rewrite user data in bulk and must
be unreachable from any client. Driven from the CLI, looping on the returned
cursor. Only changed rows are patched, and those get `updatedAt` +
`contentUpdatedAt` bumped so offline replicas re-pull them.

Two things the 2026-08-04 migration established, worth knowing before trusting
the premise again: the serving URL's last segment is an **internal UUID**, not
the `_storage` id (both survived the import unchanged), and this workspace
turned out to embed **no** file URLs at all — every cover is a `gradient:N`
token — so the rewrite was a 0-row no-op. Check before assuming it's needed:
`grep -c "<old-deployment>" pages/documents.jsonl` in an unzipped export.

### Migrating between deployments

Done once, on 2026-08-04 (dev → prod). The runbook, should it be needed again:

1. Freeze every client — online, signed in, outbox drained. There is no UI for
   this; check `indexedDB.open("vellum-offline")` → `outbox` store count is 0
   in each client's DevTools console (the Mac app has them under View →
   Toggle Developer Tools).
2. `npx convex export --path <zip> --include-file-storage` from the source.
   **Keep this zip** — it and the untouched source deployment are the rollback.
3. `npx convex import <zip> --prod --replace-all -y`. `--replace-all` clears the
   destination first, so scratch data doesn't need separate cleanup.
4. **Gate before anything irreversible:** row counts match, a known page keeps
   its `_id` *and* `updatedAt`, and a known storage id still serves its exact
   byte count. Convex preserved all of these, but verify rather than assume.
5. Run the rewrite mutations above.
6. Auth: the imported `authAccounts` row carries a self-contained scrypt hash,
   so **the same password keeps working and the account need not be recreated**
   — which also keeps Touch ID enrollment valid. Do clear `authSessions`,
   `authRefreshTokens`, `authVerifiers`, `authVerificationCodes` and
   `authRateLimits`, which are signed by / scoped to the source deployment:
   `: > empty.jsonl` then, per table,
   `npx convex import --table <t> --replace -y --format jsonLines empty.jsonl --prod`.
7. Verify on the **hosted** app, not a local build: full tree, trash, database
   property definitions, history, search hits, and images loading from the new
   host.

### Search

`pages.search` and the replica's `useSearch` both build contextual snippets
with `makeSnippet` (`convex/lib/snippet.ts`) — shared for the same reason as
`extractPageLinks`. The snippet is plain text; `QuickSwitcher` wraps matches
in `<mark>` client-side rather than accepting HTML from the server.

### Command palette

`QuickSwitcher.tsx` (⌘K) mixes page search/create with an Actions section
(new page/database, theme toggle, open trash, new-from-template). Actions are
plain rows with a `run()` callback.

### Library (2026-08-08)

Notion-style workspace index at the sidebar's "Library" entry
(`LibraryView.tsx`, `src/lib/library.ts`): tabs Recents / Favorites /
Private / Templates over one table (name, source = parent or "Private",
last edited, last visited). Vault pages (root included) never appear.

- Routes through the ordinary nav with the **sentinel id `__library`**
  (`LIBRARY_ID`), so tabs/history/⌘-nav work unchanged. Anything treating
  `pageId` as a real page must check `isLibraryId` — App.tsx guards the
  disappeared-page fallback and ⌘D; TabBar/TopBar special-case the title.
- **"Last visited" is per-device** (`src/lib/visits.ts`, localStorage,
  capped): recorded on arrival *and on departure* via the App effect's
  cleanup — arrival-only made rows edited while you sat on the page
  outrank the page itself. LibraryView re-snapshots the map in a mount
  effect because that cleanup runs *after* the view's first render.
  `visits.ts` subscribes to `vellum:id-remapped` (the store.remapId
  invariant: temp ids hide everywhere).
- Recents falls back to `updatedAt` for never-visited pages so a fresh
  device isn't empty; unvisited rows show "—".
- Tested by `scripts/e2e-library.mjs`, the library block in
  `e2e-guide-organizing.mjs` (the organizing guide documents it), and
  `tests/library.test.ts`.

### AI (2026-08-07, model + chat panel 2026-08-08)

Three Notion-AI-style features over one model provider (OpenRouter).

**Setup.** The key is a Convex environment variable — *never* a `VITE_*` one.
Vite inlines those into the client bundle, and Vellum ships as a web app and
an Electron bundle, so the key would be readable in DevTools:

```
npx convex env set OPENROUTER_API_KEY "sk-or-v1-…"          # dev
npx convex env set OPENROUTER_API_KEY "sk-or-v1-…" --prod   # live
```

**The model is an env var, and the guardrail must agree.** `OPENROUTER_MODEL`
(Convex env) selects the slug; `DEFAULT_MODEL` in `convex/lib/openrouter.ts`
is only the fallback. The key also carries an OpenRouter **guardrail** with a
model allowlist, and **the two are a matched pair** — asking for a slug the
guardrail doesn't permit 404s every call. This took AI down twice while the
slug lived in code, which is why it moved to an env var: switching models is
now `npx convex env set OPENROUTER_MODEL <slug> --prod`, no deploy. A `:free`
suffix is part of the slug's identity; free and paid variants are separately
allowlisted strings.

Current: `google/gemini-2.5-flash-lite`. Measured against prod on 2026-08-08,
a short grammar fix took **~2.5-5s end-to-end** (~2s of that is `npx convex
run` overhead), against **26-40s** on `nemotron-3-super:free`. The free tier's
queue, not model size, was the bottleneck all along — swapping Ultra for Super
on the free tier changed nothing.

**Guardrail PII redaction rewrites text before the model ever sees it.**
OpenRouter guardrails have a *Sensitive Info* section that redacts matched
spans **on the way in**, replacing them with placeholders. It is not a model
or provider behaviour — verified across both Google endpoints — so no code
change can work around it.

- **`person-name` must stay off.** With it on, "Michael sent it to Sarah"
  comes back as "[PERSON_NAME] sent it to [PERSON_NAME]". In a notes app,
  whose content *is* largely names, that is silent data corruption.
- **`us-ssn` and `credit-card` are deliberately left on** (decided
  2026-08-08). Those genuinely should not reach a third-party model, and
  they are rare in prose.

The cost of keeping those two: a rewrite of text containing one comes back
carrying the placeholder — "card 4111 1111 1111 1111" → "card
[CREDIT_CARD]" — so accepting **Replace selection** would overwrite the real
number. `AiMenu`'s preview card shows the result before anything is applied,
so it is visible rather than silent, but it is the one destructive path.
Generating paths (AI columns, chat) only ever *create* values, so nothing is
lost there. A guard that disables Replace when the result gains a
placeholder the input didn't have was offered and not (yet) built.

`OPENROUTER_PROVIDER` optionally pins upstream providers (comma-separated,
`allow_fallbacks: false`). Unset by default. It exists because OpenRouter
load-balances one model across providers that need not behave identically —
it was added while chasing the redaction above, which turned out to be the
guardrail rather than a provider.

Gemini is not a reasoning model by default, unlike Nemotron, so responses no
longer spend most of their token budget deliberating. `chat()` still returns
only `content` and ignores any `reasoning` fields, which keeps a future
reasoning model from leaking its scratchpad into the UI.

Free-tier limits were 20 req/min and 1,000/day. `chat()` retries 429 and 5xx
three times with exponential backoff, honours `Retry-After`, and does *not*
retry other 4xx (a bad key or a guardrail miss will never succeed, and
retrying just burns the minute budget).

**The three features** (all in `convex/ai.ts`):

- `transform` — the writing assistant. Takes raw text, not a page id: the
  editor operates on a live selection that may not be persisted, and the
  result is applied client-side so the user can discard it. UI is
  `AiMenu.tsx`, a portalled overlay (same technique as `CodeCopyOverlay` /
  `BlockAnchorOverlay` — BlockNote's own chrome is fragile to extend).
  Opens on ⌘J or `/Ask AI`. Results are parsed with
  `tryParseMarkdownToBlocks` so a bulleted answer lands as real blocks.
- `fillProperty` — Notion's AI database properties. `dbProp.type === "ai"`
  with `aiKind` (summary / keyTopics / sentiment / actionItems / custom) and
  `aiPrompt`. Unlike rollup/formula the value **is stored**: each fill is a
  paid round-trip, so it must never re-run on render. Generation is per row,
  on demand, from a button in `AiCell` (`database/Cell.tsx`), and writes
  through the normal `setRowProp` so it syncs through the outbox.
- `ask` — one-shot workspace Q&A with citations. Retrieval uses the
  **existing `search` index**, not embeddings: it is already maintained on
  every write, needs no backfill, and a personal workspace is small enough
  that keyword recall suffices. Swapping in a vector index only changes
  `_retrieve`.
- `converse` + `deckOutline` — the docked chat panel (`AiChatPanel.tsx`),
  opened by the floating bottom-right bubble (`AiLauncher.tsx`) or ⌘⇧J.
  The bubble is the *discoverable* entry point and hides while the panel is
  open; there is deliberately no sidebar row, matching Notion. `converse` is multi-turn and optionally grounded in
  the open page (the composer's context chip) and/or workspace retrieval.
  History is folded into one labelled transcript because the provider takes
  a flat message list. `deckOutline` returns Markdown the panel maps onto
  heading/bullet blocks in a brand-new page.

  The panel is a **sibling of `.main-col`** in `.app`'s flex row, so it
  narrows the page instead of covering it. It replaced an earlier
  `AskAiModal` — the panel does everything the modal did and holds a
  conversation, and two surfaces for one task was clutter. `ask` is kept
  because it is the cheaper primitive and still has tests.

  "Personalize" stores custom instructions in `localStorage`
  (`vellum:ai-persona`) and passes them as `persona`, injected into the
  system prompt. Deliberately not in the schema: it is a per-device
  preference, not workspace data.

**Vault.** AI is absent inside the vault, not merely disabled. `aiAllowed`
in `Editor.tsx` gates the client, `fillProperty` refuses `vault` rows
server-side, and `_retrieve` filters them from Q&A. Vault content is
ciphertext the server cannot read anyway — the guards keep the *shape* of the
guarantee honest rather than relying on that accident.

**Availability.** `useAi().available` is false while offline and true with
deterministic stubs in mock mode (like `useLinkPreview`), so demo mode and
e2e specs exercise the menus without a key or a network call. Every AI call
is a live round-trip, so there is nothing meaningful to queue in the outbox —
the affordances hide themselves rather than failing on click.

**Shortcuts collide if you're careless.** ⌘J (selection menu, `Editor.tsx`)
and ⌘⇧J (chat panel, `App.tsx`) — the editor handler *must* test `!e.shiftKey`,
because `"J".toLowerCase() === "j"` and `preventDefault()` doesn't stop
propagation, so ⌘⇧J would otherwise open both surfaces at once.

**Tests.** `tests/ai.test.ts` (18) stubs `fetch` and covers the guards —
auth, the vault, empty/oversized input, error translation, env-driven model
selection, and that only `content` is ever returned. `scripts/e2e-ai.mjs`
(29 checks) clicks every surface in mock mode: the selection menu, writing
from a blank line, AI database columns, the floating launcher's position and
show/hide, and the panel's multi-turn history, context chip and persona
persistence.
`VITE_MOCK_CONVEX=1 npx vite --port 5241 & E2E_URL=http://localhost:5241 node scripts/e2e-ai.mjs`

## Commands

- `npm run dev` — convex + vite + electron. `npm run dev:web` — no electron.
- `npx vitest run` — all tests: Convex function tests (`tests/pages.test.ts`,
  convex-test), pure-helper tests (`tests/linkMeta.test.ts`,
  `tests/snippet.test.ts`, `tests/dbviews.test.ts`, `tests/publicUrl.test.ts`)
  and offline-layer unit/integration tests (`tests/offline/`). New
  `convex/*.ts` modules must be added to the `import.meta.glob` list in
  `tests/pages.test.ts` or convex-test can't resolve them.
- `npm run build` — typecheck + vite build.
- `node scripts/e2e*.mjs` — Playwright UI suites against a mock-mode vite
  server on port 5199 (`VITE_MOCK_CONVEX=1 npx vite --port 5199`), e.g.
  `e2e-embeds.mjs` (embed block + export menu) and `e2e-dbfeatures.mjs`
  (date ranges, timeline, formulas). They all navigate to `${BASE}/app.html`
  — the server root is the landing page.
  The scripts default to `/opt/pw-browsers/chromium`; set `CHROMIUM_PATH` if
  your Playwright browsers live elsewhere. On this machine the binary is
  `~/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google
  Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` (note:
  not `Chromium.app` — newer Playwright ships Chrome for Testing).
- `node scripts/e2e-vault.mjs` — the E2E-encrypted Vault (same mock server):
  setup, the no-plaintext-at-rest assertion against `vellum:mockdb`,
  lock/unlock, ⌘K exclusion, reload-relocks, and image-paste compression.
- `node scripts/e2e-landing.mjs` — the landing page at `/` (same mock server):
  structure, images, CTA hrefs, the `vellum:hasSession` copy flip, and
  click-through to `/app`. Takes `E2E_URL`, and accepts either the workspace or
  the login screen on arrival, so it doubles as a post-deploy smoke test.
- `node scripts/e2e-help.mjs` — the Help Center at `/help` (same mock server,
  and it also works against a built preview or `E2E_URL`): index ↔ article
  parity, hash routing, search, links back to `/app`.
- `node scripts/e2e-guide-{basics,writing,organizing,databases,sharing}.mjs` —
  the five suites that assert the *content* of the help guides against the
  real UI (mock server; they were written before the guides, not after).
- `node scripts/e2e-pwa.mjs` — service worker + manifest. Needs a **built**
  app over http (`npm run build && npx vite preview --port 5197`), since the
  worker only registers in PROD builds.
- `node scripts/capture-landing.mjs` — regenerates the committed landing
  screenshots. Same mock server on 5199. Run on demand, commit the output.
- `node scripts/electron-pdf-smoke.mjs` — launches the real desktop app,
  stubs the save dialog and invokes the `vellum:export-pdf` handler. Needs
  `npm run build` first.
- **Anything that launches Electron must drop `ELECTRON_RUN_AS_NODE`**: IDE
  terminals (VS Code/Cursor) export it, and it silently makes the Electron
  binary start as plain Node — `require("electron")` returns a path string,
  so every API is `undefined`, and Playwright just says "Process failed to
  launch!". `electron-pdf-smoke.mjs` strips it.
- `node scripts/e2e-offline.mjs` — offline-sync e2e against a real (non-mock)
  deployment; defaults to whatever `.env.local` names, i.e. dev (vite on port
  5201, no mock flag; push functions first with `npx convex dev --once`).
  Sign-in is required: pass the owner's password as `VELLUM_E2E_PASSWORD`.
- **`npx vitest run` reports one failing *file*, `_to_delete/pages.test.ts`.**
  It's a stale copy in a gitignored scratch folder whose `./_generated/api`
  import can't resolve. Pre-existing and unrelated — don't chase it. The real
  count is what matters: all tests in `tests/` pass.

### Convex CLI gotchas

- **`npx convex env list` prints secret values in full**, and multi-line values
  (like `JWT_PRIVATE_KEY`) survive a single-line `grep -v` filter. Print names
  only — `| grep -oE '^[A-Z_]+='` — or you will leak a key into a transcript.
- **Set multi-line secrets with `--from-file`**, never by shell interpolation:
  `npx convex env set JWT_PRIVATE_KEY --from-file key.pem --prod`. It preserves
  PKCS8 newlines byte-exactly (verified by hash), so the dashboard paste that's
  usually recommended isn't necessary.
- **`npx convex deploy` prompts for confirmation** and refuses to run in a
  non-interactive terminal. Piping `y` doesn't help — it checks for a TTY. Wrap
  it: `expect -c 'spawn npx convex deploy; expect -re "push your code.*"; send
  "y\r"; expect eof'`.
- A project has one **default** production deployment; `deployment create
  --default` fails while another holds the slot, and there is no promote
  command. Delete the incumbent from its dashboard settings page first.

### Where the real data lives

**Prod is the system of record; dev holds a frozen pre-migration copy.**
Anything that writes to *either* should still create uniquely-named pages and
delete them afterwards — `e2e-offline.mjs` does this in its `finally` block —
because dev is the rollback artefact and prod is live.

Two verifications proved worthless during this work, both for the same reason:
`vite preview` and a local `vite build` don't reproduce production. Vercel's
`cleanUrls` broke the service worker's offline shell, and `convex deploy`
overrode a `VITE_*` variable — each passed locally and failed once deployed.
**Verify hosted behaviour against the hosted site**, not a local build. Both
new suites take `E2E_URL` for exactly this:
`E2E_URL=https://vellum-gilt.vercel.app node scripts/e2e-pwa.mjs`.
