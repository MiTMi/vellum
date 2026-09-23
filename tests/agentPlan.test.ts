/// <reference types="vite/client" />
// The agent's plan vocabulary: JSON extraction from model replies, the
// whole-plan validator, and the markdown → blocks converter the client
// executor applies plans with. All pure — no backend, no network.
import { expect, test } from "vitest";
import {
  MAX_PLAN_OPS,
  parseAgentJson,
  salvageAgentReply,
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

// The 2026-08-15 live failure: two concatenated objects, the first broken
// by unescaped quotes inside its reply string, the second valid. The scan
// must skip past the garbage (and past the first object's nested plan
// steps, which parse as objects but lack protocol keys) to the real one.
const brokenThenValid =
  '{"reply":"I can add content to the "macOS .plist" page. What would you like?","plan":[{"kind":"createPage","title":"macOS .plist","parent":"root"}]}\n' +
  '{"reply":"Adding it now.","plan":[{"kind":"appendToPage","target":"current","markdown":"## What are .plist files?"}]}';

test("recovers a valid protocol object after a quote-poisoned one", () => {
  const parsed = parseAgentJson(brokenThenValid, ["reply", "tool", "plan"]);
  expect(parsed?.reply).toBe("Adding it now.");
  expect(Array.isArray(parsed?.plan)).toBe(true);
});

test("requiredKeys skips nested fragments without breaking normal parses", () => {
  // A lone plan step must not be mistaken for the protocol message…
  expect(
    parseAgentJson('{"kind":"createPage","title":"x","parent":"root"}', [
      "reply",
      "tool",
      "plan",
    ]),
  ).toBeNull();
  // …while an un-keyed call (the web guard's verdict) behaves as before.
  expect(parseAgentJson('{"allowed":true}')).toEqual({ allowed: true });
});

test("salvageAgentReply pulls the reply out of quote-poisoned JSON", () => {
  const broken =
    '{"reply":"I can add content to the "macOS .plist" page.\\nShall I?","plan":[]}';
  expect(salvageAgentReply(broken)).toBe(
    'I can add content to the "macOS .plist" page.\nShall I?',
  );
  // Plain prose is not protocol-shaped — must pass through untouched.
  expect(salvageAgentReply("Sure, I can help with that.")).toBeNull();
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

test("a missing parent on create steps defaults to root (flash-lite omits it)", () => {
  const result = validatePlan([
    { kind: "createPage", title: "Fable Test Page", markdown: "hi" },
    { kind: "createDatabase", title: "Meals", columns: [{ name: "Day", type: "text" }] },
  ]);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.plan[0]).toMatchObject({ parent: "root" });
    expect(result.plan[1]).toMatchObject({ parent: "root" });
  }
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

test("executor: append-only and existing-db writes report as touched, not silence", async () => {
  // The live 2026-08-16 bug: an append-only apply succeeded but `created`
  // was empty, so the panel announced "Nothing was created."
  const { deps, store } = fakeDeps({
    notes: { title: "Field Notes", icon: "📓", content: [], contentText: "" },
    meals: {
      title: "Meals", type: "database",
      dbProps: [{ id: "day-0", name: "Day", type: "text" }],
    },
  });
  const plan: AgentOp[] = [
    { kind: "appendToPage", target: "notes", markdown: "- new line" },
    { kind: "appendToPage", target: "notes", markdown: "- another" }, // dedup
    { kind: "addRow", target: "meals", title: "Pasta", props: { Day: "Mon" } },
  ];
  const result = await executePlan(plan, deps);
  expect(result.failures).toEqual([]);
  expect(result.created).toEqual([]);
  expect(result.touched).toEqual([
    { pageId: "notes", title: "Field Notes", icon: "📓" },
    { pageId: "meals", title: "Meals", icon: null },
  ]);
  expect(store.get("notes")!.content).toHaveLength(2);
});

test("executor: an in-plan database is a created chip, never doubled as touched", async () => {
  const { deps } = fakeDeps();
  const plan: AgentOp[] = [
    {
      kind: "createDatabase", title: "Trips", parent: "root",
      columns: [{ name: "Where", type: "text" }],
    },
    { kind: "addRow", target: "#0", title: "Rome" },
  ];
  const result = await executePlan(plan, deps);
  expect(result.failures).toEqual([]);
  expect(result.created).toHaveLength(1);
  expect(result.touched).toEqual([]);
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

test("two concatenated JSON objects parse as the first (observed live)", () => {
  const doubled =
    '{"tool":"fetchUrl","url":"https://en.wikipedia.org/wiki/X"}\n{"reply":"premature answer","plan":[]}';
  expect(parseAgentJson(doubled)).toEqual({
    tool: "fetchUrl",
    url: "https://en.wikipedia.org/wiki/X",
  });
  // Braces inside string values don't break the balance scan.
  expect(parseAgentJson('{"reply":"use {curly} braces"} trailing prose')).toEqual({
    reply: "use {curly} braces",
  });
});

/* ------------------------------ replaceText ------------------------------ */

import { findReplaceTargets, replaceBlockIn } from "../src/lib/agentPlan";
import { extractText } from "../src/lib/blocks";

test("replaceText: validator accepts the edit op and keeps delete unrepresentable", () => {
  expect(
    validatePlan([{ kind: "replaceText", target: "current", find: "old text", markdown: "new text" }]).ok,
  ).toBe(true);
  // A blank replacement would be a delete.
  expect(
    validatePlan([{ kind: "replaceText", target: "current", find: "old text", markdown: "   " }]),
  ).toMatchObject({ ok: false, error: /markdown/ });
  // An anchor too short to be unambiguous.
  expect(
    validatePlan([{ kind: "replaceText", target: "current", find: "ab", markdown: "x" }]),
  ).toMatchObject({ ok: false, error: /find/ });
  expect(
    validatePlan([{ kind: "replaceText", target: "", find: "old text", markdown: "x" }]),
  ).toMatchObject({ ok: false, error: /target/ });
});

const para = (text: string, children: unknown[] = []) => ({
  id: text.replace(/\W/g, "_"),
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
  children,
});

test("replaceText: exact block match wins over substring matches", () => {
  const blocks = [para("The quick brown fox"), para("The quick brown fox jumps")];
  const hits = findReplaceTargets(blocks, "The quick brown fox");
  expect(hits).toHaveLength(1);
  expect(hits[0]).toBe(blocks[0]);
  // No exact match → substring, which finds both → ambiguous for the executor.
  expect(findReplaceTargets(blocks, "quick brown")).toHaveLength(2);
  expect(findReplaceTargets(blocks, "nowhere")).toHaveLength(0);
});

test("replaceText: nested children ride along on the last replacement block", () => {
  const kids = [para("child")];
  const blocks = [para("intro"), para("target", kids), para("outro")];
  const next = replaceBlockIn(blocks, blocks[1], [para("a"), para("b")]);
  expect(next.map((b) => (b as { id: string }).id)).toEqual(["intro", "a", "b", "outro"]);
  expect((next[2] as { children: unknown[] }).children).toBe(kids);
});

test("executor: replaceText swaps exactly one block in place and reports the page as touched", async () => {
  const { deps, store } = fakeDeps({
    p1: {
      title: "Notes",
      content: [para("keep me"), para("The quick brown fox"), para("and me")],
      contentText: "keep me\nThe quick brown fox\nand me",
    },
  });
  deps.currentPageId = "p1" as PageId;
  const result = await executePlan(
    [{ kind: "replaceText", target: "current", find: "The quick brown fox", markdown: "A formal fox" }],
    deps,
  );
  expect(result.failures).toEqual([]);
  expect(result.created).toEqual([]);
  expect(result.touched.map((t) => t.pageId)).toEqual(["p1"]);
  const doc = store.get("p1")!;
  // Read each block the way the app does — the replacement comes from
  // markdownToBlocks and is not shaped like the fixture.
  const texts = (doc.content as unknown[]).map((b) => extractText([b]).trim());
  expect(texts).toEqual(["keep me", "A formal fox", "and me"]);
  expect(doc.contentText).toContain("A formal fox");
  expect(doc.contentText).not.toContain("quick brown");
});

test("executor: replaceText refuses a missing or ambiguous anchor without writing", async () => {
  const { deps, calls } = fakeDeps({
    p1: { title: "Notes", content: [para("same line"), para("same line")] },
  });
  deps.currentPageId = "p1" as PageId;
  const result = await executePlan(
    [
      { kind: "replaceText", target: "current", find: "same line", markdown: "x" },
      { kind: "replaceText", target: "current", find: "not on the page", markdown: "y" },
    ],
    deps,
  );
  expect(result.failures.map((f) => f.opIndex)).toEqual([0, 1]);
  expect(result.failures[0].reason).toMatch(/more than once/);
  expect(result.failures[1].reason).toMatch(/no longer on the page/);
  expect(calls.filter((c) => c.fn === "updateContent")).toHaveLength(0);
});

import { blockLines } from "../convex/lib/agentPlan";

test("blockLines: one line per block, runs joined without stray spaces, children indented", () => {
  const doc = [
    { type: "heading", content: [{ type: "text", text: "Touch ID sign-in", styles: {} }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Offers ", styles: {} },
        { type: "text", text: "Sign in with Touch ID", styles: { bold: true } },
        { type: "text", text: " next to the form.", styles: {} },
      ],
      children: [{ type: "paragraph", content: [{ type: "text", text: "nested", styles: {} }] }],
    },
    { type: "paragraph", content: [] },
  ];
  expect(blockLines(doc)).toBe(
    "Touch ID sign-in\nOffers Sign in with Touch ID next to the form.\n  nested",
  );
});

test("replaceText: a line copied from blockLines matches a multi-run block", () => {
  const block = {
    type: "paragraph",
    content: [
      { type: "text", text: "Offers ", styles: {} },
      { type: "text", text: "Sign in with Touch ID", styles: { bold: true } },
      { type: "text", text: " next to the form.", styles: {} },
    ],
  };
  const line = blockLines([block]);
  expect(findReplaceTargets([block], line)).toHaveLength(1);
});

import { partialReply } from "../convex/lib/agentPlan";

test("partialReply decodes the reply string as far as it has streamed", () => {
  expect(partialReply("")).toBeNull();
  expect(partialReply('{"tool":"search","query":"x"}')).toBeNull(); // tool round: nothing to show
  expect(partialReply('{"reply":"Hel')).toBe("Hel");
  expect(partialReply('{"reply":"Line one\\nLine \\"two\\"')).toBe('Line one\nLine "two"');
  expect(partialReply('{"reply":"ends here\\')).toBe("ends here"); // escape split across chunks
  expect(partialReply('{"reply":"caf\\u00e9 done","plan":[')).toBe("café done");
  expect(partialReply('```json\n{"reply":"fenced')).toBe("fenced");
  expect(partialReply("Plain prose streams as-is")).toBe("Plain prose streams as-is");
});
