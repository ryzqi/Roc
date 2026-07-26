import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFromFile } from 'vite';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

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

async function readPackageJson(): Promise<Record<string, unknown>> {
  const content = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) {
    throw new Error('agent_integration_package_json_invalid');
  }
  return parsed;
}

async function loadVitestTestConfig(fileName: string) {
  const config = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    resolve(repositoryRoot, fileName)
  );
  if (config === null) {
    throw new Error(`agent_integration_vitest_config_missing:${fileName}`);
  }
  if (config.config.test === undefined) {
    throw new Error(`agent_integration_vitest_test_config_missing:${fileName}`);
  }
  return config.config.test;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
