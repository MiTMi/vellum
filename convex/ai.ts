import {
  ActionCtx,
  action,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { getAccessiblePage, isOwnerUser, requireUser } from "./lib/auth";
import { chat, aiModel } from "./lib/openrouter";
import {
  AI_POOL_MONTHLY_MICRO_USD,
  AI_USER_MONTHLY_MICRO_USD,
  aiSpend,
  monthKey,
} from "./lib/quotas";
import { AgentOp, parseAgentJson, validatePlan } from "./lib/agentPlan";
import { fetchUrlText, searchConfigured, webSearch } from "./lib/websearch";
import { Doc, Id } from "./_generated/dataModel";

/**
 * AI features, mirroring the three Notion AI capabilities that fit Vellum's
 * data model:
 *
 *  - `transform`     — the selection-level writing assistant (improve, fix,
 *                      summarize, translate, change tone…)
 *  - `fillProperty`  — Notion's "AI properties": a database column whose
 *                      value is generated per row from that row's content
 *  - `ask`           — workspace Q&A with citations, retrieving over the
 *                      existing `search` index rather than embeddings
 *
 * ## Vault
 *
 * Vault pages are end-to-end encrypted: the server holds only ciphertext and
 * the key never leaves the device (see CLAUDE.md). Sending that content to a
 * third-party model is exactly the guarantee the vault exists to make, so
 * every entry point here refuses vault pages, and `ask` filters them out of
 * retrieval. `transform` is text-only and never sees a page id, so the
 * client is responsible for not offering AI inside the vault — the two other
 * actions re-derive the check server-side, where it can't be bypassed.
 */

/* ------------------------------------------------------------------ *
 * Spend metering (docs/multi-user-plan.md, decided 2026-08-09)
 *
 * Every model call goes through `meteredChat`: a pre-flight budget check
 * ($0.10/user/month and a $0.85/month pool shared by all non-owner users),
 * then the call, then recording OpenRouter's reported cost. The owner is
 * exempt and never recorded — so the pool is simply the month's total.
 * Concurrent calls can overshoot a cap by one request; that is cents, and
 * accepted.
 * ------------------------------------------------------------------ */

export const _budgetCheck = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<{ exempt: boolean }> => {
    if (await isOwnerUser(ctx, args.userId)) return { exempt: true };
    const { userMicro, poolMicro } = await aiSpend(ctx, args.userId);
    if (userMicro >= AI_USER_MONTHLY_MICRO_USD) {
      throw new ConvexError(
        "You've used this month's AI allowance. It resets on the 1st.",
      );
    }
    if (poolMicro >= AI_POOL_MONTHLY_MICRO_USD) {
      throw new ConvexError(
        "This month's shared AI budget is used up. It resets on the 1st.",
      );
    }
    return { exempt: false };
  },
});

export const _recordSpend = internalMutation({
  args: { userId: v.id("users"), costMicroUsd: v.number() },
  handler: async (ctx, args) => {
    const month = monthKey();
    const row = await ctx.db
      .query("aiUsage")
      .withIndex("by_user_month", (q) =>
        q.eq("userId", args.userId).eq("month", month),
      )
      .unique();
    if (row) {
      await ctx.db.patch("aiUsage", row._id, {
        costMicroUsd: row.costMicroUsd + args.costMicroUsd,
        calls: row.calls + 1,
      });
    } else {
      await ctx.db.insert("aiUsage", {
        userId: args.userId,
        month,
        costMicroUsd: args.costMicroUsd,
        calls: 1,
      });
    }
  },
});

/** The one way AI actions may call the model: budget-gated and metered. */
async function meteredChat(
  ctx: ActionCtx,
  userId: Id<"users">,
  messages: Parameters<typeof chat>[0],
  opts?: Parameters<typeof chat>[1],
): Promise<string> {
  const gate: { exempt: boolean } = await ctx.runQuery(
    internal.ai._budgetCheck,
    { userId },
  );
  const { text, costMicroUsd } = await chat(messages, opts);
  if (!gate.exempt) {
    await ctx.runMutation(internal.ai._recordSpend, { userId, costMicroUsd });
  }
  return text;
}

/** Retrieval budget for `ask`. Enough context to answer across pages,
 *  short enough to stay well inside the model's practical latency. */
const MAX_CONTEXT_PAGES = 8;
const MAX_CHARS_PER_PAGE = 2000;
/** Row content sent per AI property fill. Rows are usually short. */
const MAX_ROW_CHARS = 4000;
/** Guards against a whole-page selection blowing the request budget. */
const MAX_SELECTION_CHARS = 12_000;

