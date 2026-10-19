/**
 * The "Claude" database: one row per conversation.
 *
 * Found (or created) by title at the root of the signed-in user's
 * workspace, with a fixed set of columns keyed by stable ids — so a user
 * renaming "Summary" to "TL;DR" in the app keeps working, and a column
 * they deleted is quietly re-added on the next log. Rows are ordinary
 * pages under the database: title = the conversation's title, props = the
 * cells, content = the notes or transcript.
 *
 * Rows are upserted on a caller-supplied key (the Claude Code session id,
 * or whatever Claude Desktop passes as `conversation_key`) held in the
 * Session column, so a session that fires the hook on every turn keeps
 * updating one row instead of minting a new one each time.
 */
import { blocksToMarkdown, extractText, markdownToBlocks } from "./blocks.mjs";

export const CLAUDE_DB_TITLE = "Claude";
export const CLAUDE_DB_ICON = "✳️";

/** Column definitions; ids are the contract, names are just the default label. */
export const COLUMNS = [
  { id: "date", name: "Date", type: "date" },
  { id: "device", name: "Device", type: "select", options: [] },
  { id: "source", name: "Source", type: "select", options: [] },
  { id: "project", name: "Project", type: "text" },
  { id: "tags", name: "Tags", type: "multiSelect", options: [] },
  { id: "summary", name: "Summary", type: "text" },
  { id: "session", name: "Session", type: "text" },
];

const OPTION_COLORS = ["gray", "blue", "green", "yellow", "red", "purple", "pink", "orange"];

export const SOURCES = ["Claude Desktop", "Claude Code", "Claude.ai", "Other"];

function slug(name, taken) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "opt";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Find an option by name (case-insensitive) or mint one. Mutates `col`. */
function optionId(col, name) {
  const wanted = String(name).trim();
  if (!wanted) return null;
  col.options ??= [];
  const found = col.options.find((o) => o.name.toLowerCase() === wanted.toLowerCase());
  if (found) return found.id;
  const opt = {
    id: slug(wanted, new Set(col.options.map((o) => o.id))),
    name: wanted,
    color: OPTION_COLORS[col.options.length % OPTION_COLORS.length],
  };
  col.options.push(opt);
  col.__dirty = true;
  return opt.id;
}

function optionName(col, id) {
  return col?.options?.find((o) => o.id === id)?.name ?? (id == null ? null : String(id));
}

export class ClaudeLog {
  /** @param {import("./vellum.mjs").VellumClient} vellum */
  constructor(vellum) {
    this.vellum = vellum;
    this.dbId = null;
  }

  /** The database's id and current schema, creating it on first use. */
  async database() {
    if (!this.dbId) {
      const pages = await this.vellum.query("pages:list");
      const existing = pages.find(
        (p) =>
          p.type === "database" &&
          !p.vault &&
          p.parentId === null &&
          p.title.trim().toLowerCase() === CLAUDE_DB_TITLE.toLowerCase(),
      );
      this.dbId = existing
        ? existing._id
        : await this.vellum.mutation("pages:create", {
            type: "database",
            title: CLAUDE_DB_TITLE,
            icon: CLAUDE_DB_ICON,
          });
    }
    const doc = await this.vellum.query("pages:get", { id: this.dbId });
    if (!doc || doc.type !== "database") {
      // Deleted or trashed since we cached it — start over once.
      this.dbId = null;
      throw new Error("The Claude database disappeared; retry the call");
    }
    let dbProps = structuredClone(doc.dbProps ?? []);
    let changed = false;
    if (doc.dbProps === undefined || !dbProps.some((c) => COLUMNS.some((k) => k.id === c.id))) {
      // A freshly created database carries the app's Status/Tags/Date
      // starter columns; replace them with ours before any row exists.
      dbProps = structuredClone(COLUMNS);
      changed = true;
    } else {
      for (const col of COLUMNS) {
        if (!dbProps.some((c) => c.id === col.id)) {
          dbProps.push(structuredClone(col));
          changed = true;
        }
      }
    }
    if (changed) await this.vellum.mutation("pages:updateDbProps", { id: this.dbId, dbProps });
    return { id: this.dbId, dbProps };
  }

  /** Cell values (by column id) from human-facing fields; mints options. */
  buildProps(dbProps, fields) {
    const props = {};
    const col = (id) => dbProps.find((c) => c.id === id);
    if (fields.date) props.date = fields.date;
    if (fields.device) props.device = optionId(col("device"), fields.device);
    if (fields.source) props.source = optionId(col("source"), fields.source);
    if (fields.project) props.project = String(fields.project);
    if (fields.tags) {
      const ids = fields.tags.map((t) => optionId(col("tags"), t)).filter(Boolean);
      props.tags = [...new Set(ids)];
    }
    if (fields.summary !== undefined) props.summary = String(fields.summary);
    if (fields.key) props.session = String(fields.key);
    const dirty = dbProps.some((c) => c.__dirty);
    for (const c of dbProps) delete c.__dirty;
    return { props, dirty };
  }

  async findRow(dbId, key) {
    if (!key) return null;
    const pages = await this.vellum.query("pages:list");
    return pages.find((p) => p.parentId === dbId && p.props?.session === key) ?? null;
  }

