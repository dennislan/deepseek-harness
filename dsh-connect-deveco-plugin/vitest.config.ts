import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

export default defineConfig({
  // The harness `llm` sources use TypeScript decorators, and one is imported
  // directly for its `LlmAdapter` base class and `LlmError` vocabulary. The
  // repository's shared pre-transform is what lets Vite parse them.
  plugins: [standardDecoratorPlugin()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@deepseek-ai/dsh-llm': new URL('../packages/llm/llm/src/index.ts', import.meta.url).pathname,
    },
  },
})
