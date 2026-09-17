import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-connect-deveco',
  entry: { host: 'src/host.ts', cli: 'src/cli.ts', invariant: 'src/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  // The Cordis loader and the `bin` entry resolve `lib/host.js` and `lib/cli.js`
  // by name, so an ESM build must keep the `.js` extension instead of the `.mjs`
  // tsdown emits by default for an ESM-only format.
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  // `tsc` writes the declarations into `lib/types` before tsdown runs, so
  // tsdown must not wipe the directory it shares an output root with.
  clean: false,
})
