import { useCallback, useMemo } from "react";
import { useQuery, useMutation, useAction, useConvex } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  CommentsApi,
  DataApi,
  Mutations,
  PublishApi,
  publicUrlFor,
  VersionHistoryApi,
} from "./api";
import {
  BacklinkMeta,
  CommentMeta,
  LinkPreview,
  PageDoc,
  PageId,
  PageMeta,
  SearchHit,
  TrashedMeta,
  VersionDoc,
  VersionMeta,
} from "../lib/types";
import { Id } from "../../convex/_generated/dataModel";

const realApi: DataApi = {
  usePagesList() {
    return useQuery(api.pages.list) as PageMeta[] | undefined;
  },

  usePage(id: PageId | null) {
    return useQuery(
      api.pages.get,
      id ? { id } : "skip",
    ) as PageDoc | null | undefined;
  },

  useTrashed() {
    return useQuery(api.pages.trashed) as TrashedMeta[] | undefined;
  },

  useSearch(term: string) {
    return useQuery(
      api.pages.search,
      term.trim() ? { term } : "skip",
    ) as SearchHit[] | undefined;
  },

  useBacklinks(id: PageId | null) {
    return useQuery(
      api.pages.backlinks,
      id ? { id } : "skip",
    ) as BacklinkMeta[] | undefined;
  },

  useMutations(): Mutations {
    const create = useMutation(api.pages.create);
    const rename = useMutation(api.pages.rename);
    const updateContent = useMutation(api.pages.updateContent);
    const setIcon = useMutation(api.pages.setIcon);
    const setCover = useMutation(api.pages.setCover);
    const toggleFavorite = useMutation(api.pages.toggleFavorite);
    const setTemplate = useMutation(api.pages.setTemplate);
    const setPageOptions = useMutation(api.pages.setPageOptions);
    const move = useMutation(api.pages.move);
    const duplicate = useMutation(api.pages.duplicate);
    const trash = useMutation(api.pages.trash);
    const restore = useMutation(api.pages.restore);
    const deleteForever = useMutation(api.pages.deleteForever);
    const emptyTrash = useMutation(api.pages.emptyTrash);
    const updateDbProps = useMutation(api.pages.updateDbProps);
    const setRowProp = useMutation(api.pages.setRowProp);
    const setView = useMutation(api.pages.setView);
    const bootstrap = useMutation(api.pages.bootstrap);

    return useMemo<Mutations>(
      () => ({
        create: (args) => create(args as never) as Promise<PageId>,
        rename: (args) => rename(args) as unknown as Promise<void>,
        updateContent: (args) => updateContent(args) as unknown as Promise<void>,
        setIcon: (args) => setIcon(args) as unknown as Promise<void>,
        setCover: (args) => setCover(args) as unknown as Promise<void>,
        toggleFavorite: (args) => toggleFavorite(args) as unknown as Promise<void>,
        setTemplate: (args) => setTemplate(args) as unknown as Promise<void>,
        setPageOptions: (args) => setPageOptions(args) as unknown as Promise<void>,
        move: (args) => move(args) as unknown as Promise<void>,
        duplicate: (args) => duplicate(args) as Promise<PageId | null>,
        trash: (args) => trash(args) as unknown as Promise<void>,
        restore: (args) => restore(args) as unknown as Promise<void>,
        deleteForever: (args) => deleteForever(args) as unknown as Promise<void>,
        emptyTrash: () => emptyTrash() as unknown as Promise<void>,
        updateDbProps: (args) => updateDbProps(args as never) as unknown as Promise<void>,
        setRowProp: (args) => setRowProp(args) as unknown as Promise<void>,
        setView: (args) => setView(args) as unknown as Promise<void>,
        bootstrap: () => bootstrap() as Promise<PageId | null>,
      }),
      [
        create, rename, updateContent, setIcon, setCover, toggleFavorite,
        setTemplate, setPageOptions, move, duplicate, trash, restore,
        deleteForever, emptyTrash, updateDbProps, setRowProp, setView,
        bootstrap,
      ],
    );
  },

  useVersionHistory(): VersionHistoryApi {
    const client = useConvex();
    return useMemo<VersionHistoryApi>(
      () => ({
        available: true,
        list: (pageId) =>
          client.query(api.versions.list, { pageId }) as Promise<VersionMeta[]>,
        get: (id) =>
          client.query(api.versions.get, {
            id: id as Id<"pageVersions">,
          }) as Promise<VersionDoc | null>,
      }),
      [client],
    );
  },

  useLinkPreview() {
    const fetchMeta = useAction(api.linkPreview.fetchMeta);
    return useCallback(
      (url: string) => fetchMeta({ url }) as Promise<LinkPreview | null>,
      [fetchMeta],
    );
  },

  useComments(): CommentsApi {
    const client = useConvex();
    const add = useMutation(api.comments.add);
    const setResolved = useMutation(api.comments.setResolved);
    const remove = useMutation(api.comments.remove);
    return useMemo<CommentsApi>(
      () => ({
        available: true,
        list: (pageId) =>
          client.query(api.comments.list, { pageId }) as Promise<CommentMeta[]>,
        add: async (pageId, text) => {
          await add({ pageId, text });
        },
        setResolved: async (id, value) => {
          await setResolved({ id: id as Id<"comments">, value });
        },
        remove: async (id) => {
          await remove({ id: id as Id<"comments"> });
        },
      }),
      [client, add, setResolved, remove],
    );
  },

  usePublish(): PublishApi {
    const setPublished = useMutation(api.pages.setPublished);
    return useMemo<PublishApi>(
      () => ({
        available: true,
        set: async (pageId, value) =>
          (await setPublished({ id: pageId, value })) as string | null,
        urlFor: publicUrlFor,
      }),
      [setPublished],
    );
  },

  useFileUpload() {
    const generateUploadUrl = useMutation(api.files.generateUploadUrl);
    const getFileUrl = useMutation(api.files.getFileUrl);
    return useCallback(
      async (file: File): Promise<string> => {
        const postUrl = await generateUploadUrl();
        const res = await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const { storageId } = (await res.json()) as { storageId: string };
        const url = await getFileUrl({ storageId: storageId as never });
        if (!url) throw new Error("Could not resolve file URL");
        return url;
      },
      [generateUploadUrl, getFileUrl],
    );
  },
};

export default realApi;
