import { useCallback, useMemo } from "react";
import {
  IS_DIRECT,
  IS_MOCK,
  AccountApi,
  DataApi,
  Mutations,
  VersionHistoryApi,
  CommentsApi,
  PublishApi,
} from "./api";
import realApi from "./real";
import mockApi from "./mock";
import offlineApi from "./offline";
import {
  BacklinkMeta,
  LinkPreview,
  PageDoc,
  PageId,
  PageMeta,
  SearchHit,
  TrashedMeta,
} from "../lib/types";
import { maybeCompressImage } from "../lib/imageCompress";
import { encryptJson, encryptTitle } from "../lib/vaultCrypto";
import {
  cacheVaultTitle,
  isVaultPage,
  isVaultRoot,
  vaultKey,
} from "../lib/vaultSession";

const impl: DataApi = IS_MOCK ? mockApi : IS_DIRECT ? realApi : offlineApi;

/**
 * Vault E2E encryption, applied at the data layer's single choke point so
 * every implementation (offline replica, mock, direct) and every caller
 * (editor saves, renames, template application, history restore) stores
 * only ciphertext for vault pages. Reads stay encrypted — decryption
 * happens in the view layer, keyed by the in-memory session.
 *
 * The vault *root* page is exempt: its content is the plaintext vault meta
 * (salt + passphrase check) and its title is the literal "Vault".
 */
function wrapVaultMutations(raw: Mutations): Mutations {
  const encrypts = (id: PageId) => isVaultPage(id) && !isVaultRoot(id);
  return {
    ...raw,
    async create(args) {
      const parentInVault = isVaultPage(args.parentId ?? null);
      if (!parentInVault) return raw.create(args);
      if (args.type === "database") {
        throw new Error("Databases inside the Vault are not supported yet");
      }
      // vaultKey() throws while locked — creation requires an open vault.
      const key = vaultKey();
      const title = args.title ?? "";
      const encTitle = await encryptTitle(key, title);
      const id = await raw.create({ ...args, title: encTitle });
      cacheVaultTitle(id, title);
      return id;
    },
    async rename(args) {
      if (!encrypts(args.id)) return raw.rename(args);
      const encrypted = await encryptTitle(vaultKey(), args.title);
      await raw.rename({ id: args.id, title: encrypted });
      cacheVaultTitle(args.id, args.title);
    },
    async updateContent(args) {
      if (!encrypts(args.id)) return raw.updateContent(args);
      const content = await encryptJson(vaultKey(), args.content);
      // `text` is the plaintext search extraction — never stored for vault.
      await raw.updateContent({ id: args.id, content, text: "" });
    },
    async move(args) {
      // Mirror of the server-side boundary guard, so offline mode fails
      // fast instead of queueing an op the server will reject.
      if (isVaultRoot(args.id)) {
        // The root may move anywhere outside its own subtree.
        if (isVaultPage(args.parentId ?? null)) {
          throw new Error("The Vault can't be moved inside itself");
        }
        return raw.move(args);
      }
      const source = isVaultPage(args.id);
      const dest = isVaultPage(args.parentId ?? null);
      if (source !== dest) {
        throw new Error("Pages can't move into or out of the Vault");
      }
      return raw.move(args);
    },
    async duplicate(args) {
      if (isVaultRoot(args.id)) {
        throw new Error("The Vault itself can't be duplicated");
      }
      const source = isVaultPage(args.id);
      const dest =
        args.parentId !== undefined || args.toRoot
          ? isVaultPage(args.parentId ?? null)
          : source; // in place → same side as the source
      if (source !== dest) {
        throw new Error("Pages can't be duplicated into or out of the Vault");
      }
      // Suffixing an encrypted title would corrupt its envelope.
      return raw.duplicate(source ? { ...args, suffix: "" } : args);
    },
  };
}

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
export function useBacklinks(id: PageId | null): BacklinkMeta[] | undefined {
  return impl.useBacklinks(id);
}
export function useMutations(): Mutations {
  const raw = impl.useMutations();
  return useMemo(() => wrapVaultMutations(raw), [raw]);
}
export function useFileUpload(): (file: File) => Promise<string> {
  const upload = impl.useFileUpload();
  // Every upload path (paste, drop, file picker, covers) funnels through
  // here — compress images client-side before they hit Convex storage.
  return useCallback(
    async (file: File) => upload(await maybeCompressImage(file)),
    [upload],
  );
}
export function useVersionHistory(): VersionHistoryApi {
  return impl.useVersionHistory();
}
export function useLinkPreview(): (url: string) => Promise<LinkPreview | null> {
  return impl.useLinkPreview();
}
export function useComments(): CommentsApi {
  return impl.useComments();
}
export function usePublish(): PublishApi {
  return impl.usePublish();
}
export function useAccount(): AccountApi {
  return impl.useAccount();
}

export { IS_MOCK, IS_DIRECT };
export type { Mutations, VersionHistoryApi, CommentsApi, PublishApi, AccountApi };
