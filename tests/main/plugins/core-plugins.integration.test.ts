import { createTestAgentExecution } from './agent/test-execution';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SafeStorageBackend } from '../../../src/main/infrastructure/secret-manager';
import { KernelRuntime } from '../../../src/main/kernel/kernel-runtime';
import { createAgentPlugin } from '../../../src/main/plugins/agent';
import { StaticAgentModelFactoryAdapter } from '../../../src/main/plugins/agent/model-factory-adapter';
import type { AgentDeepAgentExecutor } from '../../../src/main/plugins/agent/runtime';
import { createMemoryPlugin } from '../../../src/main/plugins/memory';
import { createTaskPlugin } from '../../../src/main/plugins/task';
import { createWorkspacePlugin } from '../../../src/main/plugins/workspace';
import type {
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatStartRunRequest,
  ChatStartRunResult
} from '../../../src/shared/types';

let root: string;
let runtime: KernelRuntime | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-core-plugins-test-'));
  runtime = null;
});

afterEach(async () => {
  if (runtime !== null) {
    await runtime.shutdown();
  }
  rmSync(root, { recursive: true, force: true });
});

describe('core plugins integration', () => {
  it('loads agent, memory, workspace, and task plugins in KernelRuntime and delivers cross-plugin events', async () => {
    runtime = new KernelRuntime({
      rootDir: root,
      safeStorage: safeStorage(),
      plugins: [
        createAgentPlugin({
          deepAgentExecutor: createStaticDeepAgentExecutor(),
          modelFactory: new StaticAgentModelFactoryAdapter({
            providerId: 'openai',
            modelId: 'openai:gpt-4.1'
          }),
          status: {
            deepAgentsPackage: 'available',
            deepAgentsApi: { createDeepAgent: true },
            defaultModelConfigured: true,
            defaultModelState: {
              status: 'ready',
              modelId: 'openai:gpt-4.1',
              providerId: 'openai',
              reason: 'ready'
            },
            memoryAccess: 'store_backend',
            execution: 'ready'
          }
        }),
        createMemoryPlugin({
          workspace: {
            path: root,
            label: 'Integration Workspace'
          }
        }),
        createWorkspacePlugin({ rootDir: root }),
        createTaskPlugin()
      ]
    });

    await runtime.start();

    expect(runtime.getStatus().plugins).toMatchObject({
      '@roc/plugin-agent': { status: 'healthy' },
      '@roc/plugin-memory': { status: 'healthy' },
      '@roc/plugin-workspace': { status: 'healthy' },
      '@roc/plugin-task': { status: 'healthy' }
    });

    const run = await runtime.invokeCapability<ChatStartRunRequest, ChatStartRunResult>('agent.run.start', {
      input: 'Create an integration run record',
      mode: 'task',
      enabledCapabilities: {
        mcpServers: [],
        skills: []
      }
    });
    expect(run.threadId).toEqual(expect.stringMatching(/^thread_/u));

    const preview = await runtime.invokeCapability<BackgroundTaskPreviewRequest, BackgroundTaskPreview>('task.background.preview', {
      goal: 'Create a task plugin preview',
      trigger: {
        type: 'manual',
        description: 'Manual'
      },
      workspacePath: root,
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    expect(preview.goal).toBe('Create a task plugin preview');

    await expect(runtime.invokeCapability('memory.snapshot.preview', {})).resolves.toEqual({
      text: '# DeepAgents Memory Preview'
    });

    await runtime.publishEvent({
      type: 'agent.run.completed',
      source: '@roc/plugin-agent',
      payload: {
        runId: run.runId,
        threadId: run.threadId,
        summary: 'workspace_fact: roc.integration.memory | high | tests/main/plugins/core-plugins.integration.test.ts | Integration completion reached memory.',
        assistantMessage: 'Memory saw the agent completion.'
      },
      createdAt: new Date().toISOString()
    });

    await expect(runtime.invokeCapability('memory.snapshot.preview', {})).resolves.toMatchObject({
      text: expect.stringContaining('key: roc.integration.memory')
    });
    await expect(runtime.invokeCapability('memory.snapshot.preview', {})).resolves.toMatchObject({
      text: expect.stringContaining('summary: Integration completion reached memory.')
    });
  });
});

function safeStorage(): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^enc:/u, '')
  };
}

function createStaticDeepAgentExecutor(): AgentDeepAgentExecutor {
  return {
    execute(input) {
  return createTestAgentExecution(() => (async function* () {
      yield {
        type: 'assistant_block',
        runId: input.run.id,
        block: {
          kind: 'text',
          blockId: `text-${input.run.id}`,
          phase: 'delta',
          text: 'Static DeepAgent response.'
        }
      };
    })());
}
  };
}
