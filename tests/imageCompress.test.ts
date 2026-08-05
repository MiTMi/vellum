import { describe, expect, test } from "vitest";
import { MAX_EDGE, shouldCompress, targetSize } from "../src/lib/imageCompress";

describe("image compression decisions", () => {
  test("large rasters compress; gifs, svgs and non-images never do", () => {
    expect(shouldCompress("image/png", 4_000_000, 2880, 1800)).toBe(true);
    expect(shouldCompress("image/jpeg", 500_000, 1200, 800)).toBe(true);
    expect(shouldCompress("image/gif", 4_000_000, 2880, 1800)).toBe(false);
    expect(shouldCompress("image/svg+xml", 4_000_000, 2880, 1800)).toBe(false);
    expect(shouldCompress("application/pdf", 4_000_000, 2880, 1800)).toBe(false);
  });

  test("small already-fitting images are left alone", () => {
    expect(shouldCompress("image/png", 40_000, 640, 480)).toBe(false);
  });

  test("oversized dimensions force compression even for small files", () => {
    expect(shouldCompress("image/png", 40_000, 3000, 500)).toBe(true);
  });

  test("targetSize caps the longest edge and preserves aspect ratio", () => {
    expect(targetSize(3200, 1600)).toEqual({ width: MAX_EDGE, height: 800 });
    expect(targetSize(1600, 3200)).toEqual({ width: 800, height: MAX_EDGE });
    // Never upscales.
    expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