export const transformKind = v.union(
  v.literal("improve"),
  v.literal("fix"),
  v.literal("shorter"),
  v.literal("longer"),
  v.literal("summarize"),
  v.literal("bullets"),
  v.literal("tone"),
  v.literal("translate"),
  v.literal("continue"),
  v.literal("custom"),
);

type TransformKind =
  | "improve" | "fix" | "shorter" | "longer" | "summarize"
  | "bullets" | "tone" | "translate" | "continue" | "custom";

/**
 * Instructions are deliberately blunt about returning *only* the rewritten
 * text: a reasoning model asked to "improve this" will otherwise open with
 * "Here's an improved version:", which would be pasted straight into the
 * user's document.
 */
const SYSTEM_PROMPT =
  "You are a writing assistant embedded in a note-taking app. " +
  "Return ONLY the resulting text, with no preamble, no explanation, no " +
  "commentary, and no surrounding quotation marks. Never say what you " +
  "changed. Preserve the original language unless explicitly asked to " +
  "translate. Preserve Markdown formatting where it is already present.";

function instructionFor(kind: TransformKind, option: string | undefined): string {
  switch (kind) {
    case "improve":
      return "Rewrite the following text so it reads more clearly and fluently. Keep the meaning, length, and voice.";
    case "fix":
      return "Correct spelling, grammar, and punctuation in the following text. Change nothing else — not the wording, not the tone.";
    case "shorter":
      return "Rewrite the following text to be substantially shorter while keeping every important point.";
    case "longer":
      return "Expand the following text with more detail and explanation, keeping the same voice and intent.";
    case "summarize":
      return "Write a concise summary of the following text.";
    case "bullets":
      return "Rewrite the following text as a concise Markdown bulleted list, one '- ' per line.";
    case "tone":
      return `Rewrite the following text in a ${option || "professional"} tone. Keep the meaning intact.`;
    case "translate":
      return `Translate the following text into ${option || "English"}. Output only the translation.`;
    case "continue":
      return "Continue the following text naturally, matching its voice and formatting. Output only the continuation, not the original text.";
    case "custom":
      return option?.trim()
        ? `Apply this instruction to the text below: ${option.trim()}`
        : "Improve the following text.";
  }
}

/**
 * Kinds that rewrite text the user already has, and so are meaningless
 * without it. `continue` and `custom` are deliberately absent: on a blank
 * line they are how you write *from scratch* ("draft a standup update"),
 * which is the single most-used Notion AI flow.
 */
const NEEDS_TEXT: TransformKind[] = [
  "improve",
  "fix",
  "shorter",
  "longer",
  "summarize",
  "bullets",
  "tone",
  "translate",
];

/** Instruction for writing from nothing, where there is no text to attach. */
function blankInstructionFor(
  kind: TransformKind,
  option: string | undefined,
): string {
  if (kind === "custom" && option?.trim()) return option.trim();
  return "Write a short, useful paragraph to start this note.";
}

/**
 * The writing assistant. Takes raw text rather than a page id: the editor
 * transforms a live selection that may not be persisted yet, and the result
 * is applied client-side so the user can discard it.
 */
export const transform = action({
  args: {
    text: v.string(),
    kind: transformKind,
    /** Target tone / language / free-form instruction, per `kind`. */
    option: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const userId = await requireUser(ctx);

    const text = args.text.trim();
    if (!text && NEEDS_TEXT.includes(args.kind)) {
      throw new ConvexError("Nothing to rewrite — select some text first.");
    }
    if (text.length > MAX_SELECTION_CHARS) {
      throw new ConvexError(
        `That selection is too long (${text.length.toLocaleString()} characters). ` +
          `Select under ${MAX_SELECTION_CHARS.toLocaleString()}.`,
      );
    }

    // Writing from a blank line: there is no text to attach, so the
    // instruction stands alone rather than wrapping an empty delimiter pair.
    const content = text
      ? `${instructionFor(args.kind, args.option)}\n\n---\n${text}\n---`
      : blankInstructionFor(args.kind, args.option);

    return await meteredChat(ctx, userId, [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ]);
  },
});

/* ------------------------------------------------------------------ *
 * Database AI properties
 * ------------------------------------------------------------------ */

export const aiPropKind = v.union(
  v.literal("summary"),
  v.literal("keyTopics"),
  v.literal("sentiment"),
  v.literal("actionItems"),
  v.literal("custom"),
);

type AiPropKind = "summary" | "keyTopics" | "sentiment" | "actionItems" | "custom";

function propInstruction(kind: AiPropKind, prompt: string | undefined): string {
  switch (kind) {
    case "summary":
      return "Summarize this page in one sentence of at most 20 words.";
    case "keyTopics":
      return "List the 2-4 main topics of this page as a comma-separated list of short noun phrases. Output only the list.";
    case "sentiment":
      return "Classify the overall sentiment of this page as exactly one word: Positive, Neutral, or Negative. Output only that word.";
    case "actionItems":
      return "List the concrete action items in this page, one per line, each starting with a verb. If there are none, output exactly: None.";
    case "custom":
      return prompt?.trim() || "Summarize this page in one short sentence.";
  }
}

