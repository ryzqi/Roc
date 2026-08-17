import { createTestAgentExecution } from './plugins/agent/test-execution';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SafeStorageBackend } from '../../src/main/infrastructure/secret-manager';
import { createPluginCapabilityAdapter } from '../../src/main/ipc/plugin-capability-adapter';
import { KernelRuntime } from '../../src/main/kernel/kernel-runtime';
import { createAppPlugin } from '../../src/main/plugins/app';
import { createAgentPlugin } from '../../src/main/plugins/agent';
import { StaticAgentModelFactoryAdapter } from '../../src/main/plugins/agent/model-factory-adapter';
import type { AgentDeepAgentExecutor } from '../../src/main/plugins/agent/runtime';
import { createDiagnosticsPlugin } from '../../src/main/plugins/diagnostics';
import { createMcpPlugin } from '../../src/main/plugins/mcp';
import { createMemoryPlugin } from '../../src/main/plugins/memory';
import { createRuntimeToolsPlugin } from '../../src/main/plugins/runtime-tools';
import { createSkillsPlugin } from '../../src/main/plugins/skills';
import { createTaskPlugin } from '../../src/main/plugins/task';
import { createWorkspacePlugin } from '../../src/main/plugins/workspace';
import { RTKBinaryManager } from '../../src/rtk-integration';
import type {
  ActiveTaskItem,
  AppStatus,
  BackgroundTask,
  BackgroundTaskPreview,
  ChatRunEvent,
  ChatStartRunResult,
  DiagnosticPackage,
  FileTreeResult,
  IpcResult,
  McpServerSnapshot,
  RtkStatus,
  ScheduledTaskRun,
  TaskDetail
} from '../../src/shared/types';

let root: string;
let workspaceRoot: string;
let resourcesPath: string;
let runtime: KernelRuntime | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-microkernel-regression-test-'));
  workspaceRoot = join(root, 'workspace');
  resourcesPath = join(root, 'resources');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(join(resourcesPath, 'rtk-binaries', 'win32-x64'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'README.md'), 'Microkernel regression workspace.\n', 'utf8');
  writeFileSync(join(resourcesPath, 'rtk-binaries', 'win32-x64', 'rtk.exe'), 'fake rtk', 'utf8');
  execFileSync('git', ['init'], { cwd: workspaceRoot, windowsHide: true });
  runtime = null;
});

