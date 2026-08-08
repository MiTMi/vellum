/// <reference types="vite/client" />
// Lives outside convex/ so the Convex CLI doesn't typecheck/bundle it.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

/**
 * The AI actions, with `fetch` stubbed — these tests are about the guards
 * around the model call (auth, the Vault, input limits, error translation),
 * never about the model itself. Nothing here touches the network.
 */

const modules = import.meta.glob([
  "../convex/pages.ts",
  "../convex/ai.ts",
  "../convex/account.ts",
  "../convex/files.ts",
  "../convex/versions.ts",
  "../convex/comments.ts",
  "../convex/migrate.ts",
  "../convex/schema.ts",
  "../convex/lib/*.ts",
  "../convex/_generated/*.js",
]);

function t() {
  return convexTest(schema, modules).withIdentity({ subject: "owner|test" });
}

/** A minimal OpenRouter success envelope carrying `content`. */
function ok(content: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [{ message: { content, ...extra } }],
    }),
  } as unknown as Response;
}

function fail(status: number, message: string) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => ({ error: { message } }),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ auth */

test("AI actions reject unauthenticated callers", async () => {
  const anon = convexTest(schema, modules);
  await expect(
    anon.action(api.ai.transform, { text: "hello", kind: "improve" }),
  ).rejects.toThrow(/Not authenticated/);
  await expect(anon.action(api.ai.ask, { question: "hi" })).rejects.toThrow(
    /Not authenticated/,
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

/* ------------------------------------------------------- key + transform */

test("a missing API key fails before any network call", async () => {
  delete process.env.OPENROUTER_API_KEY;
  await expect(
    t().action(api.ai.transform, { text: "hello", kind: "improve" }),
  ).rejects.toThrow(/OPENROUTER_API_KEY/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("transform returns only `content`, never the reasoning scratchpad", async () => {
  fetchMock.mockResolvedValue(
    ok("Polished sentence.", {
      reasoning: "The user wants this improved…",
      reasoning_details: [{ type: "reasoning.text", text: "secret" }],
    }),
  );
  const out = await t().action(api.ai.transform, {
    text: "sentence bad",
    kind: "improve",
  });
  expect(out).toBe("Polished sentence.");
  expect(out).not.toMatch(/secret|scratchpad|reasoning/i);
});

test("transform pins the guardrailed model and its :free suffix", async () => {
  fetchMock.mockResolvedValue(ok("x"));
  await t().action(api.ai.transform, { text: "y", kind: "fix" });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  // Must match the slug allowlisted on the key's OpenRouter guardrail —
  // if this assertion is updated, the dashboard has to be updated too.
  expect(body.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
  expect(body.model).toMatch(/:free$/);
});

test("transform rejects empty rewrites and oversized selections without calling out", async () => {
  // Rewrite kinds need something to rewrite…
  for (const kind of ["improve", "fix", "summarize", "translate"] as const) {
    await expect(
      t().action(api.ai.transform, { text: "   ", kind }),
    ).rejects.toThrow(/Nothing to rewrite/);
  }
  await expect(
    t().action(api.ai.transform, { text: "x".repeat(12_001), kind: "improve" }),
  ).rejects.toThrow(/too long/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("writing from a blank line is allowed and carries the instruction", async () => {
  // …but "custom" and "continue" on an empty line are how you write from
  // scratch, which is the most-used Notion AI flow. They must not be blocked.
  fetchMock.mockResolvedValue(ok("Standup: shipped the AI menu."));

  const out = await t().action(api.ai.transform, {
    text: "",
    kind: "custom",
    option: "Draft a standup update",
  });
  expect(out).toBe("Standup: shipped the AI menu.");

  const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  const prompt = sent.messages[1].content as string;
  expect(prompt).toContain("Draft a standup update");
  // No empty delimiter pair wrapping nothing.
  expect(prompt).not.toMatch(/---\s*---/);

  await expect(
    t().action(api.ai.transform, { text: "", kind: "continue" }),
  ).resolves.toBeTruthy();
});

test("an empty completion is reported rather than returned as blank", async () => {
  fetchMock.mockResolvedValue(ok("   "));
  await expect(
    t().action(api.ai.transform, { text: "hello", kind: "improve" }),
  ).rejects.toThrow(/empty response/);
});

/* --------------------------------------------------------- error mapping */

test("a guardrail 404 is explained, and is not retried", async () => {
  fetchMock.mockResolvedValue(
    fail(404, "No endpoints available matching your guardrail restrictions"),
  );
  await expect(
    t().action(api.ai.transform, { text: "hello", kind: "improve" }),
  ).rejects.toThrow(/guardrail does not allow/);
  // Config errors must not burn the 20/min budget on doomed retries.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a 401 names the key rather than leaking the raw status", async () => {
  fetchMock.mockResolvedValue(fail(401, "No auth credentials found"));
  await expect(
    t().action(api.ai.transform, { text: "hello", kind: "improve" }),
  ).rejects.toThrow(/OPENROUTER_API_KEY/);
});

test("a 429 is retried and can succeed", async () => {
  fetchMock
    .mockResolvedValueOnce(fail(429, "rate limited"))
    .mockResolvedValueOnce(ok("second try"));
  const out = await t().action(api.ai.transform, {
    text: "hello",
    kind: "improve",
  });
  expect(out).toBe("second try");
  expect(fetchMock).toHaveBeenCalledTimes(2);
}, 20_000);

/* ----------------------------------------------------------------- vault */

test("fillProperty refuses vault rows server-side", async () => {
  const ctx = t();
  // Databases can't live in the Vault (pages.ts), so the row here is a
  // plain vault child — `fillProperty` gates on the `vault` flag itself,
  // which children inherit, not on the page's type.
  const root = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Vault",
    vault: true,
  });
  const row = await ctx.mutation(api.pages.create, {
    type: "doc",
    parentId: root,
    title: "venc1:iv:ciphertext",
  });

  await expect(
    ctx.action(api.ai.fillProperty, { pageId: row, kind: "summary" }),
  ).rejects.toThrow(/Vault/);
  // The guarantee is that nothing left the device — assert on the wire.
  expect(fetchMock).not.toHaveBeenCalled();
});

test("ask never retrieves vault or trashed pages", async () => {
  const ctx = t();
  const plain = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Roadmap",
  });
  await ctx.mutation(api.pages.updateContent, {
    id: plain,
    content: [],
    text: "The roadmap covers hosting migration work.",
  });

  const vaultRoot = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Vault",
    vault: true,
  });
  await ctx.mutation(api.pages.updateContent, {
    id: vaultRoot,
    content: [],
    text: "roadmap hosting migration secret",
  });

  const trashed = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Old roadmap",
  });
  await ctx.mutation(api.pages.updateContent, {
    id: trashed,
    content: [],
    text: "roadmap hosting migration obsolete",
  });
  await ctx.mutation(api.pages.trash, { id: trashed });

  fetchMock.mockResolvedValue(ok("The roadmap covers hosting. [1]"));
  const res = await ctx.action(api.ai.ask, { question: "roadmap hosting" });

  const ids = res.sources.map((s) => s.pageId);
  expect(ids).toContain(plain);
  expect(ids).not.toContain(vaultRoot);
  expect(ids).not.toContain(trashed);

  // Belt and braces: the prompt itself must not carry the excluded text.
  const sent = fetchMock.mock.calls[0][1].body as string;
  expect(sent).not.toMatch(/secret|obsolete/);
});

/* ------------------------------------------------------------- converse */

test("converse refuses a vault page as chat context", async () => {
  const ctx = t();
  const root = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Vault",
    vault: true,
  });
  await expect(
    ctx.action(api.ai.converse, {
      messages: [{ role: "user", content: "summarize this" }],
      pageId: root,
    }),
  ).rejects.toThrow(/Vault/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("converse sends the conversation history, not just the last turn", async () => {
  fetchMock.mockResolvedValue(ok("Sure."));
  await t().action(api.ai.converse, {
    messages: [
      { role: "user", content: "who wrote the roadmap" },
      { role: "assistant", content: "You did." },
      { role: "user", content: "when" },
    ],
  });
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  const transcript = sent.messages[1].content as string;
  expect(transcript).toContain("who wrote the roadmap");
  expect(transcript).toContain("You did.");
  expect(transcript).toContain("when");
});

test("converse injects custom instructions into the system prompt", async () => {
  fetchMock.mockResolvedValue(ok("Aye."));
  await t().action(api.ai.converse, {
    messages: [{ role: "user", content: "hello" }],
    persona: "Answer in British English.",
  });
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(sent.messages[0].role).toBe("system");
  expect(sent.messages[0].content).toContain("Answer in British English.");
});

test("converse rejects an empty conversation", async () => {
  await expect(
    t().action(api.ai.converse, { messages: [] }),
  ).rejects.toThrow(/Say something/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("deckOutline refuses vault pages and needs a source", async () => {
  const ctx = t();
  const vault = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Vault",
    vault: true,
  });
  await expect(
    ctx.action(api.ai.deckOutline, { pageId: vault }),
  ).rejects.toThrow(/Vault/);
  await expect(ctx.action(api.ai.deckOutline, {})).rejects.toThrow(
    /Open a page or give me a topic/,
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test("ask short-circuits when retrieval finds nothing", async () => {
  const res = await t().action(api.ai.ask, {
    question: "something that matches no page at all",
  });
  expect(res.sources).toEqual([]);
  expect(res.answer).toMatch(/couldn't find/i);
  expect(fetchMock).not.toHaveBeenCalled();
});
