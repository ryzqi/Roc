import type { HITLResponse } from 'langchain';
import type { ChatResumeDecision } from '../../../shared/types';

import type {
  ActiveChatRun,
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
  RunExecutionSnapshot,
  ResearchStage,
  TaskAcceptance,
  RunCapabilityManifestV1
} from '../../../shared/types';
import type { RocEventBus } from '../../kernel/types';
import { hashToolInput } from '../../services/deep-agent/tool-effect-store';
import { buildRunSummary } from '../../services/deep-agent/context/run-summary';
import { resolveRuntimeWorkspaceIdentity } from '../../services/deep-agent/context/workspace-scope';
import { toRunFailure } from '../../services/deep-agent/error-mapping';
import { redact } from '../../services/deep-agent/redaction';
import { RocDomainError } from '../../services/errors';
import type { RunFailure } from '../../services/deep-agent/types';
import type { PilotRunCoordinator } from '../../services/deep-agent/pilot-run';
import type { PilotDecision } from '../../services/deep-agent/pilot-gate';
import type { PilotOptInRequest, PilotStatus } from '../../../shared/schemas/harness-pilot';
import { derivePilotRequest, restrictManifestForPilot } from './pilot-profile';
import { RetryTelemetry } from '../../services/deep-agent/retry-telemetry';
import { prepareChatImageAttachments } from './chat-image-attachments';
import { AgentActiveRunLifecycle } from './active-run-lifecycle';
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
  DeepAgentExecutionResult
} from './runtime-types';
import {
  createBlockedAgentRuntimeStatus,
  createTaskEventFromAssistantBlock,
  resolveNewRunThreadKind
} from './runtime-helpers';
import { parseShellAllowedCommands } from '../../services/deep-agent/shell-policy';
import type { ResearchProof, TaskVerificationContext } from '../../services/deep-agent/task-contract-store';

export const agentChatRunEventType = 'agent.chat.run-event';

export type AgentCapabilityPreviewProvider = (input: {
  explicitSkillIds?: ChatStartRunRequest['explicitSkillIds'];
  mode: ChatStartRunRequest['mode'];
  requestedCapabilities: EnabledCapabilities;
  shellAllowedCommands?: readonly string[];
  runtimeStatus: AgentRuntimeStatus;
  workflowHint: WorkflowHint;
  researchProjectId?: string | null;
}) => Promise<AgentCapabilityPreview>;

type AgentResumeValue = HITLResponse | { answer: string };
type AgentResumePayload = Record<string, AgentResumeValue>;
type HitlDecision = HITLResponse['decisions'][number];

/**
 * Roc 的 resume 决定多出科研闸门的第三态 'revise'，而 langchain 的 HITLResponse
 * 只认 approve/edit/reject/respond。两者在运行期是同一份 payload（闸门工具自己解析 'revise'），
 * 所以只在进入 langchain API 的边界上收敛类型，不在共享 schema 里删掉这一态。
 *
 * 这里逐项映射而不做类型谓词过滤：langchain 1.5.18 给 Decision 加了 'respond'，
 * 谓词的返回类型因此比 Roc 的 ChatResumeDecision 更宽，收窄检查会在编译期失败。
 */