  /**
   * Create or update the row for a conversation.
   * @returns {Promise<{rowId: string, url: string, created: boolean}>}
   */
  async upsert(fields) {
    const { id: dbId, dbProps } = await this.database();
    const existing = await this.findRow(dbId, fields.key);
    const { props, dirty } = this.buildProps(dbProps, fields);
    if (dirty) await this.vellum.mutation("pages:updateDbProps", { id: dbId, dbProps });

    const body = fields.bodyMarkdown ? markdownToBlocks(fields.bodyMarkdown) : null;

    if (!existing) {
      const rowId = await this.vellum.mutation("pages:create", {
        parentId: dbId,
        type: "doc",
        title: fields.title,
        icon: fields.icon,
        props,
      });
      if (body && body.blocks.length) {
        await this.vellum.mutation("pages:updateContent", {
          id: rowId,
          content: body.blocks,
          text: body.text,
        });
      }
      return { rowId, url: this.vellum.pageUrl(rowId), created: true };
    }

    const rowId = existing._id;
    if (fields.title && fields.title !== existing.title) {
      await this.vellum.mutation("pages:rename", { id: rowId, title: fields.title });
    }
    for (const [propId, value] of Object.entries(props)) {
      const before = existing.props?.[propId];
      if (JSON.stringify(before) !== JSON.stringify(value)) {
        await this.vellum.mutation("pages:setRowProp", { id: rowId, propId, value });
      }
    }
    if (body && body.blocks.length) {
      // Skip the write when nothing changed: the hook re-sends the whole
      // transcript on every turn, and an identical save would only churn
      // page history and every device's sync.
      const current = await this.vellum.query("pages:get", { id: rowId });
      if (!current || current.contentText !== body.text) {
        await this.vellum.mutation("pages:updateContent", {
          id: rowId,
          content: body.blocks,
          text: body.text,
        });
      }
    }
    return { rowId, url: this.vellum.pageUrl(rowId), created: false };
  }

  /** Update a row's fields and/or append notes. */
  async update(rowId, changes) {
    const { id: dbId, dbProps } = await this.database();
    const row = await this.vellum.query("pages:get", { id: rowId });
    if (!row || row.parentId !== dbId) {
      throw new Error("That id is not a row of the Claude database (use vellum_list_conversations to find one)");
    }
    const { props, dirty } = this.buildProps(dbProps, changes);
    if (dirty) await this.vellum.mutation("pages:updateDbProps", { id: dbId, dbProps });
    if (changes.title && changes.title !== row.title) {
      await this.vellum.mutation("pages:rename", { id: rowId, title: changes.title });
    }
    for (const [propId, value] of Object.entries(props)) {
      await this.vellum.mutation("pages:setRowProp", { id: rowId, propId, value });
    }
    if (changes.replaceMarkdown !== undefined) {
      const { blocks, text } = markdownToBlocks(changes.replaceMarkdown);
      await this.vellum.mutation("pages:updateContent", { id: rowId, content: blocks, text });
    } else if (changes.appendMarkdown) {
      const { blocks } = markdownToBlocks(changes.appendMarkdown);
      const content = [...(Array.isArray(row.content) ? row.content : []), ...blocks];
      await this.vellum.mutation("pages:updateContent", {
        id: rowId,
        content,
        text: extractText(content),
      });
    }
    return { rowId, url: this.vellum.pageUrl(rowId) };
  }

  /** Rows, newest first, as plain fields. */
  async listRows(filter = {}) {
    const { id: dbId, dbProps } = await this.database();
    const col = (id) => dbProps.find((c) => c.id === id);
    const pages = await this.vellum.query("pages:list");
    let rows = pages
      .filter((p) => p.parentId === dbId)
      .map((p) => ({
        id: p._id,
        title: p.title,
        date: p.props?.date ?? null,
        device: optionName(col("device"), p.props?.device),
        source: optionName(col("source"), p.props?.source),
        project: p.props?.project ?? null,
        tags: (p.props?.tags ?? []).map((t) => optionName(col("tags"), t)),
        summary: p.props?.summary ?? null,
        key: p.props?.session ?? null,
        updatedAt: new Date(p.updatedAt).toISOString(),
        url: this.vellum.pageUrl(p._id),
      }));
    if (filter.device) rows = rows.filter((r) => r.device?.toLowerCase() === filter.device.toLowerCase());
    if (filter.source) rows = rows.filter((r) => r.source?.toLowerCase() === filter.source.toLowerCase());
    if (filter.since) rows = rows.filter((r) => (r.date ?? "") >= filter.since);
    if (filter.project) rows = rows.filter((r) => r.project?.toLowerCase() === filter.project.toLowerCase());
    rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.updatedAt.localeCompare(a.updatedAt));
    return rows.slice(0, filter.limit ?? 20);
  }

  /** A row's notes as Markdown. */
  async readRow(rowId) {
    const row = await this.vellum.query("pages:get", { id: rowId });
    if (!row) return null;
    return { title: row.title, markdown: blocksToMarkdown(row.content) };
  }
}
