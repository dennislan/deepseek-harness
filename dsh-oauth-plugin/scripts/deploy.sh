#!/usr/bin/env bash
# Deploy dsh-oauth plugin to the web profile.
#
# Usage:
#   ./scripts/deploy.sh                # build (if needed) + deploy
#   ./scripts/deploy.sh --force        # always rebuild then deploy
#   ./scripts/deploy.sh --build-only   # build without deploying
#
# The script:
#   1. Runs `tsc --build --force` to emit .js + .d.ts files for all src modules.
#   2. Builds client.js via tsdown, then copies client.cjs → client.js
#      (tsdown emits CJS as .cjs; we rename for the loader).
#   3. Tries `dsh plugin --profile web add <path>` to update the profile.
#   4. Falls back to direct file copy when pnpm store writes are blocked
#      (e.g. inside an agent sandbox).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
DSH_CLI="${DSH_CLI:-$(command -v dsh 2>/dev/null || echo '')}"
TSDOWN_BIN="$PLUGIN_ROOT/../node_modules/.bin/tsdown"
TSC_BIN="$PLUGIN_ROOT/../node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc"

SRC_FILES=(
  src/client.ts
  src/host.ts
  src/types.ts
  src/index.ts
  src/invariant.ts
  src/client-index.ts
  tsdown.config.ts
)

built() {
  [ -f "$PLUGIN_ROOT/lib/client.js" ] && [ -f "$PLUGIN_ROOT/lib/types/host.d.ts" ]
}

srcs_changed() {
  for f in "${SRC_FILES[@]}"; do
    local src="$PLUGIN_ROOT/$f"
    if [ ! -f "$src" ]; then
      echo "[deploy] missing source: $src" >&2
      return 0
    fi
    if [ ! built ] || [ "$src" -nt "$PLUGIN_ROOT/lib/client.js" ]; then
      return 0
    fi
  done
  return 1
}

