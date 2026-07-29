import { Mutations } from "../data/api";
import { isLocalId, newLocalId, OutboxOp, toCreatePayload } from "./ops";
import { Outbox } from "./outbox";
import { PageStore } from "./store";

/**
 * The offline mutation set: every write applies to the local replica
 * synchronously (instant UI) and appends to the outbox for replay against
 * Convex. Dependencies are injected so integration tests can drive the
 * exact code path the app uses.
 */
export interface OfflineMutationDeps {
  store: PageStore;
  outbox(): Outbox;
  /** Nudge the sync engine after enqueueing. */
  kick(): void;
  /** Resolves after the first successful reconcile ever (gates bootstrap). */
  firstSyncDone(): Promise<void>;
}

export function createOfflineMutations(deps: OfflineMutationDeps): Mutations {
  const { store } = deps;

  function enqueue(op: OutboxOp) {
    deps.outbox().enqueue(op);
    deps.kick();
  }

  return {
    async create(args) {
      const id = newLocalId();
      const doc = store.create(args, id, Date.now());
      enqueue({ kind: "createWithDoc", clientKey: id, doc: toCreatePayload(doc) });
      return id;
    },

    async rename({ id, title }) {
      const now = Date.now();
      if (store.rename(id, title, now)) {
        enqueue({ kind: "rename", id, title, clientUpdatedAt: now });
      }
    },

    async updateContent({ id, content, text }) {
      const now = Date.now();
      if (store.updateContent(id, content, text, now)) {
        enqueue({ kind: "updateContent", id, content, text, clientUpdatedAt: now });
      }
    },

    async setIcon({ id, icon }) {
      if (store.setIcon(id, icon, Date.now())) {
        enqueue({ kind: "setIcon", id, icon });
      }
    },

    async setCover({ id, cover }) {
      if (store.setCover(id, cover, Date.now())) {
        enqueue({ kind: "setCover", id, cover });
      }
    },

    async toggleFavorite({ id }) {
      const doc = store.toggleFavorite(id, Date.now());
      if (doc) {
        enqueue({ kind: "setFavorite", id, value: doc.isFavorite ?? false });
      }
    },

    async setPageOptions(args) {
      if (store.setPageOptions(args, Date.now())) {
        enqueue({ kind: "setPageOptions", ...args });
      }
    },

    async move({ id, parentId, rank }) {
      if (store.move(id, parentId, rank, Date.now())) {
        enqueue({ kind: "move", id, parentId, rank });
      }
    },

    async duplicate({ id }) {
      const result = store.duplicate(id, newLocalId, Date.now());
      if (!result) return null;
      // Parent-before-child order matters: each create's temp parentId is
      // remapped before the child's op drains.
      for (const doc of result.created) {
        enqueue({
          kind: "createWithDoc",
          clientKey: doc._id,
          doc: toCreatePayload(doc),
        });
      }
      return result.rootId;
    },

    async trash({ id }) {
      if (store.trash(id, Date.now()).length) enqueue({ kind: "trash", id });
    },

    async restore({ id }) {
      if (store.restore(id, Date.now()).length) enqueue({ kind: "restore", id });
    },

    async deleteForever({ id }) {
      const removed = store.deleteForever(id);
      const outbox = deps.outbox();
      for (const rid of removed) {
        // Pages created offline and never synced just vanish from the queue;
        // everything else is deleted server-side too. Per-id ops (rather
        // than only the root) cover pages that were moved under an unsynced
        // parent — deleteForever is idempotent server-side, so overlap is
        // fine.
        if (isLocalId(rid) && outbox.dropOpsForUnsyncedCreate(rid)) continue;
        outbox.enqueue({ kind: "deleteForever", id: rid });
      }
      deps.kick();
    },

    async emptyTrash() {
      const removed = store.emptyTrash();
      const outbox = deps.outbox();
      for (const rid of removed) {
        if (isLocalId(rid)) outbox.dropOpsForUnsyncedCreate(rid);
      }
      enqueue({ kind: "emptyTrash" });
    },

    async updateDbProps({ id, dbProps }) {
      if (store.updateDbProps(id, dbProps, Date.now())) {
        enqueue({ kind: "updateDbProps", id, dbProps });
      }
    },

    async setRowProp({ id, propId, value }) {
      if (store.setRowProp(id, propId, value, Date.now())) {
        enqueue({ kind: "setRowProp", id, propId, value });
      }
    },

    async setView(args) {
      if (store.setView(args, Date.now())) enqueue({ kind: "setView", ...args });
    },

    async bootstrap() {
      // Never seed until we've seen the server at least once — an existing
      // workspace must not get a duplicate welcome page from a fresh device.
      await deps.firstSyncDone();
      if (store.size() > 0) return null;
      const id = newLocalId();
      const doc = store.bootstrap(id, Date.now());
      if (!doc) return null;
      enqueue({ kind: "createWithDoc", clientKey: id, doc: toCreatePayload(doc) });
      return id;
    },
  };
}
