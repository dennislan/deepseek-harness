#!/usr/bin/env node
/**
 * Post-build: copy lib/client.cjs → lib/client.js, fix the sourceMappingURL,
 * and emit a minimal lib/types.js shim for the ESM import graph.
 * tsdown emits CJS as .cjs; the module-table loader expects a .js filename.
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const lib = join(process.cwd(), 'lib')

// ── client.cjs → client.js ───────────────────────────────────────────────────
const cjs = join(lib, 'client.cjs')
const js = join(lib, 'client.js')
const cjsMap = cjs + '.map'
const jsMap = js + '.map'

if (!existsSync(cjs)) {
  console.error('[postbuild] ERROR: lib/client.cjs not found — run tsdown first')
  process.exit(1)
}

let content = readFileSync(cjs, 'utf8')
content = content.replace(
  /# sourceMappingURL=client\.cjs\.map/,
  '# sourceMappingURL=client.js.map',
)
writeFileSync(js, content)

if (existsSync(cjsMap)) {
  copyFileSync(cjsMap, jsMap)
}

if (!content.includes('__ModuleLoader__.load')) {
  console.error('[postbuild] ERROR: __ModuleLoader__.load wrapper missing')
  process.exit(1)
}

console.log(`[postbuild] lib/client.js: ${statSync(js).size} bytes`)

// ── types.js shim ─────────────────────────────────────────────────────────────
// lib/host.js imports DEFAULT_CONFIG from './types.js'. The types module is
// normally emitted by tsc, but the repo-internal tsconfig paths skip it in
// standalone builds. Re-emit a minimal runtime-only types.js from the source.
const typesJs = join(lib, 'types.js')
if (!existsSync(typesJs)) {
  // Transpile src/types.ts manually: it is pure const exports with no imports.
  const src = readFileSync(join(process.cwd(), 'src', 'types.ts'), 'utf8')
  // Strip TS type annotations and interfaces; keep only runtime values.
  const lines = src.split('\n')
  const out = []
  let inInterface = false
  for (const line of lines) {
    if (/^export interface\s/.test(line)) { inInterface = true }
    if (inInterface) {
      if (/^\}/.test(line.trim())) { inInterface = false }
      continue
    }
    out.push(line)
  }
  let jsSrc = out.join('\n')
  // Remove type-only export statements (export type { ... })
  jsSrc = jsSrc.replace(/^export type\s+[^\n]*$/gm, '')
  writeFileSync(typesJs, jsSrc + '\n')
  console.log(`[postbuild] lib/types.js shim: ${statSync(typesJs).size} bytes`)
}
