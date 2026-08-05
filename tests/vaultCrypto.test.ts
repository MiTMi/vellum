import { describe, expect, test } from "vitest";
import {
  createVaultMeta,
  decryptJson,
  decryptTitle,
  deriveVaultKey,
  encryptJson,
  encryptTitle,
  isEncryptedContent,
  isEncryptedTitle,
  isVaultMeta,
  verifyVaultKey,
} from "../src/lib/vaultCrypto";

describe("vault crypto", () => {
  test("meta round-trip: right passphrase verifies, wrong one doesn't", async () => {
    const { meta, key } = await createVaultMeta("correct horse battery");
    expect(isVaultMeta(meta)).toBe(true);
    expect(await verifyVaultKey(key, meta)).toBe(true);

    const rederived = await deriveVaultKey("correct horse battery", meta.salt);
    expect(await verifyVaultKey(rederived, meta)).toBe(true);

    const wrong = await deriveVaultKey("wrong passphrase!", meta.salt);
    expect(await verifyVaultKey(wrong, meta)).toBe(false);
  });

  test("content encrypt/decrypt round-trips arbitrary JSON", async () => {
    const { key } = await createVaultMeta("pass phrase here");
    const blocks = [
      { type: "paragraph", content: [{ type: "text", text: "top secret ✓ émojis 🔒" }] },
      { type: "checkListItem", props: { checked: true }, content: [] },
    ];
    const env = await encryptJson(key, blocks);
    expect(isEncryptedContent(env)).toBe(true);
    // Ciphertext must not contain the plaintext.
    expect(JSON.stringify(env)).not.toContain("top secret");
    expect(await decryptJson(key, env)).toEqual(blocks);
  });

  test("same plaintext encrypts to different ciphertext (fresh IVs)", async () => {
    const { key } = await createVaultMeta("pass phrase here");
    const a = await encryptJson(key, { v: "same" });
    const b = await encryptJson(key, { v: "same" });
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  test("decrypting with the wrong key throws", async () => {
    const { key } = await createVaultMeta("first passphrase");
    const { key: other } = await createVaultMeta("second passphrase");
    const env = await encryptJson(key, { secret: true });
    await expect(decryptJson(other, env)).rejects.toThrow();
  });

  test("title envelope: prefixed string, round-trips, hides plaintext", async () => {
    const { key } = await createVaultMeta("pass phrase here");
    const enc = await encryptTitle(key, "My diary");
    expect(isEncryptedTitle(enc)).toBe(true);
    expect(enc).not.toContain("My diary");
    expect(await decryptTitle(key, enc)).toBe("My diary");
    // Plain titles pass through decryptTitle untouched.
    expect(await decryptTitle(key, "Not encrypted")).toBe("Not encrypted");
    // Empty titles still produce a non-revealing envelope.
    const empty = await encryptTitle(key, "");
    expect(isEncryptedTitle(empty)).toBe(true);
    expect(await decryptTitle(key, empty)).toBe("");
  });
});
