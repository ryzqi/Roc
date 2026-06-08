import { createDeepAgent } from 'deepagents';

import type {
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  ChatCancelRunResult,
  ChatRunEvent,
  ChatResumeRunRequest,
  ChatResumeRunResult,
  ChatStartRunRequest,
  ChatStartRunResult,
  EnabledCapabilities,
  SessionMessageEntry,
  SessionMessageSearchRequest,
  SessionMessageSearchResult,
  TaskEvent,
  TaskRun
} from '../../../shared/types';
import type { RocEventBus } from '../../kernel/types';
import { consumeMessageStream, createUsageAccumulator } from '../../services/deep-agent/stream-consumers';
import type { AgentModelFactoryAdapter } from './model-factory-adapter';
import type { AgentSessionRepository } from './session-repository';

export const agentChatRunEventType = 'agent.chat.run-event';

export type AgentCapabilityPreviewProvider = (input: {
  requestedCapabilities: EnabledCapabilities;
  runtimeStatus: AgentRuntimeStatus;
}) => Promise<AgentCapabilityPreview>;

export type AgentPluginRuntimeOptions = {
  repository: AgentSessionRepository;
  eventBus: RocEventBus;
  modelFactory: AgentModelFactoryAdapter;
  runtimeDelegate?: AgentPluginRuntimeDelegate;
  capabilityPreviewProvider?: AgentCapabilityPreviewProvider;
  pluginId?: string;
  status?: AgentRuntimeStatus;
  statusProvider?: () => AgentRuntimeStatus;
};

export type AgentPluginRuntimeDelegate = {
  startRun(request: ChatStartRunRequest): Promise<ChatStartRunResult>;
  cancelRun(runId: string): ChatCancelRunResult;
  resumeRun(request: ChatResumeRunRequest): Promise<ChatResumeRunResult>;
  onRunEvent(listener: (event: ChatRunEvent) => void): () => void;
};

type DelegatedRunMetadata = {
  mode: ChatStartRunRequest['mode'];
  threadId: string;
  providerId: string;
  modelId: string;
};

export class AgentPluginRuntime {
  private readonly activeRuns = new Set<string>();
  private readonly delegatedRuns = new Map<string, DelegatedRunMetadata>();
  private delegatedEventQueue = Promise.resolve();
  private readonly delegatedUnsubscribe: (() => void) | null;
  private readonly pendingRuns = new Set<Promise<void>>();
  private readonly scheduledRuns = new Set<NodeJS.Timeout>();
  private readonly pluginId: string;

  constructor(private readonly options: AgentPluginRuntimeOptions) {
    this.pluginId = options.pluginId === undefined ? '@roc/plugin-agent' : options.pluginId;
    this.delegatedUnsubscribe =
      options.runtimeDelegate === undefined
        ? null
        : options.runtimeDelegate.onRunEvent((event) => {
            this.delegatedEventQueue = this.delegatedEventQueue
              .then(async () => {
                await this.handleDelegatedRunEvent(event);
              })
              .catch(() => undefined);
          });
  }

  getStatus(): AgentRuntimeStatus {
    if (this.options.statusProvider !== undefined) {
      return this.options.statusProvider();
    }
    if (this.options.status !== undefined) {
      return this.options.status;
    }
    return createBlockedAgentRuntimeStatus();
  }

  async getCapabilityPreview(requestedCapabilities: EnabledCapabilities): Promise<AgentCapabilityPreview> {
    if (this.options.capabilityPreviewProvider === undefined) {
      throw new Error('agent_capability_preview_unavailable');
    }
    return await this.options.capabilityPreviewProvider({
      requestedCapabilities,
      runtimeStatus: this.getStatus()
    });
  }

  async startRun(request: ChatStartRunRequest): Promise<ChatStartRunResult> {
    const input = request.input.trim();
    if (input.length === 0) {
      throw new Error('chat_input_empty');
    }
    if (this.shouldUseRuntimeDelegate(request)) {
      return await this.startDelegatedRun(request, input);
    }
    const modelHandle = await this.options.modelFactory.createDefaultModelHandle();
    const capabilityPreview =
      this.options.capabilityPreviewProvider === undefined ? undefined : await this.getCapabilityPreview(request.enabledCapabilities);
    const run = this.options.repository.createTaskRun({
      enabledCapabilities: request.enabledCapabilities,
      modelId: modelHandle.modelId,
      threadId: typeof request.threadId === 'string' ? request.threadId : undefined,
      userInput: input
    });
    this.activeRuns.add(run.id);
    const result: ChatStartRunResult = {
      runId: run.id,
      mode: request.mode,
      threadId: run.threadId,
      providerId: modelHandle.providerId,
      modelId: modelHandle.modelId,
      createdAt: run.startedAt
    };
    await this.publish('agent.run.started', {
      ...result,
      enabledCapabilities: request.enabledCapabilities,
      userInput: input,
      workflowHint: request.workflowHint === undefined ? null : request.workflowHint,
      capabilityPreview
    });
    await this.publishChatRunEvent({
      type: 'run_started',
      ...result
    });
    const timer = setTimeout(() => {
      this.scheduledRuns.delete(timer);
      const pendingRun = this.executeRun({
        enabledCapabilities: request.enabledCapabilities,
        input,
        modelId: modelHandle.modelId,
        mode: request.mode,
        providerId: modelHandle.providerId,
        runId: run.id,
        threadId: run.threadId,
        workflowHint: request.workflowHint === undefined ? null : request.workflowHint,
        invoke: modelHandle.invoke,
        stream: modelHandle.stream
      });
      this.pendingRuns.add(pendingRun);
      void pendingRun.finally(() => {
        this.pendingRuns.delete(pendingRun);
      });
    }, 0);
    this.scheduledRuns.add(timer);
    return result;
  }

