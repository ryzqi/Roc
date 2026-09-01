import { join } from 'node:path';
import Database from 'better-sqlite3';
import { InMemoryStore, MemorySaver } from '@langchain/langgraph';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';
import { buildRunHarness, type RunHarnessServices } from '../../../../src/main/plugins/agent/run-harness';
import type { DeepAgentBuildInput } from '../../../../src/main/services/deep-agent/agent-builder';
import { ContextArtifactStore } from '../../../../src/main/services/deep-agent/context/context-artifact-store';
import { AgentToolEffectStore } from '../../../../src/main/services/deep-agent/tool-effect-store';
import { resolveRuntimeWorkspaceIdentity } from '../../../../src/main/services/deep-agent/context/workspace-scope';
import { RocPaths } from '../../../../src/main/services/paths';
import type { ChatRunEvent, RunExecutionSnapshotV2, TaskRun } from '../../../../src/shared/types';
import { createCapabilities, createMcpTool } from './agent-capability-test-fixtures';
import { createFakePreCompactionFlushRecorder } from '../../services/deep-agent/context/pre-compaction-flush-test-helpers';

const mocked = vi.hoisted(() => ({
  buildDeepAgent: vi.fn(() => ({ __stubAgent: true }))
}));

vi.mock('../../../../src/main/services/deep-agent/agent-builder', () => ({
  buildDeepAgent: mocked.buildDeepAgent
}));

const workspacePath = process.cwd();
const db = new Database(':memory:');
applyAgentDatabaseSchema(db);

afterAll(() => {
  db.close();
});

