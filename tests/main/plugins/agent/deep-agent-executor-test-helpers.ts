import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ClientTool } from '@langchain/core/tools';
import { InMemoryStore, MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import { afterAll, vi } from 'vitest';
import type {
  AppSettings,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatRunEvent,
  ChatStartRunRequest,
  ChatValidatedImageAttachment,
  FileDeleteResult,
  RecoveryPoint,
  ShellExecutionResult,
  SkillFilePreviewResult,
  SkillSnapshot,
  TaskDetail,
  TaskRun,
  Workspace
} from '../../../../src/shared/types';
import type { CapabilityDescriptor, RocCapabilityRegistry } from '../../../../src/main/kernel/types';
import { createAgentDeepAgentExecutor } from '../../../../src/main/plugins/agent/deep-agent-executor';
import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';
import { applyAgentPluginSchema } from '../../../../src/main/plugins/agent/schema';
import type { DeepAgentBuildInput } from '../../../../src/main/services/deep-agent/agent-builder';
import { ContextArtifactStore } from '../../../../src/main/services/deep-agent/context/context-artifact-store';
import type { ContextMaintenanceEvent } from '../../../../src/main/services/deep-agent/context/context-compaction-pipeline';
import { AgentToolEffectStore } from '../../../../src/main/services/deep-agent/tool-effect-store';
import type { HookRuntime } from '../../../../src/main/services/hooks';
import { RocPaths } from '../../../../src/main/services/paths';

const mocked = vi.hoisted(() => ({
  buildDeepAgent: vi.fn()
}));
let lastStreamEventsCall: { input: unknown; config: unknown } | null = null;

vi.mock('../../../../src/main/services/deep-agent/agent-builder', () => ({
  buildDeepAgent: mocked.buildDeepAgent
}));

export const workspacePath = process.cwd();
const toolEffectDb = new Database(':memory:');
applyAgentPluginSchema(toolEffectDb);

afterAll(() => {
  toolEffectDb.close();
});

interface ExecutorEventsInput {
  capabilities: RocCapabilityRegistry;
  getMemorySettings?: () => AppSettings['memory'];
  hookRuntime?: Pick<HookRuntime, 'runEvent'>;
  metricsService?: {
    recordPromptCacheMetrics: (usage: {
      input_tokens: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
    }, labels?: Record<string, string>) => void;
  };
  contextMaintenanceEvent?: ContextMaintenanceEvent;
  messages?: AsyncIterable<unknown>;
  output?: unknown;
  requestOverride?: Partial<ChatStartRunRequest>;
  snapshotWorkspacePath?: string | null;
  subagents?: AsyncIterable<unknown>;
  toolCalls?: AsyncIterable<unknown>;
  validatedAttachments?: ChatValidatedImageAttachment[];
}

export async function buildExecutorOnce(
  capabilities: RocCapabilityRegistry,
  requestOverride: Partial<ChatStartRunRequest> = {},
  validatedAttachments?: ChatValidatedImageAttachment[],
  snapshotWorkspacePath: string | null = workspacePath
): Promise<void> {
  await collectExecutorEvents({
    capabilities,
    requestOverride,
    snapshotWorkspacePath,
    validatedAttachments,
    output: {
      messages: [
        {
          role: 'assistant',
          content: 'ok'
        }
      ]
    }
  });
}

export async function collectExecutorEvents(input: ExecutorEventsInput): Promise<ChatRunEvent[]> {
  return await collectEvents(await startExecutorExecution(input));
}

export async function startExecutorExecution(input: ExecutorEventsInput): Promise<AsyncIterable<ChatRunEvent>> {
  mocked.buildDeepAgent.mockReset();
  lastStreamEventsCall = null;
  mocked.buildDeepAgent.mockReturnValue({
    streamEvents: vi.fn(async (runInput: unknown, config: unknown) => {
      lastStreamEventsCall = { input: runInput, config };
      if (input.contextMaintenanceEvent !== undefined) {
        const buildInput = readBuildInput();
        if (buildInput.contextCompaction === undefined) {
          throw new Error('context_compaction_not_wired');
        }
        buildInput.contextCompaction.emitEvent(input.contextMaintenanceEvent);
      }
      return {
        toolCalls: input.toolCalls ?? emptyAsyncIterable(),
        messages: input.messages ?? emptyAsyncIterable(),
        subagents: input.subagents ?? emptyAsyncIterable(),
        output: input.output ?? { messages: [] }
      };
    })
  });
  const executor = createAgentDeepAgentExecutor({
    capabilities: input.capabilities,
    checkpointer: new MemorySaver(),
    getMemorySettings: input.getMemorySettings,
    hookRuntime: input.hookRuntime,
    metricsService: input.metricsService,
    paths: new RocPaths(join(workspacePath, '.roc-test')),
    store: new InMemoryStore(),
    contextArtifactStore: new ContextArtifactStore(toolEffectDb),
    toolEffectStore: new AgentToolEffectStore(toolEffectDb)
  });
  const request: ChatStartRunRequest = {
    input: '每天检查测试',
    mode: 'task',
    enabledCapabilities: {
      mcpServers: [],
      skills: []
    },
    ...input.requestOverride
  };
  const run = createRun(request);
  const execution = await executor.execute({
    abortSignal: new AbortController().signal,
    modelHandle: {
      providerId: 'test-provider',
      modelId: 'test-model',
      langChainHandle: {
        model: {} as never,
        modelId: 'test-model',
        provider: {
          id: 'test-provider',
          name: 'Test Provider',
          type: 'openai_compatible',
          endpoint: 'https://example.test',
          credentialRef: null,
          enabled: true,
          models: []
        },
        runtime: {
          providerType: 'openai_compatible',
          baseUrl: null,
          streaming: true,
          modelKwargs: {},
          contextBudgetTokens: 4096
        }
      }
    },
    snapshot: createSnapshot(request, run, input.snapshotWorkspacePath === undefined ? workspacePath : input.snapshotWorkspacePath),
    run,
    validatedAttachments: input.validatedAttachments
  });
  return execution;
}

export function createCapabilities(
  calls: Array<{ name: string; input: unknown }>,
  options: {
    capabilityPreview?: boolean;
    mcpTools?: ClientTool[];
    workspace?: Workspace | null;
    skills?: SkillSnapshot[];
    skillFiles?: Record<string, string>;
  } = {}
): RocCapabilityRegistry {
  const capabilityPreviewDescriptor: CapabilityDescriptor = {
    name: 'agent.capability.preview',
    version: '1.0.0',
    inputSchema: z.unknown(),
    outputSchema: z.unknown()
  };
  return {
    declare: () => {},
    register: () => {},
    list: () => (options.capabilityPreview === true ? [capabilityPreviewDescriptor] : []),
    invoke: async <TInput, TOutput>(name: string, input: TInput): Promise<TOutput> => {
      calls.push({ name, input });
      if (name === 'agent.capability.preview') {
        return {
          interruptOn: {}
        } as TOutput;
      }
      if (name === 'workspace.getCurrent') {
        if ('workspace' in options) {
          return options.workspace as TOutput;
        }
        const workspace = {
          id: 'workspace-1',
          path: workspacePath,
          displayName: 'Roc',
          lastOpenedAt: '2026-06-04T00:00:00.000Z',
          trustState: 'trusted'
        } satisfies Workspace;
        return workspace as TOutput;
      }
      if (name === 'mcp.tools.get') {
        return (options.mcpTools === undefined ? [] : options.mcpTools) as TOutput;
      }
      if (name === 'skills.list') {
        const skills = options.skills === undefined ? [] : options.skills;
        return skills as TOutput;
      }
      if (name === 'skills.file.read') {
        const request = input as { id: string; relativePath: string };
        const files = options.skillFiles === undefined ? {} : options.skillFiles;
        const content = files[request.id];
        if (content === undefined) {
          throw new Error(`skill_file_missing:${request.id}`);
        }
        return {
          id: request.id,
          relativePath: request.relativePath,
          kind: 'text',
          content,
          truncated: false,
          sizeBytes: Buffer.byteLength(content, 'utf8')
        } satisfies SkillFilePreviewResult as TOutput;
      }
      if (name === 'task.background.preview') {
        return createPreview(input as BackgroundTaskPreviewRequest) as TOutput;
      }
      if (name === 'task.background.create') {
        return createTask(createPreview(input as BackgroundTaskPreviewRequest), 'running') as TOutput;
      }
      if (name === 'task.detail.get') {
        return createTaskDetail() as TOutput;
      }
      if (name === 'task.background.update') {
        return createTask(createPreview((input as { patch: Partial<BackgroundTaskPreviewRequest> }).patch), 'running') as TOutput;
      }
      if (name === 'task.background.cancel') {
        return createTask(createPreview({ goal: '已取消任务' }), 'cancelled') as TOutput;
      }
      if (name === 'shell.execute') {
        const request = input as { command: string; cwd?: string };
        const cwd = request.cwd === undefined ? workspacePath : request.cwd;
        return {
          command: request.command,
          normalizedCommand: request.command,
          cwd,
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 1,
          usedRtk: false
        } satisfies ShellExecutionResult as TOutput;
      }
      if (name === 'web.read') {
        return {
          content: 'Reader output body',
          source: (input as { url: string }).url,
          proxy: 'https://r.jina.ai/',
          fetchedAt: '2026-06-04T00:00:00.000Z',
          contentHash: 'a'.repeat(64),
          untrusted: true
        } as TOutput;
      }
      if (name === 'files.delete') {
        const request = input as { relativePath: string };
        return {
          relativePath: request.relativePath,
          recoveryPoint: createRecoveryPoint(request.relativePath)
        } satisfies FileDeleteResult as TOutput;
      }
      throw new Error(`unexpected_capability:${name}`);
    }
  } satisfies RocCapabilityRegistry;
}

export function createMcpTool(name: string): ClientTool {
  return {
    name,
    description: 'MCP search tool'
  } as ClientTool;
}

function createRun(request: ChatStartRunRequest): TaskRun {
  return {
    id: 'run-1',
    threadId: 'thread-1',
    runNumber: 1,
    userInput: request.input,
    status: 'running',
    startedAt: '2026-06-04T00:00:00.000Z',
    endedAt: null,
    modelId: 'test-model',
    enabledCapabilities: request.enabledCapabilities
  };
}

function createSnapshot(request: ChatStartRunRequest, run: TaskRun, snapshotWorkspacePath: string | null) {
  const explicitSkillIds = request.explicitSkillIds === undefined ? [] : request.explicitSkillIds;
  const manifestSkillIds = [...request.enabledCapabilities.skills];
  for (const skillId of explicitSkillIds) {
    if (!manifestSkillIds.includes(skillId)) {
      manifestSkillIds.push(skillId);
    }
  }
  const capabilityManifest = compileRunCapabilityManifest({
    deleteFileApprovalMode: 'fully_automatic',
    explicitSkillIds,
    mcpApprovalMode: 'fully_automatic',
    mcpServers: request.enabledCapabilities.mcpServers.map((id) => ({
      id,
      name: id,
      enabled: true,
      transport: 'http' as const,
      status: 'ready' as const,
      tools: 1,
      allowedTools: ['search']
    })),
    mode: request.mode,
    shellAllowedCommands: request.shellAllowedCommands,
    workflowHint: request.workflowHint === undefined ? null : request.workflowHint,
    requestedCapabilities: request.enabledCapabilities,
    skills: manifestSkillIds.map((id) => ({
      id,
      name: id,
      enabled: true,
      path: `F:\\skills\\${id}`,
      description: `${id} skill`,
      status: 'ready' as const
    }))
  }).manifest;
  return {
    schemaVersion: 2 as const,
    runId: run.id,
    threadId: run.threadId,
    runOrigin:
      request.taskSource === 'background_schedule'
        ? 'background_schedule' as const
        : request.workflowHint === undefined
          ? request.mode === 'task'
            ? 'manual_task_run' as const
            : 'chat' as const
          : request.taskSource === 'workbench'
            ? 'workbench_creation' as const
            : 'chat' as const,
    model: {
      providerId: 'test-provider',
      modelId: 'test-model'
    },
    mode: request.mode === 'chat' ? 'run' as const : request.mode,
    workspace:
      snapshotWorkspacePath === null
        ? null
        : {
            path: snapshotWorkspacePath,
            hash: 'snapshot_workspace_hash'
          },
    capabilityManifest,
    budget: {
      contextBudgetTokens: null,
      modelCallLimit: 20,
      modelThreadCallLimit: 100,
      toolCallLimit: 40,
      toolThreadCallLimit: 200
    },
    workflowHint: request.workflowHint === undefined ? null : request.workflowHint,
    explicitSkillIds,
    inputMessageId: 'event-1',
    dispatchKey: null
  };
}

function createPreview(input: Partial<BackgroundTaskPreviewRequest>): BackgroundTaskPreview {
  const trigger = input.trigger ?? {
    type: 'manual',
    description: '手动'
  };
  return {
    goal: input.goal ?? '每天检查测试',
    trigger,
    workspacePath: input.workspacePath ?? workspacePath,
    allowedActions: input.allowedActions ?? [],
    forbiddenActions: input.forbiddenActions ?? [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: input.enabledCapabilities === undefined ? null : input.enabledCapabilities,
    scheduled: trigger.type !== 'manual',
    nextRunAt: trigger.type === 'cron' || trigger.type === 'once' ? trigger.nextRunAt : null,
    cronExpression: trigger.type === 'cron' ? trigger.cronExpression : null,
    riskLevel: 'low',
    requiresConfirmation: false
  };
}

function createTask(preview: BackgroundTaskPreview, status: BackgroundTask['status']): BackgroundTask {
  return {
    id: 'background-1',
    threadId: 'thread-background-1',
    runId: 'run-background-1',
    goal: preview.goal,
    status,
    scheduled: preview.scheduled,
    triggerType: preview.trigger.type,
    triggerDescription: preview.trigger.description,
    nextRunAt: preview.nextRunAt,
    cronExpression: preview.cronExpression,
    workspacePath: preview.workspacePath,
    allowedActions: preview.allowedActions,
    forbiddenActions: preview.forbiddenActions,
    failurePolicy: preview.failurePolicy,
    notificationPolicy: preview.notificationPolicy,
    riskLevel: preview.riskLevel,
    requiresConfirmation: preview.requiresConfirmation,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 0,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    enabledCapabilities: preview.enabledCapabilities
  };
}

function createTaskDetail(): TaskDetail {
  return {
    threadId: 'thread-background-1',
    taskId: 'background-1',
    thread: {
      id: 'thread-background-1',
      kind: 'background',
      title: '每天检查测试',
      goal: '每天检查测试',
      status: 'running',
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z'
    },
    backgroundTask: createTask(createPreview({}), 'running'),
    lastRunId: null,
    runHistory: [],
    recentEvents: [],
    schedulerRegistered: true
  };
}

function createRecoveryPoint(relativePath: string): RecoveryPoint {
  return {
    id: 'recovery-1',
    relativePath,
    snapshotPath: 'F:\\Code\\Roc\\.roc-test\\recovery-1',
    contentSha256: 'sha256-test',
    source: 'agent',
    createdAt: '2026-06-04T00:00:00.000Z',
    restored: false
  };
}

export function readBuiltTools(): ClientTool[] {
  return readBuildInput().tools;
}

export function readBuildInput(): DeepAgentBuildInput {
  const input = mocked.buildDeepAgent.mock.calls[0]?.[0] as DeepAgentBuildInput | undefined;
  if (input === undefined) {
    throw new Error('expected_build_deep_agent_call');
  }
  return input;
}

export function readStreamEventsCall(): { input: unknown; config: unknown } {
  if (lastStreamEventsCall === null) {
    throw new Error('stream_events_call_missing');
  }
  return lastStreamEventsCall;
}

export function findTool(tools: ClientTool[], name: string): ClientTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`expected_tool:${name}`);
  }
  return tool;
}

