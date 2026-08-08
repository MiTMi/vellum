import { expect, test } from "vitest";
import {
  applyFilterGroup,
  applySorts,
  computeRollup,
  countFilterRules,
  derivedViews,
  groupRows,
  legacyFiltersToGroup,
  matchFilterGroup,
  operatorsFor,
  RowIndex,
  sortValue,
  viewsOf,
} from "../src/lib/dbviews";
import { DbProp, FilterGroup, PageId, PageMeta } from "../src/lib/types";

function row(
  id: string,
  title: string,
  props: Record<string, unknown> = {},
  times: { created?: number; updated?: number } = {},
): PageMeta {
  return {
    _id: id as PageId,
    title,
    type: "doc",
    parentId: null,
    rank: 1024,
    icon: null,
    cover: null,
    isFavorite: false,
    isTemplate: false,
    props,
    updatedAt: times.updated ?? 200,
    _creationTime: times.created ?? 100,
  };
}

/* ---------------------- computed timestamps ---------------------- */

test("sortValue reads createdTime / lastEditedTime off the row itself", () => {
  const dbProps: DbProp[] = [
    { id: "c", name: "Created", type: "createdTime" },
    { id: "e", name: "Edited", type: "lastEditedTime" },
  ];
  const r = row("r1", "A", {}, { created: 5, updated: 9 });
  expect(sortValue(r, "c", dbProps)).toBe(5);
  expect(sortValue(r, "e", dbProps)).toBe(9);
});

/* ---------------------------- rollups ---------------------------- */

const REL: DbProp = {
  id: "rel",
  name: "Projects",
  type: "relation",
  targetId: "db2",
};
const rollup = (calc: string, rollupPropId = "num"): DbProp => ({
  id: "roll",
  name: "Roll",
  type: "rollup",
  relationPropId: "rel",
  rollupPropId,
  rollupCalc: calc,
});

function index(...rows: PageMeta[]): RowIndex {
  return new Map(rows.map((r) => [r._id as string, r]));
}

test("rollup count / sum / average / min / max over related rows", () => {
  const a = row("a", "Alpha", { num: 3 });
  const b = row("b", "Beta", { num: 7 });
  const src = row("s", "Src", { rel: ["a", "b"] });
  const byId = index(a, b, src);
  const dbProps = [REL];

  expect(computeRollup(src, rollup("count"), dbProps, byId).display).toBe("2");
  expect(computeRollup(src, rollup("sum"), dbProps, byId).display).toBe("10");
  expect(computeRollup(src, rollup("average"), dbProps, byId).display).toBe("5");
  expect(computeRollup(src, rollup("min"), dbProps, byId).display).toBe("3");
  expect(computeRollup(src, rollup("max"), dbProps, byId).display).toBe("7");
});

test("rollup countValues ignores empty cells; count counts rows", () => {
  const a = row("a", "Alpha", { num: 3 });
  const b = row("b", "Beta", {}); // no value
  const src = row("s", "Src", { rel: ["a", "b"] });
  const byId = index(a, b, src);
  expect(computeRollup(src, rollup("count"), [REL], byId).display).toBe("2");
  expect(computeRollup(src, rollup("countValues"), [REL], byId).display).toBe("1");
});

test("rollup percentChecked and showOriginal", () => {
  const a = row("a", "Alpha", { done: true });
  const b = row("b", "Beta", { done: false });
  const c = row("c", "Gamma", { done: true });
  const src = row("s", "Src", { rel: ["a", "b", "c"] });
  const byId = index(a, b, c, src);
  expect(
    computeRollup(src, rollup("percentChecked", "done"), [REL], byId).display,
  ).toBe("67%");
  expect(
    computeRollup(src, rollup("showOriginal", "__title"), [REL], byId).display,
  ).toBe("Alpha, Beta, Gamma");
});