/** Server-side read for the fill actions — keeps the vault/trash checks
 *  where the client cannot skip them. */
export const _rowForFill = internalQuery({
  args: { pageId: v.id("pages"), userId: v.id("users") },
  handler: async (ctx, args): Promise<Doc<"pages"> | null> => {
    // Owner or shared-editor; viewers read as missing — a fill is paid for
    // by the caller and written back via setRowProp, which a viewer can't
    // do, so generating for them would burn budget on an unwritable value.
    const access = await getAccessiblePage(ctx, args.userId, args.pageId, "read");
    if (!access || access.role === "viewer") return null;
    return access.page;
  },
});

/** Read-only page access for AI grounding (chat context, the agent's
 *  `read` tool): any role suffices — reading is exactly what a viewer
 *  may do. `_rowForFill` stays stricter because a fill must be written
 *  back. Vault/trash handling stays with the callers, same as above. */
export const _rowForRead = internalQuery({
  args: { pageId: v.id("pages"), userId: v.id("users") },
  handler: async (ctx, args): Promise<Doc<"pages"> | null> => {
    const access = await getAccessiblePage(ctx, args.userId, args.pageId, "read");
    return access?.page ?? null;
  },
});

/**
 * Generate one AI property value for one database row. Returns the text; the
 * caller writes it through the normal `setRowProp` mutation so the value
 * flows through the offline outbox like any other edit.
 */
export const fillProperty = action({
  args: {
    pageId: v.id("pages"),
    kind: aiPropKind,
    prompt: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const userId = await requireUser(ctx);

    const row: Doc<"pages"> | null = await ctx.runQuery(
      internal.ai._rowForFill,
      { pageId: args.pageId, userId },
    );
    if (!row) throw new ConvexError("That row no longer exists.");
    if (row.vault) {
      throw new ConvexError(
        "AI is unavailable inside the Vault — its content is encrypted and never leaves your device.",
      );
    }

    // `contentText` is the plain-text projection maintained by updateContent,
    // so there is no need to walk the block tree here.
    const body = (row.contentText ?? "").slice(0, MAX_ROW_CHARS).trim();
    const title = row.title || "Untitled";
    if (!body) {
      throw new ConvexError(`"${title}" has no content to work from yet.`);
    }

    return await meteredChat(
      ctx,
      userId,
      [
        {
          role: "system",
          content:
            "You generate a single database cell value. Output only the value " +
            "itself — no preamble, no label, no quotation marks, no trailing period " +
            "unless it is a sentence.",
        },
        {
          role: "user",
          content: `${propInstruction(args.kind, args.prompt)}\n\nPage title: ${title}\n\n---\n${body}\n---`,
        },
      ],
      { maxTokens: 400 },
    );
  },
});

/* ------------------------------------------------------------------ *
 * Workspace Q&A
 * ------------------------------------------------------------------ */

export interface AskSource {
  pageId: string;
  title: string;
  icon: string | null;
  /** Set on web citations (agent webSearch/fetchUrl) — opens in a tab. */
  url?: string;
}

export interface AskResult {
  answer: string;
  sources: AskSource[];
  model: string;
}

/**
 * Retrieval for `ask`. Uses the existing `search` index (title + body text)
 * rather than embeddings: the index is already maintained on every write,
 * needs no backfill, and a personal workspace is small enough that keyword
 * recall is adequate. Swapping in a vector index later only changes this
 * function.
 */
export const _retrieve = internalQuery({
  args: { question: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const hits = await ctx.db
      .query("pages")
      .withSearchIndex("search", (q) =>
        q.search("searchText", args.question).eq("ownerId", args.userId),
      )
      .take(MAX_CONTEXT_PAGES * 2);

    return hits
      // Vault pages carry no search text at all, but filter defensively —
      // the same belt-and-braces the `search` query itself applies.
      .filter((p) => !p.vault && !p.inTrash)
      .slice(0, MAX_CONTEXT_PAGES)
      .map((p) => ({
        pageId: p._id as string,
        title: p.title || "Untitled",
        icon: p.icon ?? null,
        text: (p.contentText ?? "").slice(0, MAX_CHARS_PER_PAGE),
      }));
  },
});

/**
 * Notion's "ask your workspace": a natural-language question answered from
 * the user's own pages, with the pages it drew on returned as citations.
 */
