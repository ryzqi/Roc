import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/agent/**/*.int.test.ts'],
    setupFiles: ['tests/setup/matchers.ts'],
    testTimeout: 60000,
    hookTimeout: 60000
  }
});
