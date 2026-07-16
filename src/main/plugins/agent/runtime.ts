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
  WorkflowHint,
  Workspace,
  RunExecutionSnapshotV1
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
import { compileRunCapabilityManifest } from './run-capability-manifest';
import { createChatStartRunRequestFromSnapshot, readWorkflowHintFromSnapshot } from './run-execution-snapshot';
import type { RunExecutionSnapshotSeed } from './run-execution-snapshot';
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
  explicitSkillIds?: ChatStartRunRequest['explicitSkillIds'];
  mode: ChatStartRunRequest['mode'];
  requestedCapabilities: EnabledCapabilities;
  runtimeStatus: AgentRuntimeStatus;
}) => Promise<AgentCapabilityPreview>;

type AgentResumePayload = HITLResponse | { answer: string };

export type AgentDeepAgentExecutor = {
  execute(input: {
    snapshot: RunExecutionSnapshotV1;
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
  snapshot: RunExecutionSnapshotV1;
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
  workspaceProvider?: () => Promise<Workspace | null>;
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

  async getCapabilityPreview(input: {
    explicitSkillIds?: ChatStartRunRequest['explicitSkillIds'];
    mode: ChatStartRunRequest['mode'];
    requestedCapabilities: EnabledCapabilities;
  }): Promise<AgentCapabilityPreview> {
    if (this.options.capabilityPreviewProvider === undefined) {
      throw new Error('agent_capability_preview_unavailable');
    }
    return await this.options.capabilityPreviewProvider({
      explicitSkillIds: input.explicitSkillIds,
      mode: input.mode,
      requestedCapabilities: input.requestedCapabilities,
      runtimeStatus: this.getStatus()
    });
  }

  async startRun(request: ChatStartRunRequest): Promise<ChatStartRunResult> {
    const input = request.input.trim();
    if (input.length === 0) {
      throw new Error('chat_input_empty');
    }
    const modelHandle = await this.options.modelFactory.createDefaultModelHandle();
    const capabilityPreview = await this.getRunCapabilityPreview({
      explicitSkillIds: request.explicitSkillIds,
      mode: request.mode,
      requestedCapabilities: request.enabledCapabilities,
      modelHandle
    });
    const preparedAttachments = await prepareChatImageAttachments(request.attachments);
    const workspace = await this.resolveRunWorkspace(request);
    const explicitSkillIds = normalizeExplicitSkillIds(request.explicitSkillIds, capabilityPreview.manifest);
    const run = this.options.repository.createTaskRun({
      attachments: preparedAttachments.metadata.length === 0 ? undefined : preparedAttachments.metadata,
      capabilityPreview,
      snapshot: createRunExecutionSnapshotSeed({
        capabilityManifest: capabilityPreview.manifest,
        explicitSkillIds,
        modelHandle,
        request,
        workspace
      }),
      threadKind: resolveNewRunThreadKind(request),
      threadId: typeof request.threadId === 'string' ? request.threadId : undefined,
      userInput: input
    });
    const snapshot = this.options.repository.getRunExecutionSnapshot(run.id);
    this.activeRuns.add(run.id);
    const normalizedRequest = createChatStartRunRequestFromSnapshot(snapshot, run);
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
      enabledCapabilities: snapshot.capabilityManifest.resolvedCapabilities,
      userInput: input,
      workflowHint: snapshot.workflowHint,
      capabilityPreview
    });
    await this.publish(agentChatRunEventType, {
      type: 'run_started',
      ...result
    });
    const timer = setTimeout(() => {
      this.scheduledRuns.delete(timer);
      const pendingRun = this.executeRun({
        enabledCapabilities: snapshot.capabilityManifest.resolvedCapabilities,
        input,
        modelId: modelHandle.modelId,
        mode: request.mode,
        providerId: modelHandle.providerId,
        runId: run.id,
        request: normalizedRequest,
        abortSignal: abortController.signal,
        modelHandle,
        run,
        snapshot,
        threadId: run.threadId,
        validatedAttachments: preparedAttachments.images,
        workflowHint: readWorkflowHintFromSnapshot(snapshot.workflowHint)
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
    const snapshot = this.options.repository.getRunExecutionSnapshot(run.id);
    const modelHandle = await this.options.modelFactory.createModelHandleByProviderAndModel({
      providerId: snapshot.model.providerId,
      modelId: snapshot.model.modelId
    });
    if (modelHandle.providerId !== snapshot.model.providerId || modelHandle.modelId !== snapshot.model.modelId) {
      throw new Error('run_execution_snapshot_model_mismatch');
    }
    this.activeRuns.add(run.id);
    const resumedRequest = createChatStartRunRequestFromSnapshot(snapshot, run);
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
      await this.recordRunTaskEvent({
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
      await this.recordRunTaskEvent({
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
      enabledCapabilities: snapshot.capabilityManifest.resolvedCapabilities,
      input: run.userInput,
      mode: resumedRequest.mode,
      modelHandle,
      modelId: modelHandle.modelId,
      providerId: modelHandle.providerId,
      request: resumedRequest,
      resumePayload,
      run,
      runId: run.id,
      snapshot,
      threadId: run.threadId,
      workflowHint: readWorkflowHintFromSnapshot(snapshot.workflowHint)
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
    this.options.repository.recordEvent({
      payload: {
        providerId: input.providerId,
        modelId: input.modelId,
        finishReason: 'stop',
        durationMs: input.durationMs,
        summary: input.summary
      },
      runId: run.id,
      threadId: run.threadId,
      type: 'agent_update'
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

  private async recordRunTaskEvent(input: {
    runId: string;
    threadId: string;
    type: TaskEvent['type'];
    payload: unknown;
  }): Promise<void> {
    this.options.repository.recordEvent(input);
    await this.publish('agent.run.task-event', input);
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
          resumePayload: input.resumePayload,
          run: input.run,
          snapshot: input.snapshot,
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
    snapshot: RunExecutionSnapshotV1;
    resumePayload?: AgentResumePayload;
    run: TaskRun;
    modelHandle: AgentModelHandle;
    abortSignal: AbortSignal;
    validatedAttachments?: ChatValidatedImageAttachment[];
  }): Promise<DeepAgentExecutionResult> {
    const assistantChunks: string[] = [];
    const hookDisplayTexts: string[] = [];
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
      if (event.type === 'hook_started' || event.type === 'hook_completed') {
        collectHookDisplayText(hookDisplayTexts, event.hook.additionalContext);
        collectHookDisplayText(hookDisplayTexts, event.hook.requestContinue);
        await this.recordRunTaskEvent({
          runId: input.run.id,
          threadId: input.run.threadId,
          type: event.type,
          payload: event.hook
        });
        continue;
      }
      if (event.type === 'run_interrupted') {
        await this.handleRunInterrupted({
          interruptId: event.interruptId,
          payload: event.payload,
          runId: input.run.id,
          threadId: input.run.threadId
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
        await this.recordRunTaskEvent({
          runId: input.run.id,
          threadId: input.run.threadId,
          type: taskEvent.type,
          payload: taskEvent.payload
        });
        continue;
      }
      if (event.type === 'subagent_event') {
        await this.recordRunTaskEvent({
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
    const assistantMessage = stripHookDisplayText(assistantChunks.join('').trim(), hookDisplayTexts);
    if (assistantMessage.length === 0 && successfulToolBlockIds.size === 0 && hookDisplayTexts.length === 0) {
      throw new Error('agent_model_response_empty');
    }
    return {
      status: 'completed',
      assistantMessage,
      successfulToolNames: [...successfulToolNamesByBlockId.values()]
    };
  }

  private async resolveRunWorkspace(request: ChatStartRunRequest): Promise<Workspace | null> {
    const currentWorkspace = this.options.workspaceProvider === undefined ? null : await this.options.workspaceProvider();
    if (request.workspacePath === undefined || request.workspacePath === null) {
      return currentWorkspace;
    }
    if (request.taskSource !== 'workbench' && request.taskSource !== 'background_schedule') {
      throw new Error('agent_workspace_path_source_invalid');
    }
    const workspacePath = request.workspacePath.trim();
    if (workspacePath.length === 0) {
      throw new Error('agent_workspace_path_empty');
    }
    if (currentWorkspace !== null && currentWorkspace.path === workspacePath) {
      return currentWorkspace;
    }
    return {
      id: 'request-workspace',
      path: workspacePath,
      displayName: workspacePath,
      lastOpenedAt: new Date().toISOString(),
      trustState: 'trusted'
    };
  }

  private async getRunCapabilityPreview(input: {
    explicitSkillIds?: ChatStartRunRequest['explicitSkillIds'];
    mode: ChatStartRunRequest['mode'];
    requestedCapabilities: EnabledCapabilities;
    modelHandle: AgentModelHandle;
  }): Promise<AgentCapabilityPreview> {
    if (this.options.capabilityPreviewProvider !== undefined) {
      return await this.getCapabilityPreview({
        explicitSkillIds: input.explicitSkillIds,
        mode: input.mode,
        requestedCapabilities: input.requestedCapabilities
      });
    }
    if (input.requestedCapabilities.mcpServers.length > 0 || input.requestedCapabilities.skills.length > 0) {
      throw new Error('agent_capability_preview_unavailable');
    }
    if (input.explicitSkillIds !== undefined && input.explicitSkillIds.length > 0) {
      throw new Error('agent_capability_preview_unavailable');
    }
    const compiled = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      mode: input.mode,
      requestedCapabilities: input.requestedCapabilities,
      skills: []
    });
    return {
      runnable: false,
      modelId: input.modelHandle.modelId,
      builtInTools: [],
      selectedCapabilities: compiled.manifest.resolvedCapabilities,
      requestedCapabilities: compiled.manifest.requestedCapabilities,
      skippedCapabilities: compiled.manifest.skippedCapabilities,
      toolCards: compiled.toolCards,
      skillCards: compiled.skillCards,
      subagents: compiled.subagents,
      interruptOn: compiled.interruptOn,
      manifest: compiled.manifest,
      untrustedContextPolicy: compiled.manifest.untrustedContextPolicy,
      reason: '当前运行未配置能力预览提供者；仅装配内置工具。'
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
  }): Promise<void> {
    const pendingInterrupt: PendingInterrupt = {
      interruptId: input.interruptId,
      payload: input.payload
    };
    this.options.repository.markRunInterrupted({
      runId: input.runId,
      threadId: input.threadId,
      interrupt: pendingInterrupt
    });
    this.pendingInterrupts.set(input.runId, pendingInterrupt);
    if (input.payload.kind === 'approval') {
      await this.recordRunTaskEvent({
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

    await this.recordRunTaskEvent({
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

function createRunExecutionSnapshotSeed(input: {
  capabilityManifest: RunExecutionSnapshotV1['capabilityManifest'];
  explicitSkillIds: string[];
  modelHandle: AgentModelHandle;
  request: ChatStartRunRequest;
  workspace: Workspace | null;
}): RunExecutionSnapshotSeed {
  return {
    schemaVersion: 1,
    runOrigin: resolveRunOrigin(input.request),
    model: {
      providerId: input.modelHandle.providerId,
      modelId: input.modelHandle.modelId
    },
    mode: input.request.mode === 'chat' ? 'run' : input.request.mode,
    workspace: input.workspace === null ? null : resolveRuntimeWorkspaceIdentity(input.workspace.path),
    capabilityManifest: input.capabilityManifest,
    budget: {
      contextBudgetTokens:
        input.modelHandle.langChainHandle === undefined
          ? null
          : input.modelHandle.langChainHandle.runtime.contextBudgetTokens
    },
    workflowHint: input.request.workflowHint === undefined ? null : input.request.workflowHint,
    explicitSkillIds: input.explicitSkillIds,
    dispatchKey: null
  };
}

function resolveRunOrigin(request: ChatStartRunRequest): RunExecutionSnapshotV1['runOrigin'] {
  if (request.taskSource === 'background_schedule') {
    return 'background_schedule';
  }
  if (request.workflowHint === 'propose_background_task' || request.workflowHint === 'background_task_change') {
    if (request.taskSource !== 'workbench') {
      throw new Error('agent_workflow_hint_source_invalid');
    }
    return 'workbench_creation';
  }
  if (request.mode === 'task') {
    return 'manual_task_run';
  }
  return 'chat';
}

function normalizeExplicitSkillIds(
  explicitSkillIds: ChatStartRunRequest['explicitSkillIds'],
  capabilityManifest: RunExecutionSnapshotV1['capabilityManifest']
): string[] {
  if (explicitSkillIds === undefined) {
    return [];
  }
  const manifestSkills = new Set(capabilityManifest.skills.map((skill) => skill.canonicalIdentity));
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const skillId of explicitSkillIds) {
    const value = skillId.trim();
    if (value.length === 0) {
      throw new Error('run_explicit_skill_id_empty');
    }
    if (!manifestSkills.has(`skill:${value}`)) {
      throw new Error(`run_explicit_skill_not_authorized:${value}`);
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
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

function collectHookDisplayText(texts: string[], value: string | null): void {
  if (value !== null && value.length > 0 && !texts.includes(value)) {
    texts.push(value);
  }
}

function stripHookDisplayText(content: string, hookDisplayTexts: readonly string[]): string {
  let nextContent = content;
  for (const text of [...hookDisplayTexts].sort((left, right) => right.length - left.length)) {
    nextContent = nextContent.split(text).join('');
  }
  return nextContent === content ? content : nextContent.trimStart();
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