export async function invokeTool(tool: ClientTool, input: Record<string, unknown>, config?: { signal?: AbortSignal }): Promise<unknown> {
  const invoke = Reflect.get(tool, 'invoke');
  if (typeof invoke !== 'function') {
    throw new Error(`tool_not_invokable:${tool.name}`);
  }
  return await invoke.call(tool, input, config);
}

export function readJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new Error('expected_json_string_tool_output');
  }
  return JSON.parse(value) as unknown;
}

async function* emptyAsyncIterable(): AsyncIterable<unknown> {}

export async function* createAsyncIterable(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
  }
}

type ControlledAsyncStream<T> = {
  close: () => void;
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  waitForRead: () => Promise<void>;
};

export function createControlledAsyncStream<T>(): ControlledAsyncStream<T> {
  const values: T[] = [];
  const pendingReads: Array<(result: IteratorResult<T>) => void> = [];
  const readWaiters: Array<() => void> = [];
  let closed = false;
  let readCount = 0;
  let observedReadCount = 0;

  const notifyRead = () => {
    readCount += 1;
    const waiters = readWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  };

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      const reads = pendingReads.splice(0);
      reads.forEach((resolve) => resolve({ done: true, value: undefined }));
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          notifyRead();
          if (values.length > 0) {
            return Promise.resolve({ done: false, value: values.shift() as T });
          }
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            pendingReads.push(resolve);
          });
        }
      })
    },
    push: (value) => {
      if (closed) {
        throw new Error('controlled_stream_closed');
      }
      const read = pendingReads.shift();
      if (read === undefined) {
        values.push(value);
        return;
      }
      read({ done: false, value });
    },
    waitForRead: async () => {
      if (readCount > observedReadCount) {
        observedReadCount = readCount;
        return;
      }
      await new Promise<void>((resolve) => {
        readWaiters.push(() => {
          observedReadCount = readCount;
          resolve();
        });
      });
    }
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  if (resolve === null) {
    throw new Error('deferred_resolve_missing');
  }
  return {
    promise,
    resolve
  };
}

async function collectEvents(events: AsyncIterable<ChatRunEvent>): Promise<ChatRunEvent[]> {
  const result: ChatRunEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

export async function readIteratorValue<T>(read: Promise<IteratorResult<T>>, label: string): Promise<T> {
  const result = await waitForPromise(read, label);
  if (result.done === true) {
    throw new Error(`expected_iterator_value:${label}`);
  }
  return result.value;
}

export async function waitForPromise<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed_out:${label}`)), 100);
      })
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

export async function drainIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  while (true) {
    const result = await iterator.next();
    if (result.done === true) {
      return;
    }
  }
}

export function isChatRunEventBuffer(value: readonly unknown[]): boolean {
  if (value.length === 0) {
    return false;
  }
  const first = value[0];
  if (typeof first !== 'object' || first === null || !('type' in first)) {
    return false;
  }
  return first.type === 'assistant_block';
}

