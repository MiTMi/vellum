/**
 * The little expression language behind formula properties.
 *
 * Notion's formulas, scoped to what this app can support: reference other
 * properties with `prop("Name")`, combine them with arithmetic, comparisons
 * and a handful of functions. Deliberately a hand-written tokenizer +
 * precedence-climbing parser rather than anything that reaches `eval` — the
 * expression is user input that runs on every render, so it must never be
 * able to touch the page or the network.
 *
 * Pure and dependency-free; see tests/formula.test.ts.
 */

export type FormulaValue = number | string | boolean | null;

/* ----------------------------- tokenizer ----------------------------- */

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string }
  | { kind: "end" };

const OPERATORS = [
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "<",
  ">",
  "=",
  "(",
  ")",
  ",",
  "!",
];

class FormulaError extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      const n = Number(raw);
      if (Number.isNaN(n)) throw new FormulaError(`Bad number "${raw}"`);
      out.push({ kind: "num", value: n });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          value += src[j + 1];
          j += 2;
        } else {
          value += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new FormulaError("Unterminated string");
      out.push({ kind: "str", value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ kind: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPERATORS.includes(two)) {
      out.push({ kind: "op", value: two });
      i += 2;
      continue;
    }
    if (OPERATORS.includes(c)) {
      out.push({ kind: "op", value: c });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character "${c}"`);
  }
  out.push({ kind: "end" });
  return out;
}

/* ------------------------------- AST -------------------------------- */

type Node =
  | { type: "lit"; value: FormulaValue }
  | { type: "unary"; op: string; arg: Node }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "call"; name: string; args: Node[] };

// Higher binds tighter. "=" is accepted as an alias for "==".
const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "=": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "^": 7,
};

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpression(minPrec = 0): Node {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t.kind !== "op") break;
      const prec = BINARY_PRECEDENCE[t.value];
      if (prec === undefined || prec < minPrec) break;
      next();
      // "^" is right-associative; everything else binds left to right.
      const right = parseExpression(t.value === "^" ? prec : prec + 1);
      left = { type: "binary", op: t.value === "=" ? "==" : t.value, left, right };
    }
    return left;
  }

  function parseUnary(): Node {
    const t = peek();
    if (t.kind === "op" && (t.value === "-" || t.value === "!")) {
      next();
      return { type: "unary", op: t.value, arg: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): Node {
    const t = next();
    if (t.kind === "num" || t.kind === "str") {
      return { type: "lit", value: t.value };
    }
    if (t.kind === "ident") {
      const lower = t.value.toLowerCase();
      if (lower === "true") return { type: "lit", value: true };
      if (lower === "false") return { type: "lit", value: false };
      const after = peek();
      if (after.kind === "op" && after.value === "(") {
        next();
        const args: Node[] = [];
        if (!(peek().kind === "op" && (peek() as { value: string }).value === ")")) {
          for (;;) {
            args.push(parseExpression());
            const sep = peek();
            if (sep.kind === "op" && sep.value === ",") {
              next();
              continue;
            }
            break;
          }
        }
        const close = next();
        if (close.kind !== "op" || close.value !== ")") {
          throw new FormulaError(`Missing ")" after ${t.value}(`);
        }
        return { type: "call", name: lower, args };
      }
      throw new FormulaError(
        `Unknown name "${t.value}" — reference properties with prop("Name")`,
      );
    }
    if (t.kind === "op" && t.value === "(") {
      const inner = parseExpression();
      const close = next();
      if (close.kind !== "op" || close.value !== ")") {
        throw new FormulaError('Missing ")"');
      }
      return inner;
    }
    throw new FormulaError("Unexpected end of formula");
  }

  const node = parseExpression();
  if (peek().kind !== "end") throw new FormulaError("Unexpected trailing input");
  return node;
}

/* ----------------------------- evaluation ---------------------------- */

const num = (v: FormulaValue): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === "") return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};

const str = (v: FormulaValue): string => {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
};

const truthy = (v: FormulaValue): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v !== null && v !== "";
};

const DAY_MS = 86_400_000;

/** Dates are "YYYY-MM-DD" strings; parsed as local midnight, never UTC. */
function toDate(v: FormulaValue): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = new Date(`${v.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface FormulaContext {
  /** Resolve `prop("Name")`; return null when the property has no value. */
  prop: (name: string) => FormulaValue;
  /** Injected so results stay deterministic in tests. */
  now?: Date;
}

function evaluate(node: Node, ctx: FormulaContext): FormulaValue {
  switch (node.type) {
    case "lit":
      return node.value;

    case "unary": {
      const v = evaluate(node.arg, ctx);
      return node.op === "-" ? -num(v) : !truthy(v);
    }

    case "binary": {
      const { op } = node;
      // Short-circuit before evaluating the right side.
      if (op === "&&") {
        const l = evaluate(node.left, ctx);
        return truthy(l) ? truthy(evaluate(node.right, ctx)) : false;
      }
      if (op === "||") {
        const l = evaluate(node.left, ctx);
        return truthy(l) ? true : truthy(evaluate(node.right, ctx));
      }
      const l = evaluate(node.left, ctx);
      const r = evaluate(node.right, ctx);
      switch (op) {
        case "+":
          // "+" concatenates when either side is a non-numeric string,
          // matching what people expect from a spreadsheet-ish language.
          if (typeof l === "string" || typeof r === "string") {
            const bothNumeric =
              (typeof l !== "string" || l.trim() !== "") &&
              (typeof r !== "string" || r.trim() !== "") &&
              !Number.isNaN(Number(l)) &&
              !Number.isNaN(Number(r));
            if (!bothNumeric) return str(l) + str(r);
          }
          return num(l) + num(r);
        case "-":
          return num(l) - num(r);
        case "*":
          return num(l) * num(r);
        case "/":
          return num(r) === 0 ? null : num(l) / num(r);
        case "%":
          return num(r) === 0 ? null : num(l) % num(r);
        case "^":
          return num(l) ** num(r);
        case "==":
          return typeof l === "string" || typeof r === "string"
            ? str(l) === str(r)
            : num(l) === num(r);
        case "!=":
          return typeof l === "string" || typeof r === "string"
            ? str(l) !== str(r)
            : num(l) !== num(r);
        case "<":
          return typeof l === "string" && typeof r === "string"
            ? l < r
            : num(l) < num(r);
        case "<=":
          return typeof l === "string" && typeof r === "string"
            ? l <= r
            : num(l) <= num(r);
        case ">":
          return typeof l === "string" && typeof r === "string"
            ? l > r
            : num(l) > num(r);
        case ">=":
          return typeof l === "string" && typeof r === "string"
            ? l >= r
            : num(l) >= num(r);
        default:
          throw new FormulaError(`Unknown operator "${op}"`);
      }
    }

    case "call": {
      const a = (i: number) => evaluate(node.args[i], ctx);
      const arity = (n: number) => {
        if (node.args.length !== n) {
          throw new FormulaError(`${node.name}() takes ${n} argument(s)`);
        }
      };
      switch (node.name) {
        case "prop": {
          arity(1);
          const name = a(0);
          if (typeof name !== "string") {
            throw new FormulaError('prop() needs a quoted name, e.g. prop("Price")');
          }
          return ctx.prop(name);
        }
        case "if":
          arity(3);
          return truthy(a(0)) ? a(1) : a(2);
        case "empty":
          arity(1);
          return !truthy(a(0));
        case "not":
          arity(1);
          return !truthy(a(0));
        case "concat":
          return node.args.map((_, i) => str(a(i))).join("");
        case "join": {
          if (!node.args.length) return "";
          const sep = str(a(0));
          return node.args
            .slice(1)
            .map((_, i) => str(a(i + 1)))
            .filter((s) => s !== "")
            .join(sep);
        }
        case "length":
          arity(1);
          return str(a(0)).length;
        case "lower":
          arity(1);
          return str(a(0)).toLowerCase();
        case "upper":
          arity(1);
          return str(a(0)).toUpperCase();
        case "contains":
          arity(2);
          return str(a(0)).includes(str(a(1)));
        case "replace":
          arity(3);
          return str(a(0)).split(str(a(1))).join(str(a(2)));
        case "slice": {
          const s = str(a(0));
          const from = num(a(1));
          return node.args.length > 2 ? s.slice(from, num(a(2))) : s.slice(from);
        }
        case "abs":
          arity(1);
          return Math.abs(num(a(0)));
        case "round": {
          const n = num(a(0));
          const places = node.args.length > 1 ? Math.max(0, num(a(1))) : 0;
          const f = 10 ** places;
          return Math.round(n * f) / f;
        }
        case "floor":
          arity(1);
          return Math.floor(num(a(0)));
        case "ceil":
          arity(1);
          return Math.ceil(num(a(0)));
        case "sqrt":
          arity(1);
          return num(a(0)) < 0 ? null : Math.sqrt(num(a(0)));
        case "min":
          if (!node.args.length) return null;
          return Math.min(...node.args.map((_, i) => num(a(i))));
        case "max":
          if (!node.args.length) return null;
          return Math.max(...node.args.map((_, i) => num(a(i))));
        case "sum":
          return node.args.reduce((acc, _, i) => acc + num(a(i)), 0);
        case "now":
          return dateKey(ctx.now ?? new Date());
        case "today":
          return dateKey(ctx.now ?? new Date());
        case "year": {
          arity(1);
          const d = toDate(a(0));
          return d ? d.getFullYear() : null;
        }
        case "month": {
          arity(1);
          const d = toDate(a(0));
          return d ? d.getMonth() + 1 : null;
        }
        case "day": {
          arity(1);
          const d = toDate(a(0));
          return d ? d.getDate() : null;
        }
        case "datediff": {
          arity(2);
          const from = toDate(a(0));
          const to = toDate(a(1));
          if (!from || !to) return null;
          return Math.round((to.getTime() - from.getTime()) / DAY_MS);
        }
        case "dateadd": {
          arity(2);
          const d = toDate(a(0));
          if (!d) return null;
          d.setDate(d.getDate() + Math.round(num(a(1))));
          return dateKey(d);
        }
        case "format":
          arity(1);
          return str(a(0));
        case "number":
          arity(1);
          return num(a(0));
        default:
          throw new FormulaError(`Unknown function "${node.name}()"`);
      }
    }
  }
}

/* ------------------------------ public API --------------------------- */

export interface FormulaResult {
  value: FormulaValue;
  error: string | null;
}

const cache = new Map<string, Node | string>();

/** Parse (memoized — the same formula runs once per row per render). */
function compile(source: string): Node | string {
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  let result: Node | string;
  try {
    result = parse(tokenize(source));
  } catch (err) {
    result = err instanceof Error ? err.message : "Invalid formula";
  }
  // Unbounded growth isn't a concern: keys are the formulas a user has typed.
  cache.set(source, result);
  return result;
}

export function evalFormula(
  source: string | undefined,
  ctx: FormulaContext,
): FormulaResult {
  if (!source || !source.trim()) return { value: null, error: null };
  const compiled = compile(source);
  if (typeof compiled === "string") return { value: null, error: compiled };
  try {
    return { value: evaluate(compiled, ctx), error: null };
  } catch (err) {
    return {
      value: null,
      error: err instanceof Error ? err.message : "Formula failed",
    };
  }
}

/** Syntax check for the editor, without needing row data. */
export function checkFormula(source: string): string | null {
  if (!source.trim()) return null;
  const compiled = compile(source);
  return typeof compiled === "string" ? compiled : null;
}

/** Display string for a computed value. */
export function formatFormulaValue(v: FormulaValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "—";
    // Trim float noise (0.1 + 0.2) without truncating real precision.
    return String(Math.round(v * 1e10) / 1e10);
  }
  return v;
}
