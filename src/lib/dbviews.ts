import { DbProp, PageMeta, RollupCalc } from "./types";
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

export function applySort(
  rows: PageMeta[],
  sort: Sort,
  dbProps: DbProp[],
  byId?: RowIndex,
): PageMeta[] {
  if (!sort) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    const va = sortValue(a, sort.key, dbProps, byId);
    const vb = sortValue(b, sort.key, dbProps, byId);
    const cmp =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
    return sort.dir === "asc" ? cmp : -cmp;
  });
  return copy;
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

/** Active filters: propId → allowed option ids (select/multiSelect) or
    ["__checked"|"__unchecked"] for checkboxes. Filters are ANDed. */
export type Filters = Record<string, string[]>;

export function applyFilters(
  rows: PageMeta[],
  filters: Filters,
  dbProps: DbProp[],
): PageMeta[] {
  const entries = Object.entries(filters).filter(([, v]) => v.length > 0);
  if (!entries.length) return rows;
  return rows.filter((row) =>
    entries.every(([propId, allowed]) => {
      const prop = dbProps.find((p) => p.id === propId);
      if (!prop) return true;
      const raw = row.props?.[propId];
      if (prop.type === "checkbox") {
        const checked = raw === true;
        return allowed.includes(checked ? "__checked" : "__unchecked");
      }
      if (prop.type === "select") {
        return typeof raw === "string" && allowed.includes(raw);
      }
      if (prop.type === "multiSelect") {
        const ids = Array.isArray(raw) ? (raw as string[]) : [];
        return ids.some((id) => allowed.includes(id));
      }
      return true;
    }),
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
/* Per-database view state persisted locally (filters, sort, search)   */
/* ------------------------------------------------------------------ */

export interface LocalViewState {
  sort: Sort;
  filters: Filters;
  /** Table-view grouping — local, like sort/filter. */
  groupBy: string | null;
  collapsedGroups: string[];
}

export function loadViewState(dbId: string): LocalViewState {
  try {
    const raw = localStorage.getItem(`vellum:dbview:${dbId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalViewState>;
      // State persisted before grouping existed has neither key.
      return {
        sort: parsed.sort ?? null,
        filters: parsed.filters ?? {},
        groupBy: parsed.groupBy ?? null,
        collapsedGroups: parsed.collapsedGroups ?? [],
      };
    }
  } catch {
    /* ignore */
  }
  return { sort: null, filters: {}, groupBy: null, collapsedGroups: [] };
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
