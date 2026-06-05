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
  capabilityPreviewProvider?: AgentCapabilityPreviewProvider;
  pluginId?: string;
  status?: AgentRuntimeStatus;
  statusProvider?: () => AgentRuntimeStatus;
};

export class AgentPluginRuntime {
  private readonly activeRuns = new Set<string>();
  private readonly pendingRuns = new Set<Promise<void>>();
  private readonly scheduledRuns = new Set<NodeJS.Timeout>();
  private readonly pluginId: string;

  constructor(private readonly options: AgentPluginRuntimeOptions) {
    this.pluginId = options.pluginId === undefined ? '@roc/plugin-agent' : options.pluginId;
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
        invoke: modelHandle.invoke
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
    for (const timer of this.scheduledRuns) {
      clearTimeout(timer);
    }
    this.scheduledRuns.clear();
    if (this.pendingRuns.size > 0) {
      await Promise.allSettled([...this.pendingRuns]);
    }
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
  }): Promise<void> {
    if (!this.activeRuns.has(input.runId)) {
      return;
    }
    try {
      const startedAtMs = Date.now();
      const assistantMessage = await input.invoke(input.input);
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
