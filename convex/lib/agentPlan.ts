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
/** The first complete, brace-balanced JSON object in `t` at or after
 *  `from`, or null. String-aware, so braces inside quoted values don't
 *  confuse it. */
function firstJsonObject(t: string, from = 0): string | null {
  const start = t.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = inString;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return t.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Parse attempts per reply. Broken JSON with markdown/code inside can
 *  hold many `{`s; parsing is cheap but bound it anyway. */
const MAX_PARSE_CANDIDATES = 40;

export function parseAgentJson(
  text: string,
  /** When set, a candidate only counts if it carries at least one of
   *  these top-level keys. This is what lets the scan skip nested
   *  fragments (a plan step parses as an object too) while hunting for
   *  a real protocol message in a partially broken reply. */
  requiredKeys?: string[],
): Record<string, unknown> | null {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  const accept = (parsed: unknown): Record<string, unknown> | null => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (requiredKeys && !requiredKeys.some((k) => k in obj)) return null;
    return obj;
  };
  // Whole text first; then every balanced object, front to back — models
  // sometimes emit a tool call AND a final reply in one turn, or a broken
  // object followed by a valid one (both observed live). Taking the first
  // acceptable candidate means a tool call executes before a premature
  // reply, and a valid later object survives a garbled earlier one.
  try {
    const whole = accept(JSON.parse(t) as unknown);
    if (whole) return whole;
  } catch {
    /* fall through to the scan */
  }
  let from = 0;
  for (let n = 0; n < MAX_PARSE_CANDIDATES; n++) {
    const start = t.indexOf("{", from);
    if (start === -1) break;
    const span = firstJsonObject(t, start);
    if (span) {
      try {
        const parsed = accept(JSON.parse(span) as unknown);
        if (parsed) return parsed;
      } catch {
        /* try the next opening brace */
      }
    }
    from = start + 1;
  }
  return null;
}

/**
 * Last-resort extraction of the user-facing reply from a protocol-shaped
 * message that failed every parse — flash-lite sometimes leaves inner
 * quotes unescaped inside the reply string (observed live 2026-08-15),
 * which poisons the whole object. Null when the text doesn't look like
 * the protocol at all (a plain-prose reply must pass through untouched).
 */
export function salvageAgentReply(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("{") || !/"reply"\s*:/.test(t)) return null;
  // Up to the next protocol key or the closing brace — non-greedy, so
  // stray unescaped quotes inside the reply are captured rather than
  // terminating it.
  const m =
    t.match(/"reply"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:plan|tool)"/) ??
    t.match(/"reply"\s*:\s*"([\s\S]*?)"\s*\}/);
  if (!m || !m[1].trim()) return null;
  // Single pass — sequential replaces would let a literal backslash bleed
  // into the next escape (`\\n` in the raw JSON is a backslash then "n",
  // not a newline).
  return m[1]
    .replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c))
    .trim();
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

    // flash-lite omits `parent` on create steps at low temperature even
    // though the prompt spells it out (observed live 2026-08-15, 4/4 on
    // prod). A missing parent means "nowhere special" — default it to the
    // workspace root rather than rejecting the whole plan. Written onto
    // the op because the executor consumes this same object.
    if (
      (op.kind === "createPage" || op.kind === "createDatabase") &&
      op.parent == null
    ) {
      op.parent = "root";
    }

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
