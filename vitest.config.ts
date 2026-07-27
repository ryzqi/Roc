import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      ...configDefaults.exclude,
      'tests/integration/**',
      'tests/evals/**',
      'tests/performance/**'
    ],
    setupFiles: ['tests/setup/matchers.ts'],
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
