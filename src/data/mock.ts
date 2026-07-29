import { useCallback } from "react";
import { DataApi, Mutations } from "./api";
import { PageDoc, PageId } from "../lib/types";
import { createPageStore } from "../offline/store";
import { createStoreReadHooks } from "../offline/storeHooks";

/**
 * In-memory implementation of the data layer (demo mode & tests).
 * Thin wrapper over the shared replica store (src/offline/store.ts),
 * persisted to localStorage.
 */

let seq = 0;
function newId(): PageId {
  return `mock_${Date.now().toString(36)}_${(seq++).toString(36)}` as PageId;
}

const store = createPageStore();

try {
  const raw = localStorage.getItem("vellum:mockdb");
  if (raw) store.load(JSON.parse(raw) as PageDoc[]);
} catch {
  /* ignore */
}

store.subscribe(() => {
  try {
    localStorage.setItem("vellum:mockdb", JSON.stringify(store.all()));
  } catch {
    /* ignore */
  }
});

const mutations: Mutations = {
  async create(args) {
    return store.create(args, newId(), Date.now())._id;
  },
  async rename({ id, title }) {
    store.rename(id, title, Date.now());
  },
  async updateContent({ id, content, text }) {
    store.updateContent(id, content, text, Date.now());
  },
  async setIcon({ id, icon }) {
    store.setIcon(id, icon, Date.now());
  },
  async setCover({ id, cover }) {
    store.setCover(id, cover, Date.now());
  },
  async toggleFavorite({ id }) {
    store.toggleFavorite(id, Date.now());
  },
  async setPageOptions(args) {
    store.setPageOptions(args, Date.now());
  },
  async move({ id, parentId, rank }) {
    store.move(id, parentId, rank, Date.now());
  },
  async duplicate({ id }) {
    return store.duplicate(id, newId, Date.now())?.rootId ?? null;
  },
  async trash({ id }) {
    store.trash(id, Date.now());
  },
  async restore({ id }) {
    store.restore(id, Date.now());
  },
  async deleteForever({ id }) {
    store.deleteForever(id);
  },
  async emptyTrash() {
    store.emptyTrash();
  },
  async updateDbProps({ id, dbProps }) {
    store.updateDbProps(id, dbProps, Date.now());
  },
  async setRowProp({ id, propId, value }) {
    store.setRowProp(id, propId, value, Date.now());
  },
  async setView(args) {
    store.setView(args, Date.now());
  },
  async bootstrap() {
    return store.bootstrap(newId(), Date.now())?._id ?? null;
  },
};

const mockApi: DataApi = {
  ...createStoreReadHooks(store),

  useMutations() {
    return mutations;
  },

  useFileUpload() {
    return useCallback(async (file: File): Promise<string> => {
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(file);
      });
    }, []);
  },
};

export default mockApi;
