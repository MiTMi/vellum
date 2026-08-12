/**
 * Which stored files a document still refers to.
 *
 * Deleting a page has never reclaimed the blobs it embedded: `pages.ts`
 * removes rows and sidecars but nothing ever called `ctx.storage.delete`,
 * so every image ever uploaded outlived the page that used it (audit
 * finding, 2026-08-12 — two such orphans were found on prod). The reclaim
 * is a mark-and-sweep over storage, and this module is the "mark" half.
 *
 * Pure and dependency-free, like snippet.ts / pageLinks.ts, so the sweep's
 * one dangerous decision — "nothing references this, delete it" — is
 * exhaustively unit-testable.
 *
 * ## Why keys, not URLs
 *
 * A serving URL is `https://<deployment>.convex.cloud/api/storage/<key>`.
 * The host is not stable across deployments (that is what `migrate.ts`
 * rewrites), so matching whole URLs would strand every file the moment a
 * workspace moved. Only the key after `/api/storage/` is compared.
 *
 * ## Safety bias
 *
 * Every ambiguity resolves toward KEEPING a file. Failing to collect a
 * reference deletes data a user can still see; failing to delete an orphan
 * merely wastes bytes until the next sweep. So the walker reads every
 * string anywhere in the document — not just `props.url` — because a
 * storage URL can legitimately sit in a database row's `url` property, a
 * cover, a bookmark's props, or inline link markup.
 */

/** Chars a Convex storage key can contain: UUIDs in prod, base64 in tests. */
const KEY_RE = /\/api\/storage\/([A-Za-z0-9+/=_%.-]+)/g;

/**
 * Every storage key mentioned anywhere in `text`. A single string may hold
 * more than one (markdown with two images, say), so this scans rather than
 * parses — and it never throws on malformed input.
 */
export function storageKeysInString(text: string): string[] {
  if (!text.includes("/api/storage/")) return [];
  const out: string[] = [];
  // Fresh lastIndex per call: KEY_RE is global and module-level.
  KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEY_RE.exec(text)) !== null) {
    const key = normalizeKey(m[1]);
    if (key) out.push(key);
  }
  return out;
}

/**
 * The comparable identity of a storage key. Trailing URL punctuation is
 * stripped (a key pasted mid-sentence picks up commas and parens) and
 * percent-encoding is decoded once, so a key that travelled through a URL
 * encoder still matches the raw one.
 */
function normalizeKey(raw: string): string {
  let key = raw.replace(/[.,;:!?)\]}'"]+$/, "");
  if (key.includes("%")) {
    try {
      key = decodeURIComponent(key);
    } catch {
      /* malformed escape — compare the raw form */
    }
  }
  return key;
}

/** The storage key a serving URL points at, or null if it isn't one. */
export function storageKeyFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const keys = storageKeysInString(url);
  return keys.length > 0 ? keys[0] : null;
}

/**
 * Deep-walk any JSON value and collect every storage key it mentions.
 *
 * Deliberately field-agnostic: it inspects every string at every depth
 * rather than looking for known block shapes. A new block type that stores
 * a file URL under some other prop name is covered the day it ships, with
 * no change here — which is exactly the drift that would otherwise make
 * the sweep delete live data.
 */
export function collectStorageKeys(
  value: unknown,
  into: Set<string> = new Set(),
): Set<string> {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    // Cheap guards: vault ciphertext and pathological nesting both stop here.
    if (depth > 64 || node === null || node === undefined) return;
    if (typeof node === "string") {
      for (const key of storageKeysInString(node)) into.add(key);
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return; // cycles can't come from JSON, but be safe
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    for (const child of Object.values(node as Record<string, unknown>)) {
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return into;
}
