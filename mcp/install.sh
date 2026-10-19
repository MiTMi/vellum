#!/usr/bin/env bash
# One-command setup of Vellum's Claude logging on a Mac.
#
#   git clone --depth 1 https://github.com/KodKode/vellum.git ~/.vellum-claude; bash ~/.vellum-claude/mcp/install.sh
#
# (works for a private repository too, using the Mac's own GitHub login), or
#   curl -fsSL https://raw.githubusercontent.com/KodKode/vellum/main/mcp/install.sh | bash
# for a public one; or, from a checkout:  bash mcp/install.sh
#
# What it does, idempotently (safe to run again):
#   1. checks for Node 20+
#   2. clones the repo into ~/.vellum-claude (or updates it), unless run from
#      a checkout, in which case that checkout is used
#   3. installs the runtime dependencies (no dev tools, no Electron)
#   4. signs in to Vellum once (stores a refresh token, never the password)
#   5. registers the MCP server in Claude Desktop's config
#   6. registers the Claude Code hook in ~/.claude/settings.json
#   7. restarts Claude Desktop if it is running
#   8. puts the "log every conversation" instruction on the clipboard
#
# Overrides: VELLUM_REPO, VELLUM_BRANCH, VELLUM_DIR, VELLUM_DEVICE.
set -euo pipefail

REPO_URL="${VELLUM_REPO:-https://github.com/KodKode/vellum.git}"
BRANCH="${VELLUM_BRANCH:-main}"
TARGET_DIR="${VELLUM_DIR:-$HOME/.vellum-claude}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Node -----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    say "Installing Node with Homebrew…"
    brew install node
  else
    die "Node.js is required. Install it from https://nodejs.org (LTS), then run this again."
  fi
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20 or newer is required (found $("$NODE_BIN" -v))."

# --- 2. The code ---------------------------------------------------------------
# Run from inside a checkout? Use it. Otherwise clone/update ~/.vellum-claude.
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ] && [ -f "$(cd "$(dirname "$SELF")" && pwd)/server.mjs" ]; then
  REPO_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
  if [ "$REPO_DIR" = "$TARGET_DIR" ]; then
    # Our own private clone (the one-liner clones, then runs this file).
    NPM_FLAGS="--omit=dev"
    say "Updating $REPO_DIR…"
    git -C "$REPO_DIR" pull --quiet --ff-only || true
  else
    NPM_FLAGS=""   # a developer's checkout keeps its dev dependencies
    say "Using the checkout at $REPO_DIR"
  fi
else
  NPM_FLAGS="--omit=dev"   # the private clone needs only the runtime deps (no Electron)
  REPO_DIR="$TARGET_DIR"
  if [ -d "$REPO_DIR/.git" ]; then
    say "Updating $REPO_DIR ($BRANCH)…"
    git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"
    git -C "$REPO_DIR" checkout --quiet "$BRANCH"
    git -C "$REPO_DIR" pull --quiet --ff-only origin "$BRANCH"
  else
    say "Cloning Vellum into $REPO_DIR…"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
  fi
fi
SERVER="$REPO_DIR/mcp/server.mjs"
HOOK="$REPO_DIR/mcp/hook.mjs"
[ -f "$SERVER" ] || die "Expected $SERVER — is this the right repository/branch?"

# --- 3. Dependencies -------------------------------------------------------------
say "Installing dependencies…"
(cd "$REPO_DIR" && npm install $NPM_FLAGS --no-audit --no-fund --loglevel=error)

# --- 4. Sign in ------------------------------------------------------------------
if [ "${VELLUM_INSTALL_NO_LOGIN:-}" != "1" ]; then
  if "$NODE_BIN" "$SERVER" check 2>/dev/null; then
    say "Already signed in to Vellum."
  else
    say "Sign in to Vellum (your Vellum email and password; the password is not stored):"
    "$NODE_BIN" "$SERVER" login < /dev/tty
  fi
fi

# --- 5. Claude Desktop ----------------------------------------------------------
DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
say "Registering the MCP server in Claude Desktop…"
mkdir -p "$(dirname "$DESKTOP_CFG")"
"$NODE_BIN" - "$DESKTOP_CFG" "$NODE_BIN" "$SERVER" <<'JS'
const fs = require("node:fs");
const [file, node, server] = process.argv.slice(2);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.vellum = { command: node, args: [server] };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log("  " + file);
JS

# --- 6. Claude Code hook ----------------------------------------------------------
CODE_CFG="$HOME/.claude/settings.json"
say "Registering the Claude Code hook…"
mkdir -p "$(dirname "$CODE_CFG")"
"$NODE_BIN" - "$CODE_CFG" "$NODE_BIN" "$HOOK" <<'JS'
const fs = require("node:fs");
const [file, node, hook] = process.argv.slice(2);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
cfg.hooks = cfg.hooks || {};
const command = `"${node}" "${hook}"`;
for (const event of ["Stop", "SessionEnd"]) {
  const groups = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
  // Drop any earlier registration of this hook (older path), then add ours.
  for (const g of groups) {
    if (Array.isArray(g.hooks)) g.hooks = g.hooks.filter((h) => !String(h.command || "").includes("/mcp/hook.mjs"));
  }
  const kept = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
  kept.push({ hooks: [{ type: "command", command, timeout: 30 }] });
  cfg.hooks[event] = kept;
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log("  " + file);
JS

# --- 7. Restart Claude Desktop ---------------------------------------------------------
if command -v osascript >/dev/null 2>&1 && pgrep -xq "Claude"; then
  say "Restarting Claude Desktop so it picks up the server…"
  osascript -e 'quit app "Claude"' >/dev/null 2>&1 || true
  sleep 2
  open -a "Claude" >/dev/null 2>&1 || true
fi

# --- 8. The standing instruction ------------------------------------------------------------
INSTRUCTION='At the end of every conversation, and whenever I say "log this", save a record to Vellum with the vellum_log_conversation tool: a short title, a summary of what I asked and what we concluded, notes in Markdown (decisions, action items as a checklist), and a few tags. If you already logged this conversation, pass the same conversation_key so the row is updated instead of duplicated. Then tell me the link.'
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$INSTRUCTION" | pbcopy
  CLIP="It is on your clipboard."
else
  CLIP=""
fi

say "Done."
cat <<TXT

One manual step remains, because Claude Desktop has no setting a script can write:
open Claude Desktop → Settings → Profile → "personal preferences" and paste this. $CLIP

  $INSTRUCTION

From now on:
  • Claude Desktop can log any chat (ask "log this to Vellum", or it will do so
    at the end of a conversation once the preference above is saved).
  • Claude Code sessions are logged automatically after every turn.
  • Everything lands in the "Claude" database in Vellum, one row per conversation.
TXT
