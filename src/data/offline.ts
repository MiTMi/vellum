import { useCallback, useMemo, useSyncExternalStore } from "react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import {
  AccountApi,
  AiApi,
  CommentsApi,
  DataApi,
  PublishApi,
  publicUrlFor,
  VersionHistoryApi,
} from "./api";
import {
  AiAnswer,
  CommentMeta,
  LinkPreview,
  VersionDoc,
  VersionMeta,
} from "../lib/types";
import { createOfflineMutations } from "../offline/mutations";
import { isLocalId } from "../offline/ops";
import {
  convexClient,
  offlineEngine,
  offlineOutbox,
  offlineStore,
} from "../offline/runtime";
import { createStoreReadHooks } from "../offline/storeHooks";

/**
 * The default data layer for real deployments: reads come from the local
 * replica (identical online and offline), writes apply to the replica
 * instantly and queue in the outbox for replay against Convex. The sync
 * engine (src/offline/sync.ts) keeps replica and server converged.
 */

const store = offlineStore();
const hooks = createStoreReadHooks(store);

const mutations = createOfflineMutations({
  store,
  outbox: () => offlineOutbox(),
  kick: () => offlineEngine().kick(),
  firstSyncDone: () => offlineEngine().firstSyncDone(),
});

const offlineApi: DataApi = {
  ...hooks,

  useMutations() {
    return mutations;
  },

  useVersionHistory(): VersionHistoryApi {
    // History lives server-side only (a new table the replica never mirrors),
    // so it reads straight through the Convex client and is unavailable
    // offline. Subscribe to sync status so the UI re-renders on reconnect.
    const connected = useSyncExternalStore(
      (cb) => offlineEngine().subscribeStatus(cb),
      () => offlineEngine().getStatus().connected,
      () => false,
    );
    return useMemo<VersionHistoryApi>(
      () => ({
        available: connected,
        list: (pageId) =>
          convexClient().query(api.versions.list, { pageId }) as Promise<
            VersionMeta[]
          >,
        get: (id) =>
          convexClient().query(api.versions.get, {
            id: id as Id<"pageVersions">,
          }) as Promise<VersionDoc | null>,
      }),
      [connected],
    );
  },

  useLinkPreview() {
    return useCallback(async (url: string): Promise<LinkPreview | null> => {
      if (!offlineEngine().isConnected()) return null;
      return (await convexClient().action(api.linkPreview.fetchMeta, {
        url,
      })) as LinkPreview | null;
    }, []);
  },

  useComments(): CommentsApi {
    const connected = useSyncExternalStore(
      (cb) => offlineEngine().subscribeStatus(cb),
      () => offlineEngine().getStatus().connected,
      () => false,
    );
    return useMemo<CommentsApi>(
      () => ({
        available: connected,
        list: (pageId) =>
          // A page created offline has no server id yet, so it can't own
          // server-side comments until its create replays.
          isLocalId(pageId)
            ? Promise.resolve([])
            : (convexClient().query(api.comments.list, { pageId }) as Promise<
                CommentMeta[]
              >),
        add: async (pageId, text) => {
          if (isLocalId(pageId)) return;
          await convexClient().mutation(api.comments.add, { pageId, text });
        },
        setResolved: async (id, value) => {
          await convexClient().mutation(api.comments.setResolved, {
            id: id as Id<"comments">,
            value,
          });
        },
        remove: async (id) => {
          await convexClient().mutation(api.comments.remove, {
            id: id as Id<"comments">,
          });
        },
      }),
      [connected],
    );
  },

  usePublish(): PublishApi {
    const connected = useSyncExternalStore(
      (cb) => offlineEngine().subscribeStatus(cb),
      () => offlineEngine().getStatus().connected,
      () => false,
    );
    return useMemo<PublishApi>(
      () => ({
        available: connected,
        set: async (pageId, value) => {
          // A page created offline has no server id to publish yet.
          if (isLocalId(pageId)) return null;
          return (await convexClient().mutation(api.pages.setPublished, {
            id: pageId as Id<"pages">,
            value,
          })) as string | null;
        },
        urlFor: publicUrlFor,
      }),
      [connected],
    );
  },

  useAccount(): AccountApi {
    const connected = useSyncExternalStore(
      (cb) => offlineEngine().subscribeStatus(cb),
      () => offlineEngine().getStatus().connected,
      () => false,
    );
    return useMemo<AccountApi>(
      () => ({
        available: connected,
        getEmail: async () =>
          (await convexClient().query(api.account.me, {})).email,
        changePassword: async (currentPassword, newPassword) => {
          await convexClient().action(api.account.changePassword, {
            currentPassword,
            newPassword,
          });
        },
        signOutEverywhere: async () => {
          await convexClient().action(api.account.signOutEverywhere, {});
        },
        deleteAccount: async (password) => {
          await convexClient().action(api.account.deleteAccount, { password });
        },
      }),
      [connected],
    );
  },

  useFileUpload() {
    return useCallback(async (file: File): Promise<string> => {
      if (!offlineEngine().isConnected()) {
        throw new Error(
          "Uploading files requires a connection — try again when back online.",
        );
      }
      const client = convexClient();
      const postUrl = await client.mutation(api.files.generateUploadUrl, {});
      const res = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const { storageId } = (await res.json()) as { storageId: string };
      const fileUrl = await client.mutation(api.files.getFileUrl, {
        storageId: storageId as never,
      });
      if (!fileUrl) throw new Error("Could not resolve file URL");
      return fileUrl;
    }, []);
  },

  useAi(): AiApi {
    const connected = useSyncExternalStore(
      (cb) => offlineEngine().subscribeStatus(cb),
      () => offlineEngine().getStatus().connected,
      () => false,
    );
    return useMemo<AiApi>(
      () => ({
        // Every AI call is a live model round-trip; there is nothing
        // meaningful to queue in the outbox, so the affordances hide
        // themselves while offline rather than failing on click.
        available: connected,
        transform: (args) =>
          convexClient().action(api.ai.transform, args) as Promise<string>,
        fillProperty: (args) =>
          convexClient().action(api.ai.fillProperty, {
            ...args,
            pageId: args.pageId as Id<"pages">,
          }) as Promise<string>,
        ask: (question) =>
          convexClient().action(api.ai.ask, { question }) as Promise<AiAnswer>,
        converse: (args) =>
          convexClient().action(api.ai.converse, {
            ...args,
            pageId: args.pageId as Id<"pages"> | undefined,
          }) as Promise<AiAnswer>,
        deckOutline: (args) =>
          convexClient().action(api.ai.deckOutline, {
            ...args,
            pageId: args.pageId as Id<"pages"> | undefined,
          }) as Promise<string>,
      }),
      [connected],
    );
  },
};

export default offlineApi;
