import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ClientTool } from '@langchain/core/tools';
import { InMemoryStore, MemorySaver } from '@langchain/langgraph';
import { afterAll, vi } from 'vitest';
import type {
  AppSettings,
  ChatRunEvent,
  ChatStartRunRequest,
  ChatValidatedImageAttachment,
  TaskRun
} from '../../../../src/shared/types';
import type { RocCapabilityRegistry } from '../../../../src/main/kernel/types';
import type { AgentDeepAgentExecution } from '../../../../src/main/plugins/agent/agent-execution';
import { toRunExecutionMode } from '../../../../src/main/plugins/agent/run-execution-snapshot';
import {
  createAgentDeepAgentExecutor
} from '../../../../src/main/plugins/agent/deep-agent-executor';
import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';
import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
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
applyAgentDatabaseSchema(toolEffectDb);

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
  observeStreamEventsConfig?: (config: unknown) => void | Promise<void>;
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
  const execution = await startExecutorExecution(input);
  const events = await collectEvents(execution.events);
  await execution.outcome;
  return events;
}

export async function startExecutorExecution(input: ExecutorEventsInput): Promise<AgentDeepAgentExecution> {
  mocked.buildDeepAgent.mockReset();
  lastStreamEventsCall = null;
  mocked.buildDeepAgent.mockReturnValue({
    streamEvents: vi.fn(async (runInput: unknown, config: unknown) => {
      lastStreamEventsCall = { input: runInput, config };
      if (input.observeStreamEventsConfig !== undefined) {
        await input.observeStreamEventsConfig(config);
      }
      if (input.contextMaintenanceEvent !== undefined) {
        const buildInput = readBuildInput();
        if (buildInput.contextCompaction === undefined) {
          throw new Error('context_compaction_not_wired');
        }
        buildInput.contextCompaction.emitEvent(input.contextMaintenanceEvent);
      }
      const output = input.output === undefined ? { messages: [] } : input.output;
      const toolCalls = input.toolCalls === undefined ? emptyAsyncIterable() : input.toolCalls;
      const messages = input.messages === undefined ? emptyAsyncIterable() : input.messages;
      const subagents = input.subagents === undefined ? emptyAsyncIterable() : input.subagents;
      return {
        toolCalls,
        messages,
        subagents,
        output: isPromiseLike(output) ? output : Promise.resolve(output),
        interrupted: false,
        interrupts: []
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
    observeModelUsage: () => {},
    modelHandle: {
      providerId: 'test-provider',
      modelId: 'test-model',
      langChainHandle: {
        model: {
          getNumTokens: async (content: string) => Math.ceil(Buffer.byteLength(content, 'utf8') / 4)
        } as never,
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
          contextBudgetTokens: 128_000
        }
      }
    },
    snapshot: createSnapshot(request, run, input.snapshotWorkspacePath === undefined ? workspacePath : input.snapshotWorkspacePath),
    run,
    validatedAttachments: input.validatedAttachments
  });
  return execution;
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
    mode: toRunExecutionMode(request.mode),
    workspace:
      snapshotWorkspacePath === null
        ? null
        : {
            path: snapshotWorkspacePath,
            hash: 'snapshot_workspace_hash'
          },
    capabilityManifest,
    budget: {
      contextBudgetTokens: 128_000
    },
    workflowHint: request.workflowHint === undefined ? null : request.workflowHint,
    explicitSkillIds,
    inputMessageId: 'event-1',
    dispatchKey: null
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

async function* emptyAsyncIterable<T>(): AsyncIterable<T> {}

export async function* createAsyncIterable<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) {
    yield value;
  }
}

export function createVendorMessageHandle(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    namespace: ['model_request:fixture'],
    node: 'model_request',
    text: emptyAsyncIterable(),
    toolCalls: emptyAsyncIterable(),
    reasoning: emptyAsyncIterable(),
    usage: emptyAsyncIterable(),
    output: Promise.resolve({ content: [], type: 'ai' }),
    ...overrides
  };
}

export function createVendorToolCallHandle(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name: 'read_file',
    callId: 'call-fixture',
    input: { path: '/workspace/fixture.txt' },
    output: Promise.resolve('fixture output'),
    status: Promise.resolve('finished'),
    error: Promise.resolve(undefined),
    ...overrides
  };
}

export function createVendorSubagentHandle(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name: 'researcher',
    cause: { type: 'toolCall', tool_call_id: 'call-subagent' },
    output: Promise.resolve({ messages: [] }),
    messages: emptyAsyncIterable(),
    toolCalls: emptyAsyncIterable(),
    subagents: emptyAsyncIterable(),
    ...overrides
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return false;
  }
  return typeof Reflect.get(value, 'then') === 'function';
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
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let reject: ((reason: unknown) => void) | null = null;
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  if (resolve === null || reject === null) {
    throw new Error('deferred_settlement_missing');
  }
  return {
    promise,
    reject,
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

