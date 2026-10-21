import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against the packages' source, so they need no build first.
    alias: [
      { find: /^@zekel\/game-kit$/, replacement: fileURLToPath(new URL('./packages/game-kit/src/index.ts', import.meta.url)) },
      { find: /^@zekel\/mcp$/, replacement: fileURLToPath(new URL('./packages/mcp/src/index.ts', import.meta.url)) },
      { find: /^@zekel\/mcp\/(.*)$/, replacement: fileURLToPath(new URL('./packages/mcp/src/', import.meta.url)) + '$1.ts' },
    ],
  },
  test: {
    include: ['packages/*/src/**/__tests__/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 2,
    minWorkers: 1,
  },
});