test("rollup degrades gracefully: unconfigured, empty, missing rows, non-numeric", () => {
  const src = row("s", "Src", { rel: ["a", "ghost"] });
  const a = row("a", "Alpha", { num: "not a number" });
  const byId = index(a, src);

  // No relation/property chosen yet.
  expect(
    computeRollup(src, { id: "r", name: "R", type: "rollup" }, [REL], byId)
      .display,
  ).toBe("—");
  // No index available (e.g. mid-remap).
  expect(computeRollup(src, rollup("count"), [REL], undefined).display).toBe("—");
  // "ghost" isn't in the index — a deleted or still-unsynced row drops out.
  expect(computeRollup(src, rollup("count"), [REL], byId).display).toBe("1");
  // Non-numeric values leave a sum with nothing to add.
  expect(computeRollup(src, rollup("sum"), [REL], byId).display).toBe("—");
  // Row with no relation value at all.
  const lonely = row("l", "Lonely");
  expect(computeRollup(lonely, rollup("count"), [REL], byId).display).toBe("0");
});

test("rollup ignores a relationPropId that isn't a relation column", () => {
  const src = row("s", "Src", { rel: ["a"] });
  const byId = index(row("a", "Alpha", { num: 1 }), src);
  const notARelation: DbProp = { id: "rel", name: "Text", type: "text" };
  expect(
    computeRollup(src, rollup("count"), [notARelation], byId).display,
  ).toBe("—");
});

test("sortValue on a rollup sorts numerically by the aggregate", () => {
  const a = row("a", "Alpha", { num: 3 });
  const b = row("b", "Beta", { num: 7 });
  const one = row("1", "One", { rel: ["a"] });
  const two = row("2", "Two", { rel: ["a", "b"] });
  const byId = index(a, b, one, two);
  const dbProps = [REL, rollup("sum")];
  expect(sortValue(one, "roll", dbProps, byId)).toBe(3);
  expect(sortValue(two, "roll", dbProps, byId)).toBe(10);
});

/* ---------------------------- grouping --------------------------- */

const STATUS: DbProp = {
  id: "status",
  name: "Status",
  type: "select",
  options: [
    { id: "todo", name: "To do", color: "gray" },
    { id: "done", name: "Done", color: "green" },
  ],
};

test("groupRows keeps option order, preserves empty groups, puts 'no value' last", () => {
  const rows = [
    row("a", "A", { status: "done" }),
    row("b", "B", {}),
  ];
  const groups = groupRows(rows, "status", [STATUS])!;
  expect(groups.map((g) => g.key)).toEqual(["todo", "done", "__none"]);
  expect(groups.map((g) => g.rows.length)).toEqual([0, 1, 1]);
  expect(groups[2].label).toBe("No Status");
});

test("groupRows splits checkbox props into Checked / Unchecked", () => {
  const prop: DbProp = { id: "ok", name: "Ok", type: "checkbox" };
  const groups = groupRows(
    [row("a", "A", { ok: true }), row("b", "B", { ok: false }), row("c", "C")],
    "ok",
    [prop],
  )!;
  expect(groups.map((g) => [g.key, g.rows.length])).toEqual([
    ["__checked", 1],
    ["__unchecked", 2],
  ]);
});

test("a multi-select row appears under each of its values", () => {
  const tags: DbProp = {
    id: "tags",
    name: "Tags",
    type: "multiSelect",
    options: [
      { id: "x", name: "X", color: "red" },
      { id: "y", name: "Y", color: "blue" },
    ],
  };
  const groups = groupRows([row("a", "A", { tags: ["x", "y"] })], "tags", [tags])!;
  expect(groups.find((g) => g.key === "x")!.rows).toHaveLength(1);
  expect(groups.find((g) => g.key === "y")!.rows).toHaveLength(1);
  expect(groups.find((g) => g.key === "__none")!.rows).toHaveLength(0);
});

test("groupRows returns null when grouping is off or the prop can't group", () => {
  expect(groupRows([], null, [STATUS])).toBeNull();
  expect(groupRows([], "missing", [STATUS])).toBeNull();
  expect(groupRows([], "t", [{ id: "t", name: "T", type: "text" }])).toBeNull();
});

/* --------------------------- filtering --------------------------- */

