import type { HITLResponse } from 'langchain';

import type {
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  ChatAssistantBlock,
  ChatCancelRunResult,
  ChatInterruptPayload,
  ChatRunEventsReplayRequest,
  ChatRunEventsReplayResult,
  ChatRunEvent,
  ChatResumeRunRequest,
  ChatResumeRunResult,
  ChatStartRunRequest,
  ChatStartRunResult,
  ChatValidatedImageAttachment,
  EnabledCapabilities,
  SessionMessageEntry,
  SessionMessageSearchRequest,
  SessionMessageSearchResult,
  TaskEvent,
  TaskRun,
  WorkflowHint
} from '../../../shared/types';
import type { ActiveChatRun } from '../../../shared/types';
import type { RocEventBus } from '../../kernel/types';
import { buildRunSummary } from '../../services/deep-agent/context/run-summary';
import { resolveRuntimeWorkspaceIdentity } from '../../services/deep-agent/context/workspace-scope';
import { toRunFailure } from '../../services/deep-agent/error-mapping';
import type { RunFailure } from '../../services/deep-agent/types';
import { prepareChatImageAttachments } from './chat-image-attachments';
import type { AgentModelFactoryAdapter, AgentModelHandle } from './model-factory-adapter';
import type { AgentRunEventLog } from './run-event-log';
import type { AgentSessionRepository } from './session-repository';
import { toRecoveryDecision } from './recovery-policy';
import type { AgentLifecycleHookEmitter, DeepAgentExecutionResult, PendingInterrupt } from './runtime-types';
import {
  createBlockedAgentRuntimeStatus,
  createTaskEventFromAssistantBlock,
  resolveNewRunThreadKind,
  updateSuccessfulToolBlocks
} from './runtime-helpers';

export const agentChatRunEventType = 'agent.chat.run-event';

export type AgentCapabilityPreviewProvider = (input: {
  requestedCapabilities: EnabledCapabilities;
  runtimeStatus: AgentRuntimeStatus;
}) => Promise<AgentCapabilityPreview>;

type AgentResumePayload = HITLResponse | { answer: string };

export type AgentDeepAgentExecutor = {
  execute(input: {
    request: ChatStartRunRequest;
    resumePayload?: AgentResumePayload;
    run: TaskRun;
    modelHandle: AgentModelHandle;
    abortSignal: AbortSignal;
    validatedAttachments?: ChatValidatedImageAttachment[];
  }): AsyncIterable<ChatRunEvent> | Promise<AsyncIterable<ChatRunEvent>>;
};

type ExecuteRunInput = {
  runId: string;
  providerId: string;
  modelId: string;
  mode: ChatStartRunRequest['mode'];
  input: string;
  request: ChatStartRunRequest;
  resumePayload?: AgentResumePayload;
  run: TaskRun;
  modelHandle: AgentModelHandle;
  abortSignal: AbortSignal;
  threadId: string;
  validatedAttachments?: ChatValidatedImageAttachment[];
  workflowHint: ChatStartRunRequest['workflowHint'] | null;
  enabledCapabilities: EnabledCapabilities;
};

export type AgentPluginRuntimeOptions = {
  repository: AgentSessionRepository;
  eventBus: RocEventBus;
  modelFactory: AgentModelFactoryAdapter;
  deepAgentExecutor?: AgentDeepAgentExecutor;
  lifecycleHooks?: AgentLifecycleHookEmitter;
  capabilityPreviewProvider?: AgentCapabilityPreviewProvider;
  pluginId?: string;
  runEventLog?: AgentRunEventLog;
  status?: AgentRuntimeStatus;
  statusProvider?: () => AgentRuntimeStatus;
};

