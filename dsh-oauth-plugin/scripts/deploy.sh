#!/usr/bin/env bash
# Deploy dsh-oauth plugin to the web profile.
#
# Usage:
#   ./scripts/deploy.sh                # build (if needed) + deploy
#   ./scripts/deploy.sh --force        # always rebuild then deploy
#   ./scripts/deploy.sh --build-only   # build without deploying
#
# The script:
#   1. Runs `npx tsc --build --force` to emit .js + .d.ts files for all src modules.
#   2. Builds the client bundle via `npx tsdown` (tsdown is a devDependency,
#      resolved from the plugin's own node_modules, no repo checkout required).
#   3. Copies client.cjs → client.js with fixed sourceMappingURL.
#   4. Tries `dsh plugin --profile web add <path>` to update the profile;
#      falls back to direct file copy when pnpm writes are blocked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
DSH_CLI="${DSH_CLI:-$(command -v dsh 2>/dev/null || echo '')}"

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
    if [ ! -f "$PLUGIN_ROOT/lib/client.js" ] || [ "$src" -nt "$PLUGIN_ROOT/lib/client.js" ]; then
      return 0
    fi
  done
  return 1
}

# Build all artifacts: tsc for host+types+invariant, tsdown for the client bundle.
build() {
  echo "[deploy] building dsh-oauth plugin…"
  cd "$PLUGIN_ROOT"

  # tsc: emit .js + .d.ts for all src modules (required for package.json exports).
  echo "[deploy] running tsc --build --force …"
  npx tsc --build --force 2>&1 || {
    echo "[deploy] tsc build failed" >&2
    exit 1
  }

  # tsdown: bundle the client entry into lib/client.cjs (CJS with closure wrapper).
  echo "[deploy] running tsdown for client bundle …"
  npx tsdown --config tsdown.config.ts 2>&1 || {
    echo "[deploy] tsdown build failed" >&2
    exit 1
  }

  # tsdown emits client.cjs for CJS format; rename to client.js with correct sourceMappingURL.
  local cjs="$PLUGIN_ROOT/lib/client.cjs"
  local js="$PLUGIN_ROOT/lib/client.js"
  if [ ! -f "$cjs" ]; then
    echo "[deploy] ERROR: client.cjs not found after tsdown" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const cjs = '$cjs';
    const js  = '$js';
    let content = fs.readFileSync(cjs, 'utf8');
    content = content.replace(/# sourceMappingURL=client\.cjs\.map/, '# sourceMappingURL=client.js.map');
    fs.writeFileSync(js, content);
    if (fs.existsSync(cjs + '.map')) fs.copyFileSync(cjs + '.map', js + '.map');
    console.log('copied client.cjs -> client.js (' + fs.statSync(js).size + ' bytes)');
  "

  # Verify the closure wrapper is present.
  if ! grep -q '__ModuleLoader__.load' "$js"; then
    echo "[deploy] ERROR: client.js missing __ModuleLoader__.load wrapper" >&2
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
  # profile (e.g. a link: or file: spec). Re-running pnpm add on an already
  # resolved local spec hangs on circular re-resolution.
  local pkg_name
  pkg_name=$(node -p "require('$PLUGIN_ROOT/package.json').name" 2>/dev/null || true)
  if [ -n "$pkg_name" ] && grep -q "\"$pkg_name\"" "$PROFILE_DIR/package.json" 2>/dev/null; then
    echo "[deploy] $pkg_name already in profile dependencies — falling back to direct copy"
    fallback_copy && return 0
    return 1
  fi
  echo "[deploy] trying: $DSH_CLI plugin --profile web add $PLUGIN_ROOT"
  "$DSH_CLI" plugin --profile web add "$PLUGIN_ROOT" && return 0
  return 1
}

# Copy only when different; succeeds when identical.
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
    echo "[deploy]   install first: dsh plugin --profile web add $PLUGIN_ROOT" >&2
    return 1
  fi
  echo "[deploy] falling back to direct file copy → $target_lib"

  # Detect the symlink case: profile's dsh-oauth may symlink back to PLUGIN_ROOT,
  # making source and target the same directory. Skip the copy to avoid rm -rf.
  local src_real tgt_real
  src_real=$(python3 -c "import os; print(os.path.realpath('$PLUGIN_ROOT/lib'))" 2>/dev/null || echo "$PLUGIN_ROOT/lib")
  tgt_real=$(python3 -c "import os; print(os.path.realpath('$target_lib'))" 2>/dev/null || echo "$target_lib")

  if [ "$src_real" = "$tgt_real" ]; then
    echo "[deploy] lib dir is co-located (symlinked) — no copy needed"
    return 0
  fi

  _cp_if_diff "$PLUGIN_ROOT/lib/client.js"       "$target_lib/client.js"       || return 1
  [ -f "$PLUGIN_ROOT/lib/client.js.map" ] && _cp_if_diff "$PLUGIN_ROOT/lib/client.js.map" "$target_lib/client.js.map"
  _cp_if_diff "$PLUGIN_ROOT/lib/host.js"         "$target_lib/host.js"         || return 1
  _cp_if_diff "$PLUGIN_ROOT/lib/invariant.js"    "$target_lib/invariant.js"    || return 1
  [ -f "$PLUGIN_ROOT/lib/types.js" ] && _cp_if_diff "$PLUGIN_ROOT/lib/types.js" "$target_lib/types.js"

  if [ -d "$PLUGIN_ROOT/lib/types" ]; then
    if [ ! -d "$target_lib/types" ] || ! cmp -rq "$PLUGIN_ROOT/lib/types" "$target_lib/types" 2>/dev/null; then
      rm -rf "$target_lib/types"
      cp -r "$PLUGIN_ROOT/lib/types" "$target_lib/types" || return 1
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

if [ ! -d "$PLUGIN_ROOT" ]; then
  echo "[deploy] ERROR: plugin root not found: $PLUGIN_ROOT" >&2
  exit 1
fi
if [ ! -d "$PROFILE_DIR" ]; then
  echo "[deploy] ERROR: profile dir not found: $PROFILE_DIR" >&2
  exit 1
fi

if try_plugin_add; then
  echo "[deploy] deployed"
elif fallback_copy; then
  echo "[deploy] deployed via fallback copy"
else
  echo "[deploy] ERROR: both dsh plugin add and fallback copy failed" >&2
  exit 1
fi

# Ensure real npm-installed deps exist in the plugin's node_modules.
# (No symlinks — all deps are real packages via npm install.)
node -e "
const fs = require('fs');
const path = require('path');
const root = '$PLUGIN_ROOT';
const nm = path.join(root, 'node_modules', '@deepseek-ai');
const pkgs = ['cordis', 'dsh-home-paths', 'schemastery', 'dsh-session'];
for (const pkg of pkgs) {
  const p = path.join(nm, pkg);
  if (!fs.existsSync(p)) {
    console.error('[deploy] WARNING: ' + p + ' missing — run: cd ' + root + ' && npm install');
  }
}
console.log('[deploy] dependency check done');
"

echo "[deploy] done"
