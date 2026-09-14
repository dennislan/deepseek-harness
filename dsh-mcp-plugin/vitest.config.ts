import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Root at the plugin dir so `@deepseek-ai/*` and the MCP SDK resolve through
    // the symlinks created by scripts/setup-deps.sh, not the repo root.
    root: import.meta.dirname,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
