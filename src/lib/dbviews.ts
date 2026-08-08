import {
  DbProp,
  DbView,
  FilterCondition,
  FilterGroup,
  FilterOp,
  PageMeta,
  RollupCalc,
  SortRule,
  ViewKind,
} from "./types";
import { evalFormula, FormulaResult, FormulaValue } from "./formula";

/* ------------------------------------------------------------------ */
/* Computed properties (createdTime / lastEditedTime / rollup)         */
/* ------------------------------------------------------------------ */

/** Index of every page by id — rollups resolve related rows through it. */
export type RowIndex = Map<string, PageMeta>;

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The raw value a rollup pulls from one related row. */
function targetValue(row: PageMeta, rollupPropId: string): unknown {
  if (rollupPropId === "__title") return row.title;
  if (rollupPropId === "__createdTime") return row._creationTime;
  if (rollupPropId === "__lastEditedTime") return row.updatedAt;
  return row.props?.[rollupPropId];
}

function numbers(values: unknown[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const n = typeof v === "number" ? v : Number(v);
    if (typeof v !== "boolean" && v !== null && v !== "" && !Number.isNaN(n)) {
      out.push(n);
    }
  }
  return out;
}

export interface RollupResult {
  display: string;
  /** Numeric where meaningful so sorting doesn't fall back to strings. */
  sortVal: number | string;
}

/**
 * Aggregate a property of the rows linked through a relation column.
 *
 * Everything is computed at render — rollups are never stored, so there is
 * nothing to sync and no invariant to violate. Unresolvable ids (a target
 * row deleted, or a relation still holding an unsynced temp id) simply drop
 * out, which degrades to a smaller aggregate rather than an error.
 */
