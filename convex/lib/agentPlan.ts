/**
 * The AI workspace agent's plan vocabulary (docs/ai-agent-design.md).
 *
 * Four ops, all additive — no update, no move, no trash. That is not a
 * v1 restriction hidden behind a flag: the vocabulary simply cannot
 * express destructive actions, so no prompt injection can reach them.
 *
 * Pure module (like snippet.ts / pageLinks.ts): the server validates
 * plans with it before returning them, the client executor consumes the
 * same types, and the unit tests exercise it directly.
 */

export type AgentColumnType =
  | "text"
  | "number"
  | "select"
  | "multiSelect"
  | "date"
  | "checkbox"
  | "url";

export interface AgentColumn {
  name: string;
  type: AgentColumnType;
  options?: string[];
}

export type AgentRef = `#${number}`;

export type AgentOp =
  | {
      kind: "createPage";
      title: string;
      icon?: string;
      parent: "current" | "root" | AgentRef;
      markdown?: string;
    }
  | {
      kind: "createDatabase";
      title: string;
      icon?: string;
      parent: "current" | "root";
      columns: AgentColumn[];
    }
  | {
      kind: "addRow";
      target: AgentRef | string; // ref to a createDatabase op, or a page id
      title: string;
      props?: Record<string, string | number | boolean | string[]>;
    }
  | {
      kind: "appendToPage";
      target: "current" | string;
      markdown: string;
    };

export const MAX_PLAN_OPS = 20;
const MAX_TITLE_CHARS = 300;
const MAX_MARKDOWN_CHARS = 20_000;
const MAX_COLUMNS = 20;
const MAX_OPTIONS = 30;

const COLUMN_TYPES: readonly string[] = [
  "text",
  "number",
  "select",
  "multiSelect",
  "date",
  "checkbox",
  "url",
];

/**
 * Extract one JSON object from a model reply. Strips markdown fences
 * (flash-lite loves wrapping JSON) and falls back to the outermost
 * brace span. Null means "this is not JSON" — callers treat the text
 * as a plain reply, never as an error.
 */
export function parseAgentJson(text: string): Record<string, unknown> | null {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  const candidates = [t];
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first > 0 || (first === 0 && last !== t.length - 1)) {
    if (first !== -1 && last > first) candidates.push(t.slice(first, last + 1));
  }
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function isRef(v: unknown): v is AgentRef {
  return typeof v === "string" && /^#\d+$/.test(v);
}

function refIndex(ref: AgentRef): number {
  return Number(ref.slice(1));
}

function isShortString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

export type PlanValidation =
  | { ok: true; plan: AgentOp[] }
  | { ok: false; error: string };

/**
 * Validate a raw plan from the model. Whole-plan reject on any invalid
 * op — a partially-applied hallucination is worse than no plan (the
 * reply text still reaches the user either way).
 */
export function validatePlan(raw: unknown): PlanValidation {
  if (!Array.isArray(raw)) return { ok: false, error: "plan is not a list" };
  if (raw.length === 0) return { ok: false, error: "plan is empty" };
  if (raw.length > MAX_PLAN_OPS) {
    return { ok: false, error: `plan exceeds ${MAX_PLAN_OPS} steps` };
  }

  const kinds: string[] = [];
  const fail = (i: number, why: string): PlanValidation => ({
    ok: false,
    error: `step ${i + 1}: ${why}`,
  });

  for (let i = 0; i < raw.length; i++) {
    const op = raw[i] as Record<string, unknown>;
    if (!op || typeof op !== "object") return fail(i, "not an object");

    // A ref must point strictly backwards, at an op of the right kind.
    const checkRef = (ref: AgentRef, allowed: string[]): string | null => {
      const idx = refIndex(ref);
      if (idx >= i) return "reference points forward";
      if (!allowed.includes(kinds[idx])) {
        return `reference targets a ${kinds[idx]} step`;
      }
      return null;
    };

    switch (op.kind) {
      case "createPage": {
        if (!isShortString(op.title, MAX_TITLE_CHARS)) return fail(i, "bad title");
        if (op.icon !== undefined && !isShortString(op.icon, 16)) return fail(i, "bad icon");
        if (op.parent !== "current" && op.parent !== "root") {
          if (!isRef(op.parent)) return fail(i, "bad parent");
          const err = checkRef(op.parent, ["createPage", "createDatabase"]);
          if (err) return fail(i, err);
        }
        if (op.markdown !== undefined && (typeof op.markdown !== "string" || op.markdown.length > MAX_MARKDOWN_CHARS)) {
          return fail(i, "bad markdown");
        }
        break;
      }
      case "createDatabase": {
        if (!isShortString(op.title, MAX_TITLE_CHARS)) return fail(i, "bad title");
        if (op.icon !== undefined && !isShortString(op.icon, 16)) return fail(i, "bad icon");
        if (op.parent !== "current" && op.parent !== "root") return fail(i, "bad parent");
        if (!Array.isArray(op.columns) || op.columns.length === 0 || op.columns.length > MAX_COLUMNS) {
          return fail(i, "bad columns");
        }
        for (const col of op.columns as Record<string, unknown>[]) {
          if (!col || typeof col !== "object") return fail(i, "bad column");
          if (!isShortString(col.name, 100)) return fail(i, "bad column name");
          if (typeof col.type !== "string" || !COLUMN_TYPES.includes(col.type)) {
            return fail(i, `bad column type "${String(col.type)}"`);
          }
          if (col.options !== undefined) {
            if (!Array.isArray(col.options) || col.options.length > MAX_OPTIONS) {
              return fail(i, "bad column options");
            }
            if (!(col.options as unknown[]).every((o) => isShortString(o, 100))) {
              return fail(i, "bad column option");
            }
          }
        }
        break;
      }
      case "addRow": {
        if (isRef(op.target)) {
          const err = checkRef(op.target, ["createDatabase"]);
          if (err) return fail(i, err);
        } else if (typeof op.target !== "string" || !op.target.trim()) {
          return fail(i, "bad target");
        }
        if (typeof op.title !== "string" || op.title.length > MAX_TITLE_CHARS) {
          return fail(i, "bad title");
        }
        if (op.props !== undefined) {
          if (!op.props || typeof op.props !== "object" || Array.isArray(op.props)) {
            return fail(i, "bad props");
          }
          for (const v of Object.values(op.props as Record<string, unknown>)) {
            const okScalar =
              typeof v === "string" || typeof v === "number" || typeof v === "boolean";
            const okList = Array.isArray(v) && v.every((x) => typeof x === "string");
            if (!okScalar && !okList) return fail(i, "bad prop value");
          }
        }
        break;
      }
      case "appendToPage": {
        if (op.target !== "current" && (typeof op.target !== "string" || !op.target.trim())) {
          return fail(i, "bad target");
        }
        if (!isShortString(op.markdown, MAX_MARKDOWN_CHARS)) return fail(i, "bad markdown");
        break;
      }
      default:
        return fail(i, `unknown kind "${String(op.kind)}"`);
    }
    kinds.push(op.kind as string);
  }

  return { ok: true, plan: raw as AgentOp[] };
}
