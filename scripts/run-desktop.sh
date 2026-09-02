#!/bin/bash
# Forge Desktop Alpha Launcher
# Usage: bash scripts/run-desktop.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FORGE_ROOT="$(dirname "$SCRIPT_DIR")"
APP="$FORGE_ROOT/desktop/src-tauri/target/release/bundle/macos/Forge Desktop.app"
BIN="$FORGE_ROOT/desktop/src-tauri/target/release/forge-desktop"

if [ ! -f "$BIN" ]; then
  echo "Error: binary not found. Run: cd desktop && npx @tauri-apps/cli@v2 build"
  exit 1
fi

export FORGE_ROOT="$FORGE_ROOT"
export FORGE_HOME="${FORGE_HOME:-$HOME/.forge}"
export FORGE_RUNTIME="${FORGE_RUNTIME:-pi}"

echo "Forge Desktop Alpha"
echo "  root: $FORGE_ROOT  home: $FORGE_HOME  runtime: $FORGE_RUNTIME"

if [ -d "$APP" ]; then open "$APP"; else "$BIN" & fi

echo "Desktop launched."
