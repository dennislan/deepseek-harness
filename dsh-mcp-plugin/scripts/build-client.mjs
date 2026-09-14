#!/usr/bin/env node
// Build the client-half browser bundle with the repo's tsdown, then normalize
// tsdown's CJS output (client.cjs) to the bare client.js the loader expects.
//
// Usage: node scripts/build-client.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const repoRoot = resolve(pluginRoot, '..')

const tsdown = existsSync(`${repoRoot}/node_modules/.bin/tsdown`)
  ? `${repoRoot}/node_modules/.bin/tsdown`
  : `${repoRoot}/node_modules/.pnpm/node_modules/.bin/tsdown`

const result = spawnSync(tsdown, ['--config', 'tsdown.config.ts'], {
  cwd: pluginRoot,
  stdio: 'inherit',
})
if (result.status !== 0) process.exit(result.status ?? 1)

// tsdown emits client.cjs for CJS format despite entryFileNames; the loader
// wants lib/client.js. Copy it and point the sourcemap at the .js name.
const cjs = `${pluginRoot}/lib/client.cjs`
const js = `${pluginRoot}/lib/client.js`
if (!existsSync(cjs)) {
  // A newer tsdown may already emit client.js directly.
  console.log(`[build-client] ${cjs} not found; assuming tsdown emitted client.js directly`)
} else {
  const code = readFileSync(cjs, 'utf8')
    .replace(/# sourceMappingURL=client\.cjs\.map/, '# sourceMappingURL=client.js.map')
  writeFileSync(js, code)
  const cjsMap = `${cjs}.map`
  if (existsSync(cjsMap)) copyFileSync(cjsMap, `${js}.map`)
  console.log(`[build-client] wrote ${js}`)
}
console.log('[build-client] done')
