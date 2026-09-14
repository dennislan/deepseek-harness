#!/usr/bin/env bash
# Symlink the workspace @deepseek-ai/* packages and the MCP SDK into this
# standalone plugin's node_modules so typecheck and tests resolve them from the
# repo's source, without pnpm-installing the (latest) published versions.
#
# Usage: ./scripts/setup-deps.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_ROOT/.." && pwd)"

mkdir -p "$PLUGIN_ROOT/node_modules/@deepseek-ai"

# pkgName -> repo-relative source dir; symlinked by absolute target so the nested
# @scope/ path never confuses Node's resolution.
link_pkg() {
  local pkg="$1" dir="$2"
  local target="$REPO_ROOT/$dir"
  local link="$PLUGIN_ROOT/node_modules/$pkg"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    return 0
  fi
  rm -f "$link"
  ln -s "$target" "$link"
  echo "[setup-deps] $pkg → $target"
}

link_pkg "@deepseek-ai/cordis"        "vendor/cordis"
link_pkg "@deepseek-ai/schemastery"   "vendor/schemastery"
link_pkg "@deepseek-ai/dsh-mcp-client" "packages/mcp/mcp-client"
link_pkg "@deepseek-ai/dsh-tools"      "packages/core/tools"
link_pkg "@deepseek-ai/dsh-system-prompt" "packages/core/system-prompt"
link_pkg "@deepseek-ai/dsh-llm"        "packages/llm/llm"
link_pkg "@deepseek-ai/dsh-home-paths" "packages/util/home-paths"

# The MCP SDK from the mcp-client package's pnpm-resolved copy (exact version).
mkdir -p "$PLUGIN_ROOT/node_modules/@modelcontextprotocol"
SDK_LINK="$PLUGIN_ROOT/node_modules/@modelcontextprotocol/sdk"
SDK_TARGET="$REPO_ROOT/packages/mcp/mcp-client/node_modules/@modelcontextprotocol/sdk"
if [ ! -L "$SDK_LINK" ] || [ "$(readlink "$SDK_LINK")" != "$SDK_TARGET" ]; then
  ln -sfn "$SDK_TARGET" "$SDK_LINK"
  echo "[setup-deps] @modelcontextprotocol/sdk → $SDK_TARGET"
fi

# React + its types, resolved from the pnpm store (the client half typechecks and
# bundles against these; the bundle itself externalizes them to the module table).
REACT_STORE="$(ls -d "$REPO_ROOT/node_modules/.pnpm/react@"*/node_modules/react 2>/dev/null | head -1)"
if [ -n "$REACT_STORE" ]; then
  if [ ! -L "$PLUGIN_ROOT/node_modules/react" ] || [ "$(readlink "$PLUGIN_ROOT/node_modules/react")" != "$REACT_STORE" ]; then
    ln -sfn "$REACT_STORE" "$PLUGIN_ROOT/node_modules/react"
    echo "[setup-deps] react → $REACT_STORE"
  fi
fi
TYPES_REACT_STORE="$(ls -d "$REPO_ROOT/node_modules/.pnpm/@types+react@"*/node_modules/@types/react 2>/dev/null | head -1)"
if [ -n "$TYPES_REACT_STORE" ]; then
  mkdir -p "$PLUGIN_ROOT/node_modules/@types"
  if [ ! -L "$PLUGIN_ROOT/node_modules/@types/react" ] || [ "$(readlink "$PLUGIN_ROOT/node_modules/@types/react")" != "$TYPES_REACT_STORE" ]; then
    ln -sfn "$TYPES_REACT_STORE" "$PLUGIN_ROOT/node_modules/@types/react"
    echo "[setup-deps] @types/react → $TYPES_REACT_STORE"
  fi
fi
echo "[setup-deps] done"
