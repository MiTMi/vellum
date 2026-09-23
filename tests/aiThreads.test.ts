/// <reference types="vite/client" />
import { expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";
import { addUser, freshBackend } from "./helpers";

/**
 * Saved AI chats and in-flight AI streams are owner-only: a chat can quote
 * any page its owner reads, so another account must never see or touch
 * one — same null-on-read / throw-on-write contract as pages.
 */

const msgs = (text: string) => [
  { role: "user" as const, content: text },
  { role: "assistant" as const, content: `re: ${text}`, sources: [], plan: null },
];

test("aiThreads: save, list, reopen and delete are owner-only", async () => {
  const tc = freshBackend();
  const a = await addUser(tc, "alice@vellum.test");
  const b = await addUser(tc, "bob@vellum.test");

  const id = await a.as.mutation(api.aiThreads.save, {
    title: "Trip plan",
    messages: msgs("plan a trip"),
  });
  // Upsert: the same id is patched, never duplicated.
  expect(
    await a.as.mutation(api.aiThreads.save, { id, title: "Trip plan", messages: msgs("again") }),
  ).toBe(id);
  const listed = await a.as.query(api.aiThreads.list, {});
  expect(listed.map((t) => t._id)).toEqual([id]);
  expect((await a.as.query(api.aiThreads.get, { id }))!.messages[0].content).toBe("again");

  // B: sees nothing, can't read by id, can't overwrite or delete.
  expect(await b.as.query(api.aiThreads.list, {})).toEqual([]);
  expect(await b.as.query(api.aiThreads.get, { id })).toBeNull();
  await expect(
    b.as.mutation(api.aiThreads.save, { id, title: "x", messages: msgs("x") }),
  ).rejects.toThrow(/Not authorized/);
  await expect(b.as.mutation(api.aiThreads.remove, { id })).rejects.toThrow(/Not authorized/);

  await a.as.mutation(api.aiThreads.remove, { id });
  expect(await a.as.query(api.aiThreads.get, { id })).toBeNull();
});

test("aiThreads: a thread is capped instead of growing past the document limit", async () => {
  const tc = freshBackend();
  const a = await addUser(tc, "alice@vellum.test");
  const many = Array.from({ length: 90 }, (_, i) => ({
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    content: `message ${i}`,
  }));
  const id = await a.as.mutation(api.aiThreads.save, { title: "long", messages: many });
  const t = await a.as.query(api.aiThreads.get, { id });
  expect(t!.messages).toHaveLength(60);
  expect(t!.messages.at(-1)!.content).toBe("message 89"); // newest kept
});

test("aiStreams: progress is readable only by the account that owns it", async () => {
  const tc = freshBackend();
  const a = await addUser(tc, "alice@vellum.test");
  const b = await addUser(tc, "bob@vellum.test");
  await tc.mutation(internal.aiStreams._write, {
    userId: a.userId as Id<"users">,
    streamId: "s-1",
    status: "Thinking…",
    text: "Hel",
  });
  expect(await a.as.query(api.aiStreams.get, { streamId: "s-1" })).toEqual({
    status: "Thinking…",
    text: "Hel",
  });
  expect(await b.as.query(api.aiStreams.get, { streamId: "s-1" })).toBeNull();
  // B writing under A's id changes nothing A sees.
  await tc.mutation(internal.aiStreams._write, {
    userId: b.userId as Id<"users">,
    streamId: "s-1",
    text: "hijacked",
  });
  expect((await a.as.query(api.aiStreams.get, { streamId: "s-1" }))!.text).toBe("Hel");
  await tc.mutation(internal.aiStreams._clear, {
    userId: a.userId as Id<"users">,
    streamId: "s-1",
  });
  expect(await a.as.query(api.aiStreams.get, { streamId: "s-1" })).toBeNull();
});

test("deleting an account deletes its saved chats and stream rows", async () => {
  vi.useFakeTimers();
  const tc = freshBackend();
  const a = await addUser(tc, "alice@vellum.test");
  const b = await addUser(tc, "bob@vellum.test");
  await a.as.mutation(api.aiThreads.save, { title: "mine", messages: msgs("hi") });
  const kept = await b.as.mutation(api.aiThreads.save, { title: "bob's", messages: msgs("yo") });
  await tc.mutation(internal.aiStreams._write, {
    userId: a.userId as Id<"users">,
    streamId: "s-a",
    text: "x",
  });
  await tc.mutation(internal.account.wipeUser, { userId: a.userId as Id<"users"> });
  await tc.finishAllScheduledFunctions(vi.runAllTimers);
  await tc.run(async (ctx) => {
    const threads = await ctx.db.query("aiThreads").collect();
    expect(threads.map((t) => t._id)).toEqual([kept]);
    expect(await ctx.db.query("aiStreams").collect()).toHaveLength(0);
  });
  vi.useRealTimers();
});

test("deleting an account also deletes its web audit rows and AI usage", async () => {
  vi.useFakeTimers();
  const tc = freshBackend();
  const a = await addUser(tc, "alice@vellum.test");
  await addUser(tc, "bob@vellum.test");
  await tc.run(async (ctx) => {
    const userId = a.userId as Id<"users">;
    await ctx.db.insert("webAudit", { userId, kind: "search", text: "q", allowed: true, at: Date.now() });
    await ctx.db.insert("aiUsage", { userId, month: "2026-09", costMicroUsd: 5, calls: 1 });
  });
  await tc.mutation(internal.account.wipeUser, { userId: a.userId as Id<"users"> });
  await tc.finishAllScheduledFunctions(vi.runAllTimers);
  await tc.run(async (ctx) => {
    expect(await ctx.db.query("webAudit").collect()).toHaveLength(0);
    expect(await ctx.db.query("aiUsage").collect()).toHaveLength(0);
  });
  vi.useRealTimers();
});
