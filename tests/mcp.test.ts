/**
 * The Claude Desktop MCP server (mcp/): pure helpers, the Claude database
 * logic against an in-memory stand-in for the pages functions, and the
 * tool surface driven over an in-memory MCP connection.
 */
import { describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { blocksToMarkdown, extractText, markdownToBlocks } from "../mcp/lib/blocks.mjs";
import {
  localDate,
  parseTranscript,
  titleFromPrompt,
  transcriptToMarkdown,
} from "../mcp/lib/transcript.mjs";
import { CLAUDE_DB_TITLE, COLUMNS, ClaudeLog } from "../mcp/lib/claudeDb.mjs";
import { registerVellumTools } from "../mcp/lib/tools.mjs";
import { parseAnchor } from "../src/lib/anchors";

/* ------------------------------------------------------------------ */
/* A stand-in for the signed-in client: the pages:* functions the MCP */
/* server calls, with the server's own filtering rules.               */
/* ------------------------------------------------------------------ */

type Page = {
  _id: string;
  title: string;
  type: "doc" | "database";
  parentId: string | null;
  props?: Record<string, unknown>;
  dbProps?: unknown[];
  content?: unknown[];
  contentText?: string;
  vault?: boolean;
  inTrash?: boolean;
  icon?: string;
  updatedAt: number;
  _creationTime: number;
  calls: number;
};

class FakeVellum {
  pages = new Map<string, Page>();
  seq = 0;
  log: string[] = [];
  now = 1_700_000_000_000;

  device() {
    return "Test Mac";
  }
  pageUrl(id: string) {
    return `https://vellum.test/app#/page/${id}`;
  }
  seed(page: Partial<Page> & { title: string; type: "doc" | "database" }) {
    const _id = `p${++this.seq}`;
    this.pages.set(_id, {
      parentId: null,
      updatedAt: this.now,
      _creationTime: this.now,
      calls: 0,
      _id,
      ...page,
    });
    return _id;
  }
  async query(name: string, args: Record<string, unknown> = {}) {
    this.log.push(name);
    switch (name) {
      case "pages:list":
        return [...this.pages.values()]
          .filter((p) => !p.inTrash)
          .map((p) => ({
            _id: p._id,
            title: p.title,
            type: p.type,
            parentId: p.parentId,
            props: p.props ?? null,
            vault: p.vault ?? false,
            updatedAt: p.updatedAt,
            _creationTime: p._creationTime,
          }));
      case "pages:get":
        return this.pages.get(args.id as string) ?? null;
      case "pages:search": {
        const term = String(args.term).toLowerCase();
        return [...this.pages.values()]
          .filter((p) => !p.vault && !p.inTrash && `${p.title} ${p.contentText ?? ""}`.toLowerCase().includes(term))
          .map((p) => ({ _id: p._id, title: p.title, type: p.type, parentId: p.parentId, icon: null, snippet: p.contentText ?? "" }));
      }
    }
    throw new Error(`unexpected query ${name}`);
  }
  async mutation(name: string, args: Record<string, unknown> = {}) {
    this.log.push(name);
    const page = () => {
      const p = this.pages.get(args.id as string);
      if (!p) throw new Error("missing page");
      return p;
    };
    switch (name) {
      case "pages:create": {
        const id = this.seed({
          title: (args.title as string) ?? "",
          type: args.type as "doc" | "database",
          parentId: (args.parentId as string) ?? null,
          props: args.props as Record<string, unknown>,
          icon: args.icon as string,
          ...(args.type === "database"
            ? { dbProps: [{ id: "status", name: "Status", type: "select", options: [] }] }
            : {}),
        });
        return id;
      }
      case "pages:updateContent": {
        const p = page();
        p.content = args.content as unknown[];
        p.contentText = args.text as string;
        p.updatedAt = ++this.now;
        return;
      }
      case "pages:updateDbProps":
        page().dbProps = args.dbProps as unknown[];
        return;
      case "pages:setRowProp": {
        const p = page();
        p.props = { ...(p.props ?? {}), [args.propId as string]: args.value };
        return;
      }
      case "pages:rename":
        page().title = args.title as string;
        return;
    }
    throw new Error(`unexpected mutation ${name}`);
  }
}

const TRANSCRIPT = [
  { type: "summary", summary: "irrelevant" },
  { type: "user", isMeta: true, message: { role: "user", content: "meta line" }, timestamp: "2026-09-27T10:00:00.000Z" },
  { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
  { type: "user", message: { role: "user", content: "How do I **log** chats into Vellum?\nSecond line." }, timestamp: "2026-09-27T10:00:01.000Z" },
  { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Let me look." }, { type: "tool_use", name: "Read", input: {} }] }, timestamp: "2026-09-27T10:00:02.000Z" },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "file contents" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Use an MCP server." }] }, timestamp: "2026-09-27T10:00:05.000Z" },
  "not json at all",
]
  .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
  .join("\n");

