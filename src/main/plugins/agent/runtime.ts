import type { HITLResponse } from 'langchain';

import type {
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  ChatCancelRunResult,
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
  RunExecutionSnapshotV1,
  RunExecutionSnapshotV2
} from '../../../shared/types';
import type { ActiveChatRun } from '../../../shared/types';
import type { RocEventBus } from '../../kernel/types';
import { buildRunSummary } from '../../services/deep-agent/context/run-summary';
import { resolveRuntimeWorkspaceIdentity } from '../../services/deep-agent/context/workspace-scope';
import { toRunFailure } from '../../services/deep-agent/error-mapping';
import type { RunFailure } from '../../services/deep-agent/types';
import { prepareChatImageAttachments } from './chat-image-attachments';
import type { AgentModelFactoryAdapter, AgentModelHandle } from './model-factory-adapter';
import type { AgentDeepAgentExecution, RunOutcome } from './agent-execution';
import { createRunInterruptedEvents, type PendingInterrupt } from './interrupt-projection';
import type { AgentRunEventLog } from './run-event-log';
import { compileRunCapabilityManifest } from './run-capability-manifest';
import {
  createChatStartRunRequestFromSnapshot,
  createRunBudget,
  readWorkflowHintFromSnapshot,
  toRunExecutionMode
} from './run-execution-snapshot';
import type { RunExecutionSnapshotSeed } from './run-execution-snapshot';
import type { AgentSessionRepository, ResumeDispatchAudit } from './session-repository';
import {
  AgentRunTelemetryAccumulator,
  calculateAgentRunTelemetryDurationMs,
  type AgentModelUsageTelemetry,
  type AgentRunTelemetryV1
} from './run-telemetry';
import { toRecoveryDecision } from './recovery-policy';
import type {
  AgentLifecycleHookEmitter,
  AgentRunTracingLifecycle,
  DeepAgentExecutionResult
} from './runtime-types';
import {
  createBlockedAgentRuntimeStatus,
  createTaskEventFromAssistantBlock,
  resolveNewRunThreadKind
} from './runtime-helpers';
import { parseShellAllowedCommands } from '../../services/deep-agent/shell-policy';

export const agentChatRunEventType = 'agent.chat.run-event';

export type AgentCapabilityPreviewProvider = (input: {
  explicitSkillIds?: ChatStartRunRequest['explicitSkillIds'];
  mode: ChatStartRunRequest['mode'];
  requestedCapabilities: EnabledCapabilities;
  shellAllowedCommands?: readonly string[];
  runtimeStatus: AgentRuntimeStatus;
  workflowHint: WorkflowHint;
}) => Promise<AgentCapabilityPreview>;

type AgentResumeValue = HITLResponse | { answer: string };
type AgentResumePayload = Record<string, AgentResumeValue>;

export type AgentDeepAgentExecutor = {
  execute(input: {
    snapshot: RunExecutionSnapshotV2;
    resumePayload?: AgentResumePayload;
    run: TaskRun;
    modelHandle: AgentModelHandle;
    abortSignal: AbortSignal;
    observeModelUsage: (usage: AgentModelUsageTelemetry) => void;
    validatedAttachments?: ChatValidatedImageAttachment[];
  }): AgentDeepAgentExecution | Promise<AgentDeepAgentExecution>;
};

type ExecuteRunInput = {
  executionStream?: AgentDeepAgentExecution;
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
  snapshot: RunExecutionSnapshotV2;
};

