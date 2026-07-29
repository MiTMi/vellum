import { IS_DIRECT, IS_MOCK, DataApi, Mutations } from "./api";
import realApi from "./real";
import mockApi from "./mock";
import offlineApi from "./offline";
import {
  PageDoc,
  PageId,
  PageMeta,
  SearchHit,
  TrashedMeta,
} from "../lib/types";

const impl: DataApi = IS_MOCK ? mockApi : IS_DIRECT ? realApi : offlineApi;

/* Stable hook wrappers — `impl` is fixed for the lifetime of the app,
   so the rules of hooks hold. */

export function usePagesList(): PageMeta[] | undefined {
  return impl.usePagesList();
}
export function usePage(id: PageId | null): PageDoc | null | undefined {
  return impl.usePage(id);
}
export function useTrashed(): TrashedMeta[] | undefined {
  return impl.useTrashed();
}
export function useSearch(term: string): SearchHit[] | undefined {
  return impl.useSearch(term);
}
export function useMutations(): Mutations {
  return impl.useMutations();
}
export function useFileUpload(): (file: File) => Promise<string> {
  return impl.useFileUpload();
}

export { IS_MOCK, IS_DIRECT };
export type { Mutations };