const FILTER_PROPS: DbProp[] = [
  STATUS,
  { id: "txt", name: "Notes", type: "text" },
  { id: "num", name: "Points", type: "number" },
  { id: "due", name: "Due", type: "date" },
  { id: "ok", name: "Done", type: "checkbox" },
  { id: "rel", name: "Links", type: "relation", targetId: "db2" },
];

const and = (...conditions: FilterGroup["conditions"]): FilterGroup => ({
  logic: "and",
  conditions,
});
const or = (...conditions: FilterGroup["conditions"]): FilterGroup => ({
  logic: "or",
  conditions,
});

test("text operators", () => {
  const r = row("a", "Alpha", { txt: "Hello World" });
  const m = (op: string, value?: string) =>
    matchFilterGroup(r, and({ propId: "txt", op: op as never, value }), FILTER_PROPS);
  expect(m("is", "hello world")).toBe(true); // case-insensitive
  expect(m("isNot", "hello world")).toBe(false);
  expect(m("contains", "lo wo")).toBe(true);
  expect(m("notContains", "xyz")).toBe(true);
  expect(m("startsWith", "hell")).toBe(true);
  expect(m("endsWith", "world")).toBe(true);
  expect(m("isEmpty")).toBe(false);
  expect(m("isNotEmpty")).toBe(true);
});

test("title filters via the __title sentinel", () => {
  const r = row("a", "Meeting notes");
  expect(
    matchFilterGroup(r, and({ propId: "__title", op: "contains", value: "meet" }), []),
  ).toBe(true);
});

test("number operators", () => {
  const r = row("a", "A", { num: 5 });
  const m = (op: string, value: number) =>
    matchFilterGroup(r, and({ propId: "num", op: op as never, value }), FILTER_PROPS);
  expect(m("eq", 5)).toBe(true);
  expect(m("neq", 5)).toBe(false);
  expect(m("gt", 4)).toBe(true);
  expect(m("gte", 5)).toBe(true);
  expect(m("lt", 5)).toBe(false);
  expect(m("lte", 5)).toBe(true);
});

test("date operators compare by start, both stored shapes", () => {
  const bare = row("a", "A", { due: "2026-08-10" });
  const range = row("b", "B", { due: { start: "2026-08-10", end: "2026-08-12" } });
  for (const r of [bare, range]) {
    const m = (op: string, value: string) =>
      matchFilterGroup(r, and({ propId: "due", op: op as never, value }), FILTER_PROPS);
    expect(m("dateIs", "2026-08-10")).toBe(true);
    expect(m("dateBefore", "2026-08-11")).toBe(true);
    expect(m("dateAfter", "2026-08-09")).toBe(true);
    expect(m("dateOnOrBefore", "2026-08-10")).toBe(true);
    expect(m("dateOnOrAfter", "2026-08-11")).toBe(false);
  }
});

test("select / multiSelect anyOf & noneOf; checkbox; relation presence", () => {
  const r = row("a", "A", { status: "todo", ok: true, rel: ["x"] });
  const g = (propId: string, op: string, value?: string[]) =>
    matchFilterGroup(r, and({ propId, op: op as never, value }), FILTER_PROPS);
  expect(g("status", "anyOf", ["todo", "done"])).toBe(true);
  expect(g("status", "noneOf", ["done"])).toBe(true);
  expect(g("status", "noneOf", ["todo"])).toBe(false);
  expect(g("ok", "checked")).toBe(true);
  expect(g("ok", "unchecked")).toBe(false);
  expect(g("rel", "isNotEmpty")).toBe(true);
  expect(g("rel", "isEmpty")).toBe(false);
});

test("a rule with no operand yet matches everything", () => {
  const r = row("a", "A", { txt: "x" });
  expect(
    matchFilterGroup(r, and({ propId: "txt", op: "is", value: undefined }), FILTER_PROPS),
  ).toBe(true);
  expect(
    matchFilterGroup(r, and({ propId: "status", op: "anyOf", value: [] }), FILTER_PROPS),
  ).toBe(true);
});

