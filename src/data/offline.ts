import { useCallback, useMemo, useSyncExternalStore } from "react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { DataApi, VersionHistoryApi } from "./api";
import { LinkPreview, VersionDoc, VersionMeta } from "../lib/types";
import { createOfflineMutations } from "../offline/mutations";
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
};

export default offlineApi;
