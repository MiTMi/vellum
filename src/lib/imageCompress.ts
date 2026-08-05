/**
 * Client-side image compression, applied to every file upload (paste, drop,
 * or file picker) before it reaches Convex storage — see useFileUpload in
 * src/data/index.ts. A pasted 4 MB screenshot typically lands as a
 * ~100–300 KB WebP with no visible loss at document width.
 *
 * Rules:
 *  - only raster images; GIFs (animation) and SVGs (vectors) pass through
 *  - downscale so the longest edge is ≤ MAX_EDGE (2× a document's width —
 *    plenty for retina rendering)
 *  - re-encode as WebP at QUALITY
 *  - never make things worse: if the result isn't meaningfully smaller,
 *    or anything throws, upload the original
 */

export const MAX_EDGE = 1600;
const QUALITY = 0.8;
/** Files already this small aren't worth re-encoding. */
const SKIP_BELOW_BYTES = 100 * 1024;
/** Keep the result only if it saves at least this fraction. */
const MIN_SAVINGS = 0.1;

/** Pure decision helper (unit-tested): should this file be (re-)encoded? */
export function shouldCompress(
  type: string,
  size: number,
  width: number,
  height: number,
): boolean {
  if (!type.startsWith("image/")) return false;
  if (type === "image/gif" || type === "image/svg+xml") return false;
  const needsDownscale = Math.max(width, height) > MAX_EDGE;
  return needsDownscale || size >= SKIP_BELOW_BYTES;
}

/** Pure scale helper (unit-tested): target dimensions for a source image. */
export function targetSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function maybeCompressImage(file: File): Promise<File> {
  try {
    if (!file.type.startsWith("image/")) return file;
    const bitmap = await createImageBitmap(file);
    try {
      if (!shouldCompress(file.type, file.size, bitmap.width, bitmap.height)) {
        return file;
      }
      const { width, height } = targetSize(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", QUALITY),
      );
      if (!blob || blob.type !== "image/webp") return file; // encoder unavailable
      if (blob.size > file.size * (1 - MIN_SAVINGS)) return file;
      const name = file.name.replace(/\.[a-z0-9]+$/i, "") + ".webp";
      return new File([blob], name, { type: "image/webp" });
    } finally {
      bitmap.close();
    }
  } catch {
    // Undecodable or exotic input — upload it untouched rather than fail.
    return file;
  }
}