# Build client.cjs via tsdown, then copy to client.js with fixed sourceMappingURL.
build() {
  echo "[deploy] building dsh-oauth plugin…"
  if [ ! -x "$TSDOWN_BIN" ]; then
    echo "[deploy] ERROR: tsdown not found at $TSDOWN_BIN" >&2
    echo "[deploy]   run: cd /Users/dennis/AIProjects/deepseek-harness && pnpm install" >&2
    exit 1
  fi
  # Emit .js + .d.ts for all src modules (required for package.json exports).
  # --force ensures declarations are regenerated even when the incremental cache
  # reports the project as up-to-date (common after deleting tsconfig.tsbuildinfo).
  echo "[deploy] running tsc --build --force …"
  "$TSC_BIN" --build --force 2>&1 || {
    echo "[deploy] tsc build failed" >&2
    exit 1
  }
  # tsdown bundles the client entry into lib/client.cjs (CJS).
  echo "[deploy] running tsdown for client bundle …"
  (cd "$PLUGIN_ROOT" && bash "$TSDOWN_BIN" \
    --config "$PLUGIN_ROOT/tsdown.config.ts" 2>&1) || {
    echo "[deploy] build failed" >&2
    exit 1
  }
  # tsdown outputs client.cjs for CJS format; copy to client.js with correct map ref
  local cjs="$PLUGIN_ROOT/lib/client.cjs"
  local js="$PLUGIN_ROOT/lib/client.js"
  if [ ! -f "$cjs" ]; then
    echo "[deploy] ERROR: client.cjs not found after build" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const cjs = '$cjs';
    const js  = '$js';
    const m   = js + '.map';
    let content = fs.readFileSync(cjs, 'utf8');
    content = content.replace(/# sourceMappingURL=client\.cjs\.map/, '# sourceMappingURL=client.js.map');
    fs.writeFileSync(js, content);
    fs.copyFileSync(cjs + '.map', m);
    console.log('copied client.cjs -> client.js (' + fs.statSync(js).size + ' bytes)');
  "
  # Verify wrapper is present
  if ! grep -q '__ModuleLoader__.load' "$js"; then
    echo "[deploy] ERROR: client.js missing __ModuleLoader__.load wrapper" >&2
    exit 1
  fi
  if ! grep -q 'var module = { exports: {} }' "$js"; then
    echo "[deploy] ERROR: client.js missing CJS module shim (exports will be undefined)" >&2
    exit 1
  fi
  echo "[deploy] build OK → lib/client.js ($(wc -c < "$js") bytes)"
}

try_plugin_add() {
  if [ -z "$DSH_CLI" ]; then
    echo "[deploy] dsh CLI not on PATH, skipping dsh plugin add" >&2
    return 1
  fi
  # Skip pnpm add when the plugin is already listed as a dependency in the
  # profile (e.g. a link: spec). Running pnpm add on an already-resolved local
  # link hangs because pnpm tries to re-resolve the circular reference.
  # Use the package's own "name" field, not the directory basename.
  local pkg_name
  pkg_name=$(node -p "require('$PLUGIN_ROOT/package.json').name" 2>/dev/null || true)
  if [ -n "$pkg_name" ] && grep -q "\"$pkg_name\"" "$PROFILE_DIR/package.json" 2>/dev/null; then
    echo "[deploy] $pkg_name already in profile dependencies — skipping pnpm add"
    # The link already exists, but lib/ may be stale after a rebuild. Fall through
    # to the direct copy path so updated files reach the profile.
    fallback_copy && return 0
    return 1
  fi
  # dsh plugin --profile web add <path> runs pnpm add in the profile directory,
  # then reconciles dsh.profile.bundles in package.json.
  echo "[deploy] trying: $DSH_CLI plugin --profile web add $PLUGIN_ROOT"
  "$DSH_CLI" plugin --profile web add "$PLUGIN_ROOT" && return 0
  return 1
}

# Copy src → dst only if different; succeeds when identical.
_cp_if_diff() {
  local src="$1" dst="$2"
  if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
    cp "$src" "$dst" || return 1
  fi
  return 0
}

fallback_copy() {
  local target_lib="$PROFILE_DIR/node_modules/dsh-oauth/lib"
  if [ ! -d "$target_lib" ]; then
    echo "[deploy] ERROR: target lib dir missing: $target_lib" >&2
    return 1
  fi
  echo "[deploy] falling back to direct file copy → $target_lib"
  _cp_if_diff "$PLUGIN_ROOT/lib/client.js"          "$target_lib/client.js"       || return 1
  _cp_if_diff "$PLUGIN_ROOT/lib/client.js.map"      "$target_lib/client.js.map"   || return 1
  _cp_if_diff "$PLUGIN_ROOT/lib/host.js"            "$target_lib/host.js"         || return 1
  _cp_if_diff "$PLUGIN_ROOT/lib/invariant.js"       "$target_lib/invariant.js"    || return 1
  _cp_if_diff "$PLUGIN_ROOT/lib/types.js"           "$target_lib/types.js"        || return 1
  # types directory may not exist for standalone plugins — skip if absent
  # IMPORTANT: the profile's dsh-oauth is often a symlink back to PLUGIN_ROOT,
  # making source and target the same directory. Detect this and skip the copy
  # to avoid accidentally deleting the source via rm -rf on the "target".
  if [ -d "$PLUGIN_ROOT/lib/types" ]; then
    local src_real tgt_real
    src_real=$(python3 -c "import os; print(os.path.realpath('$PLUGIN_ROOT/lib/types'))" 2>/dev/null || echo "$PLUGIN_ROOT/lib/types")
    tgt_real=$(python3 -c "import os; print(os.path.realpath('$target_lib/types'))" 2>/dev/null || echo "$target_lib/types")
    if [ "$src_real" = "$tgt_real" ]; then
      echo "[deploy] types dir is co-located (symlinked) — skipping copy" >&2
    else
      if [ ! -d "$target_lib/types" ] || ! cmp -rq "$PLUGIN_ROOT/lib/types" "$target_lib/types" 2>/dev/null; then
        rm -rf "$target_lib/types"
        cp -r "$PLUGIN_ROOT/lib/types" "$target_lib/types" || return 1
      fi
    fi
  fi
  echo "[deploy] copy OK"
}

# ── Main ──────────────────────────────────────────────────────────────────────

FLAG="${1:-}"

case "$FLAG" in
  --build-only)
    if srcs_changed; then
      build
    else
      echo "[deploy] sources unchanged — skipping build"
    fi
    exit 0
    ;;
  --force)
    build
    ;;
  "")
    if srcs_changed; then
      build
    else
      echo "[deploy] sources unchanged — skipping build"
    fi
    ;;
  *)
    echo "[deploy] unknown flag: $FLAG" >&2
    echo "       usage: ./scripts/deploy.sh [--force|--build-only]" >&2
    exit 1
    ;;
esac

# Check paths exist
if [ ! -d "$PLUGIN_ROOT" ]; then
  echo "[deploy] ERROR: plugin root not found: $PLUGIN_ROOT" >&2
  exit 1
fi
if [ ! -d "$PROFILE_DIR" ]; then
  echo "[deploy] ERROR: profile dir not found: $PROFILE_DIR" >&2
  exit 1
fi

# Deploy: try dsh plugin add first, then fallback
if try_plugin_add; then
  echo "[deploy] deployed"
elif fallback_copy; then
  echo "[deploy] deployed via fallback copy"
else
  echo "[deploy] ERROR: both dsh plugin add and fallback copy failed" >&2
  exit 1
fi

# Ensure dependency symlinks exist so the loader can resolve peer deps
# at runtime (the profile has no @deepseek-ai/* scope in its own node_modules).
setup_deps() {
  local dsh_base="$HOME/.nvm/versions/node/v24.12.0/lib/node_modules/@deepseek-ai/dsh/node_modules"
  local nm="$PLUGIN_ROOT/node_modules/@deepseek-ai"
  mkdir -p "$nm"
  for pkg in cordis schemastery dsh-home-paths dsh-session; do
    local target="$dsh_base/@deepseek-ai/$pkg"
    local link="$nm/$pkg"
    if [ ! -e "$link" ]; then
      ln -sf "$target" "$link"
      echo "[deploy] symlinked $pkg → $target"
    elif [ ! -L "$link" ]; then
      echo "[deploy] WARNING: $link exists but is not a symlink, skipping" >&2
    fi
  done
}
setup_deps
echo "[deploy] done"
