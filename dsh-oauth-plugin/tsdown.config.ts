import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-oauth/client',
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  // Explicitly request only CJS — tsdown will emit client.cjs by default for
  // this format. The postbuild step (run by deploy.sh) copies it to client.js.
  format: ['cjs'],
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  // The loader expects a bare .js filename. tsdown appends .cjs for CJS format;
  // we work around that by inlining the CJS shim into the banner so the factory
  // closure is well-formed regardless of extension. deploy.sh copies client.cjs
  // to client.js and rewrites the sourceMappingURL afterward.
  entryFileNames: 'client.js',
  banner: "window.__ModuleLoader__.load({ id: 'dsh-oauth', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  footer: 'return module.exports; } });',
})
