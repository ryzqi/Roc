import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InfrastructureLogger } from '../../../src/main/infrastructure/logger';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-infrastructure-logger-test-'));
  mkdirSync(join(root, 'logs'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('InfrastructureLogger', () => {
  it('writes plugin logs through the existing logs/app.jsonl path contract', () => {
    const logger = new InfrastructureLogger(join(root, 'logs'));
    const pluginLogger = logger.createPluginLogger('@roc/plugin-agent');

    pluginLogger.info('Agent started.', { runId: 'run_1' });
    pluginLogger.warn('Agent degraded.', { reason: 'missing_dependency' });
    pluginLogger.error('Agent failed.', { code: 'failure' });

    const appLogPath = join(root, 'logs', 'app.jsonl');
    expect(existsSync(appLogPath)).toBe(true);
    const lines = readFileSync(appLogPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        pluginId: '@roc/plugin-agent',
        message: 'Agent started.',
        metadata: { runId: 'run_1' }
      }),
      expect.objectContaining({
        level: 'warn',
        pluginId: '@roc/plugin-agent',
        message: 'Agent degraded.',
        metadata: { reason: 'missing_dependency' }
      }),
      expect.objectContaining({
        level: 'error',
        pluginId: '@roc/plugin-agent',
        message: 'Agent failed.',
        metadata: { code: 'failure' }
      })
    ]);
    expect(lines.every((line) => typeof line.createdAt === 'string')).toBe(true);
  });

  it('rejects invalid plugin ids', () => {
    const logger = new InfrastructureLogger(join(root, 'logs'));

    expect(() => logger.createPluginLogger('@roc/other')).toThrow(/invalid_plugin_id/u);
  });
});
