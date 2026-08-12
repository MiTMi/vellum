import { AgentOp } from "../../convex/lib/agentPlan";
import { Mutations } from "../data/api";
import { DbProp, PageDoc, PageId, SelectOption } from "./types";
import { markdownToBlocks } from "./markdownBlocks";
import { getActiveEditorFor } from "./editorRegistry";

/**
 * Executes an approved agent plan through the ordinary mutations
 * (docs/ai-agent-design.md) — every write hits the replica instantly,
 * queues in the outbox, and passes the normal server authorization. The
 * ops arrive validated (convex/lib/agentPlan.ts); this module's own
 * guards are the client-side belt: vault, viewer-role, trashed, and
 * missing targets fail their op with a readable reason.
 */

export interface ExecuteDeps {
  mutations: Mutations;
  getDoc: (id: PageId) => Promise<PageDoc | null>;
  /** The open page — what "current" resolves to. */
  currentPageId: PageId | null;
}

export interface ExecuteResult {
  /** Pages created, in op order — for the confirmation chips. */
  created: { pageId: PageId; title: string; icon: string | null }[];
  /** Ops that could not run, with why. Empty means a clean apply. */
  failures: { opIndex: number; reason: string }[];
}

const OPTION_COLORS = ["gray", "blue", "green", "yellow", "red", "purple", "pink", "orange"];

function slug(name: string, i: number): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return s ? `${s}-${i}` : `col-${i}`;
}

/** A writable existing target: present, a real page, and not read-only. */
async function writableDoc(
  deps: ExecuteDeps,
  id: PageId,
): Promise<{ doc: PageDoc } | { reason: string }> {
  const doc = await deps.getDoc(id);
  if (!doc) return { reason: "the target page no longer exists" };
  if (doc.vault) return { reason: "the target is in the Vault" };
  if (doc.role === "viewer") return { reason: "you can only view that page" };
  if (doc.inTrash) return { reason: "the target is in the Trash" };
  return { doc };
}

