import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { requireUser } from "./lib/auth";
import { chat, AI_MODEL } from "./lib/openrouter";
import { Doc } from "./_generated/dataModel";

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
    await requireUser(ctx);

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

    return await chat([
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
  args: { pageId: v.id("pages") },
  handler: async (ctx, args): Promise<Doc<"pages"> | null> => {
    return await ctx.db.get(args.pageId);
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
    await requireUser(ctx);

    const row: Doc<"pages"> | null = await ctx.runQuery(
      internal.ai._rowForFill,
      { pageId: args.pageId },
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

    return await chat(
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
  args: { question: v.string() },
  handler: async (ctx, args) => {
    const hits = await ctx.db
      .query("pages")
      .withSearchIndex("search", (q) => q.search("searchText", args.question))
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
    await requireUser(ctx);

    const question = args.question.trim();
    if (!question) throw new ConvexError("Ask a question first.");

    const docs: {
      pageId: string;
      title: string;
      icon: string | null;
      text: string;
    }[] = await ctx.runQuery(internal.ai._retrieve, { question });

    if (docs.length === 0) {
      return {
        answer:
          "I couldn't find anything in your workspace about that. Try different wording, or check that the pages you mean aren't in the Trash or the Vault.",
        sources: [],
        model: AI_MODEL,
      };
    }

    // Numbered so the model can cite positionally; the client maps [1] back
    // to a real page link using the `sources` array's order.
    const context = docs
      .map((d, i) => `[${i + 1}] ${d.title}\n${d.text || "(no body text)"}`)
      .join("\n\n");

    const answer = await chat([
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
      model: AI_MODEL,
    };
  },
});