  cancelRun(input: { runId: string }): ChatCancelRunResult {
    if (this.delegatedRuns.has(input.runId) && this.options.runtimeDelegate !== undefined) {
      return this.options.runtimeDelegate.cancelRun(input.runId);
    }
    if (!this.activeRuns.has(input.runId)) {
      return {
        runId: input.runId,
        cancelled: false
      };
    }
    this.activeRuns.delete(input.runId);
    this.options.repository.updateRunStatus({
      endedAt: new Date().toISOString(),
      runId: input.runId,
      status: 'cancelled'
    });
    return {
      runId: input.runId,
      cancelled: true
    };
  }

  async resumeRun(request: ChatResumeRunRequest): Promise<ChatResumeRunResult> {
    const delegatedRun = this.delegatedRuns.get(request.runId);
    if (delegatedRun !== undefined && this.options.runtimeDelegate !== undefined) {
      const result = await this.options.runtimeDelegate.resumeRun(request);
      await this.publish('agent.run.resumed', result);
      if (delegatedRun.mode === 'chat' && typeof request.interruptId === 'string') {
        await this.publish('agent.run.task-event', {
          runId: request.runId,
          threadId: delegatedRun.threadId,
          type: 'approval_decision',
          payload: {
            interruptId: request.interruptId,
            decisions: request.decisions
          }
        });
      }
      return result;
    }
    const run = this.options.repository.getRun(request.runId);
    if (run.threadId !== request.threadId) {
      throw new Error('chat_resume_thread_mismatch');
    }
    if (run.modelId === null) {
      throw new Error('chat_resume_run_missing');
    }
    await this.options.modelFactory.createModelHandleByModelId(run.modelId);
    this.activeRuns.add(run.id);
    const resumedAt = new Date().toISOString();
    const result: ChatResumeRunResult = {
      runId: run.id,
      threadId: run.threadId,
      resumedAt
    };
    await this.publish('agent.run.resumed', result);
    return result;
  }

  listSessionMessages(input: { threadId: string; limit?: number }): SessionMessageEntry[] {
    return this.options.repository.listSessionMessages(input);
  }

  searchSessionMessages(input: SessionMessageSearchRequest): SessionMessageSearchResult {
    return this.options.repository.searchSessionMessages(input);
  }

  async shutdown(): Promise<void> {
    if (this.delegatedUnsubscribe !== null) {
      this.delegatedUnsubscribe();
    }
    for (const timer of this.scheduledRuns) {
      clearTimeout(timer);
    }
    this.scheduledRuns.clear();
    if (this.pendingRuns.size > 0) {
      await Promise.allSettled([...this.pendingRuns]);
    }
    await this.delegatedEventQueue;
  }

  async completeRun(input: {
    runId: string;
    assistantMessage: string;
    summary: string;
    durationMs: number;
    providerId: string;
    modelId: string;
  }): Promise<{ run: TaskRun; message: SessionMessageEntry; event: TaskEvent }> {
    const run = this.options.repository.updateRunStatus({
      endedAt: new Date().toISOString(),
      runId: input.runId,
      status: 'completed'
    });
    this.activeRuns.delete(input.runId);
    const message = this.options.repository.recordSessionMessage({
      content: input.assistantMessage,
      role: 'assistant',
      threadId: run.threadId
    });
    const event = this.options.repository.recordEvent({
      payload: {
        role: 'assistant',
        content: input.assistantMessage,
        providerId: input.providerId,
        modelId: input.modelId
      },
      runId: run.id,
      threadId: run.threadId,
      type: 'message'
    });
    await this.publish('agent.run.completed', {
      runId: run.id,
      threadId: run.threadId,
      providerId: input.providerId,
      modelId: input.modelId,
      durationMs: input.durationMs,
      summary: input.summary,
      assistantMessage: input.assistantMessage,
      finishReason: 'stop'
    });
    await this.publishChatRunEvent({
      type: 'run_completed',
      runId: run.id,
      threadId: run.threadId,
      providerId: input.providerId,
      modelId: input.modelId,
      createdAt: run.startedAt,
      durationMs: input.durationMs,
      summary: input.summary,
      assistantMessage: input.assistantMessage
    });
    return { run, message, event };
  }