export class AgentPluginRuntime {
  private readonly activeRuns = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeRunMetadata = new Map<
    string,
    {
      request: ChatStartRunRequest;
      threadId: string | null;
    }
  >();
  private readonly pendingInterrupts = new Map<string, PendingInterrupt>();
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
    const preparedAttachments = await prepareChatImageAttachments(request.attachments);
    const run = this.options.repository.createTaskRun({
      attachments: preparedAttachments.metadata.length === 0 ? undefined : preparedAttachments.metadata,
      enabledCapabilities: request.enabledCapabilities,
      modelId: modelHandle.modelId,
      threadKind: resolveNewRunThreadKind(request),
      threadId: typeof request.threadId === 'string' ? request.threadId : undefined,
      userInput: input
    });
    this.activeRuns.add(run.id);
    const normalizedRequest = {
      ...request,
      input
    };
    this.activeRunMetadata.set(run.id, {
      request: normalizedRequest,
      threadId: run.threadId
    });
    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
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
        request: normalizedRequest,
        abortSignal: abortController.signal,
        modelHandle,
        run,
        threadId: run.threadId,
        validatedAttachments: preparedAttachments.images,
        workflowHint: request.workflowHint === undefined ? null : request.workflowHint
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
    const metadata = this.activeRunMetadata.get(input.runId);
    this.activeRunMetadata.delete(input.runId);
    const abortController = this.abortControllers.get(input.runId);
    abortController?.abort();
    this.abortControllers.delete(input.runId);
    this.pendingInterrupts.delete(input.runId);
    this.options.repository.clearPendingInterrupt(input.runId);
    this.options.repository.updateRunStatus({
      endedAt: new Date().toISOString(),
      runId: input.runId,
      status: 'cancelled'
    });
    if (metadata !== undefined) {
      void this.emitSessionEndBestEffort({
        runId: input.runId,
        threadId: metadata.threadId,
        request: metadata.request,
        status: 'cancelled',
        error: null
      });
    }
    return {
      runId: input.runId,
      cancelled: true
    };
  }

  async resumeRun(request: ChatResumeRunRequest): Promise<ChatResumeRunResult> {
    const pendingInterrupt = this.resolvePendingInterrupt(request.runId);
    if (pendingInterrupt === undefined) {
      throw new Error('chat_resume_no_pending_interrupt');
    }
    if (request.interruptId !== pendingInterrupt.interruptId) {
      throw new Error('chat_resume_interrupt_mismatch');
    }
    if (request.kind !== pendingInterrupt.payload.kind) {
      throw new Error('chat_resume_interrupt_kind_mismatch');
    }
    const run = this.options.repository.getRun(request.runId);
    if (run.threadId !== request.threadId) {
      throw new Error('chat_resume_thread_mismatch');
    }
    if (run.status !== 'waiting_user') {
      this.pendingInterrupts.delete(request.runId);
      this.options.repository.clearPendingInterrupt(request.runId);
      throw new Error('chat_resume_run_not_waiting_user');
    }
    if (run.modelId === null) {
      throw new Error('chat_resume_run_missing');
    }
    const modelHandle = await this.options.modelFactory.createModelHandleByModelId(run.modelId);
    this.activeRuns.add(run.id);
    const resumedRequest: ChatStartRunRequest = {
      input: run.userInput,
      mode: pendingInterrupt.mode,
      threadId: run.threadId,
      enabledCapabilities: run.enabledCapabilities,
      taskSource: pendingInterrupt.taskSource,
      workspacePath: pendingInterrupt.workspacePath,
      workflowHint: pendingInterrupt.workflowHint
    };
    if (pendingInterrupt.explicitSkillIds !== undefined) {
      resumedRequest.explicitSkillIds = pendingInterrupt.explicitSkillIds;
    }
    this.activeRunMetadata.set(run.id, {
      request: resumedRequest,
      threadId: run.threadId
    });
    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
    const resumedAt = new Date().toISOString();
    const result: ChatResumeRunResult = {
      runId: run.id,
      threadId: run.threadId,
      resumedAt
    };
    this.options.repository.updateRunStatus({
      runId: run.id,
      status: 'running'
    });
    this.pendingInterrupts.delete(run.id);
    this.options.repository.clearPendingInterrupt(run.id);
    await this.publish('agent.run.resumed', result);
    await this.publishChatRunEvent({
      type: 'run_resumed',
      runId: run.id,
      threadId: run.threadId,
      interruptId: pendingInterrupt.interruptId
    });
    if (request.kind === 'approval') {
      await this.publish('agent.run.task-event', {
        runId: run.id,
        threadId: run.threadId,
        type: 'approval_decision',
        payload: {
          interruptId: request.interruptId,
          decisions: request.decisions
        }
      });
    }
    if (request.kind === 'question') {
      this.options.repository.recordEvent({
        runId: run.id,
        threadId: run.threadId,
        type: 'message',
        payload: {
          role: 'user',
          content: request.answer
        }
      });
      this.options.repository.recordSessionMessage({
        threadId: run.threadId,
        role: 'user',
        content: request.answer
      });
      await this.publish('agent.run.task-event', {
        runId: run.id,
        threadId: run.threadId,
        type: 'human_question_answered',
        payload: {
          interruptId: request.interruptId,
          answer: request.answer
        }
      });
    }
    const resumePayload: AgentResumePayload =
      request.kind === 'approval'
        ? { decisions: request.decisions }
        : { answer: request.answer };
    const pendingRun = this.executeRun({
      abortSignal: abortController.signal,
      enabledCapabilities: run.enabledCapabilities,
      input: run.userInput,
      mode: pendingInterrupt.mode,
      modelHandle,
      modelId: modelHandle.modelId,
      providerId: modelHandle.providerId,
      request: resumedRequest,
      resumePayload,
      run,
      runId: run.id,
      threadId: run.threadId,
      workflowHint: pendingInterrupt.workflowHint
    });
    this.pendingRuns.add(pendingRun);
    pendingRun.finally(() => {
      this.pendingRuns.delete(pendingRun);
    });
    return result;
  }

  listSessionMessages(input: { threadId: string; limit?: number }): SessionMessageEntry[] {
    return this.options.repository.listSessionMessages(input);
  }

  searchSessionMessages(input: SessionMessageSearchRequest): SessionMessageSearchResult {
    return this.options.repository.searchSessionMessages(input);
  }

  listRunEvents(request: ChatRunEventsReplayRequest): ChatRunEventsReplayResult {
    if (this.options.runEventLog === undefined) {
      throw new Error('agent_run_event_log_unavailable');
    }
    return {
      runId: request.runId,
      events: this.options.runEventLog.listRunEvents(request)
    };
  }

  getActiveRun(input: { threadId: string }): ActiveChatRun | null {
    for (const runId of this.activeRuns) {
      const metadata = this.activeRunMetadata.get(runId);
      if (metadata === undefined) {
        continue;
      }
      if (metadata.threadId !== input.threadId) {
        continue;
      }
      return {
        runId,
        threadId: input.threadId,
        status: this.pendingInterrupts.has(runId) ? 'waiting_user' : 'running'
      };
    }
    return null;
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
    workspacePath: ChatStartRunRequest['workspacePath'];
  }): Promise<{ run: TaskRun; message: SessionMessageEntry; event: TaskEvent }> {
    const run = this.options.repository.updateRunStatus({
      endedAt: new Date().toISOString(),
      runId: input.runId,
      status: 'completed'
    });
    this.activeRuns.delete(input.runId);
    this.activeRunMetadata.delete(input.runId);
    this.abortControllers.delete(input.runId);
    this.pendingInterrupts.delete(input.runId);
    this.options.repository.clearPendingInterrupt(input.runId);
    const workspaceIdentity = resolveRuntimeWorkspaceIdentity(input.workspacePath === undefined ? null : input.workspacePath);
    const message = this.options.repository.recordSessionMessage({
      content: input.assistantMessage,
      role: 'assistant',
      threadId: run.threadId,
      workspaceHash: workspaceIdentity === null ? null : workspaceIdentity.hash
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
    const completedPayload: {
      runId: string;
      threadId: string;
      providerId: string;
      modelId: string;
      durationMs: number;
      summary: string;
      assistantMessage: string;
      finishReason: 'stop';
      workspacePath?: string | null;
    } = {
      runId: run.id,
      threadId: run.threadId,
      providerId: input.providerId,
      modelId: input.modelId,
      durationMs: input.durationMs,
      summary: input.summary,
      assistantMessage: input.assistantMessage,
      finishReason: 'stop'
    };
    if (input.workspacePath !== undefined) {
      completedPayload.workspacePath = input.workspacePath;
    }
    await this.publish('agent.run.completed', completedPayload);
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

  private async emitSessionEndBestEffort(input: Parameters<AgentLifecycleHookEmitter['emitSessionEnd']>[0]): Promise<void> {
    if (this.options.lifecycleHooks === undefined) {
      return;
    }
    try {
      await this.options.lifecycleHooks.emitSessionEnd(input);
    } catch (error) {
      console.warn(
        '[AgentPluginRuntime] SessionEnd hook failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
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
    this.options.runEventLog?.recordRunEvent(payload);
    await this.publish(agentChatRunEventType, payload);
  }

  private async executeRun(input: ExecuteRunInput): Promise<void> {
    if (!this.activeRuns.has(input.runId)) {
      return;
    }
    const startedAtMs = Date.now();
    let attempt = 0;
    let firstFailureAtMs: number | null = null;
    while (this.activeRuns.has(input.runId)) {
      try {
        if (this.options.deepAgentExecutor === undefined) {
          throw new Error('agent_deep_agent_executor_missing');
        }
        const execution = await this.executeDeepAgentRun({
          abortSignal: input.abortSignal,
          modelHandle: input.modelHandle,
          request: input.request,
          resumePayload: input.resumePayload,
          run: input.run,
          validatedAttachments: input.validatedAttachments
        });
        if (execution.status === 'interrupted') {
          return;
        }
        if (!this.activeRuns.has(input.runId)) {
          return;
        }
        if (attempt > 0) {
          const recoveredAt = new Date().toISOString();
          await this.publish('agent.run.recovery.succeeded', {
            runId: input.runId,
            threadId: input.threadId,
            providerId: input.providerId,
            modelId: input.modelId,
            attempt,
            recoveredAt
          });
          await this.publishChatRunEvent({
            type: 'run_recovered',
            runId: input.runId,
            threadId: input.threadId,
            attempt,
            recoveredAt
          });
        }
        await this.completeRun({
          runId: input.runId,
          assistantMessage: execution.assistantMessage,
          summary: buildCompletionSummary({
            assistantMessage: execution.assistantMessage,
            successfulToolNames: execution.successfulToolNames,
            workflowHint: input.request.workflowHint === undefined ? null : input.request.workflowHint
          }),
          durationMs: Date.now() - startedAtMs,
          providerId: input.providerId,
          modelId: input.modelId,
          workspacePath: input.request.workspacePath
        });
        await this.emitSessionEndBestEffort({
          runId: input.runId,
          threadId: input.threadId,
          request: input.request,
          status: 'completed',
          error: null
        });
        return;
      } catch (error) {
        if (!this.activeRuns.has(input.runId)) {
          return;
        }
        const failure = toRunFailure(error);
        attempt += 1;
        const nowMs = Date.now();
        if (firstFailureAtMs === null) {
          firstFailureAtMs = nowMs;
        }
        const decision = toRecoveryDecision({
          failure,
          attempt,
          firstFailureAtMs,
          nowMs
        });
        if (decision.action === 'recover') {
          const nextRetryAt = new Date(nowMs + decision.delayMs).toISOString();
          this.options.repository.updateRunStatus({
            runId: input.runId,
            status: 'running'
          });
          await this.publish('agent.run.recovery.started', {
            runId: input.runId,
            threadId: input.threadId,
            providerId: input.providerId,
            modelId: input.modelId,
            errorCode: failure.code,
            attempt
          });
          await this.publishChatRunEvent({
            type: 'run_recovering',
            runId: input.runId,
            threadId: input.threadId,
            code: failure.code,
            message: failure.message,
            attempt,
            nextRetryAt
          });
          try {
            await waitForRecoveryDelay(decision.delayMs, input.abortSignal);
          } catch (delayError) {
            if (!this.activeRuns.has(input.runId)) {
              return;
            }
            throw delayError;
          }
          continue;
        }
        await this.failRun({ input, failure });
        return;
      }
    }
  }

  private async failRun(input: { input: ExecuteRunInput; failure: RunFailure }): Promise<void> {
    this.activeRuns.delete(input.input.runId);
    this.activeRunMetadata.delete(input.input.runId);
    this.abortControllers.delete(input.input.runId);
    this.pendingInterrupts.delete(input.input.runId);
    this.options.repository.clearPendingInterrupt(input.input.runId);
    this.options.repository.updateRunStatus({
      endedAt: new Date().toISOString(),
      runId: input.input.runId,
      status: 'failed'
    });
    await this.emitSessionEndBestEffort({
      runId: input.input.runId,
      threadId: input.input.threadId,
      request: input.input.request,
      status: 'failed',
      error: input.failure.message
    });
    await this.publish('agent.run.failed', {
      runId: input.input.runId,
      threadId: input.input.threadId,
      providerId: input.input.providerId,
      modelId: input.input.modelId,
      error: input.failure.message,
      code: input.failure.code,
      retryable: input.failure.retryable
    });
    await this.publishChatRunEvent({
      type: 'run_failed',
      runId: input.input.runId,
      threadId: input.input.threadId,
      code: input.failure.code,
      diagnostic: input.failure.diagnostic,
      message: input.failure.message,
      retryable: input.failure.retryable,
      suggestion: input.failure.suggestion
    });
  }

  private async executeDeepAgentRun(input: {
    request: ChatStartRunRequest;
    resumePayload?: AgentResumePayload;
    run: TaskRun;
    modelHandle: AgentModelHandle;
    abortSignal: AbortSignal;
    validatedAttachments?: ChatValidatedImageAttachment[];
  }): Promise<DeepAgentExecutionResult> {
    const assistantChunks: string[] = [];
    const successfulToolBlockIds = new Set<string>();
    const successfulToolNamesByBlockId = new Map<string, string>();
    for await (const event of await this.options.deepAgentExecutor!.execute(input)) {
      if (!this.activeRuns.has(input.run.id)) {
        return {
          status: 'completed',
          assistantMessage: '',
          successfulToolNames: []
        };
      }
      await this.publishChatRunEvent(event);
      if (event.type === 'run_interrupted') {
        await this.handleRunInterrupted({
          interruptId: event.interruptId,
          payload: event.payload,
          mode: input.request.mode,
          runId: input.run.id,
          threadId: input.run.threadId,
          taskSource: input.request.taskSource === undefined ? null : input.request.taskSource,
          workflowHint: input.request.workflowHint === undefined ? null : input.request.workflowHint,
          workspacePath: input.request.workspacePath,
          explicitSkillIds: input.request.explicitSkillIds
        });
        return {
          status: 'interrupted'
        };
      }
      if (event.type === 'assistant_block') {
        if (event.block.kind === 'text' && typeof event.block.text === 'string') {
          assistantChunks.push(event.block.text);
        }
        updateSuccessfulToolBlocks(successfulToolBlockIds, event.block);
        updateSuccessfulToolNames(successfulToolNamesByBlockId, event.block);
        const taskEvent = createTaskEventFromAssistantBlock(event.block);
        await this.publish('agent.run.task-event', {
          runId: input.run.id,
          threadId: input.run.threadId,
          type: taskEvent.type,
          payload: taskEvent.payload
        });
        continue;
      }
      if (event.type === 'subagent_event') {
        await this.publish('agent.run.task-event', {
          runId: input.run.id,
          threadId: input.run.threadId,
          type: 'subagent_event',
          payload: {
            sequence: event.sequence,
            identity: event.identity,
            event: event.event
          }
        });
      }
    }
    const assistantMessage = assistantChunks.join('').trim();
    if (assistantMessage.length === 0 && successfulToolBlockIds.size === 0) {
      throw new Error('agent_model_response_empty');
    }
    return {
      status: 'completed',
      assistantMessage,
      successfulToolNames: [...successfulToolNamesByBlockId.values()]
    };
  }

  private resolvePendingInterrupt(runId: string): PendingInterrupt | undefined {
    const pendingInterrupt = this.pendingInterrupts.get(runId);
    if (pendingInterrupt !== undefined) {
      return pendingInterrupt;
    }
    const persistedInterrupt = this.options.repository.getPendingInterrupt(runId);
    if (persistedInterrupt === null) {
      return undefined;
    }
    this.pendingInterrupts.set(runId, persistedInterrupt.interrupt);
    return persistedInterrupt.interrupt;
  }

  private async handleRunInterrupted(input: {
    runId: string;
    threadId: string;
    interruptId: string;
    payload: ChatInterruptPayload;
    mode: ChatStartRunRequest['mode'];
    taskSource: ChatStartRunRequest['taskSource'] | null;
    workflowHint: ChatStartRunRequest['workflowHint'] | null;
    workspacePath: ChatStartRunRequest['workspacePath'];
    explicitSkillIds: ChatStartRunRequest['explicitSkillIds'];
  }): Promise<void> {
    const pendingInterrupt: PendingInterrupt = {
      interruptId: input.interruptId,
      payload: input.payload,
      mode: input.mode,
      taskSource: input.taskSource,
      workflowHint: input.workflowHint,
      workspacePath: input.workspacePath,
      explicitSkillIds: input.explicitSkillIds
    };
    this.options.repository.markRunInterrupted({
      runId: input.runId,
      threadId: input.threadId,
      interrupt: pendingInterrupt
    });
    this.pendingInterrupts.set(input.runId, pendingInterrupt);
    if (input.payload.kind === 'approval') {
      await this.publish('agent.run.task-event', {
        runId: input.runId,
        threadId: input.threadId,
        type: 'approval_requested',
        payload: {
          interruptId: input.interruptId,
          ...input.payload.request
        }
      });
      return;
    }

    await this.publish('agent.run.task-event', {
      runId: input.runId,
      threadId: input.threadId,
      type: 'human_question_requested',
      payload: {
        interruptId: input.interruptId,
        question: input.payload.question,
        context: input.payload.context ?? null,
        suggestedResponses: input.payload.suggestedResponses ?? []
      }
    });
  }
}

function buildCompletionSummary(input: {
  assistantMessage: string;
  successfulToolNames: readonly string[];
  workflowHint: WorkflowHint;
}): string {
  const summary = buildRunSummary(input);
  if (summary === null) {
    return '';
  }
  return summary;
}

function updateSuccessfulToolNames(namesByBlockId: Map<string, string>, block: ChatAssistantBlock): void {
  if (block.kind !== 'tool_call') {
    return;
  }
  if (block.phase === 'end') {
    namesByBlockId.set(block.blockId, block.name);
    return;
  }
  if (block.phase === 'error') {
    namesByBlockId.delete(block.blockId);
  }
}

function waitForRecoveryDelay(delayMs: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    throw new Error('chat_run_cancelled');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    abortSignal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('chat_run_cancelled'));
      },
      { once: true }
    );
  });
}
