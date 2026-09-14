import { defineConfig } from 'tsdown'

/**
 * Client-half browser bundle. Mirrors dsh-oauth: CJS platform=browser wrapped in
 * the web shell's `window.__ModuleLoader__` factory, so the deployed artifact
 * (`lib/client.js`) is a self-contained module the shell seats under the id
 * `dsh-mcp-plugin`. `react` / `react/jsx-runtime` are externalized to the frozen
 * module table (both are seeded by `PLATFORM_MODULES`), so the bundle stays
 * React-version-agnostic.
 */
export default defineConfig({
  name: 'dsh-mcp-plugin/client',
  entry: { client: 'src/client.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  jsx: 'react-jsx',
  deps: {
    neverBundle: ['react', 'react/jsx-runtime'],
  },
  dts: false,
  sourcemap: true,
  clean: false,
  // tsdown appends `.cjs` for CJS; the loader expects a bare `.js`. entryFileNames
  // names it client.js; scripts/build-client.mjs normalizes client.cjs → client.js.
  entryFileNames: 'client.js',
  banner: "window.__ModuleLoader__.load({ id: 'dsh-mcp-plugin', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  footer: 'return module.exports; } });',
})
