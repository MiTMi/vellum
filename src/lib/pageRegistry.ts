/**
 * A tiny module-level store mirroring the pages index so that custom
 * BlockNote blocks (which render outside our main React tree) can look up
 * page titles/icons and re-render when they change.
 */

export interface RegistryPage {
  title: string;
  icon: string | null;
  type: "doc" | "database";
  inTrash?: boolean;
}

let pages = new Map<string, RegistryPage>();
const listeners = new Set<() => void>();

export function setRegistry(next: Map<string, RegistryPage>) {
  pages = next;
  listeners.forEach((l) => l());
}

export function subscribeRegistry(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function registrySnapshot(): Map<string, RegistryPage> {
  return pages;
}
