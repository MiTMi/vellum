import { expect, test } from "vitest";
import {
  computeRollup,
  groupRows,
  RowIndex,
  sortValue,
} from "../src/lib/dbviews";
import { DbProp, PageId, PageMeta } from "../src/lib/types";

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
