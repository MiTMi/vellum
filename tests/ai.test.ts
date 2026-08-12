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

import { modules, ownerBackend } from "./helpers";

// Fresh backend with the owner signed in (a real users row — functions
// stamp and compare Id<"users">). Owner is exempt from AI budgets, so
// these tests exercise the model-call guards, not the quota layer.
async function t() {
  return (await ownerBackend()).as;
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
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.GOOGLE_SEARCH_API_KEY;
  delete process.env.GOOGLE_SEARCH_CX;
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
    (await t()).action(api.ai.transform, { text: "hello", kind: "improve" }),
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
  const out = await (await t()).action(api.ai.transform, {
    text: "sentence bad",
    kind: "improve",
  });
  expect(out).toBe("Polished sentence.");
  expect(out).not.toMatch(/secret|scratchpad|reasoning/i);
});

test("the model comes from OPENROUTER_MODEL, falling back to the default", async () => {
  // Whatever this resolves to must be on the key's guardrail allowlist —
  // the two are a matched pair and a mismatch 404s every call.
  fetchMock.mockResolvedValue(ok("x"));
  await (await t()).action(api.ai.transform, { text: "y", kind: "fix" });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe(
    "google/gemini-2.5-flash-lite",
  );

  fetchMock.mockClear();
  process.env.OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b";
  await (await t()).action(api.ai.transform, { text: "y", kind: "fix" });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe(
    "nvidia/nemotron-3-super-120b-a12b",
  );
  delete process.env.OPENROUTER_MODEL;
});

