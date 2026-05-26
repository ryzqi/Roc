import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/matchers.ts'],
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
