import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SafeStorageBackend } from '../../../src/main/infrastructure/secret-manager';
import { KernelRuntime } from '../../../src/main/kernel/kernel-runtime';
import { createAgentPlugin } from '../../../src/main/plugins/agent';
import { AgentTaskHistoryContract } from '../../../src/main/plugins/agent/agent-task-history-contract';
import { StaticAgentModelFactoryAdapter } from '../../../src/main/plugins/agent/model-factory-adapter';
import { createDiagnosticsPlugin } from '../../../src/main/plugins/diagnostics';
import { createMcpPlugin } from '../../../src/main/plugins/mcp';
import { createMemoryPlugin } from '../../../src/main/plugins/memory';
import { createRuntimeToolsPlugin } from '../../../src/main/plugins/runtime-tools';
import { createSkillsPlugin } from '../../../src/main/plugins/skills';
import { createTaskPlugin } from '../../../src/main/plugins/task';
import { createWorkspacePlugin } from '../../../src/main/plugins/workspace';
import { RTKBinaryManager } from '../../../src/rtk-integration';
import type {
  FileTreeRequest,
  FileTreeResult,
  GitStatusResult,
  McpServerSnapshot,
  PerformanceSample,
  PerformanceSampleRequest,
  RtkStatus,
  TerminalSessionCloseRequest,
  TerminalSessionCreateRequest,
  TerminalSessionSnapshot,
  Workspace,
  WorkspaceSelectRequest
} from '../../../src/shared/types';

let root: string;
let workspaceRoot: string;
let resourcesPath: string;
let runtime: KernelRuntime | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-secondary-plugins-test-'));
  workspaceRoot = join(root, 'workspace');
  resourcesPath = join(root, 'resources');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(join(resourcesPath, 'rtk-binaries', 'win32-x64'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'README.md'), 'Secondary plugin integration workspace.\n', 'utf8');
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

describe('secondary plugins integration', () => {
  it('loads Phase 2 and Phase 3 plugins and exposes secondary capabilities', async () => {
    runtime = new KernelRuntime({
      rootDir: root,
      safeStorage: safeStorage(),
      createPlugins: (databasePool) => [
        createAgentPlugin({
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
            label: 'Secondary Workspace'
          }
        }),
        createTaskPlugin({
          agentTaskHistory: new AgentTaskHistoryContract(databasePool.getConnection('@roc/plugin-agent'))
        }),
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

    expect(runtime.getStatus().plugins).toMatchObject({
      '@roc/plugin-agent': { status: 'healthy' },
      '@roc/plugin-memory': { status: 'healthy' },
      '@roc/plugin-task': { status: 'healthy' },
      '@roc/plugin-workspace': { status: 'healthy' },
      '@roc/plugin-mcp': { status: 'healthy' },
      '@roc/plugin-skills': { status: 'healthy' },
      '@roc/plugin-runtime-tools': { status: 'healthy' },
      '@roc/plugin-diagnostics': { status: 'healthy' }
    });

    const workspace = await runtime.invokeCapability<WorkspaceSelectRequest, Workspace>('workspace.select', {
      path: workspaceRoot
    });
    const fileTree = await runtime.invokeCapability<FileTreeRequest, FileTreeResult>('files.listTree', {
      relativePath: '',
      limit: 20
    });
    const gitStatus = await runtime.invokeCapability<{}, GitStatusResult>('git.status', {});
    const terminal = await runtime.invokeCapability<TerminalSessionCreateRequest, TerminalSessionSnapshot>(
      'terminal.createSession',
      {
        cwd: workspaceRoot,
        cols: 80,
        rows: 24
      }
    );
    const mcpServers = await runtime.invokeCapability<{}, McpServerSnapshot[]>('mcp.listServers', {});
    const rtkStatus = await runtime.invokeCapability<{}, RtkStatus>('rtk.status', {});
    const performanceSample = await runtime.invokeCapability<PerformanceSampleRequest, PerformanceSample>(
      'diagnostics.samplePerformance',
      {
        mode: 'test',
        memoryBudgetMb: 2048
      }
    );
    await runtime.invokeCapability<TerminalSessionCloseRequest, { closed: true }>('terminal.closeSession', {
      sessionId: terminal.id
    });

    expect(workspace.path).toBe(workspaceRoot);
    expect(fileTree.entries).toContainEqual(expect.objectContaining({ name: 'README.md', relativePath: 'README.md' }));
    expect(gitStatus).toMatchObject({
      workspacePath: workspaceRoot,
      isRepository: true
    });
    expect(terminal).toMatchObject({
      cwd: workspaceRoot,
      status: 'ready',
      cols: 80,
      rows: 24
    });
    expect(mcpServers).toContainEqual(
      expect.objectContaining({
        id: 'exa-hosted',
        preset: true,
        enabled: false
      })
    );
    expect(rtkStatus).toMatchObject({
      resourceState: 'ready',
      binaryPath: join(resourcesPath, 'rtk-binaries', 'win32-x64', 'rtk.exe')
    });
    expect(performanceSample.timing.samples).toContainEqual(
      expect.objectContaining({
        phase: 'ipc_call',
        label: 'diagnostics.samplePerformance',
        metadata: {
          channel: 'diagnostics.samplePerformance',
          ok: true
        }
      })
    );
    expect(performanceSample.ipc.topSlowCalls).toContainEqual(
      expect.objectContaining({
        channel: 'diagnostics.samplePerformance',
        count: 1,
        lastOk: true
      })
    );
  });
});

function safeStorage(): SafeStorageBackend {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^enc:/u, '')
  };
}
