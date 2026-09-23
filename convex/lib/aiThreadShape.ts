import { v } from "convex/values";

/**
 * One saved chat message — the client's `AiChatMessage`, as stored in an
 * `aiThreads` document. Shared by the schema and `aiThreads.save` so the
 * two can't drift. A plan is stored as the model produced it (already
 * validated by convex/lib/agentPlan.ts when it was generated) and is only
 * ever re-rendered, never re-executed without the user clicking Apply.
 */
export const aiThreadSource = v.object({
  pageId: v.string(),
  title: v.string(),
  icon: v.union(v.string(), v.null()),
  url: v.optional(v.string()),
});

export const aiThreadMessage = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  sources: v.optional(v.array(aiThreadSource)),
  plan: v.optional(v.union(v.null(), v.array(v.any()))),
  planApplied: v.optional(v.boolean()),
  error: v.optional(v.string()),
});
