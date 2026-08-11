import { useCallback, useMemo } from "react";
import {
  AiApi,
  CommentsApi,
  DataApi,
  Mutations,
  PublishApi,
  ShareEntry,
  SharesApi,
  VersionHistoryApi,
} from "./api";
import {
  AiAnswer,
  CommentMeta,
  LinkPreview,
  PageDoc,
  PageId,
  VersionDoc,
  VersionMeta,
} from "../lib/types";
import { createPageStore } from "../offline/store";
import { createStoreReadHooks } from "../offline/storeHooks";
import {
  MAX_VERSIONS_PER_PAGE,
  shouldSnapshot,
} from "../../convex/lib/versions";
import { hostLabel, normalizeUrl } from "../../convex/lib/linkMeta";

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

/**
 * Page-history sidecar. History is a read-only projection that never feeds
 * back into page state, so mirroring it here (rather than in the shared
 * reducer) keeps mock/offline page behavior identical — the one sanctioned
 * exception to the "edit the reducer, not the wrappers" rule.
 *
 * The snapshot interval is 0 in mock mode so a single edit is immediately
 * restorable; the real backend throttles to SNAPSHOT_INTERVAL_MS.
 */
/** Share grants, keyed by pageId — enough state to drive the Share UI. */
function mockShares(): Record<string, ShareEntry[]> {
  try {
    return JSON.parse(localStorage.getItem("vellum:mockshares") ?? "{}");
  } catch {
    return {};
  }
}
function saveMockShares(all: Record<string, ShareEntry[]>) {
  try {
    localStorage.setItem("vellum:mockshares", JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

const MOCK_SNAPSHOT_INTERVAL_MS = 0;
const versions = new Map<string, VersionDoc[]>();

function loadVersions() {
  try {
    const raw = localStorage.getItem("vellum:mockversions");
    if (raw) {
      for (const [k, v] of Object.entries(
        JSON.parse(raw) as Record<string, VersionDoc[]>,
      )) {
        versions.set(k, v);
      }
    }
  } catch {
    /* ignore */
  }
}

function saveVersions() {
  try {
    localStorage.setItem(
      "vellum:mockversions",
      JSON.stringify(Object.fromEntries(versions)),
    );
  } catch {
    /* ignore */
  }
}

/** Snapshot a page's current content before it gets overwritten. */
function captureVersion(id: PageId, now: number) {
  const page = store.get(id);
  if (!page || page.content === undefined) return;
  const list = versions.get(id) ?? [];
  const latest = list[0];
  if (!shouldSnapshot(latest?.savedAt, now, MOCK_SNAPSHOT_INTERVAL_MS)) return;
  list.unshift({
    _id: `mockver_${now.toString(36)}_${(seq++).toString(36)}`,
    pageId: id,
    title: page.title,
    content: structuredClone(page.content),
    savedAt: now,
  });
  versions.set(id, list.slice(0, MAX_VERSIONS_PER_PAGE));
  saveVersions();
}

/** Comments sidecar — same read-only-projection argument as versions. */
const comments = new Map<string, CommentMeta[]>();

function loadComments() {
  try {
    const raw = localStorage.getItem("vellum:mockcomments");
    if (raw) {
      for (const [k, v] of Object.entries(
        JSON.parse(raw) as Record<string, CommentMeta[]>,
      )) {
        comments.set(k, v);
      }
    }
  } catch {
    /* ignore */
  }
}

function saveComments() {
  try {
    localStorage.setItem(
      "vellum:mockcomments",
      JSON.stringify(Object.fromEntries(comments)),
    );
  } catch {
    /* ignore */
  }
}

loadVersions();
loadComments();

const mutations: Mutations = {
  async create(args) {
    return store.create(args, newId(), Date.now())._id;
  },
  async rename({ id, title }) {
    store.rename(id, title, Date.now());
  },
  async updateContent({ id, content, text }) {
    const now = Date.now();
    captureVersion(id, now);
    store.updateContent(id, content, text, now);
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
  async setTemplate({ id, value }) {
    store.setTemplate(id, value, Date.now());
  },
  async setPageOptions(args) {
    store.setPageOptions(args, Date.now());
  },
  async move({ id, parentId, rank }) {
    store.move(id, parentId, rank, Date.now());
  },
  async duplicate({ id, ...opts }) {
    return store.duplicate(id, newId, Date.now(), opts)?.rootId ?? null;
  },
  async trash({ id }) {
    store.trash(id, Date.now());
  },
  async restore({ id }) {
    store.restore(id, Date.now());
  },
  async deleteForever({ id }) {
    for (const removed of store.deleteForever(id)) {
      versions.delete(removed);
      comments.delete(removed);
    }
    saveVersions();
    saveComments();
  },
  async emptyTrash() {
    for (const removed of store.emptyTrash()) {
      versions.delete(removed);
      comments.delete(removed);
    }
    saveVersions();
    saveComments();
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
  async setViews(args) {
    store.setViews(args, Date.now());
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

  useVersionHistory(): VersionHistoryApi {
    return useMemo(
      () => ({
        available: true,
        async list(pageId: PageId): Promise<VersionMeta[]> {
          return (versions.get(pageId) ?? []).map((v) => ({
            _id: v._id,
            title: v.title,
            savedAt: v.savedAt,
          }));
        },
        async get(id: string): Promise<VersionDoc | null> {
          for (const list of versions.values()) {
            const hit = list.find((v) => v._id === id);
            if (hit) return structuredClone(hit);
          }
          return null;
        },
      }),
      [],
    );
  },

  useComments(): CommentsApi {
    return useMemo<CommentsApi>(
      () => ({
        available: true,
        async list(pageId: PageId): Promise<CommentMeta[]> {
          return structuredClone(comments.get(pageId) ?? []);
        },
        async add(pageId: PageId, text: string) {
          const t = text.trim();
          if (!t || !store.get(pageId)) return;
          const list = comments.get(pageId) ?? [];
          list.push({
            _id: `mockcmt_${Date.now().toString(36)}_${(seq++).toString(36)}`,
            pageId,
            text: t.slice(0, 5000),
            createdAt: Date.now(),
          });
          comments.set(pageId, list);
          saveComments();
        },
        async setResolved(id: string, value: boolean) {
          for (const list of comments.values()) {
            const hit = list.find((c) => c._id === id);
            if (hit) {
              hit.resolved = value;
              saveComments();
              return;
            }
          }
        },
        async remove(id: string) {
          for (const [pageId, list] of comments) {
            const idx = list.findIndex((c) => c._id === id);
            if (idx !== -1) {
              list.splice(idx, 1);
              comments.set(pageId, list);
              saveComments();
              return;
            }
          }
        },
      }),
      [],
    );
  },

  useShares(): SharesApi {
    return useMemo<SharesApi>(
      () => ({
        available: true,
        list: async (pageId) => mockShares()[pageId] ?? [],
        add: async (pageId, email, role) => {
          const all = mockShares();
          const entries = all[pageId] ?? [];
          const existing = entries.find((e) => e.email === email);
          if (existing) existing.role = role;
          else entries.push({ userId: email, email, role });
          all[pageId] = entries;
          saveMockShares(all);
        },
        setRole: async (pageId, userId, role) => {
          const all = mockShares();
          const entry = (all[pageId] ?? []).find((e) => e.userId === userId);
          if (entry) {
            entry.role = role;
            saveMockShares(all);
          }
        },
        remove: async (pageId, userId) => {
          const all = mockShares();
          all[pageId] = (all[pageId] ?? []).filter((e) => e.userId !== userId);
          saveMockShares(all);
        },
      }),
      [],
    );
  },

  usePublish(): PublishApi {
    return useMemo<PublishApi>(
      () => ({
        available: true,
        // No backend in mock mode: mint a stable fake slug so the UI can be
        // driven end-to-end without publishing anything for real.
        async set(pageId: PageId, value: boolean) {
          return value ? `mock${String(pageId).slice(-8)}` : null;
        },
        urlFor: (slug) => `https://example.invalid/p/${slug}`,
      }),
      [],
    );
  },

  useLinkPreview() {
    // Deterministic stub so the bookmark e2e doesn't need the network.
    return useCallback(async (input: string): Promise<LinkPreview | null> => {
      const url = normalizeUrl(input);
      if (!url) return null;
      const host = hostLabel(url);
      return {
        url,
        title: `${host} — preview`,
        description: `A mock bookmark preview for ${host}.`,
        image: "",
      };
    }, []);
  },

  useAccount() {
    // Demo mode has no account at all — Settings shows a note instead.
    return useMemo(
      () => ({
        available: false,
        getEmail: async () => null,
        changePassword: async () => {
          throw new Error("No account in demo mode");
        },
        signOutEverywhere: async () => {
          throw new Error("No account in demo mode");
        },
        deleteAccount: async () => {
          throw new Error("No account in demo mode");
        },
      }),
      [],
    );
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

  useAi(): AiApi {
    // Deterministic stubs, like useLinkPreview above: the AI e2e specs
    // exercise the menus and the apply/discard flow without a network call
    // or an API key, and demo mode gets something coherent to show.
    return useMemo<AiApi>(
      () => ({
        available: true,
        transform: async ({ text, kind, option }) => {
          switch (kind) {
            case "fix":
              return text;
            case "shorter":
              return text.split(/\s+/).slice(0, 8).join(" ");
            case "longer":
              return `${text} ${text}`;
            case "summarize":
              return `Summary: ${text.slice(0, 60)}`;
            case "bullets":
              return text
                .split(/(?<=[.!?])\s+/)
                .filter(Boolean)
                .map((s) => `- ${s.trim()}`)
                .join("\n");
            case "tone":
              return `(${option ?? "professional"}) ${text}`;
            case "translate":
              return `(${option ?? "English"}) ${text}`;
            case "continue":
              return " …and so the note continues.";
            case "custom":
              return `(${option ?? "edited"}) ${text}`;
            case "improve":
            default:
              return text.replace(/\s+/g, " ").trim();
          }
        },
        fillProperty: async ({ kind, prompt }) => {
          switch (kind) {
            case "summary":
              return "A short generated summary.";
            case "keyTopics":
              return "planning, design";
            case "sentiment":
              return "Neutral";
            case "actionItems":
              return "Review the draft";
            case "custom":
            default:
              return prompt?.trim() ? `Result for: ${prompt.trim()}` : "Generated";
          }
        },
        ask: async (question): Promise<AiAnswer> => ({
          answer: `Demo answer for "${question}". Connect a workspace to ask for real.`,
          sources: [],
          model: "demo",
        }),
        converse: async ({ messages }): Promise<AiAnswer> => {
          const last = [...messages].reverse().find((m) => m.role === "user");
          return {
            answer: `Demo reply to "${last?.content ?? ""}". Connect a workspace to chat for real.`,
            sources: [],
            model: "demo",
          };
        },
        deckOutline: async ({ topic }) =>
          [
            `## ${topic?.trim() || "Overview"}`,
            "- What this covers",
            "- Why it matters",
            "",
            "## Key points",
            "- First point",
            "- Second point",
            "",
            "## Next steps",
            "- What to do next",
          ].join("\n"),
      }),
      [],
    );
  },
};

export default mockApi;