  private async publish<TPayload>(type: string, payload: TPayload): Promise<void> {
    await this.options.eventBus.publish({
      type,
      source: this.pluginId,
      payload,
      createdAt: new Date().toISOString()
    });
  }

  private async publishChatRunEvent(payload: ChatRunEvent): Promise<void> {
    await this.publish(agentChatRunEventType, payload);
  }

  private shouldUseRuntimeDelegate(request: ChatStartRunRequest): boolean {
    return this.options.runtimeDelegate !== undefined && request.workflowHint !== 'propose_background_task';
  }

  private async startDelegatedRun(request: ChatStartRunRequest, input: string): Promise<ChatStartRunResult> {
    if (this.options.runtimeDelegate === undefined) {
      throw new Error('agent_runtime_delegate_missing');
    }
    const capabilityPreview =
      this.options.capabilityPreviewProvider === undefined ? undefined : await this.getCapabilityPreview(request.enabledCapabilities);
    const result = await this.options.runtimeDelegate.startRun(request);
    if (typeof result.threadId !== 'string') {
      throw new Error('agent_runtime_delegate_thread_missing');
    }
    this.delegatedRuns.set(result.runId, {
      mode: request.mode,
      threadId: result.threadId,
      providerId: result.providerId,
      modelId: result.modelId
    });
    await this.publish('agent.run.started', {
      ...result,
      enabledCapabilities: request.enabledCapabilities,
      userInput: input,
      workflowHint: request.workflowHint === undefined ? null : request.workflowHint,
      capabilityPreview
    });
    await this.publishChatRunEvent({
      type: 'run_started',
      ...result
    });
    return result;
  }

  private async handleDelegatedRunEvent(event: ChatRunEvent): Promise<void> {
    if (event.type === 'run_started') {
      if (typeof event.threadId === 'string') {
        this.delegatedRuns.set(event.runId, {
          mode: event.mode,
          threadId: event.threadId,
          providerId: event.providerId,
          modelId: event.modelId
        });
      }
      return;
    }
    if (event.type === 'run_resumed') {
      return;
    }

    const delegatedRun = this.delegatedRuns.get(event.runId);
    if (event.type === 'run_completed') {
      if (typeof event.threadId === 'string') {
        this.options.repository.recordSessionMessage({
          content: event.assistantMessage,
          role: 'assistant',
          threadId: event.threadId
        });
      }
      await this.publish('agent.run.completed', {
        runId: event.runId,
        threadId: event.threadId,
        providerId: event.providerId,
        modelId: event.modelId,
        durationMs: event.durationMs,
        summary: event.summary,
        assistantMessage: event.assistantMessage,
        finishReason: 'stop'
      });
      this.delegatedRuns.delete(event.runId);
    } else if (event.type === 'run_failed') {
      await this.publish('agent.run.failed', {
        runId: event.runId,
        threadId: event.threadId,
        providerId: delegatedRun?.providerId ?? 'unknown',
        modelId: delegatedRun?.modelId ?? 'unknown',
        error: event.message,
        code: event.code,
        retryable: event.retryable
      });
      this.delegatedRuns.delete(event.runId);
    } else if (delegatedRun?.mode === 'chat') {
      const taskEvent = this.toDelegatedChatTaskEvent(event, delegatedRun);
      if (taskEvent !== null) {
        await this.publish('agent.run.task-event', taskEvent);
      }
    }

    await this.publishChatRunEvent(event);
  }

  private toDelegatedChatTaskEvent(
    event: ChatRunEvent,
    delegatedRun: DelegatedRunMetadata
  ): { runId: string; threadId: string; type: TaskEvent['type']; payload: Record<string, unknown> } | null {
    if (event.type === 'message_delta') {
      return {
        runId: event.runId,
        threadId: delegatedRun.threadId,
        type: 'message_delta',
        payload: {
          role: 'assistant',
          delta: event.delta
        }
      };
    }
    if (event.type === 'reasoning_delta') {
      return {
        runId: event.runId,
        threadId: delegatedRun.threadId,
        type: 'reasoning_delta',
        payload: {
          delta: event.delta
        }
      };
    }
    if (event.type === 'tool_event') {
      return {
        runId: event.runId,
        threadId: delegatedRun.threadId,
        type: 'tool_call',
        payload: {
          name: event.name,
          status: event.event,
          ...(event.event === 'end'
            ? { output: event.data }
            : event.event === 'error'
              ? { error: event.data }
              : { input: event.data })
        }
      };
    }
    if (event.type === 'subagent_event' && (event.status === 'started' || event.status === 'completed')) {
      return {
        runId: event.runId,
        threadId: delegatedRun.threadId,
        type: event.status === 'started' ? 'subagent_started' : 'subagent_completed',
        payload: {
          name: event.subagent,
          summary: event.summary
        }
      };
    }
    if (event.type === 'run_interrupted') {
      return {
        runId: event.runId,
        threadId: delegatedRun.threadId,
        type: 'approval_requested',
        payload: {
          interruptId: event.interruptId,
          ...event.payload
        }
      };
    }
    return null;
  }

