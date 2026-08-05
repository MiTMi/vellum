/**
 * Vault cryptography — the only place encryption primitives appear.
 *
 * The Vault is end-to-end encrypted: a passphrase-derived AES-GCM key that
 * never leaves the device encrypts vault page titles and content *before*
 * they reach the data layer, so the server (and every replica store) only
 * ever holds ciphertext. Pure WebCrypto, no dependencies, no app imports —
 * unit-tested in tests/vaultCrypto.test.ts.
 *
 * Formats (all versioned for future migration):
 *  - content envelope: { __venc: 1, iv, data }        (JSON → AES-GCM)
 *  - title string:     "venc1:<iv>:<data>"            (title → AES-GCM)
 *  - vault meta:       { __vaultMeta: 1, salt, check } (stored plaintext on
 *    the vault root page; `check` is an encrypted sentinel used to verify a
 *    passphrase without storing anything derived from it)
 */

const PBKDF2_ITERATIONS = 250_000;
const SENTINEL = "vellum-vault-check-v1";
const TITLE_PREFIX = "venc1:";

export interface EncryptedBox {
  iv: string; // base64
  data: string; // base64
}

export interface EncryptedContent extends EncryptedBox {
  __venc: 1;
}

export interface VaultMeta {
  __vaultMeta: 1;
  salt: string; // base64
  check: EncryptedBox;
}

/* ---------------------------------------------------------------- base64 */

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const raw = atob(s);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/* ------------------------------------------------------------------ keys */

export async function deriveVaultKey(
  passphrase: string,
  saltB64: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fromB64(saltB64) as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: the key can be used but never exported
    ["encrypt", "decrypt"],
  );
}

/** First-time setup: mint a salt, derive the key, encrypt the sentinel. */
export async function createVaultMeta(
  passphrase: string,
): Promise<{ meta: VaultMeta; key: CryptoKey }> {
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveVaultKey(passphrase, salt);
  const check = await encryptBytes(key, new TextEncoder().encode(SENTINEL));
  return { meta: { __vaultMeta: 1, salt, check }, key };
}

/** True iff `key` decrypts this vault's sentinel — i.e. right passphrase. */
export async function verifyVaultKey(
  key: CryptoKey,
  meta: VaultMeta,
): Promise<boolean> {
  try {
    const bytes = await decryptBytes(key, meta.check);
    return new TextDecoder().decode(bytes) === SENTINEL;
  } catch {
    return false;
  }
}

export function isVaultMeta(value: unknown): value is VaultMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __vaultMeta?: unknown }).__vaultMeta === 1
  );
}

/* ------------------------------------------------------------- envelopes */

async function encryptBytes(
  key: CryptoKey,
  bytes: Uint8Array,
): Promise<EncryptedBox> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    bytes as unknown as BufferSource,
  );
  return { iv: toB64(iv), data: toB64(ct) };
}

async function decryptBytes(
  key: CryptoKey,
  box: EncryptedBox,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(box.iv) as unknown as BufferSource },
    key,
    fromB64(box.data) as unknown as BufferSource,
  );
  return new Uint8Array(pt);
}

/** Encrypt any JSON value (page content, i.e. BlockNote blocks). */
export async function encryptJson(
  key: CryptoKey,
  value: unknown,
): Promise<EncryptedContent> {
  const box = await encryptBytes(
    key,
    new TextEncoder().encode(JSON.stringify(value ?? null)),
  );
  return { __venc: 1, ...box };
}

export async function decryptJson(
  key: CryptoKey,
  env: EncryptedContent,
): Promise<unknown> {
  const bytes = await decryptBytes(key, env);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function isEncryptedContent(value: unknown): value is EncryptedContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __venc?: unknown }).__venc === 1
  );
}

/** Titles are strings in the schema, so their envelope is a prefixed string. */
export async function encryptTitle(
  key: CryptoKey,
  title: string,
): Promise<string> {
  const box = await encryptBytes(key, new TextEncoder().encode(title));
  return `${TITLE_PREFIX}${box.iv}:${box.data}`;
}

export async function decryptTitle(key: CryptoKey, s: string): Promise<string> {
  if (!isEncryptedTitle(s)) return s;
  const [iv, data] = s.slice(TITLE_PREFIX.length).split(":");
  const bytes = await decryptBytes(key, { iv, data });
  return new TextDecoder().decode(bytes);
}

export function isEncryptedTitle(s: string): boolean {
  return s.startsWith(TITLE_PREFIX);
}