/* ------------------------------------------------------------------ */

describe("markdown ⇄ blocks", () => {
  test("emits complete BlockNote blocks with ids and inline runs", () => {
    const { blocks, text } = markdownToBlocks(
      "# Title\n\n- [x] done\n- [ ] todo\n* bullet\n2) second\n> quoted\n```js\nconst a = 1;\n```\n---\nplain **bold**",
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "checkListItem",
      "checkListItem",
      "bulletListItem",
      "numberedListItem",
      "quote",
      "codeBlock",
      "paragraph",
    ]);
    for (const b of blocks) {
      expect(typeof b.id).toBe("string");
      expect(b.children).toEqual([]);
      expect(b.content[0]).toMatchObject({ type: "text", styles: {} });
    }
    expect(blocks[0].props).toEqual({ level: 1 });
    expect(blocks[1].props).toEqual({ checked: true });
    expect(blocks[2].props).toEqual({ checked: false });
    expect(blocks[6].props).toEqual({ language: "js" });
    expect(blocks[6].content[0].text).toBe("const a = 1;");
    expect(text).toContain("Title done todo bullet second quoted const a = 1; plain **bold**");
  });

  test("heading levels beyond three clamp, search text is capped", () => {
    const { blocks } = markdownToBlocks("##### deep");
    expect(blocks[0].props).toEqual({ level: 3 });
    const long = markdownToBlocks("x".repeat(10_000));
    expect(long.text.length).toBe(8000);
    expect(extractText([{ type: "paragraph", content: "string form" }])).toBe("string form");
  });

  test("blocks read back as markdown, page links keep their id", () => {
    const { blocks } = markdownToBlocks("## Notes\n- one\n1. first\n- [ ] later");
    const md = blocksToMarkdown([
      ...blocks,
      { type: "pageLink", props: { pageId: "abc" }, content: [], children: [] },
      { type: "table", content: { rows: [{ cells: [{ content: [{ type: "text", text: "a" }] }, { content: [{ type: "text", text: "b" }] }] }] } },
    ]);
    expect(md).toBe("## Notes\n- one\n1. first\n- [ ] later\n[[page abc]]\n| a | b |\n| --- | --- |");
  });
});

