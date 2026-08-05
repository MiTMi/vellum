/**
 * The vault's runtime state — module-level, like pageRegistry, so both React
 * components and the non-React data-layer wrapper can reach it.
 *
 * Holds the unlocked AES key (in memory only — a reload always locks), the
 * set of vault page ids mirrored from the pages index, and a cache of
 * decrypted titles for sidebar/breadcrumb/switcher display. Decrypted page
 * *content* is never cached here; PageView decrypts it per page on render.
 *
 * Auto-locks after IDLE_LOCK_MS without any encrypt/decrypt activity.
 */

import { useSyncExternalStore } from "react";
import { PageMeta } from "./types";
import {
  VaultMeta,
  decryptTitle,
  isEncryptedTitle,
  verifyVaultKey,
} from "./vaultCrypto";

const IDLE_LOCK_MS = 15 * 60 * 1000;

export const VAULT_LOCKED_TITLE = "Locked page";

interface VaultState {
  rootId: string | null;
  ids: Set<string>;
  key: CryptoKey | null;
  titles: Map<string, string>; // decrypted titles, only while unlocked
}

const state: VaultState = {
  rootId: null,
  ids: new Set(),
  key: null,
  titles: new Map(),
};

let version = 0;
const listeners = new Set<() => void>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  version++;
  listeners.forEach((l) => l());
}

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => lockVault(), IDLE_LOCK_MS);
}

/** Any successful vault crypto op counts as activity for auto-lock. */
export function touchVault() {
  if (state.key) armIdleTimer();
}

/* ------------------------------------------------------------- queries */

export function isVaultPage(id: string | null | undefined): boolean {
  return !!id && state.ids.has(id);
}

export function vaultRootId(): string | null {
  return state.rootId;
}

export function isVaultRoot(id: string): boolean {
  return state.rootId === id;
}

export function isVaultUnlocked(): boolean {
  return state.key !== null;
}

/** The unlocked key, for the data-layer wrapper. Throws when locked. */
export function vaultKey(): CryptoKey {
  if (!state.key) {
    throw new Error("The Vault is locked — unlock it before editing.");
  }
  touchVault();
  return state.key;
}

/**
 * Display title for any page meta: plaintext titles pass through; encrypted
 * ones resolve from the decrypted cache, or a placeholder while locked (or
 * for vault pages outside the live index, e.g. in the trash).
 */
export function displayTitle(meta: {
  _id: string;
  title: string;
}): string {
  if (!isEncryptedTitle(meta.title)) return meta.title;
  return state.titles.get(meta._id) ?? VAULT_LOCKED_TITLE;
}

/** Case-insensitive decrypted-title search, for ⌘K while unlocked. */
export function searchVaultTitles(
  term: string,
): { _id: string; title: string }[] {
  if (!state.key) return [];
  const t = term.trim().toLowerCase();
  if (!t) return [];
  const hits: { _id: string; title: string }[] = [];
  for (const [id, title] of state.titles) {
    if (title.toLowerCase().includes(t)) hits.push({ _id: id, title });
  }
  return hits.slice(0, 10);
}

/* ------------------------------------------------------------ lifecycle */

/**
 * Mirror vault membership from the pages index (runs on every index
 * change). Newly appeared vault pages get their titles decrypted while
 * unlocked; pages that vanished drop out of the caches.
 */
export function syncVaultIndex(pages: PageMeta[]) {
  const ids = new Set<string>();
  let rootId: string | null = null;
  const byId = new Map(pages.map((p) => [p._id, p]));
  for (const p of pages) {
    if (!p.vault) continue;
    ids.add(p._id);
    const parent = p.parentId ? byId.get(p.parentId) : undefined;
    if (!parent?.vault) rootId = p._id;
  }
  state.ids = ids;
  state.rootId = rootId;
  for (const id of [...state.titles.keys()]) {
    if (!ids.has(id)) state.titles.delete(id);
  }
  if (state.key) {
    void decryptTitles(pages.filter((p) => p.vault));
  }
  notify();
}

async function decryptTitles(pages: { _id: string; title: string }[]) {
  const key = state.key;
  if (!key) return;
  let changed = false;
  for (const p of pages) {
    if (!isEncryptedTitle(p.title)) continue;
    try {
      const title = await decryptTitle(key, p.title);
      if (state.titles.get(p._id) !== title) {
        state.titles.set(p._id, title);
        changed = true;
      }
    } catch {
      // A title we can't decrypt (e.g. mid-sync partial state) stays locked.
    }
  }
  if (changed) notify();
}

/** Called by VaultView after key derivation + sentinel verification. */
export async function unlockVault(
  key: CryptoKey,
  meta: VaultMeta,
  pages: PageMeta[],
): Promise<boolean> {
  if (!(await verifyVaultKey(key, meta))) return false;
  state.key = key;
  armIdleTimer();
  await decryptTitles(pages.filter((p) => p.vault));
  notify();
  return true;
}

export function lockVault() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!state.key && state.titles.size === 0) return;
  state.key = null;
  state.titles.clear();
  notify();
}

/** Keep the display cache warm after a local rename (avoids a re-decrypt). */
export function cacheVaultTitle(id: string, plaintextTitle: string) {
  if (!state.key) return;
  state.titles.set(id, plaintextTitle);
  notify();
}

/* ---------------------------------------------------------------- react */

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * React subscription: re-renders on lock/unlock/title-cache changes.
 * Returns a monotonically increasing version — components read the module
 * getters for actual state.
 */
export function useVaultVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
