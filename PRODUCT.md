# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Open decision — do not assume one.** Michael has deliberately not settled
who Vellum is for. The evidence points two ways and both readings are
currently true of the code:

- it behaves as a personal workspace (one owner, the owner's account is
  quota-exempt and admin, `OWNER_EMAIL` is a per-deployment env var);
- it also has real multi-tenancy — invite-gated sign-up, per-user quotas,
  subtree sharing with viewer/editor roles, and public legal pages.

What is confirmed: today there is one owner (Michael) and sign-up is
invite-only, so every other account exists because he issued a code.
Future work must not invent an audience, write copy that implies a
customer base, or design onboarding for a persona that has not been
agreed. When a surface needs an audience decision, ask.

## Product Purpose

A Notion-style workspace — pages, rich-text blocks, and databases with
table/board/calendar/gallery/timeline views — that runs against a Convex
deployment its owner controls. It works fully offline and syncs when it
reconnects, and it runs both in the browser (PWA, installable) and as a
native macOS app against the same workspace.

Success is that it is genuinely usable as the owner's daily writing and
note-keeping tool, not a demo of one.

## Positioning

**A vault the operator cannot read.** Vellum's `vault: true` subtree is
end-to-end encrypted with a key derived from a passphrase that never
leaves the device: titles are `venc1:` strings, content is an AES-GCM
envelope, and the server stores ciphertext it has no way to open. The
guarantee is *enforced server-side rather than promised* — search fields
are forced empty for vault pages, publishing throws, `move`/`duplicate`
fence the boundary, the AI retrieval path filters vault rows out, and
uploads into the vault are refused because file bytes would bypass the
encryption.

That is the claim a neighbouring product (Notion, Craft, Obsidian Sync)
could not truthfully copy: not "we respect your privacy" and not
"encrypted at rest", but a region of the workspace whose operator,
server, and AI provider all see nothing but ciphertext.

## Operating Context

- Two Convex deployments, both EU West: prod is the system of record and
  serves `vellum-gilt.vercel.app`; dev holds a frozen pre-migration copy
  and is the rollback target.
- Four build entries from one `dist/`: the marketing landing page at `/`,
  the workspace at `/app`, the Help Center at `/help`, and the legal
  pages at `/legal`.
- The same bundle must resolve from Electron's `file://`, from the Vercel
  origin, and from the PWA's offline shell.
- The workspace is used online and offline; the offline case is ordinary
  use, not an error path.

## Capabilities and Constraints

**BINDING SCOPE CONSTRAINT — the workspace app's UI and UX are frozen.**
Michael's instruction, verbatim in intent: *the app must preserve 100% of
its current UI design and UX; design changes may happen only on the
landing page.* This governs every future design task. Concretely:

- Everything served at `/app` — `src/components/`, `src/styles`, the
  editor, sidebar, databases, modals, command palette, vault views — is
  off limits to design work. Do not restyle, re-space, recolor,
  re-typeset, animate, or "polish" it.
- The landing page (`index.html`, `src/landing/`) is the only surface
  open to design change.
- The Help Center and legal pages *extend the landing stylesheet*
  (`help.ts` imports `landing.css` before `help.css`). A landing restyle
  therefore restyles them too — that coupling is real and must be
  accounted for before touching landing tokens, or confirmed with
  Michael first.
- Functional and correctness work inside the app is unaffected by this
  constraint; it restricts *design*, not engineering.

Confirmed functionality: block editor (BlockNote with custom page-link,
mention, equation, callout, TOC, embed and bookmark blocks); databases
with saved views, compound filters, relations, rollups and formulas;
E2E-encrypted Vault; offline-first replica with a durable outbox;
publish-to-web via unguessable slugs; subtree sharing (viewer/editor);
AI writing assistant, AI database columns, and a workspace agent that
proposes additive-only plans the user applies; page history; comments;
Markdown/HTML/CSV/PDF export and Markdown/HTML import; full-text search;
command palette; templates; Library index; PWA offline shell; Touch ID
sign-in in the Mac app.

Constraints: sign-up is invite-gated; quotas are 2,000 pages and 50 MB of
files per user with an AI spend cap, and the owner account is exempt; no
databases, uploads, comments, or cross-boundary mentions inside the
Vault; page history and comments are online-only by design.

## Brand Commitments

- **Name:** Vellum. Author: Michael Touboul. MIT licensed.
- **The existing "ink on vellum" landing identity is the incumbent
  authority**, not a starting point to be discarded without a decision:
  warm paper-white ground, near-black ink, one vermilion accent used as
  rubrication (pilcrows, eyebrows, the caret, primary buttons), Newsreader
  for display and Inter for text, both bundled via `@fontsource` and never
  from a CDN. Any replacement of that world is a decision for Michael, not
  an assumption.
- **Privacy claims must stay literally true.** The privacy policy names
  real processors (Convex EU, OpenRouter, Tavily and its query retention,
  the 90-day web audit log) and states the operator-can-read boundary
  outside the Vault. No marketing copy may outrun what the code enforces.
- Current landing voice is plain and declarative — "Write it down. Keep it
  forever." / "One quiet place for everything you write." Quiet, not
  salesy.

## Evidence on Hand

- Real, shipped product at `vellum-gilt.vercel.app`; source at
  `github.com/MiTMi/vellum`.
- Committed product screenshots in `src/landing/assets/`, regenerated by
  `scripts/capture-landing.mjs` against a **mock-mode** server so they can
  never contain real notes.
- 21 Help Center guides whose claims are themselves tested by
  `scripts/e2e-guide-*.mjs`.
- Design docs in `docs/`: `ai-agent-design.md`, `multi-user-plan.md`,
  `phase2-sharing-design.md`.
- **Absences future work must not fabricate:** there are no customers,
  testimonials, case studies, press mentions, user counts, benchmarks, or
  pricing. Nothing is for sale. Do not invent social proof.

## Product Principles

1. **The vault guarantee is structural, not stated.** Where a privacy
   claim is made, the server must enforce it — and where it can't yet
   (file bytes), the feature is refused rather than quietly weakened.
2. **Offline is ordinary, not degraded.** Reads come from the local
   replica and writes queue durably. A feature that genuinely needs the
   network hides its affordance rather than failing on click.
3. **Say only what is true.** Claims in copy, guides and policy are
   held to what the code does; the guides have tests for exactly this
   reason.
4. **The workspace is finished; the front door is not.** Effort goes to
   how Vellum is explained and introduced, not to restyling what already
   works.
5. **One owner's data, in one place they control.** Deployment, keys and
   licence all sit with the person running it.
