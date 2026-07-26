import { describe, expect, it } from 'vitest';

import { loadVitestTestConfig, readPackageJson } from './config-test-helpers';

describe('agent integration test mode configuration', () => {
  it('provides the dedicated agent integration command', async () => {
    const packageJson = await readPackageJson();
    const scripts = packageJson.scripts;
    if (!isRecord(scripts)) {
      throw new Error('agent_integration_package_scripts_missing');
    }

    expect(scripts['test:agent:integration']).toBe(
      'vitest run --config vitest.agent-integration.config.ts'
    );
  });

  it('keeps the dedicated integration directory out of the default suite', async () => {
    const testConfig = await loadVitestTestConfig('vitest.config.ts');

    expect(testConfig.exclude).toContain('tests/integration/**');
  });

  it('collects only agent integration cases in the dedicated config', async () => {
    const testConfig = await loadVitestTestConfig('vitest.agent-integration.config.ts');

    expect(testConfig.include).toEqual(['tests/integration/agent/**/*.int.test.ts']);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