afterEach(async () => {
  if (runtime !== null) {
    await runtime.shutdown();
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  rmSync(root, { recursive: true, force: true });
});

describe('microkernel regression', () => {
  it('serves core renderer workflows through plugin-backed IPC capabilities', async () => {
    runtime = new KernelRuntime({
      rootDir: root,
      safeStorage: safeStorage(),
      plugins: [
        createAppPlugin({
          statusProvider: () => ({
            appName: 'Roc',
            version: '0.1.0',
            mode: 'test',
            startedAt: '2026-06-04T00:00:00.000Z',
            appearance: {
              accentColor: '#0078d4',
              inForcedColorsMode: false,
              prefersReducedTransparency: false,
              resolvedTheme: 'dark',
              shouldUseHighContrastColors: false,
              shouldUseInvertedColorScheme: false,
              themeSource: 'system'
            },
            workspace: { selectedPath: workspaceRoot, label: workspaceRoot },
            paths: {
              root,
              configDir: join(root, 'config'),
              memoryDir: join(root, 'memory'),
              logsDir: join(root, 'logs'),
              diagnosticsDir: join(root, 'diagnostics'),
              skillsDir: join(root, 'skills'),
              artifactsDir: join(root, 'tasks', 'artifacts')
            },
            services: {
              app: 'ready',
              agent: 'ready',
              config: 'ready',
              database: 'ready',
              diagnostics: 'ready',
              files: 'ready',
              git: 'ready',
              lifecycle: 'ready',
              mcp: 'ready',
              memory: 'ready',
              rtk: 'ready',
              skills: 'ready',
              tasks: 'ready',
              terminal: 'ready',
              workspace: 'ready'
            },
            defaultModelConfigured: true,
            rendererBoundary: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: {
                enabled: false,
                evaluated: true,
                reason: 'test',
                compensatingControls: []
              }
            }
          })
        }),
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
            path: workspaceRoot,
            label: 'Regression Workspace'
          }
        }),
        createTaskPlugin(),
        createWorkspacePlugin({ rootDir: root }),
        createMcpPlugin(),
        createSkillsPlugin({ rootDir: root }),
        createRuntimeToolsPlugin({
          rootDir: root,
          workspacePath: workspaceRoot,
          binaryManager: new RTKBinaryManager({
            platform: 'win32',
            arch: 'x64',
            resourcesPath
          })
        }),
        createDiagnosticsPlugin({ rootDir: root })
      ]
    });
    await runtime.start();
    const adapter = createPluginCapabilityAdapter(runtime);

    const appStatus = await unwrap<AppStatus>(adapter.invoke('app.getStatus', []));
    const chatRun = await unwrap<ChatStartRunResult>(
      adapter.invoke('chat.startRun', [
        {
          input: 'Create a regression chat run',
          mode: 'chat',
          enabledCapabilities: { mcpServers: [], skills: [] }
        }
      ])
    );
    const backgroundTaskRequest = {
      goal: 'Create a regression task',
      trigger: { type: 'manual' as const, description: 'Manual' },
      workspacePath: workspaceRoot,
      allowedActions: [],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report' as const,
      notificationPolicy: 'failures_and_confirmations' as const
    };
    await unwrap<BackgroundTaskPreview>(adapter.invoke('tasks.createBackgroundTaskPreview', [backgroundTaskRequest]));
    const task = await unwrap<BackgroundTask>(adapter.invoke('tasks.createBackgroundTask', [backgroundTaskRequest]));
    const backgroundTasks = await unwrap<BackgroundTask[]>(adapter.invoke('tasks.listBackgroundTasks', []));
    const activeTasks = await unwrap<ActiveTaskItem[]>(adapter.invoke('tasks.getActiveTasks', []));
    const taskDetail = await unwrap<TaskDetail>(adapter.invoke('tasks.getTaskDetail', [{ taskId: task.id }]));
    const scheduledRuns = await unwrap<ScheduledTaskRun[]>(adapter.invoke('tasks.listScheduledRuns', [{ taskId: task.id }]));
    await unwrap<BackgroundTask>(adapter.invoke('tasks.pauseBackgroundTask', [task.id]));
    await unwrap<BackgroundTask>(adapter.invoke('tasks.resumeBackgroundTask', [task.id]));
    const runNow = await unwrap<{ taskId: string; runId: string }>(adapter.invoke('tasks.runBackgroundNow', [task.id]));
    const runOutputEvents = await waitForTaskRunOutput(adapter, task.id, runNow.runId);
    await unwrap<BackgroundTask>(adapter.invoke('tasks.cancelBackgroundTask', [task.id]));
    const memorySnapshot = await unwrap<{ text: string }>(adapter.invoke('memory.snapshotPreview', []));
    const mcpServers = await unwrap<McpServerSnapshot[]>(adapter.invoke('mcp.listServers', []));
    const rtkStatus = await unwrap<RtkStatus>(adapter.invoke('rtk.status', []));
    await unwrap(adapter.invoke('workspace.select', [{ path: workspaceRoot }]));
    const fileTree = await unwrap<FileTreeResult>(adapter.invoke('files.listTree', [{ relativePath: '', limit: 20 }]));
    const diagnosticPackage = await unwrap<DiagnosticPackage>(
      adapter.invoke('diagnostics.createDiagnosticPackage', [
        {
          taskId: task.id,
          errorSummary: 'Regression package'
        }
      ])
    );

    expect(appStatus.appName).toBe('Roc');
    expect(chatRun.runId).toMatch(/^run_/u);
    expect(backgroundTasks).toContainEqual(expect.objectContaining({ id: task.id }));
    expect(activeTasks).toContainEqual(expect.objectContaining({ taskId: task.id }));
    expect(taskDetail).toMatchObject({ taskId: task.id, backgroundTask: { id: task.id } });
    expect(scheduledRuns).toEqual([]);
    expect(runNow).toMatchObject({ taskId: task.id });
    expect(runOutputEvents).toContainEqual(expect.objectContaining({ runId: runNow.runId, type: 'message', role: 'assistant' }));
    expect(memorySnapshot.text).toContain('# DeepAgents Memory Preview');
    expect(memorySnapshot.text).toContain('type: workspace_fact');
    expect(memorySnapshot.text).toContain('key: roc.microkernel.static_response');
    expect(memorySnapshot.text).toContain('summary: Static DeepAgent response.');
    expect(mcpServers).toContainEqual(expect.objectContaining({ id: 'exa-hosted' }));
    expect(rtkStatus).toMatchObject({ resourceState: 'ready' });
    expect(fileTree.entries).toContainEqual(expect.objectContaining({ name: 'README.md' }));
    expect(diagnosticPackage).toMatchObject({ taskId: task.id, redacted: true });
  });
});

async function unwrap<T>(resultPromise: Promise<IpcResult<unknown>>): Promise<T> {
  const result = await resultPromise;
  if (!result.ok) {
    throw new Error(result.error.code);
  }
  return result.data as T;
}

async function waitForTaskRunOutput(
  adapter: ReturnType<typeof createPluginCapabilityAdapter>,
  taskId: string,
  runId: string
): Promise<Array<{ runId: string; type: string; role: string | null }>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const detail = await unwrap<TaskDetail>(adapter.invoke('tasks.getTaskDetail', [{ taskId }]));
    const events = detail.recentEvents
      .filter((event) => event.runId === runId && event.type === 'message')
      .map((event) => ({
        runId: event.runId,
        type: event.type,
        role:
          event.payload !== null && typeof event.payload === 'object' && typeof Reflect.get(event.payload, 'role') === 'string'
            ? Reflect.get(event.payload, 'role') as string
            : null
      }));
    if (events.some((event) => event.role === 'assistant')) {
      return events;
    }
    if (events.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

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
          text: 'workspace_fact: roc.microkernel.static_response | high | tests/main/microkernel-regression.test.ts | Static DeepAgent response.'
        }
      } satisfies ChatRunEvent;
    })());
}
  };
}
