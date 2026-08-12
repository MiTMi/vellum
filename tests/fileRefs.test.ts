/// <reference types="vite/client" />
// The "mark" half of storage reclamation. Every case here guards a
// DESTRUCTIVE decision: a key this walker fails to collect is a file the
// sweep will delete out from under a live page, so the bias throughout is
// "when in doubt, collect it".
import { describe, expect, test } from "vitest";
import {
  collectStorageKeys,
  storageKeyFromUrl,
  storageKeysInString,
} from "../convex/lib/fileRefs";

const HOST = "https://gregarious-schnauzer-219.eu-west-1.convex.cloud";
const KEY = "0c7f4e2a-91b3-4d55-8f0e-2a1b6c9d4e77";
const URL_A = `${HOST}/api/storage/${KEY}`;

describe("storageKeyFromUrl", () => {
  test("pulls the key out of a serving URL", () => {
    expect(storageKeyFromUrl(URL_A)).toBe(KEY);
  });

  test("is host-independent — a migrated deployment must still match", () => {
    const moved = `https://friendly-jellyfish-107.eu-west-1.convex.cloud/api/storage/${KEY}`;
    expect(storageKeyFromUrl(moved)).toBe(storageKeyFromUrl(URL_A));
  });

  test("handles the base64 keys convex-test mints, slashes included", () => {
    const b64 = "LPJNul+wow4m6Dsq/xbninhsWHlwfp0JecwQzYpOLmCQ=";
    expect(storageKeyFromUrl(`${HOST}/api/storage/${b64}`)).toBe(b64);
  });

  test("survives percent-encoding round-trips", () => {
    const raw = "a+b/c=";
    const encoded = encodeURIComponent(raw);
    expect(storageKeyFromUrl(`${HOST}/api/storage/${encoded}`)).toBe(raw);
  });

  test("ignores anything that isn't a storage URL", () => {
    expect(storageKeyFromUrl("https://example.com/image.png")).toBeNull();
    expect(storageKeyFromUrl("gradient:4")).toBeNull();
    expect(storageKeyFromUrl(null)).toBeNull();
    expect(storageKeyFromUrl(42)).toBeNull();
    expect(storageKeyFromUrl("")).toBeNull();
  });
});

describe("storageKeysInString", () => {
  test("finds several keys in one string", () => {
    const md = `![a](${URL_A}) and ![b](${HOST}/api/storage/second-key)`;
    expect(storageKeysInString(md)).toEqual([KEY, "second-key"]);
  });

  test("strips trailing punctuation from a URL pasted mid-sentence", () => {
    expect(storageKeysInString(`see ${URL_A}, then stop.`)).toEqual([KEY]);
    expect(storageKeysInString(`(${URL_A})`)).toEqual([KEY]);
  });

  test("is reusable — the global regex must not carry lastIndex over", () => {
    expect(storageKeysInString(URL_A)).toEqual([KEY]);
    expect(storageKeysInString(URL_A)).toEqual([KEY]);
    expect(storageKeysInString(URL_A)).toEqual([KEY]);
  });
});

describe("collectStorageKeys", () => {
  test("finds a key in a BlockNote image block", () => {
    const content = [
      { type: "paragraph", content: [{ type: "text", text: "hi" }] },
      { type: "image", props: { url: URL_A, caption: "" } },
    ];
    expect([...collectStorageKeys(content)]).toEqual([KEY]);
  });

  test("finds keys the block schema doesn't know about", () => {
    // A page cover, a database row's url property, and a bookmark's image
    // are all real places a storage URL lives that a content-only walker
    // would miss — and missing one means deleting a live file.
    const page = {
      cover: URL_A,
      props: { "url-1": `${HOST}/api/storage/row-prop-key` },
      content: [
        { type: "bookmark", props: { image: `${HOST}/api/storage/bookmark-key` } },
      ],
    };
    expect([...collectStorageKeys(page)].sort()).toEqual(
      [KEY, "bookmark-key", "row-prop-key"].sort(),
    );
  });

  test("walks nested children and inline content", () => {
    const content = [
      {
        type: "bulletListItem",
        children: [
          { type: "image", props: { url: `${HOST}/api/storage/deep-key` } },
        ],
      },
    ];
    expect([...collectStorageKeys(content)]).toEqual(["deep-key"]);
  });

  test("accumulates into a shared set across many documents", () => {
    const into = new Set<string>();
    collectStorageKeys({ cover: URL_A }, into);
    collectStorageKeys({ cover: `${HOST}/api/storage/other` }, into);
    collectStorageKeys({ cover: URL_A }, into); // duplicate collapses
    expect(into.size).toBe(2);
  });

  test("returns nothing for documents with no files", () => {
    expect(collectStorageKeys({ cover: "gradient:4", content: [] }).size).toBe(0);
    expect(collectStorageKeys(null).size).toBe(0);
    expect(collectStorageKeys(undefined).size).toBe(0);
  });

  test("terminates on a cyclic object rather than hanging the sweep", () => {
    const a: Record<string, unknown> = { cover: URL_A };
    a.self = a;
    expect([...collectStorageKeys(a)]).toEqual([KEY]);
  });

  test("terminates on pathological nesting", () => {
    let deep: unknown = URL_A;
    for (let i = 0; i < 500; i++) deep = { next: deep };
    expect(() => collectStorageKeys(deep)).not.toThrow();
  });

  test("vault ciphertext yields no keys and does not throw", () => {
    const vaultPage = {
      title: "venc1:aXY=:ZGF0YQ==",
      content: { __venc: 1, iv: "aXY=", data: "Y2lwaGVydGV4dA==" },
    };
    expect(collectStorageKeys(vaultPage).size).toBe(0);
  });
});