export function computeRollup(
  row: PageMeta,
  prop: DbProp,
  dbProps: DbProp[],
  byId: RowIndex | undefined,
): RollupResult {
  const empty: RollupResult = { display: "—", sortVal: 0 };
  if (!prop.relationPropId || !prop.rollupPropId || !byId) return empty;

  const relationProp = dbProps.find((p) => p.id === prop.relationPropId);
  if (!relationProp || relationProp.type !== "relation") return empty;

  const rawIds = row.props?.[relationProp.id];
  const ids = Array.isArray(rawIds) ? (rawIds as string[]) : [];
  const related = ids
    .map((id) => byId.get(id))
    .filter((p): p is PageMeta => Boolean(p));

  const calc = (prop.rollupCalc ?? "count") as RollupCalc;
  if (calc === "count") {
    return { display: String(related.length), sortVal: related.length };
  }

  const values = related.map((r) => targetValue(r, prop.rollupPropId!));
  const present = values.filter(
    (v) => v !== undefined && v !== null && v !== "",
  );

  switch (calc) {
    case "countValues":
      return { display: String(present.length), sortVal: present.length };
    case "percentChecked": {
      if (!related.length) return { display: "0%", sortVal: 0 };
      const checked = values.filter((v) => v === true).length;
      const pct = Math.round((checked / related.length) * 100);
      return { display: `${pct}%`, sortVal: pct };
    }
    case "showOriginal": {
      const labels = present.map((v) => String(v));
      return {
        display: labels.length ? labels.join(", ") : "—",
        sortVal: labels.join(",").toLowerCase(),
      };
    }
    default: {
      const nums = numbers(present);
      if (!nums.length) return empty;
      let n: number;
      if (calc === "sum") n = nums.reduce((a, b) => a + b, 0);
      else if (calc === "average")
        n = nums.reduce((a, b) => a + b, 0) / nums.length;
      else if (calc === "min") n = Math.min(...nums);
      else if (calc === "max") n = Math.max(...nums);
      else return empty;
      const rounded = Math.round(n * 100) / 100;
      return { display: String(rounded), sortVal: rounded };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Formula properties                                                  */
/* ------------------------------------------------------------------ */

/**
 * Evaluate a formula property for one row.
 *
 * `prop("Name")` resolves against this row's *other* properties, each
 * flattened to a scalar the expression language can work with (a select
 * becomes its option name, a relation its link count, a date its start).
 * Formulas may reference other formulas; `seen` breaks the cycle that
 * would otherwise recurse forever when two reference each other.
 */
export function computeFormula(
  row: PageMeta,
  prop: DbProp,
  dbProps: DbProp[],
  byId?: RowIndex,
  seen: ReadonlySet<string> = new Set(),
): FormulaResult {
  if (seen.has(prop.id)) {
    return { value: null, error: "Formula references itself" };
  }
  const nowSeen = new Set(seen).add(prop.id);

  const resolve = (name: string): FormulaValue => {
    const target =
      dbProps.find((p) => p.name === name) ??
      dbProps.find((p) => p.name.toLowerCase() === name.toLowerCase());

    if (!target) {
      // The title column isn't in dbProps; Notion calls it "Name".
      const lower = name.toLowerCase();
      if (lower === "name" || lower === "title") return row.title ?? "";
      return null;
    }

    switch (target.type) {
      case "createdTime":
        return toDateKey(new Date(row._creationTime));
      case "lastEditedTime":
        return toDateKey(new Date(row.updatedAt));
      case "rollup":
        return computeRollup(row, target, dbProps, byId).sortVal;
      case "formula":
        return computeFormula(row, target, dbProps, byId, nowSeen).value;
      default:
        break;
    }

    const raw = row.props?.[target.id];
    if (raw === undefined || raw === null) return null;
    switch (target.type) {
      case "number":
        return typeof raw === "number" ? raw : Number(raw) || 0;
      case "checkbox":
        return raw === true;
      case "select":
        return target.options?.find((o) => o.id === raw)?.name ?? null;
      case "multiSelect": {
        const ids = Array.isArray(raw) ? (raw as string[]) : [];
        return ids
          .map((id) => target.options?.find((o) => o.id === id)?.name ?? "")
          .filter(Boolean)
          .join(", ");
      }
      case "date":
        return parseDateValue(raw)?.start ?? null;
      case "relation":
        // A list can't be a scalar; the count is the useful number.
        return Array.isArray(raw) ? raw.length : 0;
      default:
        return typeof raw === "string" ? raw : String(raw);
    }
  };

  return evalFormula(prop.formula, { prop: resolve });
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

export type Sort = { key: string; dir: "asc" | "desc" } | null;

export function sortValue(
  row: PageMeta,
  key: string,
  dbProps: DbProp[],
  byId?: RowIndex,
): string | number {
  if (key === "__title") return row.title.toLowerCase();
  const prop = dbProps.find((p) => p.id === key);
  // Computed types read off the row itself rather than `props`.
  if (prop?.type === "createdTime") return row._creationTime;
  if (prop?.type === "lastEditedTime") return row.updatedAt;
  if (prop?.type === "rollup") {
    return computeRollup(row, prop, dbProps, byId).sortVal;
  }
  if (prop?.type === "formula") {
    const { value } = computeFormula(row, prop, dbProps, byId);
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    return (value ?? "").toString().toLowerCase();
  }
  const raw = row.props?.[key];
  // Dates sort by their start, whether stored as a bare string or a range.
  if (prop?.type === "date") return parseDateValue(raw)?.start ?? "";
  if (raw === undefined || raw === null) {
    if (prop?.type === "number") return -Infinity;
    // Relation sorts numerically (by link count) — an empty cell must stay a
    // number or the comparator falls back to string compare.
    if (prop?.type === "relation") return 0;
    return "";
  }
  switch (prop?.type) {
    case "number":
      return typeof raw === "number" ? raw : Number(raw) || 0;
    case "checkbox":
      return raw === true ? 1 : 0;
    case "select": {
      const o = prop.options?.find((x) => x.id === raw);
      return (o?.name ?? "").toLowerCase();
    }
    case "multiSelect": {
      const ids = Array.isArray(raw) ? (raw as string[]) : [];
      return ids
        .map((id) => prop.options?.find((x) => x.id === id)?.name ?? "")
        .join(",")
        .toLowerCase();
    }
    case "relation":
      // Sorting by opaque page ids is meaningless; link count is not.
      return Array.isArray(raw) ? raw.length : 0;
    default:
      return String(raw).toLowerCase();
  }
}

/** Multi-key sort: earlier rules win, later ones break ties. */
export function applySorts(
  rows: PageMeta[],
  sorts: SortRule[],
  dbProps: DbProp[],
  byId?: RowIndex,
): PageMeta[] {
  if (!sorts.length) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    for (const rule of sorts) {
      const va = sortValue(a, rule.key, dbProps, byId);
      const vb = sortValue(b, rule.key, dbProps, byId);
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      if (cmp !== 0) return rule.dir === "asc" ? cmp : -cmp;
    }
    return 0;
  });
  return copy;
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

/** Legacy per-database filter shape (pre-saved-views, localStorage only):
    propId → allowed option ids, or ["__checked"|"__unchecked"]. Kept solely
    so old persisted state can seed a derived view's FilterGroup. */
export type Filters = Record<string, string[]>;

export function isFilterGroup(
  node: FilterCondition | FilterGroup,
): node is FilterGroup {
  return "logic" in node;
}

/** Operator sets per property type. Relation is deliberately presence-only —
    a "contains page X" op would put page ids inside `views`, which the
    offline layer's temp-id remap doesn't walk. */
const TEXT_OPS: FilterOp[] = ["is", "isNot", "contains", "notContains", "startsWith", "endsWith", "isEmpty", "isNotEmpty"];
const NUMBER_OPS: FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"];
const DATE_OPS: FilterOp[] = ["dateIs", "dateBefore", "dateAfter", "dateOnOrBefore", "dateOnOrAfter", "isEmpty", "isNotEmpty"];
const SELECT_OPS: FilterOp[] = ["anyOf", "noneOf", "isEmpty", "isNotEmpty"];
const CHECKBOX_OPS: FilterOp[] = ["checked", "unchecked"];
const PRESENCE_OPS: FilterOp[] = ["isEmpty", "isNotEmpty"];
// Computed values (formula/rollup) can be text or numbers; offer both.
const VALUE_OPS: FilterOp[] = ["is", "contains", "gt", "lt", "isEmpty", "isNotEmpty"];

export function operatorsFor(prop: DbProp | "__title"): FilterOp[] {
  if (prop === "__title") return TEXT_OPS;
  switch (prop.type) {
    case "text":
    case "url":
    case "ai":
      return TEXT_OPS;
    case "number":
      return NUMBER_OPS;
    case "date":
    case "createdTime":
    case "lastEditedTime":
      return DATE_OPS;
    case "select":
    case "multiSelect":
      return SELECT_OPS;
    case "checkbox":
      return CHECKBOX_OPS;
    case "relation":
      return PRESENCE_OPS;
    case "formula":
    case "rollup":
      return VALUE_OPS;
  }
}

export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  dateIs: "is",
  dateBefore: "is before",
  dateAfter: "is after",
  dateOnOrBefore: "is on or before",
  dateOnOrAfter: "is on or after",
  anyOf: "is any of",
  noneOf: "is none of",
  checked: "is checked",
  unchecked: "is unchecked",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
};

/** Ops that need no operand — a rule with one is always evaluable. */
const NO_VALUE_OPS: FilterOp[] = ["checked", "unchecked", "isEmpty", "isNotEmpty"];

export function opNeedsValue(op: FilterOp): boolean {
  return !NO_VALUE_OPS.includes(op);
}

/** The raw comparable value of one cell (title included via "__title"). */
function cellValue(
  row: PageMeta,
  propId: string,
  dbProps: DbProp[],
  byId?: RowIndex,
): unknown {
  if (propId === "__title") return row.title;
  const prop = dbProps.find((p) => p.id === propId);
  if (!prop) return undefined;
  if (prop.type === "createdTime") return toDateKey(new Date(row._creationTime));
  if (prop.type === "lastEditedTime") return toDateKey(new Date(row.updatedAt));
  if (prop.type === "rollup") {
    return computeRollup(row, prop, dbProps, byId).sortVal;
  }
  if (prop.type === "formula") {
    return computeFormula(row, prop, dbProps, byId).value;
  }
  return row.props?.[propId];
}

function isEmptyValue(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return true;
  if (Array.isArray(raw)) return raw.length === 0;
  if (raw === false) return true; // an unchecked checkbox counts as empty
  return false;
}

function matchCondition(
  row: PageMeta,
  cond: FilterCondition,
  dbProps: DbProp[],
  byId?: RowIndex,
): boolean {
  const raw = cellValue(row, cond.propId, dbProps, byId);

  switch (cond.op) {
    case "isEmpty":
      return isEmptyValue(raw);
    case "isNotEmpty":
      return !isEmptyValue(raw);
    case "checked":
      return raw === true;
    case "unchecked":
      return raw !== true;
    default:
      break;
  }

  // A rule whose operand hasn't been filled in yet matches everything —
  // adding a filter must never blank the view before a value is chosen.
  const v = cond.value;
  if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
    return true;
  }

  switch (cond.op) {
    case "anyOf":
    case "noneOf": {
      const wanted = Array.isArray(v) ? v : [String(v)];
      const have = Array.isArray(raw)
        ? (raw as string[])
        : typeof raw === "string" && raw
          ? [raw]
          : [];
      const hit = have.some((id) => wanted.includes(id));
      return cond.op === "anyOf" ? hit : !hit;
    }
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const n = typeof raw === "number" ? raw : Number(raw);
      const w = typeof v === "number" ? v : Number(v);
      if (Number.isNaN(n) || Number.isNaN(w)) return cond.op === "neq";
      if (cond.op === "eq") return n === w;
      if (cond.op === "neq") return n !== w;
      if (cond.op === "gt") return n > w;
      if (cond.op === "gte") return n >= w;
      if (cond.op === "lt") return n < w;
      return n <= w;
    }
    case "dateIs":
    case "dateBefore":
    case "dateAfter":
    case "dateOnOrBefore":
    case "dateOnOrAfter": {
      // Dates compare as ISO "YYYY-MM-DD" strings; ranges compare by start.
      const d = parseDateValue(raw)?.start;
      const w = String(v);
      if (!d) return false;
      if (cond.op === "dateIs") return d === w;
      if (cond.op === "dateBefore") return d < w;
      if (cond.op === "dateAfter") return d > w;
      if (cond.op === "dateOnOrBefore") return d <= w;
      return d >= w;
    }
    default: {
      // Text family. Numbers/formula results compare via their string form.
      const s = (raw ?? "").toString().toLowerCase();
      const w = String(v).toLowerCase();
      // gt/lt reached via VALUE_OPS on a non-numeric formula: string compare.
      if (cond.op === "is") return s === w;
      if (cond.op === "isNot") return s !== w;
      if (cond.op === "contains") return s.includes(w);
      if (cond.op === "notContains") return !s.includes(w);
      if (cond.op === "startsWith") return s.startsWith(w);
      return s.endsWith(w);
    }
  }
}

