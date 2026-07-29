import { useMemo, useSyncExternalStore } from "react";
import { extractPageLinks } from "../../convex/lib/pageLinks";
import {
  BacklinkMeta,
  PageDoc,
  PageId,
  PageMeta,
  SearchHit,
  TrashedMeta,
} from "../lib/types";
import { PageStore } from "./store";

/**
 * Read hooks over a PageStore, shared by mock mode and the offline layer.
 * Same projections as convex/pages.ts queries.
 */
export function createStoreReadHooks(store: PageStore) {
  function useVersion(): number {
    return useSyncExternalStore(
      (cb) => store.subscribe(cb),
      () => store.version(),
    );
  }

  return {
    usePagesList(): PageMeta[] | undefined {
      const v = useVersion();
      return useMemo<PageMeta[]>(
        () =>
          store
            .all()
            .filter((p) => !p.inTrash)
            .map((p) => ({
              _id: p._id,
              title: p.title,
              type: p.type,
              parentId: p.parentId ?? null,
              rank: p.rank,
              icon: p.icon ?? null,
              cover: p.cover ?? null,
              isFavorite: p.isFavorite ?? false,
              isTemplate: p.isTemplate ?? false,
              props: p.props ?? null,
              updatedAt: p.updatedAt,
              _creationTime: p._creationTime,
            })),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [v],
      );
    },

    usePage(id: PageId | null): PageDoc | null | undefined {
      const v = useVersion();
      return useMemo<PageDoc | null | undefined>(
        () => {
          if (!id) return undefined;
          const doc = store.get(id);
          return doc ? structuredClone(doc) : null;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [id, v],
      );
    },

    useTrashed(): TrashedMeta[] | undefined {
      const v = useVersion();
      return useMemo<TrashedMeta[]>(
        () =>
          store
            .all()
            .filter((p) => p.inTrash && p.trashRoot)
            .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
            .map((p) => ({
              _id: p._id,
              title: p.title,
              icon: p.icon ?? null,
              type: p.type,
              trashedAt: p.trashedAt ?? 0,
            })),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [v],
      );
    },

    useBacklinks(id: PageId | null): BacklinkMeta[] | undefined {
      const v = useVersion();
      return useMemo<BacklinkMeta[]>(
        () => {
          if (!id) return [];
          return store
            .all()
            .filter(
              (p) =>
                !p.inTrash &&
                p._id !== id &&
                extractPageLinks(p.content).includes(id),
            )
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((p) => ({
              _id: p._id,
              title: p.title,
              icon: p.icon ?? null,
              type: p.type,
            }));
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [id, v],
      );
    },

    useSearch(term: string): SearchHit[] | undefined {
      const v = useVersion();
      return useMemo<SearchHit[]>(() => {
        const t = term.trim().toLowerCase();
        if (!t) return [];
        return store
          .all()
          .filter(
            (p) => !p.inTrash && (p.searchText ?? "").toLowerCase().includes(t),
          )
          .slice(0, 20)
          .map((p) => ({
            _id: p._id,
            title: p.title,
            icon: p.icon ?? null,
            type: p.type,
            parentId: p.parentId ?? null,
          }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [term, v]);
    },
  };
}
