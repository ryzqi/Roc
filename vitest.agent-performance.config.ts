import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/performance/agent-performance.smoke.test.ts'],
    setupFiles: ['tests/setup/matchers.ts'],
    testTimeout: 180000,
    hookTimeout: 180000
  }
});