test("transform rejects empty rewrites and oversized selections without calling out", async () => {
  // Rewrite kinds need something to rewrite…
  for (const kind of ["improve", "fix", "summarize", "translate"] as const) {
    await expect(
      (await t()).action(api.ai.transform, { text: "   ", kind }),
    ).rejects.toThrow(/Nothing to rewrite/);
  }
  await expect(
    (await t()).action(api.ai.transform, { text: "x".repeat(12_001), kind: "improve" }),
  ).rejects.toThrow(/too long/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("writing from a blank line is allowed and carries the instruction", async () => {
  // …but "custom" and "continue" on an empty line are how you write from
  // scratch, which is the most-used Notion AI flow. They must not be blocked.
  fetchMock.mockResolvedValue(ok("Standup: shipped the AI menu."));

  const out = await (await t()).action(api.ai.transform, {
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
    (await t()).action(api.ai.transform, { text: "", kind: "continue" }),
  ).resolves.toBeTruthy();
});

test("an empty completion is reported rather than returned as blank", async () => {
  fetchMock.mockResolvedValue(ok("   "));
  await expect(
    (await t()).action(api.ai.transform, { text: "hello", kind: "improve" }),
  ).rejects.toThrow(/empty response/);
});

/* --------------------------------------------------------- error mapping */

test("a guardrail 404 is explained, and is not retried", async () => {
  fetchMock.mockResolvedValue(
    fail(404, "No endpoints available matching your guardrail restrictions"),
  );
  await expect(
    (await t()).action(api.ai.transform, { text: "hello", kind: "improve" }),
  ).rejects.toThrow(/guardrail does not allow/);
  // Config errors must not burn the 20/min budget on doomed retries.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a 401 names the key rather than leaking the raw status", async () => {
  fetchMock.mockResolvedValue(fail(401, "No auth credentials found"));
  await expect(
    (await t()).action(api.ai.transform, { text: "hello", kind: "improve" }),
  ).rejects.toThrow(/OPENROUTER_API_KEY/);
});

test("a 429 is retried and can succeed", async () => {
  fetchMock
    .mockResolvedValueOnce(fail(429, "rate limited"))
    .mockResolvedValueOnce(ok("second try"));
  const out = await (await t()).action(api.ai.transform, {
    text: "hello",
    kind: "improve",
  });
  expect(out).toBe("second try");
  expect(fetchMock).toHaveBeenCalledTimes(2);
}, 20_000);

/* ----------------------------------------------------------------- vault */

test("fillProperty refuses vault rows server-side", async () => {
  const ctx = await t();
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
  const ctx = await t();
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
  const ctx = await t();
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
  await (await t()).action(api.ai.converse, {
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
  await (await t()).action(api.ai.converse, {
    messages: [{ role: "user", content: "hello" }],
    persona: "Answer in British English.",
  });
  const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(sent.messages[0].role).toBe("system");
  expect(sent.messages[0].content).toContain("Answer in British English.");
});

test("converse rejects an empty conversation", async () => {
  await expect(
    (await t()).action(api.ai.converse, { messages: [] }),
  ).rejects.toThrow(/Say something/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("deckOutline refuses vault pages and needs a source", async () => {
  const ctx = await t();
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
  const res = await (await t()).action(api.ai.ask, {
    question: "something that matches no page at all",
  });
  expect(res.sources).toEqual([]);
  expect(res.answer).toMatch(/couldn't find/i);
  expect(fetchMock).not.toHaveBeenCalled();
});

/* ------------------------------------------------------ workspace agent */

test("agent: a direct reply with a valid plan comes back validated", async () => {
  fetchMock.mockResolvedValue(
    ok(
      JSON.stringify({
        reply: "Here's your meal planner.",
        plan: [
          {
            kind: "createDatabase",
            title: "Meals",
            parent: "root",
            columns: [{ name: "Day", type: "select", options: ["Mon"] }],
          },
          { kind: "addRow", target: "#0", title: "Pasta", props: { Day: "Mon" } },
        ],
      }),
    ),
  );
  const res = await (await t()).action(api.ai.agent, {
    messages: [{ role: "user", content: "make me a meal planner" }],
  });
  expect(res.answer).toBe("Here's your meal planner.");
  expect(res.plan).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("agent: tool rounds run, feed results back, and cap at 4 calls", async () => {
  const ctx = await t();
  // Model asks to search three times, then must answer on the forced
  // final round. Every round is a metered model call.
  fetchMock
    .mockResolvedValueOnce(ok('{"tool":"search","query":"groceries"}'))
    .mockResolvedValueOnce(ok('{"tool":"search","query":"errands"}'))
    .mockResolvedValueOnce(ok('{"tool":"search","query":"chores"}'))
    .mockResolvedValueOnce(ok('{"reply":"Nothing found."}'));
  const res = await ctx.action(api.ai.agent, {
    messages: [{ role: "user", content: "what's on my lists?" }],
  });
  expect(res.answer).toBe("Nothing found.");
  expect(res.plan).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  // The later requests carry the earlier tool results in the transcript.
  const lastBody = JSON.parse(fetchMock.mock.calls[3][1].body as string);
  expect(lastBody.messages[1].content).toContain('Tool result for search "groceries"');
  expect(lastBody.messages[1].content).toContain("final JSON now");
});

test("agent: a malformed plan is rejected whole; the reply survives", async () => {
  fetchMock.mockResolvedValue(
    ok(
      JSON.stringify({
        reply: "Done!",
        plan: [{ kind: "trashPage", target: "everything" }],
      }),
    ),
  );
  const res = await (await t()).action(api.ai.agent, {
    messages: [{ role: "user", content: "clean up my workspace" }],
  });
  expect(res.plan).toBeNull();
  expect(res.answer).toContain("Done!");
  expect(res.answer).toMatch(/malformed/);
});

test("agent: off-protocol prose becomes the answer, never an error", async () => {
  fetchMock.mockResolvedValue(ok("I'm not sure what you mean."));
  const res = await (await t()).action(api.ai.agent, {
    messages: [{ role: "user", content: "hmm" }],
  });
  expect(res.answer).toBe("I'm not sure what you mean.");
  expect(res.plan).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("agent: vault context page is refused before any model call", async () => {
  const ctx = await t();
  const vault = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Vault",
    vault: true,
  });
  await expect(
    ctx.action(api.ai.agent, {
      messages: [{ role: "user", content: "summarize" }],
      pageId: vault,
    }),
  ).rejects.toThrow(/Vault/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("agent: the read tool refuses vault pages but allows normal ones", async () => {
  const ctx = await t();
  const normal = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "Groceries",
  });
  await ctx.mutation(api.pages.updateContent, {
    id: normal,
    content: [{ type: "paragraph", content: [{ type: "text", text: "milk and eggs", styles: {} }] }],
    text: "milk and eggs",
  });
  const vault = await ctx.mutation(api.pages.create, {
    type: "doc",
    title: "venc1:x:y",
    vault: true,
  });
  fetchMock
    .mockResolvedValueOnce(ok(`{"tool":"read","pageId":"${vault}"}`))
    .mockResolvedValueOnce(ok(`{"tool":"read","pageId":"${normal}"}`))
    .mockResolvedValueOnce(ok('{"reply":"ok"}'));
  await ctx.action(api.ai.agent, {
    messages: [{ role: "user", content: "read my pages" }],
  });
  const thirdBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
  const transcript = thirdBody.messages[1].content as string;
  expect(transcript).toContain("That page is not available."); // the vault read
  expect(transcript).toContain("milk and eggs"); // the normal read
});

/* ------------------------------------------------- agent web tools */

test("agent: web tools stay out of the prompt without the globe opt-in", async () => {
  fetchMock
    .mockResolvedValueOnce(ok('{"tool":"webSearch","query":"news"}'))
    .mockResolvedValueOnce(ok('{"reply":"ok, no web"}'));
  const res = await (await t()).action(api.ai.agent, {
    messages: [{ role: "user", content: "what's new?" }],
  });
  const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(firstBody.messages[0].content).not.toContain("webSearch");
  expect(firstBody.messages[0].content).not.toContain("fetchUrl");
  // The uninvited tool call degrades to "unavailable", not an error.
  const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
  expect(secondBody.messages[1].content).toContain("unavailable");
  expect(res.answer).toBe("ok, no web");
});

test("agent: webSearch round-trips a provider and cites web sources", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "b";
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("api.search.brave.com")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          web: {
            results: [
              { title: "Vellum docs", url: "https://docs.example", description: "the manual" },
            ],
          },
        }),
      } as unknown as Response;
    }
    // OpenRouter: first a search, then the final reply.
    const isFirst = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("openrouter"),
    ).length <= 1;
    return ok(
      isFirst
        ? '{"tool":"webSearch","query":"vellum manual"}'
        : '{"reply":"Found it."}',
    );
  });
  const res = await (await t()).action(api.ai.agent, {
    messages: [{ role: "user", content: "find the vellum manual online" }],
    allowWeb: true,
  });
  expect(res.answer).toBe("Found it.");
  const web = res.sources.find((s) => (s as { url?: string }).url);
  expect((web as { url?: string })?.url).toBe("https://docs.example");
  const lastOr = fetchMock.mock.calls.filter((c) => String(c[0]).includes("openrouter")).pop()!;
  expect(JSON.parse(lastOr[1].body as string).messages[1].content).toContain("the manual");
});

test("agent: fetchUrl works with no search keys and feeds page text back", async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("site.example")) {
      return {
        ok: true,
        status: 200,
        url: "https://site.example/article",
        headers: new Headers({ "content-type": "text/html" }),
        arrayBuffer: async () =>
          new TextEncoder().encode("<h1>Big news</h1><p>details here</p>").buffer,
      } as unknown as Response;
    }
    const isFirst = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("openrouter"),
    ).length <= 1;
    return ok(
      isFirst
        ? '{"tool":"fetchUrl","url":"https://site.example/article"}'
        : '{"reply":"Summarized."}',
    );
  });
  const res = await (await t()).action(api.ai.agent, {
    messages: [{ role: "user", content: "summarize https://site.example/article" }],
    allowWeb: true,
  });
  expect(res.answer).toBe("Summarized.");
  const lastOr = fetchMock.mock.calls.filter((c) => String(c[0]).includes("openrouter")).pop()!;
  expect(JSON.parse(lastOr[1].body as string).messages[1].content).toContain("Big news details here");
  expect(res.sources.some((s) => (s as { url?: string }).url === "https://site.example/article")).toBe(true);
});
