import { ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { AgentProgress, AiApi, AiThreadsApi } from "./api";
import { AgentAnswer, AiChatMessage } from "../lib/types";

/**
 * The server-backed halves of the AI API shared by offline and direct
 * mode — both hold a ConvexReactClient, and neither can use `useQuery`
 * here (offline mode has no ConvexProvider).
 */

type AgentArgs = Parameters<AiApi["agent"]>[0];

/**
 * Runs the agent, reporting progress while it works (streaming,
 * 2026-09-22). The action can't push to the client, so it writes progress
 * into an `aiStreams` row keyed by an id minted here, and this watches that
 * row. The action's return value is the final answer either way.
 */
export async function agentWithProgress(
  client: ConvexReactClient,
  args: AgentArgs,
  onProgress?: (p: AgentProgress) => void,
): Promise<AgentAnswer> {
  const payload = { ...args, pageId: args.pageId as Id<"pages"> | undefined };
  if (!onProgress) return (await client.action(api.ai.agent, payload)) as AgentAnswer;
  const streamId = crypto.randomUUID();
  const watch = client.watchQuery(api.aiStreams.get, { streamId });
  const unsubscribe = watch.onUpdate(() => {
    try {
      const row = watch.localQueryResult();
      if (row) onProgress({ status: row.status, text: row.text });
    } catch {
      // A failed progress read is cosmetic; the answer still arrives.
    }
  });
  try {
    return (await client.action(api.ai.agent, { ...payload, streamId })) as AgentAnswer;
  } finally {
    unsubscribe();
  }
}

/** Convex rejects `undefined` inside arrays and some nested shapes; a JSON
 *  round-trip drops every undefined field the UI leaves on messages. */
function storable(messages: AiChatMessage[]): AiChatMessage[] {
  return JSON.parse(JSON.stringify(messages)) as AiChatMessage[];
}

export function remoteThreads(
  client: () => ConvexReactClient,
  available: boolean,
): AiThreadsApi {
  return {
    available,
    list: async () => await client().query(api.aiThreads.list, {}),
    get: async (id) =>
      (await client().query(api.aiThreads.get, {
        id: id as Id<"aiThreads">,
      })) as { _id: string; title: string; messages: AiChatMessage[] } | null,
    save: async ({ id, title, messages }) =>
      await client().mutation(api.aiThreads.save, {
        id: (id ?? undefined) as Id<"aiThreads"> | undefined,
        title,
        messages: storable(messages) as never,
      }),
    remove: async (id) => {
      await client().mutation(api.aiThreads.remove, { id: id as Id<"aiThreads"> });
    },
  };
}
