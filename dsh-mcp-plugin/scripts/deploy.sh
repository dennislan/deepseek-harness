#!/usr/bin/env bash
# Deploy dsh-mcp-plugin to the web profile (host lib + client bundle).
#
# Usage:
#   ./scripts/deploy.sh              # build (if needed) + deploy
#   ./scripts/deploy.sh --force      # always rebuild then deploy
#   ./scripts/deploy.sh --build-only # build without deploying
#
# The script:
#   1. Runs `tsc --build --force` (host lib) and `scripts/build-client.mjs`
#      (browser bundle) for every src module.
#   2. Tries `dsh plugin --profile web add <path>` to register the plugin.
#   3. Falls back to a direct file copy when pnpm writes are blocked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
DSH_CLI="${DSH_CLI:-$(command -v dsh 2>/dev/null || echo '')}"
TSC_BIN="$PLUGIN_ROOT/../node_modules/.pnpm/node_modules/typescript/bin/tsc"
if [ ! -x "$TSC_BIN" ]; then TSC_BIN="$PLUGIN_ROOT/../node_modules/.bin/tsc"; fi

SRC_FILES=(
  src/host.ts
  src/store.ts
  src/mount.ts
  src/types.ts
  src/index.ts
  src/invariant.ts
  src/client.tsx
)

built() {
  [ -f "$PLUGIN_ROOT/lib/host.js" ] && [ -f "$PLUGIN_ROOT/lib/types/host.d.ts" ] && [ -f "$PLUGIN_ROOT/lib/client.js" ]
}

srcs_changed() {
  for f in "${SRC_FILES[@]}"; do
    local src="$PLUGIN_ROOT/$f"
    if [ ! -f "$src" ]; then
      echo "[deploy] missing source: $f" >&2
      return 0
    fi
    if [ ! built ] || [ "$src" -nt "$PLUGIN_ROOT/lib/host.js" ]; then
      return 0
    fi
  done
  return 1
}

build() {
  echo "[deploy] building dsh-mcp-plugin…"
  if [ ! -x "$TSC_BIN" ]; then
    echo "[deploy] ERROR: tsc not found at $TSC_BIN" >&2
    echo "[deploy]   run: cd $PLUGIN_ROOT/.. && pnpm install" >&2
    exit 1
  fi
  (cd "$PLUGIN_ROOT" && "$TSC_BIN" --build --force) || {
    echo "[deploy] tsc build failed" >&2
    exit 1
  }
  # The client half bundles separately (tsdown CJS → normalized lib/client.js).
  (cd "$PLUGIN_ROOT" && node scripts/build-client.mjs) || {
    echo "[deploy] client bundle build failed" >&2
    exit 1
  }
  echo "[deploy] build OK → lib/ (host + client)"
}

try_plugin_add() {
  if [ -z "$DSH_CLI" ]; then
    echo "[deploy] dsh CLI not on PATH, skipping dsh plugin add" >&2
    return 1
  fi
  local pkg_name
  pkg_name=$(node -p "require('$PLUGIN_ROOT/package.json').name" 2>/dev/null || true)
  if [ -n "$pkg_name" ] && grep -q "\"$pkg_name\"" "$PROFILE_DIR/package.json" 2>/dev/null; then
    echo "[deploy] $pkg_name already in profile dependencies — copying updated files"
    fallback_copy && return 0
    return 1
  fi
  echo "[deploy] trying: $DSH_CLI plugin --profile web add $PLUGIN_ROOT"
  "$DSH_CLI" plugin --profile web add "$PLUGIN_ROOT" && return 0
  return 1
}

_cp_if_diff() {
  local src="$1" dst="$2"
  if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
    cp "$src" "$dst" || return 1
  fi
  return 0
}

fallback_copy() {
  local target_lib="$PROFILE_DIR/node_modules/dsh-mcp-plugin/lib"
  if [ ! -d "$target_lib" ]; then
    echo "[deploy] ERROR: target lib dir missing: $target_lib" >&2
    return 1
  fi
  echo "[deploy] falling back to direct file copy → $target_lib"
  # The profile references the plugin through a symlink, so copying into
  # target_lib writes through to the source tree's lib/ directly.
  #
  # NOTE: if lib/types stops being emitted by tsc (removed from tsconfig.json),
  # this guard is a no-op and no stale copy remains — no cleanup needed.
  for f in host.js store.js mount.js types.js index.js invariant.js client.js client.js.map; do
    _cp_if_diff "$PLUGIN_ROOT/lib/$f" "$target_lib/$f" || return 1
  done
  if [ -d "$PLUGIN_ROOT/lib/types" ]; then
    rm -rf "$target_lib/types"
    cp -r "$PLUGIN_ROOT/lib/types" "$target_lib/types" || return 1
  fi
  echo "[deploy] copy OK"
}

FLAG="${1:-}"
case "$FLAG" in
  --build-only)
    if srcs_changed; then build; else echo "[deploy] sources unchanged — skipping build"; fi
    exit 0
    ;;
  --force) build ;;
  "")
    if srcs_changed; then build; else echo "[deploy] sources unchanged — skipping build"; fi
    ;;
  *)
    echo "[deploy] unknown flag: $FLAG" >&2
    echo "       usage: ./scripts/deploy.sh [--force|--build-only]" >&2
    exit 1
    ;;
esac

if [ ! -d "$PLUGIN_ROOT" ]; then echo "[deploy] ERROR: plugin root not found" >&2; exit 1; fi
if [ ! -d "$PROFILE_DIR" ]; then echo "[deploy] ERROR: profile dir not found: $PROFILE_DIR" >&2; exit 1; fi

if try_plugin_add; then
  echo "[deploy] deployed"
elif fallback_copy; then
  echo "[deploy] deployed via fallback copy"
else
  echo "[deploy] ERROR: both dsh plugin add and fallback copy failed" >&2
  exit 1
fi
echo "[deploy] done"