export function matchFilterGroup(
  row: PageMeta,
  group: FilterGroup,
  dbProps: DbProp[],
  byId?: RowIndex,
): boolean {
  if (!group.conditions.length) return true;
  const results = group.conditions.map((node) =>
    isFilterGroup(node)
      ? matchFilterGroup(row, node, dbProps, byId)
      : matchCondition(row, node, dbProps, byId),
  );
  return group.logic === "and" ? results.every(Boolean) : results.some(Boolean);
}

export function applyFilterGroup(
  rows: PageMeta[],
  filter: FilterGroup | undefined,
  dbProps: DbProp[],
  byId?: RowIndex,
): PageMeta[] {
  if (!filter || !filter.conditions.length) return rows;
  return rows.filter((row) => matchFilterGroup(row, filter, dbProps, byId));
}

/** Count the individual rules in a filter (for toolbar badges). */
export function countFilterRules(filter: FilterGroup | undefined): number {
  if (!filter) return 0;
  return filter.conditions.reduce<number>(
    (n, node) => n + (isFilterGroup(node) ? countFilterRules(node) : 1),
    0,
  );
}

export function applySearch(rows: PageMeta[], term: string): PageMeta[] {
  const t = term.trim().toLowerCase();
  if (!t) return rows;
  return rows.filter((row) => {
    if (row.title.toLowerCase().includes(t)) return true;
    const props = row.props ?? {};
    return Object.values(props).some(
      (v) => typeof v === "string" && v.toLowerCase().includes(t),
    );
  });
}

