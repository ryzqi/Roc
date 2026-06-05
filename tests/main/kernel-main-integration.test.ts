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
import { ConfigService } from '../../src/main/services/config-service';
import { PerformanceObserverService } from '../../src/main/services/performance-observer-service';
import { RocPaths } from '../../src/main/services/paths';
import { SecretService } from '../../src/main/services/secret-service';
import type { AgentRuntimeStatus, ChatStartRunRequest, ChatStartRunResult, PerformanceSample } from '../../src/shared/types';

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
    expect(source).toContain('kernel.subscribeEvent<TerminalSessionOutputEvent>');
    expect(source).toContain('kernel.subscribeEvent<ChatRunEvent>');
    expect(source).toContain('agentChatRunEventType');
    expect(source).toContain('const performanceObserverService = new PerformanceObserverService();');
    expect(source).toContain('performanceObserverService,');
    expect(source).not.toContain('services.terminalSessionService.onOutput');
  });

  it('boots only the main kernel from the Electron entrypoint', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8');

    expect(source).toContain('const kernel = createMainKernelBootstrap({');
    expect(source).toContain('registerIpc(kernel, mainWindow');
    expect(source).toContain("kernel.subscribeEvent<TaskUpdateEvent>('task.updated'");
    expect(source).not.toContain('createAppServices');
    expect(source).not.toContain('activeServices');
    expect(source).not.toMatch(/\bservices\./u);
    expect(source).not.toContain('deepAgentRuntimeService.onRunEvent');
    expect(source).not.toContain('taskSchedulerService.handlePowerResume');
  });

  it('reads provider settings saved after kernel startup before agent runs', async () => {
    const bootstrap = createMainKernelBootstrap({
      activateMigration: async ({ paths }) => join(paths.root, 'plugin-data'),
      dataRoot: root,
      safeStorage: safeStorage()
    });
    await bootstrap.start();

    try {
      const paths = new RocPaths(root);
      const configService = new ConfigService(paths);
      configService.initialize();
      const secretService = new SecretService(paths, safeStorage());
      secretService.setProviderSecret('smoke-provider', 'sk-smoke-seed-secret');
      configService.saveSettingsSnapshot({
        settings: configService.getSettings(),
        permissions: configService.getPermissions(),
        providers: [
          {
            id: 'smoke-provider',
            name: 'Smoke Provider',
            type: 'openai_compatible',
            endpoint: 'http://127.0.0.1:65534/v1',
            credentialRef: 'secret:smoke-provider',
            enabled: true,
            models: [
              {
                id: 'smoke-model',
                displayName: 'Smoke Model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ],
        defaultModelId: 'smoke-model'
      });

      await expect(bootstrap.invokeCapability<{}, AgentRuntimeStatus>('agent.status.get', {})).resolves.toMatchObject({
        defaultModelConfigured: true
      });
      await expect(
        bootstrap.invokeCapability<ChatStartRunRequest, ChatStartRunResult>('agent.run.start', {
          input: 'Use the configured model',
          mode: 'chat',
          enabledCapabilities: { mcpServers: [], skills: [] }
        })
      ).resolves.toMatchObject({
        providerId: 'smoke-provider',
        modelId: 'smoke-model'
      });
    } finally {
      await bootstrap.shutdown();
    }
  });

  it('shares bootstrap IPC timings with plugin diagnostics samples', async () => {
    const performanceObserverService = new PerformanceObserverService();
    performanceObserverService.record({
      phase: 'ipc_call',
      label: 'roc:shell:confirm',
      startedAtMs: 10,
      durationMs: 4,
      metadata: {
        channel: 'roc:shell:confirm',
        ok: true
      }
    });
    const bootstrap = createMainKernelBootstrap({
      activateMigration: async ({ paths }) => join(paths.root, 'plugin-data'),
      dataRoot: root,
      performanceObserverService,
      safeStorage: safeStorage()
    });
    await bootstrap.start();

    try {
      const sample = await bootstrap.invokeCapability<{ mode: 'test'; memoryBudgetMb: number }, PerformanceSample>(
        'diagnostics.samplePerformance',
        {
        mode: 'test',
        memoryBudgetMb: 2048
        }
      );

      expect(sample.timing.samples).toContainEqual(
        expect.objectContaining({
          label: 'roc:shell:confirm',
          metadata: {
            channel: 'roc:shell:confirm',
            ok: true
          }
        })
      );
    } finally {
      await bootstrap.shutdown();
    }
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
