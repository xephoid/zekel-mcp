import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against the kit's source, so they need no build first.
    alias: { '@zekel/game-kit': fileURLToPath(new URL('./packages/game-kit/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['packages/*/src/**/__tests__/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 2,
    minWorkers: 1,
  },
});