describe('buildRunHarness', () => {
  it('按语义分组定序工具，网络与提问在前、shell 与 MCP 在后', async () => {
    await buildRunHarness(
      createServices({ capabilities: createCapabilities([], { mcpTools: [createMcpTool('exa-hosted__web_search_exa')] }) }),
      createRequest({ enabledMcpServers: ['exa-hosted'], workflowHint: 'propose_background_task' })
    );

    // 前 9 个是 harness 自己定序的运行工具；后 4 个由上下文装配追加在尾部。
    expect(readBuiltToolNames()).toEqual([
      'web_read',
      'ask_user',
      'resolve_background_task_time',
      'propose_background_task',
      'schedule_background_task',
      'read_background_task',
      'delete_file',
      'run_shell_command',
      'web_search',
      'session_search',
      'memory_search',
      'remember',
      'read_context_artifact'
    ]);
  });

  it('plan mode 只交出网络与提问工具，不装文件与 shell', async () => {
    await buildRunHarness(createServices({}), createRequest({ mode: 'plan' }));

    const names = readBuiltToolNames();
    expect(names).toContain('web_read');
    expect(names).toContain('ask_user');
    expect(names).not.toContain('delete_file');
    expect(names).not.toContain('run_shell_command');
  });

  it('shell 允许列表显式为空时不装 shell 工具', async () => {
    await buildRunHarness(createServices({}), createRequest({ shellAllowedCommands: [] }));

    expect(readBuiltToolNames()).not.toContain('run_shell_command');
  });

  it('manifest 授权 roc_self_config 但没接服务时立即失败，而不是静默少一个工具', async () => {
    await expect(buildRunHarness(
      createServices({}),
      createRequest({ requestSelfConfig: true })
    )).rejects.toThrow('run_capability_self_config_service_missing');
  });

  it('后台任务工作流要求 workbench 来源', async () => {
    await expect(buildRunHarness(
      createServices({}),
      createRequest({ workflowHint: 'propose_background_task', runOrigin: 'chat' })
    )).rejects.toThrow('background_task_workbench_source_required');
  });

  it('SessionStart hook 拦截时返回 blocked，且不建 agent', async () => {
    const harness = await buildRunHarness(
      createServices({
        hookRuntime: {
          runEvent: vi.fn(async () => ({
            blocked: true,
            blockReason: 'SessionStart 拒绝本轮运行。',
            updatedInput: undefined,
            additionalContexts: [],
            requestContinue: null,
            runs: [],
            events: []
          }))
        }
      }),
      createRequest({})
    );

    expect(harness).toEqual({ kind: 'blocked', reason: 'SessionStart 拒绝本轮运行。' });
    expect(mocked.buildDeepAgent).not.toHaveBeenCalled();
  });

  it('hook 未给出拦截原因时给一条兜底原因，而不是空字符串', async () => {
    const harness = await buildRunHarness(
      createServices({
        hookRuntime: {
          runEvent: vi.fn(async () => ({
            blocked: true,
            blockReason: null,
            updatedInput: undefined,
            additionalContexts: [],
            requestContinue: null,
            runs: [],
            events: []
          }))
        }
      }),
      createRequest({})
    );

    expect(harness).toEqual({ kind: 'blocked', reason: 'Blocked by SessionStart hook.' });
  });

  it('SessionStart 追加的上下文接进 hook middleware 初始上下文', async () => {
    const emitted: ChatRunEvent[] = [];
    const harness = await buildRunHarness(
      createServices({
        hookRuntime: {
          runEvent: vi.fn(async () => ({
            blocked: false,
            blockReason: null,
            updatedInput: undefined,
            additionalContexts: ['项目使用 pnpm。'],
            requestContinue: null,
            runs: [],
            events: []
          }))
        }
      }),
      createRequest({ emitRuntimeEvent: (event) => emitted.push(event) })
    );

    expect(harness.kind).toBe('ready');
    expect(readBuildInput().hookMiddleware?.initialContexts).toEqual(['项目使用 pnpm。']);
  });

  it('取主 agent 与各子代理里最保守的输入预算', async () => {
    await buildRunHarness(createServices({}), createRequest({}));

    const compaction = readBuildInput().contextCompaction;
    if (compaction === undefined) {
      throw new Error('context_compaction_not_wired');
    }
    const systemPrompt = readBuildInput().systemPrompt;
    const promptTokens = Math.ceil(Buffer.byteLength(systemPrompt, 'utf8') / 4);
    // 主 agent 的系统提示最长，所以最保守画像必须来自它：预算里扣掉的系统开销不小于主提示本身。
    expect(compaction.budgetProfile.systemToolOverheadTokens).toBeGreaterThanOrEqual(promptTokens);
    expect(compaction.budgetProfile.contextWindowTokens).toBe(128_000);
    expect(compaction.budgetProfile.modelInputTokens).toBeLessThan(128_000);
  });

  it('上下文预算缺失时立即失败', async () => {
    await expect(buildRunHarness(
      createServices({}),
      createRequest({ contextBudgetTokens: null })
    )).rejects.toThrow('agent_context_budget_missing');
  });

  it('模型句柄缺失时立即失败', async () => {
    await expect(buildRunHarness(
      createServices({}),
      { ...createRequest({}), modelHandle: { modelId: 'test-model' } }
    )).rejects.toThrow('agent_deep_agent_model_handle_missing');
  });

  it('把工作区哈希与来源交给调用方，用于工具产物投影与指标分流', async () => {
    const chatHarness = await buildRunHarness(createServices({}), createRequest({}));
    const backgroundHarness = await buildRunHarness(
      createServices({}),
      createRequest({ workflowHint: 'propose_background_task' })
    );

    // 工作区哈希由运行时按路径解出，与压缩管线用的是同一个来源，两者必须一致。
    const expectedHash = resolveRuntimeWorkspaceIdentity(workspacePath)?.hash;
    expect(expectedHash).toBeTypeOf('string');
    expect(chatHarness).toMatchObject({ kind: 'ready', source: 'chat', workspaceHash: expectedHash });
    expect(backgroundHarness).toMatchObject({ kind: 'ready', source: 'background_task' });
  });

  it('没有工作区时工作区哈希为 null', async () => {
    const harness = await buildRunHarness(createServices({}), createRequest({ workspacePath: null }));

    expect(harness).toMatchObject({ kind: 'ready', workspaceHash: null });
  });

  it('把压缩事件转成运行时上下文维护事件', async () => {
    const emitted: ChatRunEvent[] = [];
    await buildRunHarness(createServices({}), createRequest({ emitRuntimeEvent: (event) => emitted.push(event) }));

    const compaction = readBuildInput().contextCompaction;
    if (compaction === undefined) {
      throw new Error('context_compaction_not_wired');
    }
    compaction.emitEvent({
      type: 'context_compaction_started',
      runId: 'run-1',
      threadId: 'thread-1',
      mode: 'task',
      stage: 'persist',
      inputTokens: 120,
      budgetTokens: 100
    });

    expect(emitted).toEqual([{
      type: 'context_maintenance',
      runId: 'run-1',
      threadId: 'thread-1',
      event: 'context_compaction_started',
      mode: 'task',
      stage: 'persist',
      inputTokens: 120,
      budgetTokens: 100
    }]);
  });
});

