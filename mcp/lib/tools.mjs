/**
 * The MCP surface: tools for logging conversations into the Claude
 * database, plus read-scoped tools over the rest of the workspace so a chat
 * can look up what was decided last time. Kept separate from the transport
 * so tests can drive it over an in-memory connection with a fake backend.
 */
import { z } from "zod";
import { blocksToMarkdown } from "./blocks.mjs";
import { SOURCES } from "./claudeDb.mjs";
import { localDate } from "./transcript.mjs";

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Day of the conversation, YYYY-MM-DD (defaults to today on this machine)");

function ok(payload, text) {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: `Vellum error: ${message}` }] };
}

const guarded = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err);
  }
};

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {{ log: import("./claudeDb.mjs").ClaudeLog, vellum: import("./vellum.mjs").VellumClient }} deps
 */
export function registerVellumTools(server, { log, vellum }) {
  server.registerTool(
    "vellum_log_conversation",
    {
      title: "Log this conversation to Vellum",
      description: `Save a record of the current conversation as one row in the user's "Claude" database in Vellum (their personal workspace). Call it at the end of a conversation, or whenever the user asks to log, save, note or remember what was discussed.

Write the summary and notes for the user's future self: what was asked, what was decided, what remains open. Notes are Markdown (headings, bullets, checklists, numbered lists, fenced code are supported; inline styling is kept as plain text).

Pass the same conversation_key again later to update the row instead of creating a second one. Returns the row id and a link that opens it in Vellum.`,
      inputSchema: {
        title: z.string().min(1).max(200).describe("Short title for the conversation (what it was about)"),
        summary: z.string().min(1).max(2000).describe("Two to four sentences: the ask, the outcome, open questions"),
        notes_markdown: z
          .string()
          .max(150_000)
          .optional()
          .describe("Detailed notes in Markdown: decisions, action items as a checklist, key facts, code that matters"),
        tags: z.array(z.string().min(1).max(40)).max(10).optional().describe("Topic tags, e.g. [\"vellum\", \"planning\"]"),
        source: z.enum(SOURCES).default("Claude Desktop").describe("Where the conversation happened"),
        project: z.string().max(120).optional().describe("Project or area the conversation belongs to"),
        date: DATE.optional(),
        conversation_key: z
          .string()
          .max(200)
          .optional()
          .describe("Stable key for this conversation (the chat's title or id). Reusing it updates the existing row"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (args) => {
      const result = await log.upsert({
        key: args.conversation_key,
        title: args.title,
        summary: args.summary,
        bodyMarkdown: args.notes_markdown,
        tags: args.tags,
        source: args.source,
        project: args.project,
        date: args.date ?? localDate(),
        device: vellum.device(),
      });
      const payload = { row_id: result.rowId, url: result.url, created: result.created };
      return ok(
        payload,
        `${result.created ? "Logged" : "Updated"} "${args.title}" in the Claude database.\nRow id: ${result.rowId}\nOpen: ${result.url}`,
      );
    }),
  );

  server.registerTool(
    "vellum_update_conversation",
    {
      title: "Update a logged conversation",
      description:
        "Change a row of the Claude database: retitle it, replace the summary or tags, append more notes, or replace the notes. Use vellum_list_conversations to find the row id.",
      inputSchema: {
        row_id: z.string().min(1).describe("Row id returned by vellum_log_conversation or vellum_list_conversations"),
        title: z.string().min(1).max(200).optional(),
        summary: z.string().max(2000).optional(),
        tags: z.array(z.string().min(1).max(40)).max(10).optional().describe("Replaces the current tags"),
        project: z.string().max(120).optional(),
        date: DATE.optional(),
        append_markdown: z.string().max(150_000).optional().describe("Markdown to add at the end of the notes"),
        replace_markdown: z.string().max(150_000).optional().describe("Markdown that replaces the notes entirely"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    guarded(async (args) => {
      const result = await log.update(args.row_id, {
        title: args.title,
        summary: args.summary,
        tags: args.tags,
        project: args.project,
        date: args.date,
        appendMarkdown: args.append_markdown,
        replaceMarkdown: args.replace_markdown,
      });
      return ok({ row_id: result.rowId, url: result.url }, `Updated. Open: ${result.url}`);
    }),
  );

  server.registerTool(
    "vellum_list_conversations",
    {
      title: "List logged conversations",
      description:
        "Recent rows of the Claude database (newest first): title, date, device, source, project, tags, summary and a link. Filter by device, source, project or a start date.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        device: z.string().optional().describe("Only conversations logged from this machine, e.g. \"MacBook Pro\""),
        source: z.enum(SOURCES).optional(),
        project: z.string().optional(),
        since: DATE.optional().describe("Only conversations on or after this day"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async (args) => {
      const rows = await log.listRows(args);
      const lines = rows.map(
        (r) =>
          `- ${r.date ?? "????-??-??"} · ${r.title} (${[r.source, r.device, r.project].filter(Boolean).join(", ")})${r.tags.length ? " #" + r.tags.join(" #") : ""}\n  id: ${r.id}${r.summary ? "\n  " + r.summary : ""}`,
      );
      return ok({ count: rows.length, conversations: rows }, rows.length ? lines.join("\n") : "No conversations logged yet.");
    }),
  );

  server.registerTool(
    "vellum_search",
    {
      title: "Search the Vellum workspace",
      description:
        "Full-text search over the user's pages (titles and content). Returns up to 20 matches with a snippet and page id; read a match with vellum_read_page. Encrypted Vault pages are never returned.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Search words"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ query }) => {
      const hits = await vellum.query("pages:search", { term: query });
      const results = hits.map((h) => ({
        id: h._id,
        title: h.title || "Untitled",
        type: h.type,
        snippet: h.snippet,
        url: vellum.pageUrl(h._id),
      }));
      const text = results.length
        ? results.map((r) => `- ${r.title} [${r.type}] — ${r.snippet}\n  id: ${r.id}`).join("\n")
        : "No pages match.";
      return ok({ count: results.length, results }, text);
    }),
  );

  server.registerTool(
    "vellum_list_pages",
    {
      title: "List pages",
      description:
        "The workspace outline: every page and database with its id, type, parent and last edit (trash and Vault excluded). Use it to pick a parent for vellum_create_page or to find a page by name when search is too fuzzy.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(200),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ limit }) => {
      const pages = await vellum.query("pages:list");
      const visible = pages
        .filter((p) => !p.vault)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((p) => ({
          id: p._id,
          title: p.title || "Untitled",
          type: p.type,
          parent_id: p.parentId,
          updated_at: new Date(p.updatedAt).toISOString(),
        }));
      const text = visible.map((p) => `- ${p.title} [${p.type}] id: ${p.id}${p.parent_id ? ` (in ${p.parent_id})` : ""}`).join("\n");
      return ok({ count: visible.length, pages: visible }, text || "The workspace is empty.");
    }),
  );

  server.registerTool(
    "vellum_read_page",
    {
      title: "Read a page",
      description:
        "A page's content as Markdown, or a database's rows. Encrypted Vault pages cannot be read (their content never reaches the server in plaintext).",
      inputSchema: {
        page_id: z.string().min(1),
        max_chars: z.number().int().min(200).max(200_000).default(20_000),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded(async ({ page_id, max_chars }) => {
      const page = await vellum.query("pages:get", { id: page_id });
      if (!page) throw new Error("No such page (or it belongs to someone else)");
      if (page.vault) throw new Error("That page is in the Vault and is end-to-end encrypted; it can only be read in the app");
      let body;
      if (page.type === "database") {
        const pages = await vellum.query("pages:list");
        const cols = page.dbProps ?? [];
        const rows = pages.filter((p) => p.parentId === page._id);
        body = rows
          .map((r) => {
            const cells = cols
              .map((c) => {
                const v = r.props?.[c.id];
                if (v === undefined || v === null || v === "") return null;
                const label = Array.isArray(c.options)
                  ? [].concat(v).map((id) => c.options.find((o) => o.id === id)?.name ?? id).join(", ")
                  : typeof v === "object" ? JSON.stringify(v) : String(v);
                return `${c.name}: ${label}`;
              })
              .filter(Boolean);
            return `- ${r.title || "Untitled"} (id: ${r._id})${cells.length ? " — " + cells.join(" · ") : ""}`;
          })
          .join("\n");
      } else {
        body = blocksToMarkdown(page.content);
      }
      const truncated = body.length > max_chars;
      const markdown = truncated ? body.slice(0, max_chars) + "\n\n… (truncated)" : body;
      return ok(
        { id: page._id, title: page.title, type: page.type, markdown, truncated, url: vellum.pageUrl(page._id) },
        `# ${page.title || "Untitled"}\n\n${markdown}`,
      );
    }),
  );

  server.registerTool(
    "vellum_create_page",
    {
      title: "Create a page",
      description:
        "Create a new page anywhere in the workspace (top level, or under a parent page id) with Markdown content. For conversation logs use vellum_log_conversation instead.",
      inputSchema: {
        title: z.string().min(1).max(200),
        markdown: z.string().max(150_000).optional(),
        parent_id: z.string().optional().describe("Parent page id; omit for a top-level page"),
        icon: z.string().max(8).optional().describe("An emoji"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async (args) => {
      const id = await vellum.mutation("pages:create", {
        type: "doc",
        title: args.title,
        parentId: args.parent_id,
        icon: args.icon,
      });
      if (args.markdown) {
        const { markdownToBlocks } = await import("./blocks.mjs");
        const { blocks, text } = markdownToBlocks(args.markdown);
        if (blocks.length) await vellum.mutation("pages:updateContent", { id, content: blocks, text });
      }
      const url = vellum.pageUrl(id);
      return ok({ id, url }, `Created "${args.title}". Open: ${url}`);
    }),
  );

  server.registerPrompt(
    "log_this_conversation",
    {
      title: "Log this conversation to Vellum",
      description: "Summarise the conversation so far and save it to the Claude database in Vellum.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Log this conversation to Vellum: call vellum_log_conversation with a short title, a summary of what I asked and what we concluded, notes in Markdown (decisions, action items as a checklist, anything I'd want to find again), and a few tags. If you already logged this conversation, pass the same conversation_key so the row is updated rather than duplicated. Then tell me the link.",
          },
        },
      ],
    }),
  );
}
