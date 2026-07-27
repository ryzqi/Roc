import { describe, expect, it } from 'vitest';

import {
  loadVitestTestConfig,
  readPackageJson
} from './config-test-helpers';

describe('agent performance smoke configuration', () => {
  it('provides the dedicated agent performance smoke command', async () => {
    const packageJson = await readPackageJson();
    const scripts = packageJson.scripts;
    if (!isRecord(scripts)) {
      throw new Error('agent_performance_package_scripts_missing');
    }

    expect(scripts['smoke:agent-performance']).toBe(
      'vitest run --config vitest.agent-performance.config.ts'
    );
  });

  it('keeps agent performance smoke out of the default suite', async () => {
    const testConfig = await loadVitestTestConfig('vitest.config.ts');

    expect(testConfig.exclude).toContain('tests/performance/**');
  });

  it('collects only agent performance smoke cases in the dedicated config', async () => {
    const testConfig = await loadVitestTestConfig('vitest.agent-performance.config.ts');

    expect(testConfig.include).toEqual([
      'tests/performance/agent-performance.smoke.test.ts'
    ]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
