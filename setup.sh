#!/bin/bash
# ============================================================
# Vellum — one-time setup (Convex Cloud)
# Run this once from the project folder:  ./setup.sh
# ============================================================
set -e
cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }

bold "── Vellum setup ─────────────────────────────────────────"

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it first:  brew install node"
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node 20+ required (you have $(node --version)). Try: brew upgrade node"
  exit 1
fi
echo "✓ Node $(node --version)"

# 2. Dependencies
if [ ! -d node_modules ]; then
  bold "Installing dependencies (one-time, ~1 min)…"
  npm install --no-audit --no-fund
else
  echo "✓ Dependencies already installed"
fi

# 3. Convex login + project provisioning
if [ ! -f .env.local ]; then
  bold "Connecting to Convex Cloud…"
  echo "A browser window will open — log in (or create a free account),"
  echo "then pick “create a new project” when asked. Name it “vellum”."
  npx convex login
  npx convex dev --once
else
  echo "✓ Convex already configured (.env.local exists)"
  npx convex dev --once
fi

bold "── Done! ───────────────────────────────────────────────"
echo
echo "Start the app:        npm run dev"
echo "Build a real .app:    npm run dist   (result in release/)"
echo