export const ask = action({
  args: { question: v.string() },
  handler: async (ctx, args): Promise<AskResult> => {
    const userId = await requireUser(ctx);

    const question = args.question.trim();
    if (!question) throw new ConvexError("Ask a question first.");

    const docs: {
      pageId: string;
      title: string;
      icon: string | null;
      text: string;
    }[] = await ctx.runQuery(internal.ai._retrieve, { question, userId });

    if (docs.length === 0) {
      return {
        answer:
          "I couldn't find anything in your workspace about that. Try different wording, or check that the pages you mean aren't in the Trash or the Vault.",
        sources: [],
        model: aiModel(),
      };
    }

    // Numbered so the model can cite positionally; the client maps [1] back
    // to a real page link using the `sources` array's order.
    const context = docs
      .map((d, i) => `[${i + 1}] ${d.title}\n${d.text || "(no body text)"}`)
      .join("\n\n");

    const answer = await meteredChat(ctx, userId, [
      {
        role: "system",
        content:
          "You answer questions using ONLY the numbered workspace excerpts " +
          "provided. Cite the excerpts you use inline as [1], [2], and so on. " +
          "If the excerpts do not contain the answer, say so plainly instead of " +
          "guessing. Be concise and use Markdown.",
      },
      {
        role: "user",
        content: `Workspace excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}`,
      },
    ]);

    return {
      answer,
      sources: docs.map(({ pageId, title, icon }) => ({ pageId, title, icon })),
      model: aiModel(),
    };
  },
});

/* ------------------------------------------------------------------ *
 * Chat panel
 * ------------------------------------------------------------------ */

/** How much of a turn's history to keep. Older turns are dropped from the
 *  front — the free tier is slow, and the tail carries the intent. */
const MAX_HISTORY_TURNS = 12;
/** The current page, when the composer's context chip is on. */
const MAX_PAGE_CONTEXT_CHARS = 6000;
/** Custom instructions ("Personalize"), capped so they can't crowd out the
 *  system prompt or smuggle in a whole document. */
const MAX_PERSONA_CHARS = 1000;

export const chatTurn = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
});

/**
 * The side-panel chat: multi-turn, optionally grounded in the open page
 * and/or the wider workspace.
 *
 * Distinct from `ask`, which is a single question against retrieval. This
 * one carries history, so it is the surface where a conversation happens.
 */
