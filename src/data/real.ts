import { useCallback, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { DataApi, Mutations } from "./api";
import { PageDoc, PageId, PageMeta, SearchHit, TrashedMeta } from "../lib/types";

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

  useMutations(): Mutations {
    const create = useMutation(api.pages.create);
    const rename = useMutation(api.pages.rename);
    const updateContent = useMutation(api.pages.updateContent);
    const setIcon = useMutation(api.pages.setIcon);
    const setCover = useMutation(api.pages.setCover);
    const toggleFavorite = useMutation(api.pages.toggleFavorite);
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
        rename: (args) => rename(args) as Promise<void>,
        updateContent: (args) => updateContent(args) as Promise<void>,
        setIcon: (args) => setIcon(args) as Promise<void>,
        setCover: (args) => setCover(args) as Promise<void>,
        toggleFavorite: (args) => toggleFavorite(args) as Promise<void>,
        setPageOptions: (args) => setPageOptions(args) as Promise<void>,
        move: (args) => move(args) as Promise<void>,
        duplicate: (args) => duplicate(args) as Promise<PageId | null>,
        trash: (args) => trash(args) as Promise<void>,
        restore: (args) => restore(args) as Promise<void>,
        deleteForever: (args) => deleteForever(args) as Promise<void>,
        emptyTrash: () => emptyTrash() as Promise<void>,
        updateDbProps: (args) => updateDbProps(args as never) as Promise<void>,
        setRowProp: (args) => setRowProp(args) as Promise<void>,
        setView: (args) => setView(args) as Promise<void>,
        bootstrap: () => bootstrap() as Promise<PageId | null>,
      }),
      [
        create, rename, updateContent, setIcon, setCover, toggleFavorite,
        setPageOptions, move, duplicate, trash, restore, deleteForever,
        emptyTrash, updateDbProps, setRowProp, setView, bootstrap,
      ],
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