/* ------------------------------------------------------------------ */
/* Per-database local state (active tab, collapsed groups)             */
/* ------------------------------------------------------------------ */

/**
 * What stays per-device after saved views: the selected tab and collapsed
 * table groups. `sort`/`filters`/`groupBy` are the pre-saved-views shape,
 * still read (never written) so old local state can seed derived views.
 */
export interface LocalViewState {
  sort: Sort;
  filters: Filters;
  groupBy: string | null;
  collapsedGroups: string[];
  /** Selected view tab — per-device, like Notion's last-used view. */
  activeViewId: string | null;
}

export function loadViewState(dbId: string): LocalViewState {
  try {
    const raw = localStorage.getItem(`vellum:dbview:${dbId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalViewState>;
      // State persisted by an older build won't have newer keys.
      return {
        sort: parsed.sort ?? null,
        filters: parsed.filters ?? {},
        groupBy: parsed.groupBy ?? null,
        collapsedGroups: parsed.collapsedGroups ?? [],
        activeViewId: parsed.activeViewId ?? null,
      };
    }
  } catch {
    /* ignore */
  }
  return {
    sort: null,
    filters: {},
    groupBy: null,
    collapsedGroups: [],
    activeViewId: null,
  };
}

/* ------------------------------------------------------------------ */
/* Saved views — derivation & migration                                */
/* ------------------------------------------------------------------ */

export const VIEW_KINDS: ViewKind[] = [
  "table",
  "board",
  "calendar",
  "gallery",
  "timeline",
];

export const VIEW_KIND_LABELS: Record<ViewKind, string> = {
  table: "Table",
  board: "Board",
  calendar: "Calendar",
  gallery: "Gallery",
  timeline: "Timeline",
};

export function newViewId(): string {
  return `v_${Math.random().toString(36).slice(2, 10)}`;
}

/** Convert the legacy localStorage filter map into a FilterGroup. */
export function legacyFiltersToGroup(
  filters: Filters,
  dbProps: DbProp[],
): FilterGroup | undefined {
  const conditions: FilterCondition[] = [];
  for (const [propId, values] of Object.entries(filters)) {
    if (!values.length) continue;
    const prop = dbProps.find((p) => p.id === propId);
    if (!prop) continue;
    if (prop.type === "checkbox") {
      // Both boxes ticked meant "everything" — no rule at all.
      if (values.length === 1) {
        conditions.push({
          propId,
          op: values[0] === "__checked" ? "checked" : "unchecked",
        });
      }
    } else {
      conditions.push({ propId, op: "anyOf", value: values });
    }
  }
  return conditions.length ? { logic: "and", conditions } : undefined;
}

/**
 * The views of a database that predates saved views: one per kind, named
 * like the old fixed tabs, seeded from the legacy synced fields and any
 * legacy local filter/sort state so nothing visibly changes on upgrade.
 * Ids are stable (`__table`…) so the per-device active tab survives until
 * the array is first materialized by `setViews`.
 */
export function derivedViews(
  page: {
    boardGroupBy?: string;
    calendarBy?: string;
  },
  dbProps: DbProp[],
  legacy: LocalViewState,
): DbView[] {
  const filter = legacyFiltersToGroup(legacy.filters, dbProps);
  const sorts: SortRule[] | undefined = legacy.sort ? [legacy.sort] : undefined;
  return VIEW_KINDS.map((kind) => ({
    id: `__${kind}`,
    name: VIEW_KIND_LABELS[kind],
    kind,
    filter,
    sorts,
    groupBy: kind === "table" ? (legacy.groupBy ?? undefined) : undefined,
    boardGroupBy: kind === "board" ? page.boardGroupBy : undefined,
    calendarBy:
      kind === "calendar" || kind === "timeline" ? page.calendarBy : undefined,
  }));
}

/** The views to render: saved ones, or the derived legacy set. */
export function viewsOf(
  page: { views?: DbView[]; boardGroupBy?: string; calendarBy?: string },
  dbProps: DbProp[],
  legacy: LocalViewState,
): { views: DbView[]; derived: boolean } {
  if (page.views && page.views.length) {
    return { views: page.views, derived: false };
  }
  return { views: derivedViews(page, dbProps, legacy), derived: true };
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

export interface RowGroup {
  key: string;
  label: string;
  color: string;
  rows: PageMeta[];
}

/**
 * Split rows into Notion-style groups by a select or checkbox property.
 * Select options keep their defined order and empty groups are preserved
 * (so you can drop/create into them); the "no value" group goes last.
 */
export function groupRows(
  rows: PageMeta[],
  groupBy: string | null,
  dbProps: DbProp[],
): RowGroup[] | null {
  if (!groupBy) return null;
  const prop = dbProps.find((p) => p.id === groupBy);
  if (!prop) return null;

  if (prop.type === "checkbox") {
    const checked: RowGroup = { key: "__checked", label: "Checked", color: "green", rows: [] };
    const unchecked: RowGroup = { key: "__unchecked", label: "Unchecked", color: "gray", rows: [] };
    for (const row of rows) {
      (row.props?.[prop.id] === true ? checked : unchecked).rows.push(row);
    }
    return [checked, unchecked];
  }

  if (prop.type !== "select" && prop.type !== "multiSelect") return null;

  const groups: RowGroup[] = (prop.options ?? []).map((o) => ({
    key: o.id,
    label: o.name,
    color: o.color,
    rows: [],
  }));
  const none: RowGroup = {
    key: "__none",
    label: `No ${prop.name}`,
    color: "gray",
    rows: [],
  };
  for (const row of rows) {
    const raw = row.props?.[prop.id];
    const ids = Array.isArray(raw)
      ? (raw as string[])
      : typeof raw === "string" && raw
        ? [raw]
        : [];
    const matched = groups.filter((g) => ids.includes(g.key));
    if (matched.length) {
      // A multi-select row legitimately appears under each of its values.
      for (const g of matched) g.rows.push(row);
    } else {
      none.rows.push(row);
    }
  }
  return [...groups, none];
}

export function saveViewState(dbId: string, state: LocalViewState) {
  try {
    localStorage.setItem(`vellum:dbview:${dbId}`, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/**
 * A date property holds either a bare `"YYYY-MM-DD"` (every value written
 * before ranges existed) or `{ start, end }`. Everything reads dates through
 * `parseDateValue`, so the two shapes stay interchangeable and no migration
 * is needed — a stored string is simply a range with no end.
 */
export interface DateValue {
  start: string;
  end?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateValue(raw: unknown): DateValue | null {
  if (typeof raw === "string") {
    return ISO_DATE.test(raw) ? { start: raw } : null;
  }
  if (raw && typeof raw === "object") {
    const start = (raw as Record<string, unknown>).start;
    const end = (raw as Record<string, unknown>).end;
    if (typeof start !== "string" || !ISO_DATE.test(start)) return null;
    return typeof end === "string" && ISO_DATE.test(end) && end > start
      ? { start, end }
      : { start };
  }
  return null;
}

/** Store the narrowest shape that fits, so single dates stay plain strings. */
export function makeDateValue(start: string, end?: string): string | DateValue | null {
  if (!ISO_DATE.test(start)) return null;
  return end && ISO_DATE.test(end) && end > start ? { start, end } : start;
}

/** Inclusive day count of a range (a single date spans one day). */
export function dateSpanDays(v: DateValue): number {
  if (!v.end) return 1;
  const ms = Date.parse(`${v.end}T00:00:00`) - Date.parse(`${v.start}T00:00:00`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

export function formatDateValue(raw: unknown): string {
  const v = parseDateValue(raw);
  if (!v) return "";
  const short = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };
  return v.end ? `${short(v.start)} → ${short(v.end)}` : short(v.start);
}

export function formatDateLong(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