function createServices(input: {
  capabilities?: RunHarnessServices['capabilities'];
  hookRuntime?: RunHarnessServices['hookRuntime'];
  selfConfigService?: RunHarnessServices['selfConfigService'];
}): RunHarnessServices {
  mocked.buildDeepAgent.mockClear();
  return {
    capabilities: input.capabilities === undefined ? createCapabilities([]) : input.capabilities,
    checkpointer: new MemorySaver(),
    contextArtifactStore: new ContextArtifactStore(db),
    hookRuntime: input.hookRuntime,
    paths: new RocPaths(join(workspacePath, '.roc-test')),
    selfConfigService: input.selfConfigService,
    sessionHistory: createFakePreCompactionFlushRecorder(),
    store: new InMemoryStore(),
    toolEffectStore: new AgentToolEffectStore(db)
  };
}

function createRequest(input: {
  contextBudgetTokens?: number | null;
  emitRuntimeEvent?: (event: ChatRunEvent) => void;
  enabledMcpServers?: readonly string[];
  mode?: RunExecutionSnapshotV2['mode'];
  requestSelfConfig?: boolean;
  runOrigin?: RunExecutionSnapshotV2['runOrigin'];
  shellAllowedCommands?: readonly string[];
  workflowHint?: RunExecutionSnapshotV2['workflowHint'];
  workspacePath?: string | null;
}) {
  const mode = input.mode === undefined ? ('task' as const) : input.mode;
  const workflowHint = input.workflowHint === undefined ? null : input.workflowHint;
  const mcpServerIds = input.enabledMcpServers === undefined ? [] : [...input.enabledMcpServers];
  const manifest = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    mcpApprovalMode: 'fully_automatic',
    mcpServers: mcpServerIds.map((id) => ({
      id,
      name: id,
      enabled: true,
      transport: 'http' as const,
      status: 'ready' as const,
      tools: 1,
      allowedTools: ['web_search_exa']
    })),
    mode: mode === 'run' ? 'chat' : mode,
    ...(input.shellAllowedCommands === undefined ? {} : { shellAllowedCommands: [...input.shellAllowedCommands] }),
    ...(input.requestSelfConfig === true ? { selfConfigAvailable: true } : {}),
    requestedCapabilities: { mcpServers: mcpServerIds, skills: [] },
    skills: [],
    workflowHint
  }).manifest;
  const run: TaskRun = {
    id: 'run-1',
    threadId: 'thread-1',
    runNumber: 1,
    userInput: '检查测试',
    status: 'running',
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: null,
    modelId: 'test-model',
    enabledCapabilities: { mcpServers: mcpServerIds, skills: [] }
  };
  const resolvedWorkspacePath = input.workspacePath === undefined ? workspacePath : input.workspacePath;
  return {
    abortSignal: new AbortController().signal,
    emitRuntimeEvent: input.emitRuntimeEvent === undefined ? () => {} : input.emitRuntimeEvent,
    modelHandle: {
      modelId: 'test-model',
      langChainHandle: {
        model: {
          getNumTokens: async (content: string) => Math.ceil(Buffer.byteLength(content, 'utf8') / 4)
        } as never,
        modelId: 'test-model',
        provider: {
          id: 'test-provider',
          name: 'Test Provider',
          type: 'openai_compatible' as const,
          endpoint: 'https://example.test',
          credentialRef: null,
          enabled: true,
          models: []
        },
        runtime: {
          providerType: 'openai_compatible' as const,
          baseUrl: null,
          streaming: true,
          modelKwargs: {},
          contextBudgetTokens: 128_000
        }
      }
    },
    run,
    snapshot: {
      schemaVersion: 2 as const,
      runId: run.id,
      threadId: run.threadId,
      runOrigin: input.runOrigin === undefined
        ? (workflowHint === null ? ('manual_task_run' as const) : ('workbench_creation' as const))
        : input.runOrigin,
      model: { providerId: 'test-provider', modelId: 'test-model' },
      mode,
      workspace: resolvedWorkspacePath === null
        ? null
        : { path: resolvedWorkspacePath, hash: 'snapshot_workspace_hash' },
      capabilityManifest: manifest,
      budget: {
        contextBudgetTokens: input.contextBudgetTokens === undefined ? 128_000 : input.contextBudgetTokens
      },
      workflowHint,
      explicitSkillIds: [],
      inputMessageId: 'event-1',
      dispatchKey: null,
      ...(input.shellAllowedCommands === undefined ? {} : { shellAllowedCommands: [...input.shellAllowedCommands] })
    } satisfies RunExecutionSnapshotV2
  };
}

function readBuildInput(): DeepAgentBuildInput {
  const calls = mocked.buildDeepAgent.mock.calls as unknown as [DeepAgentBuildInput][];
  if (calls.length === 0) {
    throw new Error('build_deep_agent_not_called');
  }
  return calls[calls.length - 1][0];
}

function readBuiltToolNames(): string[] {
  return readBuildInput().tools.map((tool) => tool.name);
}