function toHitlResumeValue(decisions: ChatResumeDecision[]): AgentResumeValue {
  const hitlDecisions: HitlDecision[] = [];
  for (const decision of decisions) {
    switch (decision.type) {
      case 'revise':
        break;
      case 'approve':
        hitlDecisions.push({ type: 'approve' });
        break;
      case 'reject':
        hitlDecisions.push(
          decision.message === undefined
            ? { type: 'reject' }
            : { type: 'reject', message: decision.message }
        );
        break;
      case 'edit':
        hitlDecisions.push({ type: 'edit', editedAction: decision.editedAction });
        break;
      default: {
        const exhaustive: never = decision;
        throw new Error(`未处理的 resume 决定类型: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  if (hitlDecisions.length === 0) {
    return { answer: decisions.map((decision) => ('message' in decision && decision.message !== undefined ? decision.message : decision.type)).join('\n') };
  }
  return { decisions: hitlDecisions };
}

/** 已落库的 resume 记录同样只可能是 'revise' 在 langchain 边界上不合法，重新过一道同一个收敛函数。 */
function toAgentResumePayload(
  recorded: Record<string, { decisions: ChatResumeDecision[] } | { answer: string }>
): AgentResumePayload {
  const payload: AgentResumePayload = {};
  for (const [interruptId, value] of Object.entries(recorded)) {
    payload[interruptId] = 'answer' in value ? { answer: value.answer } : toHitlResumeValue(value.decisions);
  }
  return payload;
}

export type AgentDeepAgentExecutor = {
  execute(input: {
    snapshot: RunExecutionSnapshot;
    resumePayload?: AgentResumePayload;
    resumeFromCheckpoint?: boolean;
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
  resumeFromCheckpoint?: boolean;
  run: TaskRun;
  modelHandle: AgentModelHandle;
  abortSignal: AbortSignal;
  threadId: string;
  validatedAttachments?: ChatValidatedImageAttachment[];
  workflowHint: ChatStartRunRequest['workflowHint'] | null;
  enabledCapabilities: EnabledCapabilities;
  snapshot: RunExecutionSnapshot;
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
  researchProjectProvider?: (projectId: string) => Promise<{ workspacePath: string | null } | null>;
  researchStageProofProvider?: (projectId: string, stage: ResearchStage) => Promise<ResearchProof>;
  /** P6-04: absent means the pilot is not wired in this composition (tests, blocked runtimes). */
  pilot?: PilotRunCoordinator;
};

async function bestEffort(
  operation: () => Promise<void> | void,
  onFailure: (error: unknown) => void
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    try {
      onFailure(error);
    } catch {
      // Failure reporting is terminal best-effort work; it must not recurse.
    }
  }
}

function readNotificationRunId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || !('runId' in value) || typeof value.runId !== 'string') {
    return undefined;
  }
  return value.runId;
}

function summarizeNotificationError(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return redact(message).slice(0, 300);
  } catch {
    return 'notification_error_summary_unavailable';
  }
}

export class AgentPluginRuntime {
  private readonly activeRunLifecycle: AgentActiveRunLifecycle;
  private readonly runTelemetry = new Map<string, AgentRunTelemetryAccumulator>();
  private readonly pluginId: string;

  constructor(private readonly options: AgentPluginRuntimeOptions) {
    this.pluginId = options.pluginId === undefined ? '@roc/plugin-agent' : options.pluginId;
    this.activeRunLifecycle = new AgentActiveRunLifecycle((error, runId) => {
      this.reportNotificationFailure('agent_pending_run_rejected', error, {
        runId,
        notificationType: 'detached_run_execution'
      });
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

  async getCapabilityPreview(input: {
    explicitSkillIds?: ChatStartRunRequest['explicitSkillIds'];
    mode: ChatStartRunRequest['mode'];
    requestedCapabilities: EnabledCapabilities;
    shellAllowedCommands?: readonly string[];
    workflowHint?: WorkflowHint;
    researchProjectId?: string | null;
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
      workflowHint: input.workflowHint === undefined ? null : input.workflowHint,
      researchProjectId: input.researchProjectId === undefined ? null : input.researchProjectId
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
        return toExistingRunStartResult(this.options.repository, existingRun, request);
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
      modelHandle,
      researchProjectId: request.researchProjectId === undefined ? null : request.researchProjectId
    });
    // P6-04: the pilot gate reads the frozen manifest, not a caller-supplied claim. The task id is
    // the submission hash, so the same request always lands in the same deterministic bucket.
    const submissionHash = hashToolInput(request);
    const pilot = this.planPilotRun(submissionHash, capabilityPreview.manifest);
    const effectivePreview = pilot === null
      ? capabilityPreview
      : narrowPreviewForPilot(capabilityPreview, pilot.manifest, pilot.removedTools);
    const preparedAttachments = await prepareChatImageAttachments(request.attachments);
    const workspace = await this.resolveRunWorkspace(request);
    const explicitSkillIds = normalizeExplicitSkillIds(request.explicitSkillIds, effectivePreview.manifest);
    let run: TaskRun;
    try {
      run = this.options.repository.createTaskRun({
        attachments: preparedAttachments.metadata.length === 0 ? undefined : preparedAttachments.metadata,
        capabilityPreview: effectivePreview,
        snapshot: createRunExecutionSnapshotSeed({
          // The narrowed preview is the only manifest source here, so the frozen snapshot and the
          // preview cannot disagree (the repository rejects exactly that mismatch).
          capabilityPreview: effectivePreview,
          dispatchKey,
          explicitSkillIds,
          modelHandle,
          request,
          shellAllowedCommands,
          workspace
        }),
        threadKind: resolveNewRunThreadKind(request),
        threadId: typeof request.threadId === 'string' ? request.threadId : undefined,
        researchProjectId: request.researchProjectId,
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
      return toExistingRunStartResult(this.options.repository, existingRun, request);
    }
    const dispatchedRun = this.options.repository.transitionRun({
      endedAt: null,
      runId: run.id,
      status: 'dispatch_pending'
    });
    const snapshot = this.options.repository.getRunExecutionSnapshot(run.id);
    this.options.repository.taskContracts.assertMatchesSnapshot(run.id, snapshot.taskContract);
    if (pilot !== null && pilot.decision.start) {
      // Pilot bookkeeping is best-effort: if the grant cannot be written, the run continues on its
      // base budget instead of being left stranded in dispatch_pending without an event.
      try {
        this.options.pilot?.attach({ runId: run.id, taskId: submissionHash, decision: pilot.decision });
      } catch (error) {
        console.error('[AgentPluginRuntime] Pilot grant could not be recorded.', error);
      }
    }
    const normalizedRequest = createChatStartRunRequestFromSnapshot(snapshot, dispatchedRun);
    const abortController = new AbortController();
    this.activeRunLifecycle.activate({
      abortController,
      runId: run.id,
      request: normalizedRequest,
      threadId: dispatchedRun.threadId
    });
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
      capabilityPreview: effectivePreview
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
    this.activeRunLifecycle.schedule(() => {
      if (!this.activeRunLifecycle.isActive(run.id)) {
        return;
      }
      const executingRun = this.options.repository.beginRunExecution(run.id);
      if (executingRun === null) {
        return;
      }
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
      this.activeRunLifecycle.trackPendingRun(run.id, pendingRun);
    });
    return result;
  }

  /**
   * P6-04: decide the pilot before the run row exists, using the manifest the harness would freeze.
   * A starting pilot narrows that manifest to its profile, and the narrowed manifest is what the
   * snapshot, the preview and the telemetry all see — one manifest, not a labelled copy.
   */
  private planPilotRun(
    taskId: string,
    manifest: RunCapabilityManifestV1
  ): PilotPlan | null {
    const pilot = this.options.pilot;
    if (pilot === undefined) {
      return null;
    }
    const settings = pilot.settings();
    if (!settings.enabled) {
      // Nothing to check beyond the refusal reason, and the manifest must stay byte-identical.
      return { decision: pilot.plan(derivePilotRequest(manifest, taskId)), manifest, removedTools: [] };
    }
    // A pilot profile *is* the surface it runs with, so the manifest is narrowed first and the
    // decision is taken on that narrowed surface. Deciding on the full manifest would refuse every
    // run that merely has an effectful tool bound, which is most of them.
    const restricted = restrictManifestForPilot(manifest, settings.profile);
    const decision = pilot.plan(derivePilotRequest(restricted.manifest, taskId));
    return decision.start
      ? { decision, manifest: restricted.manifest, removedTools: restricted.removedTools }
      : { decision, manifest, removedTools: [] };
  }

  /**
   * P6-04 surfaces. The pilot is opt-in, so reading it must work even when it is not wired; only
   * mutating calls fail, and they fail by name instead of pretending success.
   */
  getPilotStatus(): PilotStatus {
    return this.requirePilot().status();
  }

  enablePilot(request: PilotOptInRequest): PilotStatus {
    return this.requirePilot().enable(request);
  }

  rollbackPilot(): PilotStatus {
    return this.requirePilot().rollback();
  }

  private requirePilot(): PilotRunCoordinator {
    const pilot = this.options.pilot;
    if (pilot === undefined) {
      throw new Error('agent_pilot_unavailable');
    }
    return pilot;
  }

  async cancelRun(input: { runId: string }): Promise<ChatCancelRunResult> {
    if (!this.activeRunLifecycle.isActive(input.runId)) {
      return {
        runId: input.runId,
        cancelled: false
      };
    }
    const run = this.options.repository.getRun(input.runId);
    const snapshot = this.options.repository.getRunExecutionSnapshot(input.runId);
    const telemetry = this.getOrCreateRunTelemetry(run, snapshot);
    const cancellation = await this.activeRunLifecycle.cancel(input.runId);
    if (cancellation === null) {
      return {
        runId: input.runId,
        cancelled: false
      };
    }
    const endedAt = new Date().toISOString();
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
        runId: input.runId,
        telemetry: telemetry.snapshot()
      });
    } catch (error) {
      this.runTelemetry.delete(input.runId);
      this.activeRunLifecycle.finish(input.runId);
      throw error;
    }
    this.runTelemetry.delete(input.runId);
    this.activeRunLifecycle.finish(input.runId);
    // A cancellation is not a pilot failure: the breaker only opens on exhaustion or real failures.
    this.options.pilot?.recordOutcome({ runId: input.runId, status: 'cancelled', errorCode: null });
    const cancellationReport = await this.options.repository.taskContracts.verify(input.runId, this.createTaskVerificationContext({
      response: null,
      workspacePath: snapshot.workspace?.path ?? null,
      researchProjectId: snapshot.researchProjectId ?? null
    }), ['Run cancelled before all acceptance checks completed.']);
    this.options.repository.taskContracts.saveHandoff(input.runId, {
      reason: 'cancelled',
      checkpointPresent: this.options.repository.hasCheckpoint(input.runId)
    });
    await this.publishTaskAcceptance(cancellationReport);
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
    void this.emitSessionEndBestEffort({
      runId: input.runId,
      threadId: cancellation.metadata.threadId,
      request: cancellation.metadata.request,
      signal: cancellation.abortController.signal,
      status: 'cancelled',
      error: null
    });
    return {
      runId: input.runId,
      cancelled: true
    };
  }

  async resumeRun(request: ChatResumeRunRequest): Promise<ChatResumeRunResult> {
    if (request.kind === 'checkpoint') return await this.resumeCheckpointRun(request);
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
    this.options.repository.taskContracts.assertMatchesSnapshot(run.id, snapshot.taskContract);
    this.options.repository.taskContracts.assertHandoffCanResume(run.id, request.threadId, request.interruptId);
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
      request.kind === 'approval' ? toHitlResumeValue(request.decisions) : { answer: request.answer };
    const resumePayload: AgentResumePayload = {
      ...toAgentResumePayload(this.options.repository.getRecordedResumePayload(run.id)),
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
    const abortController = new AbortController();
    let resumed: { event: TaskEvent; run: TaskRun; stream: AgentDeepAgentExecution };
    try {
      resumed = await this.options.repository.dispatchResume({
        audit: resumeAudit,
        interruptId: request.interruptId,
        openStream: async (dispatchedRun) =>
          requireAgentExecution(
            await deepAgentExecutor.execute({
              abortSignal: abortController.signal,
              modelHandle,
              observeModelUsage: usage => telemetry.observeModelUsage(usage),
              resumePayload,
              run: dispatchedRun,
              snapshot
            })
          ),
        runId: run.id
      });
      this.options.repository.taskContracts.clearHandoff(run.id);
    } catch (error) {
      abortController.abort();
      throw error;
    }
    const executionStream = resumed.stream;
    const resumedRun = resumed.run;
    const resumedRequest = createChatStartRunRequestFromSnapshot(snapshot, resumedRun);
    this.activeRunLifecycle.activate({
      abortController,
      runId: run.id,
      request: resumedRequest,
      threadId: resumedRun.threadId
    });
    const resumedAt = new Date().toISOString();
    const result: ChatResumeRunResult = {
      runId: run.id,
      threadId: run.threadId,
      resumedAt
    };
    const remainingInterrupts = pendingInterrupts.filter(
      (interrupt) => interrupt.interruptId !== request.interruptId
    );
    this.activeRunLifecycle.replacePendingInterrupts(run.id, remainingInterrupts);
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
    this.activeRunLifecycle.trackPendingRun(run.id, pendingRun);
    return result;
  }

  private async resumeCheckpointRun(request: Extract<ChatResumeRunRequest, { kind: 'checkpoint' }>): Promise<ChatResumeRunResult> {
    const run = this.options.repository.getRun(request.runId);
    if (run.threadId !== request.threadId) throw new Error('chat_resume_thread_mismatch');
    if (run.status !== 'interrupted') throw new Error('chat_resume_run_not_interrupted');
    if (run.modelId === null) throw new Error('chat_resume_run_missing');
    if (!this.options.repository.hasCheckpoint(run.id)) throw new Error('task_handoff_checkpoint_missing');
    const snapshot = this.options.repository.getRunExecutionSnapshot(run.id);
    this.options.repository.taskContracts.assertMatchesSnapshot(run.id, snapshot.taskContract);
    const previousReport = this.options.repository.taskContracts.readReport(run.id);
    const refreshedReport = await this.options.repository.taskContracts.refreshReport(run.id, this.createTaskVerificationContext({
      response: null,
      workspacePath: snapshot.workspace?.path ?? null,
      researchProjectId: snapshot.researchProjectId ?? null
    }));
    if (refreshedReport !== null && hashToolInput(refreshedReport) !== hashToolInput(previousReport)) {
      await this.publishTaskAcceptance(refreshedReport);
    }
    this.options.repository.taskContracts.assertCheckpointHandoffCanResume(run.id, request.threadId);
    const continuation = this.options.repository.taskContracts.createCheckpointContinuationContext(run.id);
    this.options.repository.taskContracts.enqueueCheckpointContinuation(run.id, continuation);
    const modelHandle = await this.options.modelFactory.createModelHandleByProviderAndModel({
      providerId: snapshot.model.providerId,
      modelId: snapshot.model.modelId
    });
    if (modelHandle.providerId !== snapshot.model.providerId || modelHandle.modelId !== snapshot.model.modelId) {
      throw new Error('run_execution_snapshot_model_mismatch');
    }
    if (this.options.deepAgentExecutor === undefined) throw new Error('agent_deep_agent_executor_missing');
    const deepAgentExecutor = this.options.deepAgentExecutor;
    const telemetry = this.getOrCreateRunTelemetry(run, snapshot);
    telemetry.resumeAfterInterruption();
    const abortController = new AbortController();
    let resumed: { run: TaskRun; stream: AgentDeepAgentExecution };
    try {
      resumed = await this.options.repository.dispatchCheckpointResume({
        openStream: async (dispatchedRun) => requireAgentExecution(await deepAgentExecutor.execute({
          abortSignal: abortController.signal,
          modelHandle,
          observeModelUsage: usage => telemetry.observeModelUsage(usage),
          resumeFromCheckpoint: true,
          run: dispatchedRun,
          snapshot
        })),
        runId: run.id,
        telemetry: telemetry.snapshot()
      });
    } catch (error) {
      abortController.abort();
      this.runTelemetry.delete(run.id);
      throw error;
    }
    this.options.repository.taskContracts.clearHandoff(run.id);
    const hiddenResumeAction = this.options.repository.taskContracts.disableCheckpointResume(run.id);
    if (hiddenResumeAction !== null && !hiddenResumeAction.checkpointResumeAvailable) {
      await this.publishTaskAcceptance(hiddenResumeAction);
    }
    const resumedRun = resumed.run;
    const resumedRequest = createChatStartRunRequestFromSnapshot(snapshot, resumedRun);
    this.activeRunLifecycle.activate({ abortController, runId: run.id, request: resumedRequest, threadId: resumedRun.threadId });
    const continuedAt = new Date().toISOString();
    const result: ChatResumeRunResult = { runId: run.id, threadId: run.threadId, resumedAt: continuedAt };
    await this.publish('agent.run.resumed', result);
    await this.publishChatRunEvent({ type: 'run_continued', runId: run.id, threadId: run.threadId, continuedAt });
    const pendingRun = this.executeRun({
      abortSignal: abortController.signal,
      enabledCapabilities: snapshot.capabilityManifest.resolvedCapabilities,
      input: resumedRun.userInput,
      mode: resumedRequest.mode,
      modelHandle,
      modelId: modelHandle.modelId,
      providerId: modelHandle.providerId,
      request: resumedRequest,
      executionStream: resumed.stream,
      resumeFromCheckpoint: true,
      run: resumedRun,
      runId: run.id,
      snapshot,
      threadId: resumedRun.threadId,
      workflowHint: readWorkflowHintFromSnapshot(snapshot.workflowHint)
    });
    this.activeRunLifecycle.trackPendingRun(run.id, pendingRun);
    return result;
  }

  listSessionMessages(input: { threadId: string; limit?: number }): SessionMessageEntry[] {
    return this.options.repository.listSessionMessages(input);
  }

  searchSessionMessages(input: SessionMessageSearchRequest): SessionMessageSearchResult {
    return this.options.repository.searchSessionMessages(input);
  }

  async listRunEvents(request: ChatRunEventsReplayRequest): Promise<ChatRunEventsReplayResult> {
    if (this.options.runEventLog === undefined) {
      throw new Error('agent_run_event_log_unavailable');
    }
    const previous = this.options.repository.taskContracts.readReport(request.runId);
    if (previous !== null) {
      const snapshot = this.options.repository.getRunExecutionSnapshot(request.runId);
      this.options.repository.taskContracts.assertMatchesSnapshot(request.runId, snapshot.taskContract);
      const refreshed = await this.options.repository.taskContracts.refreshReport(request.runId, this.createTaskVerificationContext({
        response: this.options.repository.listSessionMessages({ threadId: snapshot.threadId, limit: 200 })
          .filter((message) => message.role === 'assistant')
          .at(-1)?.content ?? null,
        workspacePath: snapshot.workspace?.path ?? null,
        researchProjectId: snapshot.researchProjectId ?? null
      }));
      if (refreshed !== null && hashToolInput(refreshed) !== hashToolInput(previous)) {
        await this.publishTaskAcceptance(refreshed);
      }
    }
    return {
      runId: request.runId,
      events: this.options.runEventLog.listRunEvents(request)
    };
  }

  getActiveRun(input: { threadId: string }): ActiveChatRun | null {
    return this.activeRunLifecycle.findActiveRun(input.threadId);
  }

  async shutdown(): Promise<void> {
    await this.activeRunLifecycle.shutdown();
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
    const snapshot = this.options.repository.getRunExecutionSnapshot(input.runId);
    this.options.repository.taskContracts.assertMatchesSnapshot(input.runId, snapshot.taskContract);
    const taskAcceptance = await this.options.repository.taskContracts.evaluate(input.runId, this.createTaskVerificationContext({
      response: input.assistantMessage,
      workspacePath: snapshot.workspace?.path ?? (input.workspacePath === undefined ? null : input.workspacePath),
      researchProjectId: snapshot.researchProjectId ?? null
    }));
    const terminal = this.options.repository.completeRunAtomically({
      assistantMessage: input.assistantMessage,
      durationMs: input.durationMs,
      endedAt: input.endedAt,
      modelId: input.modelId,
      providerId: input.providerId,
      runId: input.runId,
      runStartedAt: currentRun.startedAt,
      summary: input.summary,
      telemetry: input.telemetry,
      taskAcceptance,
      workspaceHash: workspaceIdentity === null ? null : workspaceIdentity.hash
    });
    const run = terminal.run;
    this.activeRunLifecycle.finish(input.runId);
    this.options.pilot?.recordOutcome({ runId: input.runId, status: 'completed', errorCode: null });
    if (terminal.acceptanceEvent !== null && terminal.acceptanceRunEvent?.type === 'task_acceptance') {
      await this.publishTaskAcceptance(terminal.acceptanceRunEvent.report, terminal.acceptanceEvent, terminal.acceptanceRunEvent);
    }
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

  private createTaskVerificationContext(input: {
    response: string | null;
    workspacePath: string | null;
    researchProjectId: string | null;
  }): TaskVerificationContext {
    const context: TaskVerificationContext = { workspacePath: input.workspacePath, response: input.response };
    if (input.researchProjectId !== null && this.options.researchStageProofProvider !== undefined) {
      context.researchProof = async (stage) => await this.options.researchStageProofProvider!(input.researchProjectId!, stage);
    }
    return context;
  }

  private async emitSessionEndBestEffort(input: Parameters<AgentLifecycleHookEmitter['emitSessionEnd']>[0]): Promise<void> {
    const lifecycleHooks = this.options.lifecycleHooks;
    if (lifecycleHooks === undefined) {
      return;
    }
    await bestEffort(
      () => lifecycleHooks.emitSessionEnd(input),
      error => this.reportNotificationFailure('agent_session_end_notification_failed', error, {
        runId: readNotificationRunId(input),
        notificationType: 'session_end'
      })
    );
  }

  private async publish<TPayload>(type: string, payload: TPayload): Promise<void> {
    await bestEffort(
      () => this.options.eventBus.publish({
        type,
        source: this.pluginId,
        payload,
        createdAt: new Date().toISOString()
      }),
      error => this.reportNotificationFailure('agent_event_bus_notification_failed', error, {
        runId: readNotificationRunId(payload),
        notificationType: type
      })
    );
  }

  private async publishChatRunEvent(payload: ChatRunEvent): Promise<void> {
    await this.persistChatRunEvent(payload);
    await this.publish(agentChatRunEventType, payload);
  }

  private async publishChatRunEventBestEffort(payload: ChatRunEvent, persist: boolean): Promise<void> {
    if (persist) {
      await this.persistChatRunEvent(payload);
    }
    await this.publish(agentChatRunEventType, payload);
  }

  private async persistChatRunEvent(payload: ChatRunEvent): Promise<void> {
    await bestEffort(
      () => {
        this.options.runEventLog?.recordRunEvent(payload);
      },
      error => this.reportNotificationFailure('agent_run_event_replay_persist_failed', error, {
        runId: payload.runId,
        notificationType: payload.type
      })
    );
  }

  private reportNotificationFailure(
    code: string,
    error: unknown,
    context: { notificationType: string; runId?: string }
  ): void {
    const details = {
      code,
      notificationType: context.notificationType,
      ...(context.runId === undefined ? {} : { runId: context.runId }),
      error: summarizeNotificationError(error)
    };
    try {
      console.warn('[AgentPluginRuntime] Noncritical notification failed.', details);
    } catch {
      // Logging is terminal best-effort work; it must not recurse into notification reporting.
    }
    try {
      this.options.repository.recordNotificationFailure(code);
    } catch (metricError) {
      try {
        console.warn('[AgentPluginRuntime] Notification metric persistence failed.', {
          code,
          error: summarizeNotificationError(metricError)
        });
      } catch {
        // Metric and log failures must not escape the notification boundary.
      }
    }
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

  private async publishTaskAcceptance(report: TaskAcceptance, taskEvent?: TaskEvent,
    chatEvent?: Extract<ChatRunEvent, { type: 'task_acceptance' }>): Promise<void> {
    const savedTaskEvent = taskEvent ?? this.options.repository.recordTaskAcceptance(report.runId, report);
    await this.publishTaskEvent(savedTaskEvent);
    await this.publishChatRunEventBestEffort(chatEvent ?? { type: 'task_acceptance', runId: report.runId, report }, false);
  }

  private async executeRun(input: ExecuteRunInput): Promise<void> {
    if (!this.activeRunLifecycle.isActive(input.runId)) {
      return;
    }
    const runStartedAtMs = parseTimestamp(input.run.startedAt, 'agent_run_telemetry_started_at_invalid');
    const telemetry = this.getOrCreateRunTelemetry(input.run, input.snapshot);
    const retryTelemetry = new RetryTelemetry(input.runId);
    let attempt = 0;
    let firstFailureAtMs: number | null = null;
    let executionStream = input.executionStream;
    let resumePayload = input.resumePayload;
    let resumeFromCheckpoint = input.resumeFromCheckpoint === true;
    while (this.activeRunLifecycle.isActive(input.runId)) {
      try {
        if (this.options.deepAgentExecutor === undefined) {
          throw new Error('agent_deep_agent_executor_missing');
        }
        const currentExecutionStream = executionStream;
        executionStream = undefined;
        const currentResumePayload = resumePayload;
        resumePayload = undefined;
        const execution = await this.executeDeepAgentRun({
          abortSignal: input.abortSignal,
          executionStream: currentExecutionStream,
          modelHandle: input.modelHandle,
          resumePayload: currentResumePayload,
          resumeFromCheckpoint,
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
        if (!this.activeRunLifecycle.isActive(input.runId)) {
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

        // 输出重试统计
        const retrySummary = retryTelemetry.summarize();
        if (retrySummary.totalRetries > 0) {
          console.log(`[Run ${input.runId}] 重试统计:`, {
            总次数: retrySummary.totalRetries,
            按层级: retrySummary.byLayer,
            按错误码: retrySummary.byErrorCode,
            平均延迟: `${retrySummary.avgDelayMs.toFixed(0)}ms`,
            Checkpoint恢复: retrySummary.checkpointResumes
          });
        }

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
        await this.emitSessionEndBestEffort({
          runId: input.runId,
          threadId: input.threadId,
          request: input.request,
          signal: input.abortSignal,
          status: 'completed',
          error: null
        });
        return;
      } catch (error) {
        if (!this.activeRunLifecycle.isActive(input.runId)) {
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
          nowMs,
          telemetry: retryTelemetry
        });
        if (decision.action === 'recover') {
          resumeFromCheckpoint = resumeFromCheckpoint || decision.resumeFromCheckpoint;
          const nextRetryAt = new Date(nowMs + decision.delayMs).toISOString();
          this.options.repository.transitionRun({
            endedAt: null,
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
            nextRetryAt,
            ...(resumeFromCheckpoint ? { resetOutput: true } : {})
          });
          try {
            await waitForRecoveryDelay(decision.delayMs, input.abortSignal);
          } catch (delayError) {
            if (!this.activeRunLifecycle.isActive(input.runId)) {
              return;
            }
            throw delayError;
          }
          this.options.repository.transitionRun({
            endedAt: null,
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
      modelId: input.input.modelId,
      providerId: input.input.providerId,
      retryable: input.failure.retryable,
      runId: input.input.runId,
      suggestion: input.failure.suggestion,
      telemetry: input.telemetry.snapshot()
    });
    this.options.pilot?.recordOutcome({ runId: input.input.runId, status: 'failed', errorCode: input.failure.code });
    const snapshot = this.options.repository.getRunExecutionSnapshot(input.input.runId);
    const failureReport = await this.options.repository.taskContracts.verify(input.input.runId, this.createTaskVerificationContext({
      response: null,
      workspacePath: snapshot.workspace?.path ?? null,
      researchProjectId: snapshot.researchProjectId ?? null
    }), [`Run failed: ${input.failure.code}`]);
    this.options.repository.taskContracts.saveHandoff(input.input.runId, {
      reason: 'failed',
      checkpointPresent: this.options.repository.hasCheckpoint(input.input.runId)
    });
    await this.publishTaskAcceptance(failureReport);
    this.runTelemetry.delete(input.input.runId);
    this.activeRunLifecycle.finish(input.input.runId);
    await this.emitSessionEndBestEffort({
      runId: input.input.runId,
      threadId: input.input.threadId,
      request: input.input.request,
      signal: input.input.abortSignal,
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
    snapshot: RunExecutionSnapshot;
    resumePayload?: AgentResumePayload;
    resumeFromCheckpoint: boolean;
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
              ...(input.resumeFromCheckpoint ? { resumeFromCheckpoint: true } : {}),
              ...(input.validatedAttachments === undefined
                ? {}
                : { validatedAttachments: input.validatedAttachments })
            })
          )
        : input.executionStream;
    try {
      for await (const event of execution.events) {
        if (!this.activeRunLifecycle.isActive(input.run.id)) {
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
    snapshot: RunExecutionSnapshot
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
    if (typeof request.researchProjectId === 'string' && request.researchProjectId.length > 0) {
      // 研究助手的目录只认项目记录，忽略渲染进程附带的 workspacePath。
      const projectPath = await this.resolveResearchProjectWorkspacePath(request.researchProjectId);
      return this.workspaceFromPath(projectPath, currentWorkspace);
    }
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
    return this.workspaceFromPath(workspacePath, currentWorkspace);
  }

  private async resolveResearchProjectWorkspacePath(projectId: string): Promise<string> {
    if (this.options.researchProjectProvider === undefined) {
      throw new RocDomainError({
        code: 'research_project_unavailable',
        message: '研究项目服务还没准备好，无法开始对话。',
        category: 'degraded',
        retryable: true,
        userAction: '稍后再发送。'
      });
    }
    const project = await this.options.researchProjectProvider(projectId);
    const workspacePath = project?.workspacePath?.trim() ?? '';
    if (project === null || workspacePath.length === 0) {
      throw new RocDomainError({
        code: project === null ? 'research_project_not_found' : 'research_project_workspace_required',
        message: project === null ? '当前研究项目不存在，无法开始对话。' : '当前研究项目没有工作目录，无法开始对话。',
        category: project === null ? 'not_found' : 'validation',
        retryable: false,
        userAction: project === null ? '重新打开研究项目后再试。' : '先为研究项目选择工作目录。'
      });
    }
    return workspacePath;
  }

  private workspaceFromPath(workspacePath: string, currentWorkspace: Workspace | null): Workspace {
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
    researchProjectId?: string | null;
  }): Promise<AgentCapabilityPreview> {
    if (this.options.capabilityPreviewProvider !== undefined) {
      return await this.getCapabilityPreview({
        explicitSkillIds: input.explicitSkillIds,
        mode: input.mode,
        requestedCapabilities: input.requestedCapabilities,
        shellAllowedCommands: input.shellAllowedCommands,
        workflowHint: input.workflowHint,
        researchProjectId: input.researchProjectId === undefined ? null : input.researchProjectId
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
      // 该回退路径只装配内置工具，不宣称 roc_self_config。
      selfConfigAvailable: false,
      shellAllowedCommands: input.shellAllowedCommands,
      skills: [],
      workflowHint: input.workflowHint,
      researchProjectId: input.researchProjectId === undefined ? null : input.researchProjectId
    });
    return {
      runnable: false,
      modelId: input.modelHandle.modelId,
      builtInTools: [],
      toolCards: compiled.toolCards,
      skillCards: compiled.skillCards,
      subagents: compiled.subagents,
      interruptOn: compiled.interruptOn,
      manifest: compiled.manifest,
      reason: '当前运行未配置能力预览提供者；仅装配内置工具。'
    };
  }

  private resolvePendingInterrupts(runId: string): PendingInterrupt[] {
    const pendingInterrupts = this.activeRunLifecycle.readPendingInterrupts(runId);
    if (pendingInterrupts !== undefined) {
      return pendingInterrupts;
    }
    const run = this.options.repository.getRun(runId);
    const persistedInterrupts = this.options.repository.interruptProjection.readPending({
      runId,
      threadId: run.threadId
    }).interrupts;
    if (persistedInterrupts.length > 0) {
      this.activeRunLifecycle.replacePendingInterrupts(runId, persistedInterrupts);
    }
    return persistedInterrupts;
  }

  private async handleRunInterrupted(input: {
    interrupts: readonly PendingInterrupt[];
    runId: string;
    telemetry: AgentRunTelemetryV1;
    threadId: string;
  }): Promise<void> {
    const interrupted = this.options.repository.markRunInterrupted({
      interrupts: input.interrupts,
      runId: input.runId,
      telemetry: input.telemetry,
      threadId: input.threadId
    });
    this.activeRunLifecycle.replacePendingInterrupts(input.runId, input.interrupts);
    for (const event of interrupted.events) {
      await this.publishTaskEvent(event);
    }
    const snapshot = this.options.repository.getRunExecutionSnapshot(input.runId);
    const blockedBy = input.interrupts.map((interrupt) => interrupt.payload.kind === 'approval'
      ? `Approval pending: ${interrupt.interruptId}`
      : `Answer pending: ${interrupt.interruptId}`);
    const report = await this.options.repository.taskContracts.verify(input.runId, this.createTaskVerificationContext({
      response: null,
      workspacePath: snapshot.workspace?.path ?? null,
      researchProjectId: snapshot.researchProjectId ?? null
    }), blockedBy);
    this.options.repository.taskContracts.saveHandoff(input.runId, {
      reason: 'approval_pending',
      checkpointPresent: this.options.repository.hasCheckpoint(input.runId)
    });
    await this.publishTaskAcceptance(report);
  }
}

function requireAgentExecution(value: unknown): AgentDeepAgentExecution {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new Error('agent_deep_agent_execution_invalid');
  }
  // value 来自未经类型化的执行器返回值，这里按名字探它的两个成员，不假设结构形状。
  const candidate = value as { events?: unknown; outcome?: unknown };
  const events = candidate.events;
  const outcome = candidate.outcome;
  if ((typeof events !== 'object' && typeof events !== 'function') || events === null
    || typeof (events as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
    throw new Error('agent_deep_agent_execution_invalid');
  }
  if (!(outcome instanceof Promise)) {
    throw new Error('agent_deep_agent_execution_invalid');
  }
  return value as AgentDeepAgentExecution;
}

type PilotPlan = {
  decision: PilotDecision;
  manifest: RunCapabilityManifestV1;
  removedTools: readonly string[];
};

/**
 * Keeps the descriptive preview in step with the frozen manifest. Only the starting-pilot path
 * removes tools; every other path passes the original preview through untouched, so the persisted
 * `context_manifest` event never advertises a tool the run cannot call.
 */
function narrowPreviewForPilot(
  preview: AgentCapabilityPreview,
  manifest: RunCapabilityManifestV1,
  removedTools: readonly string[]
): AgentCapabilityPreview {
  if (removedTools.length === 0) {
    return { ...preview, manifest };
  }
  const removed = new Set(removedTools);
  return {
    ...preview,
    manifest,
    toolCards: preview.toolCards.filter((card) => !removed.has(card.name)),
    subagents: preview.subagents.map((subagent) => ({
      ...subagent,
      tools: subagent.tools.filter((name) => !removed.has(name))
    }))
  };
}

function createRunExecutionSnapshotSeed(input: {
  capabilityPreview: AgentCapabilityPreview;
  dispatchKey: string | null;
  explicitSkillIds: string[];
  modelHandle: AgentModelHandle;
  request: ChatStartRunRequest;
  shellAllowedCommands?: readonly string[];
  workspace: Workspace | null;
}): RunExecutionSnapshotSeed {
  const mode = toRunExecutionMode(input.request.mode);
  return {
    schemaVersion: 7,
    submissionHash: hashToolInput(input.request),
    taskContract: createTaskContract(input.request),
    runOrigin: resolveRunOrigin(input.request),
    model: {
      providerId: input.modelHandle.providerId,
      modelId: input.modelHandle.modelId
    },
    mode,
    workspace: input.workspace === null ? null : resolveRuntimeWorkspaceIdentity(input.workspace.path),
    capabilityManifest: input.capabilityPreview.manifest,
    shellAllowedCommands: input.shellAllowedCommands === undefined ? undefined : [...input.shellAllowedCommands],
    budget: createRunBudget({
        contextBudgetTokens:
          input.modelHandle.langChainHandle === undefined
            ? null
            : input.modelHandle.langChainHandle.runtime.contextBudgetTokens
      }),
    workflowHint: input.request.workflowHint === undefined ? null : input.request.workflowHint,
    explicitSkillIds: input.explicitSkillIds,
    dispatchKey: input.dispatchKey,
    researchProjectId: input.request.researchProjectId === undefined ? null : input.request.researchProjectId
  };
}

function createTaskContract(request: ChatStartRunRequest): RunExecutionSnapshot['taskContract'] {
  const isReply = request.mode === 'chat' && request.acceptanceCriteria === undefined;
  return {
    contractVersion: 1,
    objective: request.input.trim(),
    constraints: [],
    kind: isReply ? 'reply' : 'task',
    criteria: request.acceptanceCriteria ?? [{
      id: 'A-01',
      description: isReply ? 'Produce a visible response.' : 'No verifiable task acceptance criteria were supplied.',
      check: isReply ? { kind: 'response' } : { kind: 'unverified' }
    }]
  };
}

function resolveDispatchKey(request: ChatStartRunRequest): string | null {
  if (request.dispatchKey === undefined) {
    return null;
  }
  const dispatchKey = request.dispatchKey.trim();
  if (dispatchKey.length === 0) {
    throw new Error('agent_dispatch_key_empty');
  }
  return dispatchKey;
}

function toExistingRunStartResult(repository: AgentSessionRepository, run: TaskRun, request: ChatStartRunRequest): ChatStartRunResult {
  const snapshot = repository.getRunExecutionSnapshot(run.id);
  if (snapshot.submissionHash !== hashToolInput(request)) throw new Error('agent_submission_input_drift');
  return {
    runId: run.id,
    mode: createChatStartRunRequestFromSnapshot(snapshot, run).mode,
    threadId: run.threadId,
    providerId: snapshot.model.providerId,
    modelId: snapshot.model.modelId,
    createdAt: run.startedAt
  };
}

function resolveRunOrigin(request: ChatStartRunRequest): RunExecutionSnapshot['runOrigin'] {
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
  capabilityManifest: RunExecutionSnapshot['capabilityManifest']
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
