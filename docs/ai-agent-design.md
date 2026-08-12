# AI workspace agent — design (v1: propose, then apply; additive only)

*Drafted 2026-08-12 for review before code. Decisions taken with Michael
2026-08-12: the agent **proposes a plan the user applies with one click**
(never writes autonomously), and its powers are **additive only** —
create pages/databases, add rows, append content. It can never move,
overwrite, or delete anything; the worst case is an unwanted new page
you trash.*

*Status: **built as designed 2026-08-12** (commit 8475de4) and
live-verified on dev and prod — the real flash-lite model followed the
JSON protocol first try. As-built summary in CLAUDE.md's AI section.*

Goal: the chat panel stops being answer-only. "Set up a meal-planning
database with columns for day and recipe, and add this week" produces a
plan card; Apply makes it real, instantly, through the same mutations
every other edit uses.

## Architecture: server plans, client applies

The existing "Create a slide deck" flow is the template — `deckOutline`
returns structure, the panel maps it onto blocks and writes through
DataApi mutations. The agent generalizes it:

- **Server** (`ai.agent` action): runs the reasoning + a bounded
  read-tool loop, returns `{ answer, plan, sources }`. Never writes.
- **Client** (AiChatPanel): renders the plan as a card; **Apply**
  executes each op through the ordinary DataApi mutations — so writes
  hit the replica instantly, queue in the outbox, sync like any other
  edit, and inherit every Phase 1/2 authorization check at the real
  choke points. The agent gets no new write path to audit.

## Server: the agent loop

`ai.agent({ messages, pageId?, persona? })`, capped at **4 model calls**
per request (each through `meteredChat` — the existing per-user budget
applies unchanged). The model speaks a JSON protocol (prompt-engineered,
like deckOutline's fixed markdown shape — not provider function-calling,
which the guardrail/model pair may not support): each round it returns
either one read tool call or the final answer.

Read tools (owner-scoped, vault/trash-filtered):

- `search(query)` → `_retrieve` (the search index, as in `ask`)
- `read(pageId)` → a **read-scoped variant of `_rowForFill`** that
  allows viewer-role shared pages. `_rowForFill` returns null for
  viewers because a *fill* can't be written back — but reading is
  exactly what a viewer may do, so the agent (and, same fix, the chat
  context chip in `converse`, which inherited the gap) must not
  silently drop a shared page's content.

Final round returns `{ reply, plan? }`, requested with a **raised
`maxTokens`** — a 20-op plan carrying markdown blows through the cap
that suits chat replies. The plan is validated server-side before
returning — unknown op kinds, out-of-range refs, or more than **20
ops** reject the whole plan (the reply still comes back, with a note
that the plan was malformed).

Protocol robustness: markdown fences are stripped before JSON parsing
(flash-lite loves wrapping JSON), and a malformed *intermediate* tool
round degrades to treating that text as the final reply with no plan —
never an error for the whole request.

## The plan schema (the entire agent vocabulary)

```ts
type AgentOp =
  | { kind: "createPage";     title: string; icon?: string;
      parent: "current" | "root" | Ref;   markdown?: string }
  | { kind: "createDatabase"; title: string; icon?: string;
      parent: "current" | "root";
      columns: { name: string;
                 type: "text"|"number"|"select"|"multiSelect"
                      |"date"|"checkbox"|"url";
                 options?: string[] }[] }
  | { kind: "addRow";         target: Ref | PageId; title: string;
      props?: Record<string, string | number | boolean | string[]> }
  | { kind: "appendToPage";   target: "current" | PageId;
      markdown: string };
type Ref = `#${number}`; // an earlier op in the same plan, e.g. "#0"
```

Four ops, all additive. No update, no move, no trash — not "hidden for
v1" but absent from the vocabulary, so no prompt injection can reach
them. `appendToPage` only ever appends blocks after existing content.

## Client: the plan card and the executor

- The assistant bubble renders `answer`, then a **plan card**: one
  plain-language line per op ("Create database *Meals* with 3 columns",
  "Add 7 rows"), with **Apply** and **Dismiss**. Dismiss just collapses
  the card; nothing was written.
- Apply runs the executor (`src/lib/agentPlan.ts`, pure + unit-tested):
  ops in order, resolving `#n` refs to created ids, through
  `mutations.create` / `updateDbProps` / `updateContent`.
  Select/multiSelect values auto-mint option ids, reusing existing
  options by name.
- **`addRow` against an existing database**: the plan's `props` are
  keyed by column *name*, but stored row props are keyed by prop *id*.
  The executor reads the target's `dbProps` from the replica, verifies
  the target is `type: "database"` (else the op fails with a reason),
  and resolves names → ids case-insensitively; a name with no matching
  column is **skipped** (the row still lands) rather than failing the
  op. Databases created earlier in the same plan use the ids the
  executor just minted.
- Markdown → blocks via a small pure converter (headings, bullets,
  numbered lists, checkboxes, paragraphs) — the deck mapper, promoted to
  a tested helper and reused by both.
- **appendToPage** first dispatches `vellum:flush-edits` (the same
  mechanism the id-remap path uses) so debounced editor changes reach
  the replica, then reads the target and writes `existing blocks + new
  blocks`. If the target is mounted, the refresh goes through
  `getActiveEditorFor(pageId)` — BlockNote never re-reads the replica
  once mounted (the HistoryModal restore rule), and the chat panel
  can't reach PageView's remount state from outside.
- Guards at apply time (belt to the server's suspenders): targets that
  are vault, viewer-role, trashed, or missing from the replica disable
  Apply with a reason. The mutations themselves are the final authority.
- After apply, a confirmation message with source chips linking to what
  was created (same affordance as the deck flow).

## Cost, availability, safety

- Worst case per agent request: 4 metered calls ≈ today's chat turn ×4;
  the existing $0.10/user/month budget and pool apply unchanged. No new
  quota machinery.
- Offline / mock: `useAi().available` gates the surface as today; mock
  mode returns a deterministic canned plan so e2e can click Apply and
  assert real pages appear.
- Vault: read tools already refuse vault pages; the executor skips vault
  targets; nothing changes about the encryption story.
- Prompt injection from page content is contained by construction: the
  model can only emit the four additive ops, the user sees the plan
  before anything runs, and every write passes the normal auth checks.

## Tests

- `tests/agentPlan.test.ts` — plan validation (server) + executor
  mapping and markdown→blocks (client helper), pure unit tests.
- `tests/ai.test.ts` grows agent cases with stubbed fetch: tool-loop
  round-trip, malformed plan rejected, cap enforcement, vault refusal.
- `scripts/e2e-ai.mjs` grows a plan-card scene in mock mode: ask →
  card renders → Apply → the promised page/database/rows exist.

## Out of scope for v1 (deliberately)

Editing or restructuring existing content (beyond append); moving or
deleting anything; auto-apply; agent actions on shared pages beyond
what the role already permits at the mutation layer; scheduled or
background agent runs.

**Estimated effort:** 1–2 sessions — one for the server action + plan
schema + unit tests, one for the plan card, executor, and e2e.
