/**
 * A signed-in Vellum backend client for Node processes (the MCP server and
 * the Claude Code hook). No backend changes: it signs in through the same
 * Convex Auth password provider the app uses and calls the ordinary
 * `pages:*` functions, so every write passes the real auth choke points.
 *
 * Credentials live in one 0600 file (default
 * `~/.config/vellum-mcp/credentials.json`): the access token, the rotating
 * refresh token, and this machine's display name. The password is never
 * stored — `login` trades it for a refresh token once.
 *
 * Two processes share that file (Claude Desktop keeps the server running
 * while Claude Code fires the hook), and Convex Auth's refresh tokens
 * rotate with reuse detection: whoever refreshes with a stale token
 * invalidates the whole family. So a refresh always happens under a lock,
 * re-reading the file first, and the newest tokens are written back before
 * the lock is released.
 */
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONVEX_URL =
  "https://gregarious-schnauzer-219.eu-west-1.convex.cloud";
export const DEFAULT_SITE_URL = "https://vellum-gilt.vercel.app";

/** Refresh when the access token has less than this left. */
const TOKEN_SLACK_MS = 90_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export class VellumAuthError extends Error {}

export function credentialsPath() {
  return (
    process.env.VELLUM_CREDENTIALS ||
    path.join(os.homedir(), ".config", "vellum-mcp", "credentials.json")
  );
}

export function readCredentials(file = credentialsPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeCredentials(creds, file = credentialsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

async function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let mtime;
      try {
        mtime = fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between our attempt and the stat
      }
      if (Date.now() - mtime > LOCK_STALE_MS) {
        try {
          fs.rmdirSync(lock);
        } catch {}
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the credentials lock", { cause: err });
      }
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}

/** Expiry (ms since epoch) of a JWT, or 0 when it can't be read. */
export function tokenExpiry(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function tokenUsable(token) {
  return typeof token === "string" && tokenExpiry(token) - Date.now() > TOKEN_SLACK_MS;
}

/** This machine's name for the Device column. */
export function deviceName(creds) {
  return (
    process.env.VELLUM_DEVICE ||
    creds?.device ||
    os.hostname().replace(/\.local$/i, "")
  );
}

/** Convex wraps errors in request ids and stack noise; surface the message. */
export function describeError(err) {
  if (err && typeof err === "object") {
    if (typeof err.data === "string") return err.data;
    if (err.data && typeof err.data.message === "string") return err.data.message;
    const msg = typeof err.message === "string" ? err.message : String(err);
    const m = msg.match(/Uncaught (?:ConvexError|Error): ([^\n]*)/);
    return (m ? m[1] : msg).replace(/^\[Request ID: [^\]]+\]\s*/, "").trim();
  }
  return String(err);
}

export class VellumClient {
  constructor(opts = {}) {
    this.convexUrl = opts.convexUrl || process.env.VELLUM_CONVEX_URL || DEFAULT_CONVEX_URL;
    this.siteUrl = (opts.siteUrl || process.env.VELLUM_SITE_URL || DEFAULT_SITE_URL).replace(/\/$/, "");
    this.file = opts.credentialsFile || credentialsPath();
    // The signed-in client for pages:*; a second, bare client for the auth
    // actions so an expired token on the first can never poison a refresh.
    this.client = new ConvexHttpClient(this.convexUrl, { logger: false });
    this.authClient = new ConvexHttpClient(this.convexUrl, { logger: false });
    this.token = null;
    this.creds = null;
    this.refreshing = null;
  }

  /** Trade a password for tokens once; stores the refresh token, not the password. */
  async login({ email, password, device }) {
    const result = await this.authClient.action(anyApi.auth.signIn, {
      provider: "password",
      params: { email, password, flow: "signIn" },
    });
    if (!result?.tokens?.token) {
      throw new VellumAuthError("Sign-in failed: no tokens returned");
    }
    const previous = readCredentials(this.file);
    const creds = {
      convexUrl: this.convexUrl,
      email,
      device: device || previous?.device || deviceName(null),
      token: result.tokens.token,
      refreshToken: result.tokens.refreshToken,
      updatedAt: new Date().toISOString(),
    };
    writeCredentials(creds, this.file);
    this.creds = creds;
    this.token = creds.token;
    this.client.setAuth(this.token);
    return creds;
  }

  credentials() {
    return this.creds ?? readCredentials(this.file);
  }

  device() {
    return deviceName(this.credentials());
  }

  async ensureAuth(force = false) {
    if (!force && tokenUsable(this.token)) return;
    if (!this.refreshing) {
      this.refreshing = this.#refresh(force).finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
  }

  async #refresh(force) {
    await withFileLock(this.file, async () => {
      const stored = readCredentials(this.file);
      // Another process may already have refreshed — its tokens win.
      if (!force && stored && tokenUsable(stored.token) && stored.token !== this.token) {
        this.#adopt(stored);
        return;
      }
      if (stored?.refreshToken) {
        try {
          const result = await this.authClient.action(anyApi.auth.signIn, {
            refreshToken: stored.refreshToken,
          });
          if (result?.tokens?.token) {
            this.#adopt({
              ...stored,
              token: result.tokens.token,
              refreshToken: result.tokens.refreshToken,
              updatedAt: new Date().toISOString(),
            });
            writeCredentials(this.creds, this.file);
            return;
          }
        } catch (err) {
          console.error(`vellum: token refresh failed: ${describeError(err)}`);
        }
      }
      // Headless fallback (CI, a fresh machine): a password in the
      // environment re-establishes the session without a prompt.
      const email = process.env.VELLUM_EMAIL || stored?.email;
      const password = process.env.VELLUM_PASSWORD;
      if (email && password) {
        await this.login({ email, password, device: stored?.device });
        return;
      }
      throw new VellumAuthError(
        `Not signed in to Vellum (no valid session in ${this.file}). Run: node mcp/server.mjs login`,
      );
    });
  }

  #adopt(creds) {
    this.creds = creds;
    this.token = creds.token;
    this.client.setAuth(creds.token);
  }

  async #call(kind, name, args) {
    await this.ensureAuth();
    const [mod, fn] = name.split(":");
    const ref = anyApi[mod][fn];
    const run = () => this.client[kind](ref, args ?? {});
    try {
      return await run();
    } catch (err) {
      const msg = describeError(err);
      // A token revoked server-side (sign out everywhere, a wipe) still
      // parses as valid locally — refresh once and retry before giving up.
      if (/not authenticated|unauthenticated|token/i.test(msg)) {
        await this.ensureAuth(true);
        return await run();
      }
      throw new Error(msg, { cause: err });
    }
  }

  query(name, args) {
    return this.#call("query", name, args);
  }

  mutation(name, args) {
    return this.#call("mutation", name, args);
  }

  /** Deep link into the app (App.tsx parses `#/page/<id>[/block/<id>]`). */
  pageUrl(pageId, blockId) {
    const base = `${this.siteUrl}/app#/page/${encodeURIComponent(pageId)}`;
    return blockId ? `${base}/block/${encodeURIComponent(blockId)}` : base;
  }
}