export async function executePlan(
  plan: AgentOp[],
  deps: ExecuteDeps,
): Promise<ExecuteResult> {
  const created: ExecuteResult["created"] = [];
  const failures: ExecuteResult["failures"] = [];
  /** Op index → created page id, for "#n" refs. */
  const refIds = new Map<number, PageId>();
  /** Database id → its evolving dbProps (options minted as rows land). */
  const dbSchemas = new Map<PageId, { props: DbProp[]; dirty: boolean }>();

  const resolveParent = (
    parent: "current" | "root" | `#${number}`,
  ): { parentId: PageId | undefined } | { reason: string } => {
    if (parent === "root") return { parentId: undefined };
    if (parent === "current") {
      if (!deps.currentPageId) return { reason: "no page is open" };
      return { parentId: deps.currentPageId };
    }
    const id = refIds.get(Number(parent.slice(1)));
    if (!id) return { reason: "an earlier step failed" };
    return { parentId: id };
  };

  for (let i = 0; i < plan.length; i++) {
    const op = plan[i];
    try {
      switch (op.kind) {
        case "createPage": {
          const parent = resolveParent(op.parent);
          if ("reason" in parent) {
            failures.push({ opIndex: i, reason: parent.reason });
            break;
          }
          if (parent.parentId) {
            const target = await writableDoc(deps, parent.parentId);
            if ("reason" in target) {
              failures.push({ opIndex: i, reason: target.reason });
              break;
            }
          }
          const id = await deps.mutations.create({
            parentId: parent.parentId,
            type: "doc",
            title: op.title,
            icon: op.icon,
          });
          if (op.markdown) {
            const { blocks, text } = markdownToBlocks(op.markdown);
            if (blocks.length > 0) {
              await deps.mutations.updateContent({ id, content: blocks, text });
            }
          }
          refIds.set(i, id);
          created.push({ pageId: id, title: op.title, icon: op.icon ?? null });
          break;
        }

        case "createDatabase": {
          const parent = resolveParent(op.parent);
          if ("reason" in parent) {
            failures.push({ opIndex: i, reason: parent.reason });
            break;
          }
          if (parent.parentId) {
            const target = await writableDoc(deps, parent.parentId);
            if ("reason" in target) {
              failures.push({ opIndex: i, reason: target.reason });
              break;
            }
          }
          const id = await deps.mutations.create({
            parentId: parent.parentId,
            type: "database",
            title: op.title,
            icon: op.icon,
          });
          const props: DbProp[] = op.columns.map((col, ci) => ({
            id: slug(col.name, ci),
            name: col.name,
            type: col.type,
            options:
              col.type === "select" || col.type === "multiSelect"
                ? (col.options ?? []).map((name, oi) => ({
                    id: slug(name, oi),
                    name,
                    color: OPTION_COLORS[oi % OPTION_COLORS.length],
                  }))
                : undefined,
          }));
          // `create` seeds default columns; replace them wholesale.
          await deps.mutations.updateDbProps({ id, dbProps: props });
          dbSchemas.set(id, { props, dirty: false });
          refIds.set(i, id);
          created.push({ pageId: id, title: op.title, icon: op.icon ?? null });
          break;
        }

        case "addRow": {
          let dbId: PageId;
          if (/^#\d+$/.test(op.target)) {
            const id = refIds.get(Number(op.target.slice(1)));
            if (!id) {
              failures.push({ opIndex: i, reason: "an earlier step failed" });
              break;
            }
            dbId = id;
          } else {
            dbId = op.target as PageId;
          }
          // Schema: from this plan's own creation, or read from the target.
          let schema = dbSchemas.get(dbId);
          if (!schema) {
            const target = await writableDoc(deps, dbId);
            if ("reason" in target) {
              failures.push({ opIndex: i, reason: target.reason });
              break;
            }
            if (target.doc.type !== "database") {
              failures.push({ opIndex: i, reason: "the target is not a database" });
              break;
            }
            schema = { props: structuredClone(target.doc.dbProps ?? []), dirty: false };
            dbSchemas.set(dbId, schema);
          }

          // Plan props are keyed by column NAME; rows store them by id.
          const props: Record<string, unknown> = {};
          for (const [name, value] of Object.entries(op.props ?? {})) {
            const col = schema.props.find(
              (c) => c.name.toLowerCase() === name.toLowerCase(),
            );
            if (!col) continue; // unknown column: skip the value, keep the row
            if (col.type === "select" || col.type === "multiSelect") {
              const wanted = Array.isArray(value) ? value : [String(value)];
              const ids: string[] = [];
              for (const optionName of wanted) {
                let opt = (col.options ?? []).find(
                  (o) => o.name.toLowerCase() === optionName.toLowerCase(),
                );
                if (!opt) {
                  opt = {
                    id: slug(optionName, (col.options ?? []).length),
                    name: optionName,
                    color: OPTION_COLORS[(col.options ?? []).length % OPTION_COLORS.length],
                  } as SelectOption;
                  col.options = [...(col.options ?? []), opt];
                  schema.dirty = true;
                }
                ids.push(opt.id);
              }
              props[col.id] = col.type === "select" ? ids[0] : ids;
            } else if (col.type === "checkbox") {
              props[col.id] = value === true || value === "true";
            } else if (col.type === "number") {
              const n = typeof value === "number" ? value : Number(value);
              if (!Number.isNaN(n)) props[col.id] = n;
            } else {
              props[col.id] = String(value);
            }
          }

          const rowId = await deps.mutations.create({
            parentId: dbId,
            type: "doc",
            title: op.title,
            props: Object.keys(props).length > 0 ? props : undefined,
          });
          refIds.set(i, rowId);
          break;
        }

        case "appendToPage": {
          const targetId =
            op.target === "current" ? deps.currentPageId : (op.target as PageId);
          if (!targetId) {
            failures.push({ opIndex: i, reason: "no page is open" });
            break;
          }
          // Pending debounced editor changes must reach the replica before
          // we read it, or the append would clobber the last keystrokes —
          // same mechanism the id-remap path uses.
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("vellum:flush-edits"));
          }
          const target = await writableDoc(deps, targetId);
          if ("reason" in target) {
            failures.push({ opIndex: i, reason: target.reason });
            break;
          }
          const { blocks, text } = markdownToBlocks(op.markdown);
          if (blocks.length === 0) break;
          const existing = Array.isArray(target.doc.content)
            ? (target.doc.content as unknown[])
            : [];
          const combined = [...existing, ...blocks];
          const combinedText = [target.doc.contentText ?? "", text]
            .filter(Boolean)
            .join("\n");
          await deps.mutations.updateContent({
            id: targetId,
            content: combined,
            text: combinedText,
          });
          // A mounted BlockNote never re-reads the replica (the History-
          // Modal rule) — repaint it through the registry.
          const editor = getActiveEditorFor(targetId);
          if (editor) editor.replaceBlocks(editor.document, combined);
          break;
        }
      }
    } catch (err) {
      failures.push({
        opIndex: i,
        reason: err instanceof Error ? err.message : "unexpected error",
      });
    }
  }

  // Options minted while adding rows — persist each touched schema once.
  for (const [dbId, schema] of dbSchemas) {
    if (schema.dirty) {
      try {
        await deps.mutations.updateDbProps({ id: dbId, dbProps: schema.props });
      } catch {
        /* rows still landed; chips render once a later edit syncs */
      }
    }
  }

  return { created, failures };
}

/** One plain-language line per op, for the plan card. */
export function describeOp(op: AgentOp): string {
  switch (op.kind) {
    case "createPage":
      return `Create page “${op.title}”${op.parent === "current" ? " inside the open page" : ""}${op.markdown ? " with content" : ""}`;
    case "createDatabase":
      return `Create database “${op.title}” with ${op.columns.length} column${op.columns.length === 1 ? "" : "s"}`;
    case "addRow":
      return `Add row “${op.title}”`;
    case "appendToPage":
      return op.target === "current"
        ? "Append to the open page"
        : "Append to an existing page";
  }
}
