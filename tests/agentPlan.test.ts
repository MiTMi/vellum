/// <reference types="vite/client" />
// The agent's plan vocabulary: JSON extraction from model replies, the
// whole-plan validator, and the markdown → blocks converter the client
// executor applies plans with. All pure — no backend, no network.
import { expect, test } from "vitest";
import {
  MAX_PLAN_OPS,
  parseAgentJson,
  validatePlan,
} from "../convex/lib/agentPlan";
import { markdownToBlocks } from "../src/lib/markdownBlocks";

/* --------------------------- parseAgentJson --------------------------- */

test("parses bare JSON, fenced JSON, and JSON with prose around it", () => {
  expect(parseAgentJson('{"tool":"search","query":"x"}')).toEqual({
    tool: "search",
    query: "x",
  });
  expect(parseAgentJson('```json\n{"reply":"hi"}\n```')).toEqual({ reply: "hi" });
  expect(parseAgentJson('Sure! Here you go:\n{"reply":"hi"}')).toEqual({
    reply: "hi",
  });
});

test("non-JSON and JSON arrays read as null (plain replies)", () => {
  expect(parseAgentJson("I could not find anything relevant.")).toBeNull();
  expect(parseAgentJson("[1,2,3]")).toBeNull();
  expect(parseAgentJson("")).toBeNull();
});

/* ---------------------------- validatePlan ---------------------------- */

const page = { kind: "createPage", title: "Notes", parent: "root" };
const db = {
  kind: "createDatabase",
  title: "Meals",
  parent: "root",
  columns: [
    { name: "Day", type: "select", options: ["Mon", "Tue"] },
    { name: "Done", type: "checkbox" },
  ],
};

test("accepts a well-formed plan with refs", () => {
  const result = validatePlan([
    db,
    { kind: "addRow", target: "#0", title: "Pasta", props: { Day: "Mon", Done: false } },
    { kind: "createPage", title: "Shopping", parent: "#0" },
    { kind: "appendToPage", target: "current", markdown: "- milk" },
  ]);
  expect(result.ok).toBe(true);
});

test("rejects non-lists, empty plans, and oversized plans", () => {
  expect(validatePlan("nope").ok).toBe(false);
  expect(validatePlan([]).ok).toBe(false);
  expect(validatePlan(Array(MAX_PLAN_OPS + 1).fill(page)).ok).toBe(false);
  expect(validatePlan(Array(MAX_PLAN_OPS).fill(page)).ok).toBe(true);
});