export const converse = action({
  args: {
    messages: v.array(chatTurn),
    /** The open page, when the composer's context chip is active. */
    pageId: v.optional(v.id("pages")),
    /** Also retrieve across the workspace (Notion's "search your brain"). */
    useWorkspace: v.optional(v.boolean()),
    /** User's saved custom instructions, from "Personalize". */
    persona: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AskResult> => {
    const userId = await requireUser(ctx);

    const history = args.messages.slice(-MAX_HISTORY_TURNS);
    const latest = [...history].reverse().find((m) => m.role === "user");
    if (!latest?.content.trim()) throw new ConvexError("Say something first.");

    const contextParts: string[] = [];
    const sources: AskSource[] = [];

    // The open page, when the chip is on. Read-scoped: a viewer-role
    // shared page is legitimate chat context (it's on their screen).
    if (args.pageId) {
      const page: Doc<"pages"> | null = await ctx.runQuery(
        internal.ai._rowForRead,
        { pageId: args.pageId, userId },
      );
      if (page?.vault) {
        throw new ConvexError(
          "AI is unavailable inside the Vault — its content is encrypted and never leaves your device.",
        );
      }
      if (page && !page.inTrash) {
        const body = (page.contentText ?? "").slice(0, MAX_PAGE_CONTEXT_CHARS);
        contextParts.push(
          `The page currently open is "${page.title || "Untitled"}":\n${body || "(empty)"}`,
        );
        sources.push({
          pageId: page._id as string,
          title: page.title || "Untitled",
          icon: page.icon ?? null,
        });
      }
    }

    // Workspace retrieval, keyed off the newest user turn.
    if (args.useWorkspace) {
      const docs: {
        pageId: string;
        title: string;
        icon: string | null;
        text: string;
      }[] = await ctx.runQuery(internal.ai._retrieve, {
        question: latest.content,
        userId,
      });
      const fresh = docs.filter((d) => !sources.some((s) => s.pageId === d.pageId));
      if (fresh.length > 0) {
        contextParts.push(
          "Relevant pages from the workspace:\n" +
            fresh
              .map((d, i) => `[${i + 1}] ${d.title}\n${d.text || "(no body text)"}`)
              .join("\n\n"),
        );
        sources.push(
          ...fresh.map(({ pageId, title, icon }) => ({ pageId, title, icon })),
        );
      }
    }

    const persona = args.persona?.trim().slice(0, MAX_PERSONA_CHARS);
    const system =
      "You are the AI assistant built into Vellum, a personal Notion-style " +
      "workspace. Be concise and concrete, and use Markdown. When workspace " +
      "context is supplied, prefer it over general knowledge and say plainly " +
      "when it does not contain the answer rather than guessing." +
      (persona ? `\n\nThe user's instructions for you:\n${persona}` : "") +
      (contextParts.length > 0 ? `\n\n---\n${contextParts.join("\n\n")}` : "");

    // The provider takes a flat message list; history is folded into one
    // labelled transcript so a single `user` message carries the exchange.
    const transcript = history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const answer = await meteredChat(ctx, userId, [
      { role: "system", content: system },
      { role: "user", content: transcript },
    ]);

    return { answer, sources, model: aiModel() };
  },
});

/**
 * "Create a slide deck" — a structured outline the client turns into a new
 * page of heading + bullet blocks, one section per slide.
 */
export const deckOutline = action({
  args: {
    /** Base the deck on this page, when one is open. */
    pageId: v.optional(v.id("pages")),
    /** Otherwise (or additionally) a free-form topic. */
    topic: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const userId = await requireUser(ctx);

    let source = args.topic?.trim() ?? "";
    let title = source;

    if (args.pageId) {
      const page: Doc<"pages"> | null = await ctx.runQuery(
        internal.ai._rowForFill,
        { pageId: args.pageId, userId },
      );
      if (page?.vault) {
        throw new ConvexError(
          "AI is unavailable inside the Vault — its content is encrypted and never leaves your device.",
        );
      }
      if (page) {
        title = page.title || title || "Untitled";
        source = `${page.title || "Untitled"}\n\n${(page.contentText ?? "").slice(0, MAX_PAGE_CONTEXT_CHARS)}`;
      }
    }

    if (!source.trim()) {
      throw new ConvexError("Open a page or give me a topic for the deck.");
    }

    return await meteredChat(ctx, userId, [
      {
        role: "system",
        content:
          "You outline slide decks. Output Markdown only, in exactly this " +
          "shape and nothing else: a '## ' heading per slide, followed by 2-4 " +
          "'- ' bullets. No preamble, no slide numbers, no closing remarks. " +
          "Aim for 5-8 slides.",
      },
      {
        role: "user",
        content: `Outline a slide deck titled "${title}" from the following:\n\n---\n${source}\n---`,
      },
    ]);
  },
});

/* ------------------------------------------------------------------ *
 * Workspace agent (docs/ai-agent-design.md)
 * ------------------------------------------------------------------ */

/** Model calls per agent request, tool rounds included. Each is metered. */
const MAX_AGENT_CALLS = 4;
/** Tool-round replies are tiny JSON; the final round may carry a whole
 *  plan with markdown content. */
const AGENT_TOOL_MAX_TOKENS = 600;
const AGENT_FINAL_MAX_TOKENS = 4000;
/** Body budget for the agent's `read` tool and search results. */
const AGENT_READ_CHARS = 6000;
/** Web tool calls per request — protects the search providers' free
 *  tiers from a single runaway conversation. */
const MAX_WEB_OPS = 3;
/** Hard caps on what may leave the deployment, refused (never truncated)
 *  BEFORE any guard call — an exfil payload must not be judged in
 *  truncated form and then sent whole (audit finding 7, 2026-08-12).
 *  Real queries are short; real URLs fit comfortably. */
const MAX_SEARCH_QUERY_CHARS = 200;
const MAX_FETCH_URL_CHARS = 500;

/**
 * The safety gate on OUTGOING web operations (decided with Michael
 * 2026-08-12): an independent model call that sees ONLY the query/URL
 * string — never the conversation — so a jailbreak in the chat or text
 * smuggled into a page has no path into the verdict. Fail-closed: an
 * unparseable or errored verdict declines the operation.
 */
/** Audit-log retention. Old entries are pruned lazily on write. */
const WEB_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const WEB_AUDIT_PRUNE_BATCH = 25;

export const _recordWebOp = internalMutation({
  args: {
    userId: v.id("users"),
    kind: v.union(v.literal("search"), v.literal("fetch")),
    text: v.string(),
    allowed: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("webAudit", { ...args, at: now });
    // Lazy prune: a few expired rows per write keeps the table bounded
    // without a cron.
    const cutoff = now - WEB_AUDIT_RETENTION_MS;
    const stale = await ctx.db
      .query("webAudit")
      .withIndex("by_at", (q) => q.lt("at", cutoff))
      .take(WEB_AUDIT_PRUNE_BATCH);
    for (const row of stale) await ctx.db.delete("webAudit", row._id);
  },
});

const WEB_GUARD_SYSTEM =
  "You are a safety filter for outgoing web requests from a note-taking " +
  "app used by families. You will be given one search query or URL. " +
  "Judge ONLY that string. Set allowed=false if it seeks illegal " +
  "content or activity (buying drugs or weapons, exploitation, fraud, " +
  "harming someone), sexually explicit or gory content, or targets a " +
  "private person for harassment or doxxing. Also set allowed=false " +
  "when the string appears to carry data OUTWARD rather than ask for " +
  "something: pasted sentences or document passages, names with private " +
  "details, or encoded/compressed-looking payloads stuffed into the " +
  "query or URL parameters. Otherwise set " +
  "allowed=true — including medical, legal, news, and sensitive but " +
  "lawful topics, which must NOT be blocked. Reply with ONLY " +
  '{"allowed":true} or {"allowed":false,"reason":"<a few words>"}.';

async function webOpAllowed(
  ctx: ActionCtx,
  userId: Id<"users">,
  kind: "search" | "fetch",
  text: string,
): Promise<{ allowed: boolean; reason: string }> {
  const verdict = await webGuardVerdict(ctx, userId, kind, text);
  // Audit BOTH outcomes — declined attempts are the misuse evidence.
  // Best-effort: a logging failure must not break the user's request.
  try {
    await ctx.runMutation(internal.ai._recordWebOp, {
      userId,
      kind,
      text: text.slice(0, 500),
      allowed: verdict.allowed,
      ...(verdict.allowed ? {} : { reason: verdict.reason }),
    });
  } catch (err) {
    console.warn("webAudit write failed:", err);
  }
  return verdict;
}

async function webGuardVerdict(
  ctx: ActionCtx,
  userId: Id<"users">,
  kind: "search" | "fetch",
  text: string,
): Promise<{ allowed: boolean; reason: string }> {
  try {
    const verdict = await meteredChat(
      ctx,
      userId,
      [
        { role: "system", content: WEB_GUARD_SYSTEM },
        { role: "user", content: `${kind === "search" ? "Search query" : "URL"}: ${text.slice(0, 500)}` },
      ],
      { maxTokens: 60 },
    );
    const parsed = parseAgentJson(verdict);
    if (parsed && parsed.allowed === true) return { allowed: true, reason: "" };
    return {
      allowed: false,
      reason:
        parsed && typeof parsed.reason === "string"
          ? parsed.reason
          : "the safety check could not approve it",
    };
  } catch {
    // Guard call failed → fail closed, never open.
    return { allowed: false, reason: "the safety check was unavailable" };
  }
}

export interface AgentResult {
  answer: string;
  plan: AgentOp[] | null;
  sources: AskSource[];
  model: string;
}

const AGENT_SYSTEM = `You are the AI assistant built into Vellum, a personal Notion-style workspace. The user may ask you to look things up or to create content. You respond ONLY with a single JSON object, no prose around it.

To consult the workspace first (optional, at most a few times), reply with exactly one of:
{"tool":"search","query":"<keywords>"}
{"tool":"read","pageId":"<id from a search result or the open page>"}
{{WEB_TOOLS}}
To finish, reply with:
{"reply":"<your Markdown answer to the user>","plan":[...]}

Include "plan" ONLY when the user asked to create something; omit it for questions. A plan is a list of at most 20 steps executed top-to-bottom after the user approves it. Steps may only CREATE or APPEND — never modify, move, or delete. "#N" refers to the page created by step N (0-based). Available steps:

{"kind":"createPage","title":"...","icon":"<one emoji, optional>","parent":"current"|"root"|"#N","markdown":"<page content, optional>"}
{"kind":"createDatabase","title":"...","icon":"<optional>","parent":"current"|"root","columns":[{"name":"...","type":"text"|"number"|"select"|"multiSelect"|"date"|"checkbox"|"url","options":["..."]}]}
{"kind":"addRow","target":"#N"|"<database page id>","title":"...","props":{"<column name>":<value>}}
{"kind":"appendToPage","target":"current"|"<page id>","markdown":"..."}

Rules: web queries and URLs must be lawful and family-appropriate — an independent safety check declines anything else, so do not attempt it; prop values are strings, numbers, booleans, or string lists keyed by COLUMN NAME; dates are "YYYY-MM-DD"; "parent":"current" needs an open page (you are told when one is open); markdown supports #/##/### headings, - bullets, 1. numbered lists, - [ ] checkboxes, and plain paragraphs.`;

/**
 * The propose-then-apply workspace agent. Runs a bounded read-tool loop
 * server-side and returns an answer plus an optional additive plan; the
 * client renders the plan as a card and, on Apply, executes it through
 * the ordinary mutations — this action never writes anything.
 */
export const agent = action({
  args: {
    messages: v.array(chatTurn),
    /** The open page, when the composer's context chip is active. */
    pageId: v.optional(v.id("pages")),
    /** Ground in workspace retrieval up-front (the composer's toggle);
     *  the agent can also search on its own via the tool loop. */
    useWorkspace: v.optional(v.boolean()),
    /** The composer's globe toggle: allow web tools this request. Off by
     *  default — nothing touches the web unless the user opted in. */
    allowWeb: v.optional(v.boolean()),
    persona: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AgentResult> => {
    const userId = await requireUser(ctx);

    const history = args.messages.slice(-MAX_HISTORY_TURNS);
    const latest = [...history].reverse().find((m) => m.role === "user");
    if (!latest?.content.trim()) throw new ConvexError("Say something first.");

    const sources: AskSource[] = [];
    const addSource = (s: AskSource) => {
      if (!sources.some((x) => x.pageId === s.pageId)) sources.push(s);
    };

    // The open page, read-scoped (viewers may ground in what they see).
    let pageNote = "No page is currently open.";
    if (args.pageId) {
      const page: Doc<"pages"> | null = await ctx.runQuery(
        internal.ai._rowForRead,
        { pageId: args.pageId, userId },
      );
      if (page?.vault) {
        throw new ConvexError(
          "AI is unavailable inside the Vault — its content is encrypted and never leaves your device.",
        );
      }
      if (page && !page.inTrash) {
        const body = (page.contentText ?? "").slice(0, MAX_PAGE_CONTEXT_CHARS);
        pageNote = `The currently open page is "${page.title || "Untitled"}" (id ${page._id}):\n${body || "(empty)"}`;
        addSource({
          pageId: page._id as string,
          title: page.title || "Untitled",
          icon: page.icon ?? null,
        });
      }
    }

    // Up-front retrieval when the workspace toggle is on, exactly like
    // converse — the tool loop can still search deeper on its own.
    let retrievedNote = "";
    if (args.useWorkspace) {
      const docs: { pageId: string; title: string; icon: string | null; text: string }[] =
        await ctx.runQuery(internal.ai._retrieve, {
          question: latest.content,
          userId,
        });
      if (docs.length > 0) {
        retrievedNote =
          "\n\nRelevant pages from the workspace:\n" +
          docs
            .map((d) => `- "${d.title}" (id ${d.pageId}): ${d.text.slice(0, 300)}`)
            .join("\n");
        for (const d of docs) {
          addSource({ pageId: d.pageId, title: d.title, icon: d.icon });
        }
      }
    }

    // Web tools appear in the prompt only when the user opted in; the
    // search tool additionally needs a configured provider key.
    const webEnabled = args.allowWeb === true;
    const searchEnabled = webEnabled && searchConfigured();
    const webToolLines = webEnabled
      ? (searchEnabled
          ? '{"tool":"webSearch","query":"<keywords>"} — search the public web\n'
          : "") +
        '{"tool":"fetchUrl","url":"<http(s) address>"} — read a web page\'s text\n'
      : "";
    let webOps = 0;

    const persona = args.persona?.trim().slice(0, MAX_PERSONA_CHARS);
    const system =
      AGENT_SYSTEM.replace("{{WEB_TOOLS}}", webToolLines) +
      (persona ? `\n\nThe user's instructions for you:\n${persona}` : "") +
      `\n\n---\n${pageNote}` +
      retrievedNote;

    // History folds into one transcript (the provider takes a flat list),
    // and tool rounds append to it so the model sees its own trail.
    const convo: string[] = [
      history
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n\n"),
    ];

    for (let round = 0; round < MAX_AGENT_CALLS; round++) {
      const finalRound = round === MAX_AGENT_CALLS - 1;
      const text = await meteredChat(
        ctx,
        userId,
        [
          { role: "system", content: system },
          {
            role: "user",
            content:
              convo.join("\n\n") +
              (finalRound
                ? "\n\n(You must reply with the final JSON now — no more tool calls.)"
                : ""),
          },
        ],
        {
          maxTokens: finalRound ? AGENT_FINAL_MAX_TOKENS : AGENT_TOOL_MAX_TOKENS,
        },
      );

      const parsed = parseAgentJson(text);

      // Not JSON at all: treat the text as the final reply. A model that
      // drifts off-protocol mid-loop still answers the user.
      if (!parsed) return { answer: text.trim(), plan: null, sources, model: aiModel() };

      if (!finalRound && parsed.tool === "search" && typeof parsed.query === "string") {
        const docs: { pageId: string; title: string; icon: string | null; text: string }[] =
          await ctx.runQuery(internal.ai._retrieve, {
            question: parsed.query,
            userId,
          });
        for (const d of docs) {
          addSource({ pageId: d.pageId, title: d.title, icon: d.icon });
        }
        const result =
          docs.length === 0
            ? "No pages matched."
            : docs
                .map((d) => `- "${d.title}" (id ${d.pageId}): ${d.text.slice(0, 300)}`)
                .join("\n");
        convo.push(`Tool result for search "${parsed.query}":\n${result}`);
        continue;
      }

      if (!finalRound && parsed.tool === "read" && typeof parsed.pageId === "string") {
        let result = "That page is not available.";
        try {
          const page: Doc<"pages"> | null = await ctx.runQuery(
            internal.ai._rowForRead,
            { pageId: parsed.pageId as Id<"pages">, userId },
          );
          if (page && !page.vault && !page.inTrash) {
            result = `"${page.title || "Untitled"}" (id ${page._id}, ${page.type}):\n${(page.contentText ?? "").slice(0, AGENT_READ_CHARS) || "(empty)"}`;
            addSource({
              pageId: page._id as string,
              title: page.title || "Untitled",
              icon: page.icon ?? null,
            });
          }
        } catch {
          // Malformed id — the model hallucinated one; tell it plainly.
        }
        convo.push(`Tool result for read ${parsed.pageId}:\n${result}`);
        continue;
      }

      if (!finalRound && parsed.tool === "webSearch" && typeof parsed.query === "string") {
        if (!searchEnabled || webOps >= MAX_WEB_OPS) {
          convo.push(
            `Tool result for webSearch: unavailable${webOps >= MAX_WEB_OPS ? " (web budget for this request is used up)" : ""} — answer from what you have.`,
          );
          continue;
        }
        webOps++;
        if (parsed.query.length > MAX_SEARCH_QUERY_CHARS) {
          convo.push(
            `Tool result for webSearch: declined — the query is too long to send. Compose a short keyword query instead.`,
          );
          continue;
        }
        const searchVerdict = await webOpAllowed(ctx, userId, "search", parsed.query);
        if (!searchVerdict.allowed) {
          convo.push(
            `Tool result for webSearch "${parsed.query}": declined by the safety filter (${searchVerdict.reason}). Do not rephrase or retry — answer without the web and tell the user plainly that the search was declined.`,
          );
          continue;
        }
        let result = "The web search failed — answer from what you have.";
        try {
          const found = await webSearch(parsed.query);
          if (found) {
            result =
              found.length === 0
                ? "No results."
                : found
                    .map((r) => `- ${r.title} <${r.url}>: ${r.snippet}`)
                    .join("\n");
            for (const r of found) {
              addSource({ pageId: r.url, title: r.title, icon: "🌐", url: r.url });
            }
          }
        } catch {
          // Provider failure/quota — the fallback text stands.
        }
        convo.push(`Tool result for webSearch "${parsed.query}":\n${result}`);
        continue;
      }

      if (!finalRound && parsed.tool === "fetchUrl" && typeof parsed.url === "string") {
        if (!webEnabled || webOps >= MAX_WEB_OPS) {
          convo.push("Tool result for fetchUrl: unavailable — answer from what you have.");
          continue;
        }
        webOps++;
        if (parsed.url.length > MAX_FETCH_URL_CHARS) {
          convo.push(
            `Tool result for fetchUrl: declined — that URL is too long to send.`,
          );
          continue;
        }
        const fetchVerdict = await webOpAllowed(ctx, userId, "fetch", parsed.url);
        if (!fetchVerdict.allowed) {
          convo.push(
            `Tool result for fetchUrl ${parsed.url}: declined by the safety filter (${fetchVerdict.reason}). Do not retry — answer without it and tell the user plainly.`,
          );
          continue;
        }
        const fetched = await fetchUrlText(parsed.url);
        if (fetched) {
          addSource({
            pageId: fetched.url,
            title: new URL(fetched.url).hostname,
            icon: "🌐",
            url: fetched.url,
          });
          convo.push(`Tool result for fetchUrl ${fetched.url}:\n${fetched.text}`);
        } else {
          convo.push(`Tool result for fetchUrl ${parsed.url}:\nThat page is not available.`);
        }
        continue;
      }

      // Final answer (or a tool call on the forced-final round, which we
      // treat as an answer attempt).
      const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : text.trim();
      let plan: AgentOp[] | null = null;
      let note = "";
      // An empty list is the model saying "nothing to create" — treat it
      // like an absent plan, not a malformed one (observed live).
      const rawPlan =
        Array.isArray(parsed.plan) && parsed.plan.length === 0
          ? undefined
          : parsed.plan;
      if (rawPlan !== undefined) {
        const validated = validatePlan(rawPlan);
        if (validated.ok) plan = validated.plan;
        else note = `\n\n_(I drafted a plan but it was malformed — ${validated.error}. Try asking again.)_`;
      }
      return { answer: reply + note, plan, sources, model: aiModel() };
    }

    // Unreachable (the last round always returns), but typecheck-honest.
    throw new ConvexError("The agent ran out of rounds without answering.");
  },
});
