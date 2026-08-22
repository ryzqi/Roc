import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KernelRuntime } from '../../../src/main/kernel/kernel-runtime';
import type { RocPlugin } from '../../../src/main/kernel/types';
import type { SafeStorageBackend } from '../../../src/main/infrastructure/secret-manager';

let root: string;

function safeStorage(): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^enc:/u, '')
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-kernel-runtime-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('KernelRuntime', () => {
  it('starts infrastructure, loads plugins, exposes status, and owns shutdown', async () => {
    const calls: string[] = [];
    const plugin: RocPlugin = {
      manifest: {
        id: '@roc/plugin-agent',
        version: '1.0.0',
        displayName: 'Agent',
        description: 'Agent plugin.',
        loadPhase: 'critical',
        required: true,
        order: 0,
        dependencies: [],
        capabilities: [
          {
            name: 'agent.echo',
            version: '1.0.0',
            inputSchema: z.object({ value: z.string() }),
            outputSchema: z.object({ echoed: z.string() })
          }
        ]
      },
      initialize: async (context) => {
        context.database.getConnection().prepare('CREATE TABLE runtime_items (id TEXT PRIMARY KEY)').run();
        context.config.set('enabled', true);
        context.secrets.set('apiKey', 'sk-runtime');
        context.logger.info('runtime initialized');
        calls.push(context.pluginId);
      },
      shutdown: async () => {
        calls.push('shutdown');
      },
      healthCheck: async () => ({ status: 'healthy' })
    };
    const runtime = new KernelRuntime({
      rootDir: root,
      createPlugins: () => [plugin],
      safeStorage: safeStorage()
    });

    await runtime.start();

    expect(calls).toEqual(['@roc/plugin-agent']);
    expect(runtime.getStatus()).toEqual({
      started: true,
      plugins: {
        '@roc/plugin-agent': { status: 'healthy' }
      }
    });

    await runtime.shutdown();

    expect(readFileSync(join(root, 'logs', 'app.jsonl'), 'utf8')).toContain('runtime initialized');
    expect(calls).toEqual(['@roc/plugin-agent', 'shutdown']);
    expect(runtime.getStatus().started).toBe(false);
  });

  it('initializes database schemas before loading plugins', async () => {
    const plugin: RocPlugin = {
      manifest: {
        id: '@roc/plugin-agent',
        version: '1.0.0',
        displayName: 'Agent',
        description: 'Agent plugin.',
        loadPhase: 'critical',
        required: true,
        order: 0,
        dependencies: [],
        capabilities: []
      },
      initialize: async (context) => {
        expect(Object.keys(context.database)).toEqual(['getConnection']);
        expect(
          context.database.getConnection().prepare("SELECT current_version FROM schema_metadata WHERE db_name = 'agent'").pluck().get()
        ).toBe(15);
      },
      shutdown: async () => {},
      healthCheck: async () => ({ status: 'healthy' })
    };
    const runtime = new KernelRuntime({
      rootDir: root,
      createPlugins: () => [plugin],
      safeStorage: safeStorage()
    });

    await runtime.start();
    await runtime.shutdown();
  });
});
