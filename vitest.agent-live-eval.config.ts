import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/evals/live/agent/**/*.live.eval.test.ts'],
    setupFiles: ['tests/setup/matchers.ts'],
    testTimeout: 120000,
    hookTimeout: 120000
  }
});
