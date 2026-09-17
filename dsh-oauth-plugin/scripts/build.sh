#!/usr/bin/env bash
# Standalone build: build dsh-oauth from scratch using only this directory's
# own node_modules (no dependency on the deepseek-harness checkout).
#
# Usage:
#   ./scripts/build.sh
#
# Requires: npm install run first (creates node_modules with all deps).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PLUGIN_ROOT"

if [ ! -d "node_modules" ]; then
  echo "[build] node_modules not found — running npm install first…"
  npm install
fi

echo "[build] tsc…"
npx tsc -p tsconfig.standalone.json

echo "[build] tsdown…"
npx tsdown --config tsdown.config.ts

# tsdown emits lib/client.cjs for CJS format; rename to lib/client.js.
echo "[build] copying client.cjs → client.js…"
node -e "
  const fs = require('fs');
  const cjs = 'lib/client.cjs';
  const js  = 'lib/client.js';
  let c = fs.readFileSync(cjs, 'utf8');
  c = c.replace(/# sourceMappingURL=client\.cjs\.map/, '# sourceMappingURL=client.js.map');
  fs.writeFileSync(js, c);
  if (fs.existsSync(cjs + '.map')) fs.copyFileSync(cjs + '.map', js + '.map');
  console.log('[build] client.js:', fs.statSync(js).size, 'bytes');
"

echo "[build] tarball dry-run…"
npm pack --dry-run 2>&1 | grep -E "Tarball|package size|total files"

echo "[build] OK"