test("compound and/or plus one nested group", () => {
  const rows = [
    row("a", "A", { status: "todo", num: 1 }),
    row("b", "B", { status: "done", num: 9 }),
    row("c", "C", { status: "done", num: 1 }),
  ];
  // done AND (num > 5 OR title is "C")
  const filter = and(
    { propId: "status", op: "anyOf", value: ["done"] },
    or(
      { propId: "num", op: "gt", value: 5 },
      { propId: "__title", op: "is", value: "c" },
    ),
  );
  const out = applyFilterGroup(rows, filter, FILTER_PROPS);
  expect(out.map((r) => r._id)).toEqual(["b", "c"]);
  expect(countFilterRules(filter)).toBe(3);
});

test("filters on formula and computed-timestamp values", () => {
  const props: DbProp[] = [
    { id: "num", name: "Points", type: "number" },
    { id: "f", name: "Double", type: "formula", formula: 'prop("Points") * 2' },
    { id: "c", name: "Created", type: "createdTime" },
  ];
  const r = row("a", "A", { num: 4 }, { created: Date.parse("2026-08-05T12:00:00") });
  expect(matchFilterGroup(r, and({ propId: "f", op: "gt", value: 5 }), props)).toBe(true);
  expect(
    matchFilterGroup(r, and({ propId: "c", op: "dateIs", value: "2026-08-05" }), props),
  ).toBe(true);
});

test("operatorsFor keeps relation presence-only (temp-id invariant)", () => {
  const rel: DbProp = { id: "r", name: "R", type: "relation" };
  expect(operatorsFor(rel)).toEqual(["isEmpty", "isNotEmpty"]);
});

/* -------------------------- multi-sort --------------------------- */

test("applySorts: later rules break ties, direction respected", () => {
  const props: DbProp[] = [{ id: "num", name: "N", type: "number" }];
  const rows = [
    row("a", "Zed", { num: 1 }),
    row("b", "Ann", { num: 2 }),
    row("c", "Bob", { num: 1 }),
  ];
  const out = applySorts(
    rows,
    [
      { key: "num", dir: "asc" },
      { key: "__title", dir: "desc" },
    ],
    props,
  );
  expect(out.map((r) => r._id)).toEqual(["a", "c", "b"]);
  expect(applySorts(rows, [], props)).toBe(rows);
});

/* ------------------- saved views: derivation --------------------- */

const LEGACY = {
  sort: { key: "__title", dir: "asc" as const },
  filters: { status: ["todo"], ok: ["__checked"] },
  groupBy: "status",
  collapsedGroups: [],
  activeViewId: null,
};

test("legacyFiltersToGroup converts the old localStorage shape", () => {
  const g = legacyFiltersToGroup(LEGACY.filters, FILTER_PROPS)!;
  expect(g.logic).toBe("and");
  expect(g.conditions).toContainEqual({ propId: "status", op: "anyOf", value: ["todo"] });
  expect(g.conditions).toContainEqual({ propId: "ok", op: "checked" });
  // Empty map → no filter at all.
  expect(legacyFiltersToGroup({}, FILTER_PROPS)).toBeUndefined();
});

test("derivedViews: one per kind, seeded from legacy fields", () => {
  const views = derivedViews(
    { boardGroupBy: "status", calendarBy: "due" },
    FILTER_PROPS,
    LEGACY,
  );
  expect(views.map((v) => v.kind)).toEqual([
    "table",
    "board",
    "calendar",
    "gallery",
    "timeline",
  ]);
  expect(views[0].name).toBe("Table");
  expect(views[0].groupBy).toBe("status");
  expect(views[0].sorts).toEqual([LEGACY.sort]);
  expect(views[0].filter).toBeDefined();
  expect(views[1].boardGroupBy).toBe("status");
  expect(views[2].calendarBy).toBe("due");
  expect(views[4].calendarBy).toBe("due");
});

test("viewsOf prefers saved views over derivation", () => {
  const saved = [{ id: "v1", name: "Mine", kind: "table" as const }];
  expect(viewsOf({ views: saved }, FILTER_PROPS, LEGACY).views).toBe(saved);
  expect(viewsOf({ views: saved }, FILTER_PROPS, LEGACY).derived).toBe(false);
  expect(viewsOf({}, FILTER_PROPS, LEGACY).derived).toBe(true);
});
