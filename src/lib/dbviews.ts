import { DbProp, PageMeta } from "./types";

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

export type Sort = { key: string; dir: "asc" | "desc" } | null;

export function sortValue(
  row: PageMeta,
  key: string,
  dbProps: DbProp[],
): string | number {
  if (key === "__title") return row.title.toLowerCase();
  const prop = dbProps.find((p) => p.id === key);
  const raw = row.props?.[key];
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
): PageMeta[] {
  if (!sort) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    const va = sortValue(a, sort.key, dbProps);
    const vb = sortValue(b, sort.key, dbProps);
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
}

export function loadViewState(dbId: string): LocalViewState {
  try {
    const raw = localStorage.getItem(`vellum:dbview:${dbId}`);
    if (raw) return JSON.parse(raw) as LocalViewState;
  } catch {
    /* ignore */
  }
  return { sort: null, filters: {} };
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