export type AgentPluginRuntimeOptions = {
  repository: AgentSessionRepository;
  eventBus: RocEventBus;
  modelFactory: AgentModelFactoryAdapter;
  deepAgentExecutor?: AgentDeepAgentExecutor;
  lifecycleHooks?: AgentLifecycleHookEmitter;
  tracingLifecycle?: AgentRunTracingLifecycle;
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
  private readonly pendingInterrupts = new Map<string, PendingInterrupt[]>();
  private readonly pendingRuns = new Map<string, Promise<void>>();
  private readonly runTelemetry = new Map<string, AgentRunTelemetryAccumulator>();
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
    shellAllowedCommands?: readonly string[];
    workflowHint?: WorkflowHint;
  }): Promise<AgentCapabilityPreview> {
    if (this.options.capabilityPreviewProvider === undefined) {
      throw new Error('agent_capability_preview_unavailable');
    }
    return await this.options.capabilityPreviewProvider({
      explicitSkillIds: input.explicitSkillIds,
      mode: input.mode,
      requestedCapabilities: input.requestedCapabilities,
      shellAllowedCommands: input.shellAllowedCommands,
      runtimeStatus: this.getStatus(),
      workflowHint: input.workflowHint === undefined ? null : input.workflowHint
    });
  }

  async startRun(request: ChatStartRunRequest): Promise<ChatStartRunResult> {
    const input = request.input.trim();
    if (input.length === 0) {
      throw new Error('chat_input_empty');
    }
    const dispatchKey = resolveDispatchKey(request);
    if (dispatchKey !== null) {
      const existingRun = this.options.repository.findRunByDispatchKey(dispatchKey);
      if (existingRun !== null) {
        return toExistingRunStartResult(this.options.repository, existingRun);
      }
    }
    const modelHandle = await this.options.modelFactory.createDefaultModelHandle();
    const shellAllowedCommands = parseShellAllowedCommands({
      commands: request.shellAllowedCommands,
      mode: request.mode,
      taskSource: request.taskSource === undefined ? null : request.taskSource
    });
    const capabilityPreview = await this.getRunCapabilityPreview({
      explicitSkillIds: request.explicitSkillIds,
      mode: request.mode,
      requestedCapabilities: request.enabledCapabilities,
      shellAllowedCommands,
      workflowHint: request.workflowHint === undefined ? null : request.workflowHint,
      modelHandle
    });
    const preparedAttachments = await prepareChatImageAttachments(request.attachments);
    const workspace = await this.resolveRunWorkspace(request);
    const explicitSkillIds = normalizeExplicitSkillIds(request.explicitSkillIds, capabilityPreview.manifest);
    let run: TaskRun;
    try {
      run = this.options.repository.createTaskRun({
        attachments: preparedAttachments.metadata.length === 0 ? undefined : preparedAttachments.metadata,
        capabilityPreview,
        snapshot: createRunExecutionSnapshotSeed({
          capabilityManifest: capabilityPreview.manifest,
          dispatchKey,
          explicitSkillIds,
          modelHandle,
          request,
          shellAllowedCommands,
          workspace
        }),
        threadKind: resolveNewRunThreadKind(request),
        threadId: typeof request.threadId === 'string' ? request.threadId : undefined,
        userInput: input
      });
    } catch (error) {
      if (dispatchKey === null) {
        throw error;
      }
      const existingRun = this.options.repository.findRunByDispatchKey(dispatchKey);
      if (existingRun === null) {
        throw error;
      }
      return toExistingRunStartResult(this.options.repository, existingRun);
    }
    const dispatchState = this.options.repository.getRunTransitionState(run.id);
    const dispatchedRun = this.options.repository.transitionRun({
      endedAt: null,
      expectedStateVersion: dispatchState.stateVersion,
      expectedStatus: dispatchState.status,
      runId: run.id,
      status: 'dispatch_pending'
    }).run;
    const snapshot = this.options.repository.getRunExecutionSnapshot(run.id);
    this.activeRuns.add(run.id);
    const normalizedRequest = createChatStartRunRequestFromSnapshot(snapshot, dispatchedRun);
    this.activeRunMetadata.set(run.id, {
      request: normalizedRequest,
      threadId: dispatchedRun.threadId
    });
    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
    const result: ChatStartRunResult = {
      runId: run.id,
      mode: request.mode,
      threadId: dispatchedRun.threadId,
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
      runId: result.runId,
      mode: snapshot.mode,
      threadId: result.threadId,
      providerId: result.providerId,
      modelId: result.modelId,
      createdAt: result.createdAt
    });
    const timer = setTimeout(() => {
      this.scheduledRuns.delete(timer);
      if (!this.activeRuns.has(run.id)) {
        return;
      }
      const executionState = this.options.repository.getRunTransitionState(run.id);
      if (executionState.status !== 'dispatch_pending') {
        return;
      }
      const executingRun = this.options.repository.transitionRun({
        endedAt: null,
        expectedStateVersion: executionState.stateVersion,
        expectedStatus: executionState.status,
        runId: run.id,
        status: 'running'
      }).run;
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
        run: executingRun,
        snapshot,
        threadId: executingRun.threadId,
        validatedAttachments: preparedAttachments.images,
        workflowHint: readWorkflowHintFromSnapshot(snapshot.workflowHint)
      });
      this.trackPendingRun(run.id, pendingRun);
    }, 0);
    this.scheduledRuns.add(timer);
    return result;
  }

  async cancelRun(input: { runId: string }): Promise<ChatCancelRunResult> {
    if (!this.activeRuns.has(input.runId)) {
      return {
        runId: input.runId,
        cancelled: false
      };
    }
    const run = this.options.repository.getRun(input.runId);
    const snapshot = this.options.repository.getRunExecutionSnapshot(input.runId);
    const telemetry = this.getOrCreateRunTelemetry(run, snapshot);
    const abortController = this.abortControllers.get(input.runId);
    if (abortController === undefined) {
      throw new Error('agent_run_abort_controller_missing');
    }
    this.activeRuns.delete(input.runId);
    abortController.abort();
    const pendingRun = this.pendingRuns.get(input.runId);
    if (pendingRun !== undefined) {
      await pendingRun;
    }
    const endedAt = new Date().toISOString();
    const terminalState = this.options.repository.getRunTransitionState(input.runId);
    const durationMs = calculateAgentRunTelemetryDurationMs(run.startedAt, endedAt);
    telemetry.markTerminal({
      status: 'cancelled',
      durationMs,
      errorCode: null,
      retryable: null,
      cancelSource: 'user_cancelled'
    });
    let terminal: ReturnType<AgentSessionRepository['cancelRunAtomically']>;
    try {
      terminal = this.options.repository.cancelRunAtomically({
        endedAt,
        expectedStateVersion: terminalState.stateVersion,
        expectedStatus: terminalState.status,
        runId: input.runId,
        telemetry: telemetry.snapshot()
      });
    } catch (error) {
      this.activeRuns.add(input.runId);
      throw error;
    }
    this.runTelemetry.delete(input.runId);
    const metadata = this.activeRunMetadata.get(input.runId);
    this.activeRunMetadata.delete(input.runId);
    this.abortControllers.delete(input.runId);
    this.pendingInterrupts.delete(input.runId);
    void this.publish('agent.run.cancelled', {
      runId: terminal.run.id,
      threadId: terminal.run.threadId,
      reason: 'user_cancelled'
    });
    void this.publishChatRunEventBestEffort({
      type: 'run_cancelled',
      runId: terminal.run.id,
      threadId: terminal.run.threadId,
      reason: 'user_cancelled'
    }, false);
    await this.finishTracingBestEffort({
      runId: input.runId,
      status: 'cancelled',
      error: null
    });
    if (metadata !== undefined) {
      void this.emitSessionEndBestEffort({
        runId: input.runId,
        threadId: metadata.threadId,
        request: metadata.request,
        signal: abortController.signal,
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
    const pendingInterrupts = this.resolvePendingInterrupts(request.runId);
    if (pendingInterrupts.length === 0) {
      throw new Error('chat_resume_no_pending_interrupt');
    }
    const pendingInterrupt = pendingInterrupts.find((interrupt) => interrupt.interruptId === request.interruptId);
    if (pendingInterrupt === undefined) {
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
    if (this.options.deepAgentExecutor === undefined) {
      throw new Error('agent_deep_agent_executor_missing');
    }
    const deepAgentExecutor = this.options.deepAgentExecutor;
    const telemetry = this.getOrCreateRunTelemetry(run, snapshot);
    const resumeValue: AgentResumeValue =
      request.kind === 'approval' ? { decisions: request.decisions } : { answer: request.answer };
    const resumePayload: AgentResumePayload = {
      ...this.options.repository.getRecordedResumePayload(run.id),
      [request.interruptId]: resumeValue
    };
    const resumeAudit: ResumeDispatchAudit =
      request.kind === 'approval'
        ? {
            type: 'approval_decision',
            payload: {
              interruptId: request.interruptId,
              decisions: request.decisions
            }
          }
        : {
            type: 'human_question_answered',
            payload: {
              interruptId: request.interruptId,
              answer: request.answer
            },
            sessionMessage: {
              content: request.answer,
              workspaceHash: null
            }
          };
    const resumeState = this.options.repository.getRunTransitionState(run.id);
    const dispatch = this.options.repository.beginResumeDispatch({
      expectedStateVersion: resumeState.stateVersion,
      expectedStatus: resumeState.status,
      interruptId: request.interruptId,
      runId: run.id
    });
    const abortController = new AbortController();
    let executionStream: AgentDeepAgentExecution;
    try {
      executionStream = requireAgentExecution(
        await deepAgentExecutor.execute({
          abortSignal: abortController.signal,
          modelHandle,
          observeModelUsage: usage => telemetry.observeModelUsage(usage),
          resumePayload,
          run: dispatch.run,
          snapshot
        })
      );
    } catch (error) {
      this.options.repository.rollbackResumeDispatch({
        expectedStateVersion: dispatch.stateVersion,
        expectedStatus: 'dispatch_pending',
        runId: run.id
      });
      throw error;
    }
    let resumed: ReturnType<AgentSessionRepository['commitResumeDispatch']>;
    try {
      resumed = this.options.repository.commitResumeDispatch({
        audit: resumeAudit,
        expectedStateVersion: dispatch.stateVersion,
        expectedStatus: 'dispatch_pending',
        interruptId: request.interruptId,
        runId: run.id
      });
    } catch (error) {
      abortController.abort();
      this.options.repository.rollbackResumeDispatch({
        expectedStateVersion: dispatch.stateVersion,
        expectedStatus: 'dispatch_pending',
        runId: run.id
      });
      throw error;
    }
    const resumedRun = resumed.run;
    this.activeRuns.add(run.id);
    const resumedRequest = createChatStartRunRequestFromSnapshot(snapshot, resumedRun);
    this.activeRunMetadata.set(run.id, {
      request: resumedRequest,
      threadId: resumedRun.threadId
    });
    this.abortControllers.set(run.id, abortController);
    const resumedAt = new Date().toISOString();
    const result: ChatResumeRunResult = {
      runId: run.id,
      threadId: run.threadId,
      resumedAt
    };
    const remainingInterrupts = pendingInterrupts.filter(
      (interrupt) => interrupt.interruptId !== request.interruptId
    );
    if (remainingInterrupts.length === 0) {
      this.pendingInterrupts.delete(run.id);
    } else {
      this.pendingInterrupts.set(run.id, remainingInterrupts);
    }
    await this.publish('agent.run.resumed', result);
    await this.publishChatRunEvent({
      type: 'run_resumed',
      runId: run.id,
      threadId: run.threadId,
      interruptId: pendingInterrupt.interruptId
    });
    await this.publishTaskEvent(resumed.event);
    const pendingRun = this.executeRun({
      abortSignal: abortController.signal,
      enabledCapabilities: snapshot.capabilityManifest.resolvedCapabilities,
      input: resumedRun.userInput,
      mode: resumedRequest.mode,
      modelHandle,
      modelId: modelHandle.modelId,
      providerId: modelHandle.providerId,
      request: resumedRequest,
      executionStream,
      resumePayload,
      run: resumedRun,
      runId: run.id,
      snapshot,
      threadId: resumedRun.threadId,
      workflowHint: readWorkflowHintFromSnapshot(snapshot.workflowHint)
    });
    this.trackPendingRun(run.id, pendingRun);
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
      await Promise.allSettled([...this.pendingRuns.values()]);
    }
    await this.shutdownTracingBestEffort();
  }

  async completeRun(input: {
    runId: string;
    assistantMessage: string;
    summary: string;
    durationMs: number;
    endedAt: string;
    providerId: string;
    modelId: string;
    telemetry: AgentRunTelemetryV1;
    workspacePath: ChatStartRunRequest['workspacePath'];
  }): Promise<{ run: TaskRun; message: SessionMessageEntry; event: TaskEvent }> {
    const workspaceIdentity = resolveRuntimeWorkspaceIdentity(input.workspacePath === undefined ? null : input.workspacePath);
    const currentRun = this.options.repository.getRun(input.runId);
    const terminalState = this.options.repository.getRunTransitionState(input.runId);
    const terminal = this.options.repository.completeRunAtomically({
      assistantMessage: input.assistantMessage,
      durationMs: input.durationMs,
      endedAt: input.endedAt,
      expectedStateVersion: terminalState.stateVersion,
      expectedStatus: terminalState.status,
      modelId: input.modelId,
      providerId: input.providerId,
      runId: input.runId,
      runStartedAt: currentRun.startedAt,
      summary: input.summary,
      telemetry: input.telemetry,
      workspaceHash: workspaceIdentity === null ? null : workspaceIdentity.hash
    });
    const run = terminal.run;
    this.activeRuns.delete(input.runId);
    this.activeRunMetadata.delete(input.runId);
    this.abortControllers.delete(input.runId);
    this.pendingInterrupts.delete(input.runId);
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
    await this.publishChatRunEventBestEffort({
      type: 'run_completed',
      runId: run.id,
      threadId: run.threadId,
      providerId: input.providerId,
      modelId: input.modelId,
      createdAt: currentRun.startedAt,
      durationMs: input.durationMs,
      summary: input.summary,
      assistantMessage: input.assistantMessage
    }, false);
    return terminal;
  }

  private async emitSessionEndBestEffort(input: Parameters<AgentLifecycleHookEmitter['emitSessionEnd']>[0]): Promise<void> {
    if (this.options.lifecycleHooks === undefined) {
      return;
    }
    try {
      await this.options.lifecycleHooks.emitSessionEnd(input);
    } catch {
      this.recordNotificationFailure('agent_session_end_notification_failed');
    }
  }

  private async finishTracingBestEffort(input: Parameters<AgentRunTracingLifecycle['finishRun']>[0]): Promise<void> {
    if (this.options.tracingLifecycle === undefined) {
      return;
    }
    try {
      await this.options.tracingLifecycle.finishRun(input);
    } catch {
      this.recordNotificationFailure('agent_langsmith_trace_finish_failed');
    }
  }

  private async shutdownTracingBestEffort(): Promise<void> {
    if (this.options.tracingLifecycle === undefined) {
      return;
    }
    try {
      await this.options.tracingLifecycle.shutdown();
    } catch {
      this.recordNotificationFailure('agent_langsmith_trace_shutdown_failed');
    }
  }

  private async publish<TPayload>(type: string, payload: TPayload): Promise<void> {
    try {
      await this.options.eventBus.publish({
        type,
        source: this.pluginId,
        payload,
        createdAt: new Date().toISOString()
      });
    } catch {
      this.recordNotificationFailure('agent_event_bus_notification_failed');
    }
  }

  private async publishChatRunEvent(payload: ChatRunEvent): Promise<void> {
    this.persistChatRunEvent(payload);
    await this.publish(agentChatRunEventType, payload);
  }

  private async publishChatRunEventBestEffort(payload: ChatRunEvent, persist: boolean): Promise<void> {
    if (persist) {
      this.persistChatRunEvent(payload);
    }
    await this.publish(agentChatRunEventType, payload);
  }

  private persistChatRunEvent(payload: ChatRunEvent): void {
    try {
      this.options.runEventLog?.recordRunEvent(payload);
    } catch {
      this.recordNotificationFailure('agent_run_event_replay_persist_failed');
    }
  }

  private recordNotificationFailure(code: string): void {
    try {
      this.options.repository.recordNotificationFailure(code);
    } catch {
      console.warn('[AgentPluginRuntime] Notification metric persistence failed.');
    }
  }

  private trackPendingRun(runId: string, pendingRun: Promise<void>): void {
    if (this.pendingRuns.has(runId)) {
      throw new Error('agent_pending_run_already_tracked');
    }
    this.pendingRuns.set(runId, pendingRun);
    void pendingRun.then(
      () => {
        if (this.pendingRuns.get(runId) === pendingRun) {
          this.pendingRuns.delete(runId);
        }
      },
      (error: unknown) => {
        if (this.pendingRuns.get(runId) === pendingRun) {
          this.pendingRuns.delete(runId);
        }
        this.recordNotificationFailure('agent_pending_run_rejected');
        console.error('[AgentPluginRuntime] Detached run execution rejected.', error);
      }
    );
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

  private async publishTaskEvent(event: TaskEvent): Promise<void> {
    await this.publish('agent.run.task-event', {
      runId: event.runId,
      threadId: event.threadId,
      type: event.type,
      payload: event.payload
    });
  }

  private async executeRun(input: ExecuteRunInput): Promise<void> {
    if (!this.activeRuns.has(input.runId)) {
      return;
    }
    const runStartedAtMs = parseTimestamp(input.run.startedAt, 'agent_run_telemetry_started_at_invalid');
    const telemetry = this.getOrCreateRunTelemetry(input.run, input.snapshot);
    let attempt = 0;
    let firstFailureAtMs: number | null = null;
    let executionStream = input.executionStream;
    while (this.activeRuns.has(input.runId)) {
      try {
        if (this.options.deepAgentExecutor === undefined) {
          throw new Error('agent_deep_agent_executor_missing');
        }
        const currentExecutionStream = executionStream;
        executionStream = undefined;
        const execution = await this.executeDeepAgentRun({
          abortSignal: input.abortSignal,
          executionStream: currentExecutionStream,
          modelHandle: input.modelHandle,
          resumePayload: input.resumePayload,
          run: input.run,
          runStartedAtMs,
          snapshot: input.snapshot,
          telemetry,
          validatedAttachments: input.validatedAttachments
        });
        if (execution === null) {
          return;
        }
        if (attempt > 0) {
          telemetry.recordRecovery();
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
        if (execution.status === 'interrupted') {
          telemetry.observeModelUsage(execution.usage);
          const interruptedAt = new Date().toISOString();
          telemetry.updateDuration(calculateAgentRunTelemetryDurationMs(input.run.startedAt, interruptedAt));
          await this.handleRunInterrupted({
            interrupts: execution.interrupts,
            runId: input.run.id,
            telemetry: telemetry.snapshot(),
            threadId: input.run.threadId
          });
          for (const event of execution.events) {
            await this.publishChatRunEvent(event);
          }
          return;
        }
        if (!this.activeRuns.has(input.runId)) {
          return;
        }
        telemetry.observeModelUsage(execution.usage);
        const endedAt = new Date().toISOString();
        const terminalDurationMs = calculateAgentRunTelemetryDurationMs(input.run.startedAt, endedAt);
        telemetry.markTerminal({
          status: 'completed',
          durationMs: terminalDurationMs,
          errorCode: null,
          retryable: null,
          cancelSource: null
        });
        await this.completeRun({
          runId: input.runId,
          assistantMessage: execution.finalMessage,
          summary: buildCompletionSummary({
            assistantMessage: execution.finalMessage,
            successfulToolNames: execution.summarySource.successfulToolNames,
            workflowHint: input.request.workflowHint === undefined ? null : input.request.workflowHint
          }),
          durationMs: terminalDurationMs,
          endedAt,
          providerId: input.providerId,
          telemetry: telemetry.snapshot(),
          modelId: input.modelId,
          workspacePath: input.request.workspacePath
        });
        this.runTelemetry.delete(input.runId);
        await Promise.all([
          this.finishTracingBestEffort({
            runId: input.runId,
            status: 'completed',
            error: null
          }),
          this.emitSessionEndBestEffort({
            runId: input.runId,
            threadId: input.threadId,
            request: input.request,
            signal: input.abortSignal,
            status: 'completed',
            error: null
          })
        ]);
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
          const recoveryState = this.options.repository.getRunTransitionState(input.runId);
          this.options.repository.transitionRun({
            endedAt: null,
            expectedStateVersion: recoveryState.stateVersion,
            expectedStatus: recoveryState.status,
            runId: input.runId,
            status: 'recovering'
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
          const resumedRecoveryState = this.options.repository.getRunTransitionState(input.runId);
          this.options.repository.transitionRun({
            endedAt: null,
            expectedStateVersion: resumedRecoveryState.stateVersion,
            expectedStatus: resumedRecoveryState.status,
            runId: input.runId,
            status: 'running'
          });
          continue;
        }
        await this.failRun({ input, failure, telemetry });
        return;
      }
    }
  }

  private async failRun(input: {
    input: ExecuteRunInput;
    failure: RunFailure;
    telemetry: AgentRunTelemetryAccumulator;
  }): Promise<void> {
    const terminalState = this.options.repository.getRunTransitionState(input.input.runId);
    const endedAt = new Date().toISOString();
    input.telemetry.markTerminal({
      status: 'failed',
      durationMs: calculateAgentRunTelemetryDurationMs(input.input.run.startedAt, endedAt),
      errorCode: input.failure.code,
      retryable: input.failure.retryable,
      cancelSource: null
    });
    this.options.repository.failRunAtomically({
      code: input.failure.code,
      diagnostic: input.failure.diagnostic,
      endedAt,
      error: input.failure.message,
      expectedStateVersion: terminalState.stateVersion,
      expectedStatus: terminalState.status,
      modelId: input.input.modelId,
      providerId: input.input.providerId,
      retryable: input.failure.retryable,
      runId: input.input.runId,
      suggestion: input.failure.suggestion,
      telemetry: input.telemetry.snapshot()
    });
    this.runTelemetry.delete(input.input.runId);
    this.activeRuns.delete(input.input.runId);
    this.activeRunMetadata.delete(input.input.runId);
    this.abortControllers.delete(input.input.runId);
    this.pendingInterrupts.delete(input.input.runId);
    await Promise.all([
      this.finishTracingBestEffort({
        runId: input.input.runId,
        status: 'failed',
        error: input.failure.message
      }),
      this.emitSessionEndBestEffort({
        runId: input.input.runId,
        threadId: input.input.threadId,
        request: input.input.request,
        signal: input.input.abortSignal,
        status: 'failed',
        error: input.failure.message
      })
    ]);
    await this.publish('agent.run.failed', {
      runId: input.input.runId,
      threadId: input.input.threadId,
      providerId: input.input.providerId,
      modelId: input.input.modelId,
      error: input.failure.message,
      code: input.failure.code,
      retryable: input.failure.retryable
    });
    await this.publishChatRunEventBestEffort({
      type: 'run_failed',
      runId: input.input.runId,
      threadId: input.input.threadId,
      code: input.failure.code,
      diagnostic: input.failure.diagnostic,
      message: input.failure.message,
      retryable: input.failure.retryable,
      suggestion: input.failure.suggestion
    }, false);
  }

  private async executeDeepAgentRun(input: {
    snapshot: RunExecutionSnapshotV2;
    resumePayload?: AgentResumePayload;
    executionStream?: AgentDeepAgentExecution;
    run: TaskRun;
    runStartedAtMs: number;
    modelHandle: AgentModelHandle;
    abortSignal: AbortSignal;
    validatedAttachments?: ChatValidatedImageAttachment[];
    telemetry: AgentRunTelemetryAccumulator;
  }): Promise<DeepAgentExecutionResult | null> {
    const execution =
      input.executionStream === undefined
        ? requireAgentExecution(
            await this.options.deepAgentExecutor!.execute({
              abortSignal: input.abortSignal,
              observeModelUsage: usage => input.telemetry.observeModelUsage(usage),
              modelHandle: input.modelHandle,
              run: input.run,
              snapshot: input.snapshot,
              ...(input.resumePayload === undefined ? {} : { resumePayload: input.resumePayload }),
              ...(input.validatedAttachments === undefined
                ? {}
                : { validatedAttachments: input.validatedAttachments })
            })
          )
        : input.executionStream;
    try {
      for await (const event of execution.events) {
        if (!this.activeRuns.has(input.run.id)) {
          void execution.outcome.catch(() => undefined);
          return null;
        }
        input.telemetry.observeEvent(event, Date.now() - input.runStartedAtMs);
        if (event.type === 'run_interrupted') {
          continue;
        }
        await this.publishChatRunEvent(event);
        if (event.type === 'hook_started' || event.type === 'hook_completed') {
          await this.recordRunTaskEvent({
            runId: input.run.id,
            threadId: input.run.threadId,
            type: event.type,
            payload: event.hook
          });
          continue;
        }
        if (event.type === 'assistant_block') {
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
    } catch (error) {
      await observeSettledOutcomeUsage(execution.outcome, input.telemetry);
      throw error;
    }
    const outcome = await execution.outcome;
    if (outcome.status === 'interrupted') {
      return {
        ...outcome,
        events: createRunInterruptedEvents(input.run.id, input.run.threadId, outcome.interrupts)
      };
    }
    return outcome;
  }

  private getOrCreateRunTelemetry(
    run: TaskRun,
    snapshot: RunExecutionSnapshotV2
  ): AgentRunTelemetryAccumulator {
    const current = this.runTelemetry.get(run.id);
    if (current !== undefined) {
      return current;
    }
    const existing = this.options.repository.getRunTelemetry(run.id);
    if (existing === null) {
      throw new Error('agent_run_telemetry_missing');
    }
    const created = new AgentRunTelemetryAccumulator({ existing, run, snapshot });
    this.runTelemetry.set(run.id, created);
    return created;
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
    shellAllowedCommands?: readonly string[];
    workflowHint: WorkflowHint;
    modelHandle: AgentModelHandle;
  }): Promise<AgentCapabilityPreview> {
    if (this.options.capabilityPreviewProvider !== undefined) {
      return await this.getCapabilityPreview({
        explicitSkillIds: input.explicitSkillIds,
        mode: input.mode,
        requestedCapabilities: input.requestedCapabilities,
        shellAllowedCommands: input.shellAllowedCommands,
        workflowHint: input.workflowHint
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
      shellAllowedCommands: input.shellAllowedCommands,
      skills: [],
      workflowHint: input.workflowHint
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

  private resolvePendingInterrupts(runId: string): PendingInterrupt[] {
    const pendingInterrupts = this.pendingInterrupts.get(runId);
    if (pendingInterrupts !== undefined) {
      return pendingInterrupts;
    }
    const run = this.options.repository.getRun(runId);
    const persistedInterrupts = this.options.repository.interruptProjection.readPending({
      runId,
      threadId: run.threadId
    }).interrupts;
    if (persistedInterrupts.length > 0) {
      this.pendingInterrupts.set(runId, persistedInterrupts);
    }
    return persistedInterrupts;
  }

  private async handleRunInterrupted(input: {
    interrupts: readonly PendingInterrupt[];
    runId: string;
    telemetry: AgentRunTelemetryV1;
    threadId: string;
  }): Promise<void> {
    const interruptState = this.options.repository.getRunTransitionState(input.runId);
    const interrupted = this.options.repository.markRunInterrupted({
      expectedStateVersion: interruptState.stateVersion,
      expectedStatus: interruptState.status,
      interrupts: input.interrupts,
      runId: input.runId,
      telemetry: input.telemetry,
      threadId: input.threadId
    });
    this.pendingInterrupts.set(input.runId, [...input.interrupts]);
    for (const event of interrupted.events) {
      await this.publishTaskEvent(event);
    }
  }
}

function requireAgentExecution(value: unknown): AgentDeepAgentExecution {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new Error('agent_deep_agent_execution_invalid');
  }
  const events = Reflect.get(value, 'events');
  const outcome = Reflect.get(value, 'outcome');
  if ((typeof events !== 'object' && typeof events !== 'function') || events === null || typeof Reflect.get(events, Symbol.asyncIterator) !== 'function') {
    throw new Error('agent_deep_agent_execution_invalid');
  }
  if (!(outcome instanceof Promise)) {
    throw new Error('agent_deep_agent_execution_invalid');
  }
  return value as AgentDeepAgentExecution;
}

function createRunExecutionSnapshotSeed(input: {
  capabilityManifest: RunExecutionSnapshotV1['capabilityManifest'];
  dispatchKey: string | null;
  explicitSkillIds: string[];
  modelHandle: AgentModelHandle;
  request: ChatStartRunRequest;
  shellAllowedCommands?: readonly string[];
  workspace: Workspace | null;
}): RunExecutionSnapshotSeed {
  const mode = toRunExecutionMode(input.request.mode);
  return {
    schemaVersion: 2,
    runOrigin: resolveRunOrigin(input.request),
    model: {
      providerId: input.modelHandle.providerId,
      modelId: input.modelHandle.modelId
    },
    mode,
    workspace: input.workspace === null ? null : resolveRuntimeWorkspaceIdentity(input.workspace.path),
    capabilityManifest: input.capabilityManifest,
    shellAllowedCommands: input.shellAllowedCommands === undefined ? undefined : [...input.shellAllowedCommands],
    budget: createRunBudget({
        contextBudgetTokens:
          input.modelHandle.langChainHandle === undefined
            ? null
            : input.modelHandle.langChainHandle.runtime.contextBudgetTokens,
        mode,
        runOrigin: resolveRunOrigin(input.request)
      }),
    workflowHint: input.request.workflowHint === undefined ? null : input.request.workflowHint,
    explicitSkillIds: input.explicitSkillIds,
    dispatchKey: input.dispatchKey
  };
}

function resolveDispatchKey(request: ChatStartRunRequest): string | null {
  if (request.dispatchKey === undefined) {
    return null;
  }
  if (request.taskSource !== 'background_schedule') {
    throw new Error('agent_dispatch_key_source_invalid');
  }
  const dispatchKey = request.dispatchKey.trim();
  if (dispatchKey.length === 0) {
    throw new Error('agent_dispatch_key_empty');
  }
  return dispatchKey;
}

function toExistingRunStartResult(repository: AgentSessionRepository, run: TaskRun): ChatStartRunResult {
  const snapshot = repository.getRunExecutionSnapshot(run.id);
  return {
    runId: run.id,
    mode: createChatStartRunRequestFromSnapshot(snapshot, run).mode,
    threadId: run.threadId,
    providerId: snapshot.model.providerId,
    modelId: snapshot.model.modelId,
    createdAt: run.startedAt
  };
}

function resolveRunOrigin(request: ChatStartRunRequest): RunExecutionSnapshotV2['runOrigin'] {
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
  capabilityManifest: RunExecutionSnapshotV2['capabilityManifest']
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

async function observeSettledOutcomeUsage(
  outcome: Promise<RunOutcome>,
  telemetry: AgentRunTelemetryAccumulator
): Promise<void> {
  await outcome.then(
    settledOutcome => telemetry.observeModelUsage(settledOutcome.usage),
    () => undefined // Failed executions report partial usage through observeModelUsage.
  );
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

function parseTimestamp(timestamp: string, code: string): number {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    throw new Error(code);
  }
  return value;
}