describe("Claude Code transcripts", () => {
  test("keeps the conversation, drops the machinery", () => {
    const { messages, firstTs } = parseTranscript(TRANSCRIPT);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0].text).toBe("How do I **log** chats into Vellum?\nSecond line.");
    // Two assistant lines around a tool call fold into one reply.
    expect(messages[1].text).toBe("Let me look.\n\nUse an MCP server.");
    expect(firstTs).toBe("2026-09-27T10:00:01.000Z");
    expect(titleFromPrompt(messages[0].text)).toBe("How do I log chats into Vellum?");
    expect(titleFromPrompt("# " + "word ".repeat(40))).toMatch(/…$/);
    expect(titleFromPrompt("")).toBe("Untitled conversation");
  });

  test("renders turns as headings and elides the middle of huge sessions", () => {
    const md = transcriptToMarkdown(parseTranscript(TRANSCRIPT).messages);
    expect(md).toBe(
      "### You\n\nHow do I **log** chats into Vellum?\nSecond line.\n\n### Claude\n\nLet me look.\n\nUse an MCP server.",
    );
    const many = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      text: `turn ${i} ` + "x".repeat(100),
      ts: null,
    }));
    const clipped = transcriptToMarkdown(many, { maxBodyChars: 500, maxMessageChars: 50 });
    expect(clipped).toContain("turn 0");
    expect(clipped).toContain("turn 9");
    expect(clipped).toMatch(/> … \d+ earlier turns omitted/);
    expect(clipped).toContain("(message truncated)");
    expect(localDate("2026-09-27T10:00:00.000Z")).toMatch(/^2026-09-2[678]$/);
    expect(localDate("garbage")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("ClaudeLog", () => {
  test("creates the database with our columns and one row per conversation", async () => {
    const fake = new FakeVellum();
    const log = new ClaudeLog(fake as never);
    const first = await log.upsert({
      key: "sess-1",
      title: "Planning",
      summary: "We planned.",
      bodyMarkdown: "## Decisions\n- ship it",
      tags: ["Vellum", "planning"],
      source: "Claude Code",
      project: "vellum",
      date: "2026-09-28",
      device: "MacBook Pro",
    });
    expect(first.created).toBe(true);
    const db = [...fake.pages.values()].find((p) => p.type === "database");
    expect(db?.title).toBe(CLAUDE_DB_TITLE);
    expect(db?.parentId).toBeNull();
    // Starter columns replaced by ours, options minted for the selects.
    const cols = db?.dbProps as { id: string; options?: { id: string; name: string }[] }[];
    expect(cols.map((c) => c.id)).toEqual(COLUMNS.map((c) => c.id));
    expect(cols.find((c) => c.id === "device")?.options).toEqual([
      { id: "macbook-pro", name: "MacBook Pro", color: "gray" },
    ]);
    expect(cols.find((c) => c.id === "tags")?.options?.map((o) => o.name)).toEqual(["Vellum", "planning"]);
    expect(cols.every((c) => !("__dirty" in c))).toBe(true);

    const row = fake.pages.get(first.rowId)!;
    expect(row.parentId).toBe(db?._id);
    expect(row.title).toBe("Planning");
    expect(row.props).toEqual({
      date: "2026-09-28",
      device: "macbook-pro",
      source: "claude-code",
      project: "vellum",
      tags: ["vellum", "planning"],
      summary: "We planned.",
      session: "sess-1",
    });
    expect(row.contentText).toBe("Decisions ship it");

    // Same key again: the row is updated, never duplicated; an unchanged
    // transcript is not re-written.
    fake.log.length = 0;
    const again = await log.upsert({
      key: "sess-1",
      title: "Planning (renamed)",
      summary: "We planned.",
      bodyMarkdown: "## Decisions\n- ship it",
      tags: ["vellum"],
      source: "Claude Code",
      date: "2026-09-28",
      device: "MacBook Pro",
    });
    expect(again).toMatchObject({ rowId: first.rowId, created: false });
    expect(fake.pages.get(first.rowId)!.title).toBe("Planning (renamed)");
    expect(fake.pages.get(first.rowId)!.props!.tags).toEqual(["vellum"]);
    expect(fake.log).not.toContain("pages:updateContent");
    expect([...fake.pages.values()].filter((p) => p.parentId === db?._id)).toHaveLength(1);

    // No key: always a new row.
    const third = await log.upsert({ title: "Ad hoc", summary: "s", device: "Mac mini", source: "Claude Desktop", date: "2026-09-27" });
    expect(third.created).toBe(true);
    const rows = await log.listRows({});
    expect(rows.map((r) => r.title)).toEqual(["Planning (renamed)", "Ad hoc"]);
    expect(rows[0]).toMatchObject({ device: "MacBook Pro", source: "Claude Code", tags: ["Vellum"], key: "sess-1" }); // matched the existing option by name, case-insensitively
    expect(await log.listRows({ device: "mac mini" })).toHaveLength(1);
    expect(await log.listRows({ since: "2026-09-28" })).toHaveLength(1);
    expect(await log.listRows({ source: "Claude.ai" })).toHaveLength(0);
  });

  test("reuses an existing Claude database and re-adds a deleted column", async () => {
    const fake = new FakeVellum();
    const dbId = fake.seed({
      title: "claude",
      type: "database",
      dbProps: [
        { id: "date", name: "When", type: "date" },
        { id: "tags", name: "Tags", type: "multiSelect", options: [{ id: "x", name: "X", color: "red" }] },
        { id: "extra", name: "Mine", type: "text" },
      ],
    });
    fake.seed({ title: "Claude", type: "database", vault: true }); // never picked
    const log = new ClaudeLog(fake as never);
    const { id, dbProps } = await log.database();
    expect(id).toBe(dbId);
    const ids = (dbProps as { id: string; name: string }[]).map((c) => c.id);
    expect(ids).toEqual(["date", "tags", "extra", "device", "source", "project", "summary", "session"]);
    expect((dbProps as { id: string; name: string }[])[0].name).toBe("When"); // renames survive
    expect([...fake.pages.values()].filter((p) => p.type === "database")).toHaveLength(2);
  });

  test("update appends notes and refuses pages outside the database", async () => {
    const fake = new FakeVellum();
    const log = new ClaudeLog(fake as never);
    const { rowId } = await log.upsert({ title: "T", summary: "s", bodyMarkdown: "first", device: "d", source: "Other", date: "2026-01-01" });
    await log.update(rowId, { appendMarkdown: "- more", tags: ["new"] });
    const row = fake.pages.get(rowId)!;
    expect((row.content as { type: string }[]).map((b) => b.type)).toEqual(["paragraph", "bulletListItem"]);
    expect(row.contentText).toBe("first more");
    expect(row.props!.tags).toEqual(["new"]);
    await log.update(rowId, { replaceMarkdown: "# fresh" });
    expect(fake.pages.get(rowId)!.contentText).toBe("fresh");
    const stray = fake.seed({ title: "elsewhere", type: "doc" });
    await expect(log.update(stray, { title: "x" })).rejects.toThrow(/not a row/);
    expect(await log.readRow(rowId)).toEqual({ title: "T", markdown: "# fresh" });
  });
});

describe("MCP tools", () => {
  async function connect(fake: FakeVellum) {
    const server = new McpServer({ name: "test", version: "0" });
    registerVellumTools(server, { log: new ClaudeLog(fake as never), vellum: fake as never });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0" });
    await client.connect(clientTransport);
    return client;
  }

  test("exposes the tool set and logs through it", async () => {
    const fake = new FakeVellum();
    const client = await connect(fake);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "vellum_create_page",
      "vellum_list_conversations",
      "vellum_list_pages",
      "vellum_log_conversation",
      "vellum_read_page",
      "vellum_search",
      "vellum_update_conversation",
    ]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["log_this_conversation"]);

    const logged = await client.callTool({
      name: "vellum_log_conversation",
      arguments: {
        title: "Desktop chat",
        summary: "Talked about logging.",
        notes_markdown: "- [ ] wire the hook",
        tags: ["mcp"],
        conversation_key: "chat-42",
      },
    });
    const sc = logged.structuredContent as { row_id: string; created: boolean; url: string };
    expect(sc.created).toBe(true);
    expect(sc.url).toBe(`https://vellum.test/app#/page/${sc.row_id}`);
    const row = fake.pages.get(sc.row_id)!;
    // Defaults: today's date, this machine, Claude Desktop.
    expect(row.props).toMatchObject({ session: "chat-42", device: "test-mac", source: "claude-desktop" });
    expect(row.props!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const listed = await client.callTool({ name: "vellum_list_conversations", arguments: {} });
    expect((listed.structuredContent as { count: number }).count).toBe(1);

    const read = await client.callTool({ name: "vellum_read_page", arguments: { page_id: sc.row_id } });
    expect((read.structuredContent as { markdown: string }).markdown).toBe("- [ ] wire the hook");

    const found = await client.callTool({ name: "vellum_search", arguments: { query: "hook" } });
    expect((found.structuredContent as { count: number }).count).toBe(1);
  });

  test("errors are reported, never thrown; vault pages are refused", async () => {
    const fake = new FakeVellum();
    const secret = fake.seed({ title: "venc1:...", type: "doc", vault: true, content: [] });
    const client = await connect(fake);
    const refused = await client.callTool({ name: "vellum_read_page", arguments: { page_id: secret } });
    expect(refused.isError).toBe(true);
    expect((refused.content as { text: string }[])[0].text).toMatch(/Vault/);
    const missing = await client.callTool({ name: "vellum_read_page", arguments: { page_id: "nope" } });
    expect(missing.isError).toBe(true);
    // The outline never lists vault pages either.
    const outline = await client.callTool({ name: "vellum_list_pages", arguments: {} });
    expect((outline.structuredContent as { count: number }).count).toBe(0);
  });
});

describe("page deep links", () => {
  test("parseAnchor accepts page-only and block links", () => {
    expect(parseAnchor("#/page/abc")).toEqual({ pageId: "abc", blockId: null });
    expect(parseAnchor("#/page/abc/block/b1")).toEqual({ pageId: "abc", blockId: "b1" });
    expect(parseAnchor("#/page/abc/")).toBeNull();
    expect(parseAnchor("#/other")).toBeNull();
  });
});
