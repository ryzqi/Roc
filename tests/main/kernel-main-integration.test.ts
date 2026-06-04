import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMainKernelBootstrap } from '../../src/main/main-kernel-bootstrap';
import { KernelRuntime } from '../../src/main/kernel/kernel-runtime';
import type { RocPlugin } from '../../src/main/kernel/types';
import type { SafeStorageBackend } from '../../src/main/infrastructure/secret-manager';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'roc-main-kernel-bootstrap-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('main kernel bootstrap integration', () => {
  it('constructs KernelRuntime, runs migration before plugin load, and shuts kernel down', async () => {
    const calls: string[] = [];
    const plugin = createProbePlugin(calls);
    const bootstrap = createMainKernelBootstrap({
      activateMigration: async ({ paths }) => {
        calls.push('migration');
        return join(paths.root, 'plugin-data');
      },
      dataRoot: root,
      plugins: [plugin],
      safeStorage: safeStorage()
    });

    expect(bootstrap.runtime).toBeInstanceOf(KernelRuntime);

    await bootstrap.start();

    expect(calls).toEqual(['migration', 'plugin-load']);
    expect(bootstrap.runtime.getStatus()).toMatchObject({
      started: true,
      plugins: {
        '@roc/plugin-agent': { status: 'healthy' }
      }
    });

    await bootstrap.shutdown();

    expect(calls).toEqual(['migration', 'plugin-load', 'plugin-shutdown']);
    expect(bootstrap.runtime.getStatus().started).toBe(false);
  });

  it('keeps existing Electron window, tray, app icon, protocol, and host integration code in main entry', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');

    expect(source).toContain('new BrowserWindow(buildMainWindowOptions');
    expect(source).toContain('applyWindowMaterialWithFallback');
    expect(source).toContain('new Tray');
    expect(source).toContain('appIconPath');
    expect(source).toContain('protocol.handle(pdfPreviewScheme');
    expect(source).toContain('hostService.bindMainWindow');
  });
});

function createProbePlugin(calls: string[]): RocPlugin {
  return {
    manifest: {
      id: '@roc/plugin-agent',
      version: '1.0.0',
      displayName: 'Agent',
      description: 'Probe plugin.',
      loadPhase: 'critical',
      required: true,
      order: 1,
      dependencies: [],
      capabilities: [
        {
          name: 'agent.status.get',
          version: '1.0.0',
          inputSchema: z.object({}),
          outputSchema: z.object({ ok: z.literal(true) })
        }
      ]
    },
    initialize: async (context) => {
      calls.push('plugin-load');
      context.capabilities.register('@roc/plugin-agent', context.capabilities.list()[0]!, async () => ({ ok: true }));
    },
    shutdown: async () => {
      calls.push('plugin-shutdown');
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

function safeStorage(): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^enc:/u, '')
  };
}
