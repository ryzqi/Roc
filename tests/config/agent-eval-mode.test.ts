import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadVitestTestConfig,
  readPackageJson,
  repositoryRoot
} from './config-test-helpers';

describe('agent eval mode configuration', () => {
  it('provides the dedicated agent eval command', async () => {
    const packageJson = await readPackageJson();
    const scripts = packageJson.scripts;
    if (!isRecord(scripts)) {
      throw new Error('agent_eval_package_scripts_missing');
    }

    expect(scripts['eval:agent']).toBe('node scripts/run-agent-eval.mjs');
  });

  it('keeps the eval directory out of the default suite', async () => {
    const testConfig = await loadVitestTestConfig('vitest.config.ts');

    expect(testConfig.exclude).toContain('tests/evals/**');
  });

  it('collects only deterministic agent eval cases in the dedicated config', async () => {
    const testConfig = await loadVitestTestConfig('vitest.agent-eval.config.ts');

    expect(testConfig.include).toEqual(['tests/evals/agent/**/*.eval.test.ts']);
  });

  it('fails before Vitest when eval mode is missing', () => {
    const result = runEvalCli(['--']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent_eval_mode_missing');
  });

  it('fails before Vitest when eval mode is unsupported', () => {
    const result = runEvalCli(['--', '--mode', 'live']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent_eval_mode_unsupported:live');
  });
});

function runEvalCli(args: string[]) {
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, 'scripts/run-agent-eval.mjs'), ...args],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env
    }
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