  private async executeRun(input: {
    runId: string;
    providerId: string;
    modelId: string;
    mode: ChatStartRunRequest['mode'];
    input: string;
    threadId: string;
    workflowHint: ChatStartRunRequest['workflowHint'] | null;
    enabledCapabilities: EnabledCapabilities;
    invoke: (input: string) => Promise<string>;
    stream?: (input: string) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  }): Promise<void> {
    if (!this.activeRuns.has(input.runId)) {
      return;
    }
    try {
      const startedAtMs = Date.now();
      if (input.stream === undefined) {
        throw new Error('agent_model_stream_unavailable');
      }
      const assistantMessage = await this.streamAssistantMessage({
        runId: input.runId,
        threadId: input.threadId,
        input: input.input,
        stream: input.stream
      });
      if (!this.activeRuns.has(input.runId)) {
        return;
      }
      await this.completeRun({
        runId: input.runId,
        assistantMessage,
        summary: assistantMessage.slice(0, 120),
        durationMs: Date.now() - startedAtMs,
        providerId: input.providerId,
        modelId: input.modelId
      });
    } catch (error) {
      if (!this.activeRuns.has(input.runId)) {
        return;
      }
      this.activeRuns.delete(input.runId);
      const failure = error instanceof Error ? error.message : String(error);
      this.options.repository.updateRunStatus({
        endedAt: new Date().toISOString(),
        runId: input.runId,
        status: 'failed'
      });
      await this.publish('agent.run.failed', {
        runId: input.runId,
        threadId: input.threadId,
        providerId: input.providerId,
        modelId: input.modelId,
        error: failure,
        code: 'agent_run_failed',
        retryable: true
      });
      await this.publishChatRunEvent({
        type: 'run_failed',
        runId: input.runId,
        threadId: input.threadId,
        code: 'agent_run_failed',
        message: failure,
        retryable: true
      });
    }
  }

  private async streamAssistantMessage(input: {
    runId: string;
    threadId: string;
    input: string;
    stream: (input: string) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  }): Promise<string> {
    const run = this.options.repository.getRun(input.runId);
    const assistantChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const usageAccumulator = createUsageAccumulator();
    let runtimeEventQueue = Promise.resolve();
    let taskEventQueue = Promise.resolve();

    const queueRuntimeEvent = (event: ChatRunEvent): void => {
      runtimeEventQueue = runtimeEventQueue.then(async () => {
        await this.publishChatRunEvent(event);
      });
    };
    const queueTaskEvent = (
      type: 'message_delta' | 'reasoning_delta' | 'tool_call' | 'subagent_started' | 'subagent_completed' | 'guardrail_nudge',
      payload: Record<string, unknown>
    ): void => {
      taskEventQueue = taskEventQueue.then(async () => {
        await this.publish('agent.run.task-event', {
          runId: input.runId,
          threadId: input.threadId,
          type,
          payload
        });
      });
    };

    await consumeMessageStream({
      messages: await input.stream(input.input),
      context: {
        runId: input.runId,
        taskRun: run
      },
      assistantChunks,
      reasoningChunks,
      usageAccumulator,
      callbacks: {
        emitRuntimeEvent: queueRuntimeEvent,
        emitTodoEvent: () => {},
        recordTaskEvent: queueTaskEvent
      }
    });
    await runtimeEventQueue;
    await taskEventQueue;

    const assistantMessage = assistantChunks.join('').trim();
    if (assistantMessage.length === 0) {
      throw new Error('agent_model_response_empty');
    }
    return assistantMessage;
  }
}

export function createBlockedAgentRuntimeStatus(): AgentRuntimeStatus {
  return {
    deepAgentsPackage: 'available',
    deepAgentsApi: {
      createDeepAgent: typeof createDeepAgent === 'function'
    },
    defaultModelConfigured: false,
    defaultModelState: {
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: 'No default model configured for the agent plugin runtime.'
    },
    memoryAccess: 'store_backend',
    execution: 'blocked_until_provider_configured'
  };
}