test("rejects unknown kinds — destructive ops are unrepresentable", () => {
  for (const kind of ["trashPage", "movePage", "updateContent", "deleteRow"]) {
    const r = validatePlan([{ kind, target: "x" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown kind");
  }
});

test("rejects forward and wrong-kind references", () => {
  // Forward ref: step 0 points at step 1.
  expect(
    validatePlan([{ kind: "addRow", target: "#1", title: "x" }, db]).ok,
  ).toBe(false);
  // addRow must target a database, not a page.
  expect(
    validatePlan([page, { kind: "addRow", target: "#0", title: "x" }]).ok,
  ).toBe(false);
  // createPage parent ref may target either created kind.
  expect(
    validatePlan([db, { kind: "createPage", title: "ok", parent: "#0" }]).ok,
  ).toBe(true);
});

test("rejects bad columns and bad prop values", () => {
  expect(
    validatePlan([
      { ...db, columns: [{ name: "X", type: "relation" }] }, // not in vocabulary
    ]).ok,
  ).toBe(false);
  expect(validatePlan([{ ...db, columns: [] }]).ok).toBe(false);
  expect(
    validatePlan([
      db,
      { kind: "addRow", target: "#0", title: "x", props: { Day: { nested: true } } },
    ]).ok,
  ).toBe(false);
});

test("rejects oversized and empty required strings", () => {
  expect(validatePlan([{ ...page, title: "" }]).ok).toBe(false);
  expect(validatePlan([{ ...page, title: "x".repeat(500) }]).ok).toBe(false);
  expect(
    validatePlan([{ kind: "appendToPage", target: "current", markdown: "" }]).ok,
  ).toBe(false);
});

/* --------------------------- markdownToBlocks -------------------------- */

test("maps headings, lists, checkboxes, and paragraphs", () => {
  const { blocks, text } = markdownToBlocks(
    "# Title\n\n## Section\nplain text\n- bullet\n* star bullet\n1. first\n2) second\n- [ ] todo\n- [x] done",
  );
  expect(blocks.map((b) => b.type)).toEqual([
    "heading",
    "heading",
    "paragraph",
    "bulletListItem",
    "bulletListItem",
    "numberedListItem",
    "numberedListItem",
    "checkListItem",
    "checkListItem",
  ]);
  expect(blocks[0].props).toEqual({ level: 1 });
  expect(blocks[7].props).toEqual({ checked: false });
  expect(blocks[8].props).toEqual({ checked: true });
  expect(text).toContain("bullet");
  expect(text).not.toContain("- [x]"); // text is plain, markers stripped
});

test("empty and whitespace-only markdown yields no blocks", () => {
  expect(markdownToBlocks("").blocks).toHaveLength(0);
  expect(markdownToBlocks("\n  \n").blocks).toHaveLength(0);
});

/* ----------------------------- executePlan ----------------------------- */

import { executePlan, describeOp } from "../src/lib/agentPlan";
import type { AgentOp } from "../convex/lib/agentPlan";
import type { PageDoc, PageId } from "../src/lib/types";

function fakeDeps(docs: Record<string, Partial<PageDoc>> = {}) {
  let seq = 0;
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const store = new Map<string, PageDoc>(
    Object.entries(docs).map(([id, d]) => [
      id,
      { _id: id, _creationTime: 0, title: "", type: "doc", rank: 0, updatedAt: 0, ...d } as PageDoc,
    ]),
  );
  const mutations = {
    create: async (args: Record<string, unknown>) => {
      calls.push({ fn: "create", args });
      const id = `new_${seq++}` as PageId;
      store.set(id, {
        _id: id, _creationTime: 0, rank: 0, updatedAt: 0,
        title: (args.title as string) ?? "",
        type: (args.type as "doc" | "database") ?? "doc",
        parentId: args.parentId as PageId | undefined,
        props: args.props as Record<string, unknown> | undefined,
      } as PageDoc);
      return id;
    },
    updateContent: async (args: Record<string, unknown>) => {
      calls.push({ fn: "updateContent", args });
      const doc = store.get(args.id as string);
      if (doc) {
        doc.content = args.content;
        doc.contentText = args.text as string;
      }
    },
    updateDbProps: async (args: Record<string, unknown>) => {
      calls.push({ fn: "updateDbProps", args });
      const doc = store.get(args.id as string);
      if (doc) doc.dbProps = args.dbProps as PageDoc["dbProps"];
    },
  } as unknown as import("../src/data/api").Mutations;
  return {
    calls,
    store,
    deps: {
      mutations,
      getDoc: async (id: PageId) => structuredClone(store.get(id) ?? null),
      currentPageId: null as PageId | null,
    },
  };
}

test("executor: database + rows + page land with resolved refs and prop ids", async () => {
  const { deps, calls, store } = fakeDeps();
  const plan: AgentOp[] = [
    {
      kind: "createDatabase", title: "Meals", parent: "root",
      columns: [
        { name: "Day", type: "select", options: ["Mon"] },
        { name: "Done", type: "checkbox" },
      ],
    },
    { kind: "addRow", target: "#0", title: "Pasta", props: { Day: "Tue", done: true, Ghost: "x" } },
    { kind: "createPage", title: "Notes", parent: "#0", markdown: "# Hi\n- a" },
  ];
  const result = await executePlan(plan, deps);
  expect(result.failures).toEqual([]);
  expect(result.created).toHaveLength(2); // db + page, rows aren't chips

  const db = [...store.values()].find((d) => d.type === "database")!;
  expect(db.dbProps!.map((p) => p.name)).toEqual(["Day", "Done"]);
  const row = [...store.values()].find((d) => d.title === "Pasta")!;
  const dayCol = db.dbProps!.find((p) => p.name === "Day")!;
  const doneCol = db.dbProps!.find((p) => p.name === "Done")!;
  // "Tue" wasn't an option — minted, and the schema re-persisted.
  expect(db.dbProps!.find((p) => p.name === "Day")!.options!.map((o) => o.name)).toContain("Tue");
  expect(row.props![dayCol.id]).toBe(dayCol.options!.find((o) => o.name === "Tue")!.id);
  // Column-name matching is case-insensitive; unknown columns are skipped.
  expect(row.props![doneCol.id]).toBe(true);
  expect(Object.keys(row.props!)).toHaveLength(2);
  // The nested page got content from markdown.
  const page = [...store.values()].find((d) => d.title === "Notes")!;
  expect(Array.isArray(page.content)).toBe(true);
  expect(page.parentId).toBe(db._id);
  expect(calls.filter((c) => c.fn === "updateDbProps").length).toBe(2); // initial + minted option
});

test("executor: guarded targets fail their op and the rest continues", async () => {
  const { deps, store } = fakeDeps({
    vaultpage: { vault: true },
    viewerpage: { role: "viewer" },
    trashed: { inTrash: true },
    somedoc: { type: "doc" },
  });
  const plan: AgentOp[] = [
    { kind: "appendToPage", target: "vaultpage", markdown: "- x" },
    { kind: "appendToPage", target: "viewerpage", markdown: "- x" },
    { kind: "appendToPage", target: "trashed", markdown: "- x" },
    { kind: "addRow", target: "somedoc", title: "r" }, // not a database
    { kind: "appendToPage", target: "current", markdown: "- x" }, // no page open
    { kind: "createPage", title: "Still works", parent: "root" },
  ];
  const result = await executePlan(plan, deps);
  expect(result.failures).toHaveLength(5);
  expect(result.created).toHaveLength(1);
  expect(store.get("vaultpage")!.content).toBeUndefined();
});

test("executor: appendToPage keeps existing blocks and appends", async () => {
  const { deps, store } = fakeDeps({
    target: {
      content: [{ type: "paragraph", content: "old" }],
      contentText: "old",
    },
  });
  const plan: AgentOp[] = [
    { kind: "appendToPage", target: "target", markdown: "new line" },
  ];
  const result = await executePlan(plan, deps);
  expect(result.failures).toEqual([]);
  const doc = store.get("target")!;
  expect((doc.content as unknown[]).length).toBe(2);
  expect(doc.contentText).toBe("old\nnew line");
});

test("describeOp renders one plain-language line per kind", () => {
  expect(describeOp({ kind: "createDatabase", title: "M", parent: "root", columns: [{ name: "A", type: "text" }] })).toContain("1 column");
  expect(describeOp({ kind: "appendToPage", target: "current", markdown: "x" })).toContain("open page");
});
