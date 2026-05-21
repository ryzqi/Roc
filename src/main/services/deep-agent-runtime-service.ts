import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import { Command, MemorySaver, type BaseStore, type InterruptPayload } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { HITLRequest, HITLResponse } from 'langchain';
import type {
  ChatPendingApproval,
  ChatResumeRunRequest,
  ChatResumeRunResult,
  ChatRunEvent,
  ChatStartRunRequest,
  ChatStartRunResult,
  TaskRun
} from '../../shared/types';
import type { AgentService } from './agent-service';
import type { DatabaseService } from './database-service';
import { RocDomainError } from './errors';
import type { FileService } from './file-service';
import type { LangChainModelFactory } from './langchain-model-factory';
import type { LogService } from './log-service';
import type { McpService } from './mcp-service';
import type { PerformanceObserverService } from './performance-observer-service';
import type { RocPaths } from './paths';
import type { ShellExecutionService } from './shell-execution-service';
import type { TaskSchedulerService } from './task-scheduler-service';
import type { TaskService } from './task-service';
import type { WebReadService } from './web-read-service';
import type { WorkspaceService } from './workspace-service';
import { executeWithProviderRequestRetry, isRetryableProviderRequestFailure } from './provider-request-retry';
import { applyBackgroundTaskToolDecision } from './deep-agent/background-task-tools';
import {
  createDeepAgentSession,
  errorMapping,
  prompt,
  recordUtils,
  redact,
  RUN_EVENT_NAME,
  SqliteLangGraphStore,
  streamConsumers,
  type ActiveRun,
  type RunExecutionContext
} from './deep-agent';

type ResumeContext = {
  enabledCapabilities: ChatStartRunRequest['enabledCapabilities'];
  modelHandle: Awaited<ReturnType<LangChainModelFactory['createChatModelByModelId']>>;
  runId: string;
  taskRun: TaskRun;
  threadId: string;
};

export class DeepAgentRuntimeService {
  private readonly eventEmitter = new EventEmitter();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly longRunningTimers = new Map<string, NodeJS.Timeout>();
  private checkpointer: MemorySaver | SqliteSaver | null = null;
  private readonly store: BaseStore;
  private taskSchedulerService: TaskSchedulerService | null = null;
  private readonly pendingInterrupts = new Map<
    string,
    {
      threadId: string;
      approval: ChatPendingApproval;
    }
  >();

  constructor(
    private readonly langChainModelFactory: LangChainModelFactory,
    private readonly taskService: TaskService,
    private readonly databaseService: DatabaseService,
    private readonly agentService: AgentService,
    private readonly workspaceService: WorkspaceService,
    private readonly fileService: FileService,
    private readonly mcpService: McpService,
    private readonly webReadService: WebReadService,
    private readonly shellExecutionService: ShellExecutionService,
    private readonly paths: RocPaths,
    private readonly performanceObserverService: PerformanceObserverService,
    private readonly logService: LogService
  ) {
    this.store = new SqliteLangGraphStore(databaseService);
  }

  attachScheduler(taskSchedulerService: TaskSchedulerService): void {
    this.taskSchedulerService = taskSchedulerService;
  }

  private getOrCreateCheckpointer(): MemorySaver | SqliteSaver {
    if (this.checkpointer !== null) {
      return this.checkpointer;
    }
    if (process.env.VITEST === 'true') {
      this.checkpointer = new MemorySaver();
      return this.checkpointer;
    }

    // App services construct this runtime before DatabaseService.initialize(),
    // so the shared SQLite checkpointer must be created lazily on first task run.
    this.checkpointer = new SqliteSaver(this.databaseService.db);
    return this.checkpointer;
  }

  onRunEvent(listener: (event: ChatRunEvent) => void): () => void {
    this.eventEmitter.on(RUN_EVENT_NAME, listener);
    return () => {
      this.eventEmitter.off(RUN_EVENT_NAME, listener);
    };
  }

  async startRun(request: ChatStartRunRequest): Promise<ChatStartRunResult> {
    const input = request.input.trim();
    if (input.length === 0) {
      throw new RocDomainError({
        code: 'chat_input_empty',
        message: '聊天输入不能为空。',
        category: 'validation',
        retryable: true,
        userAction: '请输入要发送给 Roc 的内容。'
      });
    }

    const modelHandle = await this.langChainModelFactory.createDefaultChatModel({
      streaming: true
    });
    const createdAt = new Date().toISOString();
    const preparedInput = request.mode === 'task' && typeof request.threadId === 'string'
      ? this.prependPendingThreadContext(request.threadId, input)
      : input;
    const taskRun = this.createTaskRunIfNeeded(request, preparedInput, modelHandle.modelId);
    const threadId = request.mode === 'task' && taskRun !== null ? taskRun.threadId : prompt.resolveThreadId(request.threadId);
    const runId = request.mode === 'task' && taskRun !== null ? taskRun.id : `chat_${randomUUID()}`;
    const abortController = new AbortController();
    const activeRun: ActiveRun = {
      abortController,
      createdAt,
      enabledCapabilities: request.enabledCapabilities,
      modelHandle,
      mode: request.mode,
      runId,
      taskRun,
      threadId
    };

    this.activeRuns.set(runId, activeRun);
    this.emit({
      type: 'run_started',
      runId,
      mode: request.mode,
      threadId,
      providerId: modelHandle.provider.id,
      modelId: modelHandle.modelId,
      createdAt
    });

    const context: RunExecutionContext = {
      ...activeRun,
      input: preparedInput,
      startedAtMs: Date.now()
    };
    this.scheduleLongRunningEvaluation(taskRun);
    void this.executeRun(context);

    return {
      runId,
      mode: request.mode,
      threadId,
      providerId: modelHandle.provider.id,
      modelId: modelHandle.modelId,
      createdAt
    };
  }

  cancelRun(runId: string): { runId: string; cancelled: boolean } {
    const activeRun = this.activeRuns.get(runId);
    if (activeRun === undefined) {
      return {
        runId,
        cancelled: false
      };
    }
    activeRun.abortController.abort();
    return {
      runId,
      cancelled: true
    };
  }

  async resumeRun(request: ChatResumeRunRequest): Promise<ChatResumeRunResult> {
    const pending = this.pendingInterrupts.get(request.runId);
    if (pending === undefined) {
      throw new RocDomainError({
        code: 'chat_resume_no_pending_interrupt',
        message: '当前运行没有待处理的审批中断。',
        category: 'validation',
        retryable: true,
        userAction: '请先等待需要审批的运行中断。'
      });
    }
    if (pending.threadId !== request.threadId) {
      throw new RocDomainError({
        code: 'chat_resume_thread_mismatch',
        message: '恢复运行时的线程 ID 与待审批运行不匹配。',
        category: 'validation',
        retryable: false,
        userAction: '请回到原任务会话后重试。'
      });
    }
    if (request.interruptId !== undefined && request.interruptId !== pending.approval.interruptId) {
      throw new RocDomainError({
        code: 'chat_resume_interrupt_mismatch',
        message: '恢复运行时的审批中断 ID 与待处理审批不匹配。',
        category: 'validation',
        retryable: false,
        userAction: '请使用当前审批卡对应的操作按钮重试。'
      });
    }

    const resumeContext = await this.readResumeContext(request.runId, request.threadId);
    const abortController = new AbortController();
    const activeRun: ActiveRun = {
      abortController,
      createdAt: resumeContext.taskRun.startedAt,
      enabledCapabilities: resumeContext.enabledCapabilities,
      modelHandle: resumeContext.modelHandle,
      mode: 'task',
      runId: resumeContext.runId,
      taskRun: resumeContext.taskRun,
      threadId: resumeContext.threadId
    };
    this.activeRuns.set(request.runId, activeRun);

    const resumedAt = new Date().toISOString();
    const decisions = this.resolveResumeDecisions(request, pending.approval);
    const resumePayload: HITLResponse = {
      decisions
    };
    this.taskService.recordApprovalDecision({
      runId: resumeContext.taskRun.id,
      payload: {
        interruptId: pending.approval.interruptId,
        decisions
      }
    });
    this.taskService.markRunResumed(resumeContext.taskRun.id);
    this.emit({
      type: 'run_resumed',
      runId: request.runId,
      threadId: request.threadId,
      interruptId: pending.approval.interruptId
    });

    const context: RunExecutionContext = {
      ...activeRun,
      input: resumeContext.taskRun.userInput,
      startedAtMs: Date.now()
    };
    await this.executeResume(context, resumePayload);

    return {
      runId: request.runId,
      threadId: request.threadId,
      resumedAt
    };
  }

  private async readResumeContext(runId: string, threadId: string): Promise<ResumeContext> {
    let taskRun: TaskRun;
    try {
      taskRun = this.taskService.getRun(runId);
    } catch {
      throw new RocDomainError({
        code: 'chat_resume_run_missing',
        message: '待恢复的运行上下文不存在。',
        category: 'validation',
        retryable: true,
        userAction: '请重新发起本轮任务。'
      });
    }

    if (taskRun.threadId !== threadId) {
      throw new RocDomainError({
        code: 'chat_resume_thread_mismatch',
        message: '恢复运行时的线程 ID 与待审批运行不匹配。',
        category: 'validation',
        retryable: false,
        userAction: '请回到原任务会话后重试。'
      });
    }
    if (taskRun.modelId === null) {
      throw new RocDomainError({
        code: 'chat_resume_run_missing',
        message: '待恢复的运行上下文不存在。',
        category: 'validation',
        retryable: true,
        userAction: '请重新发起本轮任务。'
      });
    }

    return {
      enabledCapabilities: taskRun.enabledCapabilities,
      modelHandle: await this.langChainModelFactory.createChatModelByModelId(taskRun.modelId, {
        streaming: true
      }),
      runId: taskRun.id,
      taskRun,
      threadId: taskRun.threadId
    };
  }

  private createTaskRunIfNeeded(
    request: ChatStartRunRequest,
    input: string,
    modelId: string
  ): TaskRun | null {
    if (request.mode !== 'task') {
      return null;
    }

    const capabilityPreview = this.agentService.getCapabilityPreview(request.enabledCapabilities);
    const run = this.taskService.createTaskRun({
      threadId: request.threadId ?? undefined,
      userInput: input,
      modelId,
      enabledCapabilities: request.enabledCapabilities
    });
    this.taskService.markRunRunning(run.id);
    this.taskService.evaluateLongRunningPromotion(run.threadId);
    this.taskService.recordAgentCapabilityManifest({
      threadId: run.threadId,
      runId: run.id,
      preview: capabilityPreview
    });
    return run;
  }

  private prependPendingThreadContext(threadId: string, input: string): string {
    const pendingContext = this.taskService.takePendingThreadContext(threadId);
    if (pendingContext === null) {
      return input;
    }
    return `${pendingContext}\n\n[用户最新请求]\n${input}`;
  }

  private async executeRun(context: RunExecutionContext): Promise<void> {
    try {
      let attemptProducedVisibleOutput = false;
      let retryCount = 0;
      await executeWithProviderRequestRetry(async () => {
        attemptProducedVisibleOutput = false;
        const providerStartedAtMs = performance.now();
        let firstVisibleTokenRecorded = false;
        const session = await createDeepAgentSession({
          agentService: this.agentService,
          context,
          fileService: this.fileService,
          getCheckpointer: () => this.getOrCreateCheckpointer(),
          mcpService: this.mcpService,
          paths: this.paths,
          shellExecutionService: this.taskBoundShellExecutionService(context),
          store: this.store,
          taskSchedulerService: this.requireTaskSchedulerService(),
          taskService: this.taskService,
          webReadService: this.webReadService,
          workspaceService: this.workspaceService
        });

        try {
          const run = await session.agent.streamEvents(
            {
              messages: [new HumanMessage(context.input)]
            },
            {
              version: 'v3',
              configurable: session.configurable,
              signal: context.abortController.signal
            }
          );

          await this.consumeSessionStreams(run, context, session, () => {
            attemptProducedVisibleOutput = true;
            if (!firstVisibleTokenRecorded) {
              firstVisibleTokenRecorded = true;
              this.recordProviderTiming('provider_first_token', context, providerStartedAtMs, retryCount, session.usageAccumulator);
            }
          });

          if (run.interrupted) {
            this.handleInterruptedRun(context, run.interrupts);
            return;
          }

          await Promise.resolve(run.output);
          this.completeRun(context, session.usageAccumulator, session.assistantChunks, false, providerStartedAtMs, retryCount);
        } finally {
          await Promise.allSettled(session.closers.map(async (close) => close()));
        }
      }, {
        signal: context.abortController.signal,
        shouldRetry: (error) => {
          const retryable = !attemptProducedVisibleOutput && isRetryableProviderRequestFailure(error);
          if (retryable) {
            retryCount += 1;
          }
          return retryable;
        }
      });
    } catch (error) {
      this.failRun(context, error);
    } finally {
      this.clearLongRunningEvaluation(context.runId);
      this.activeRuns.delete(context.runId);
    }
  }

  private async executeResume(context: RunExecutionContext, resumePayload: HITLResponse): Promise<void> {
    const session = await createDeepAgentSession({
      agentService: this.agentService,
      context,
      fileService: this.fileService,
      getCheckpointer: () => this.getOrCreateCheckpointer(),
      mcpService: this.mcpService,
      paths: this.paths,
      shellExecutionService: this.taskBoundShellExecutionService(context),
      store: this.store,
      taskSchedulerService: this.requireTaskSchedulerService(),
      taskService: this.taskService,
      webReadService: this.webReadService,
      workspaceService: this.workspaceService
    });

    const providerStartedAtMs = performance.now();
    try {
      let firstVisibleTokenRecorded = false;
      const run = await session.agent.streamEvents(new Command({ resume: resumePayload }), {
        version: 'v3',
        configurable: session.configurable,
        signal: context.abortController.signal
      });

      await this.consumeSessionStreams(run, context, session, () => {
        if (!firstVisibleTokenRecorded) {
          firstVisibleTokenRecorded = true;
          this.recordProviderTiming('provider_first_token', context, providerStartedAtMs, 0, session.usageAccumulator);
        }
      });

      if (run.interrupted) {
        this.handleInterruptedRun(context, run.interrupts);
        return;
      }

      await Promise.resolve(run.output);
      this.completeRun(context, session.usageAccumulator, session.assistantChunks, true, providerStartedAtMs, 0);
    } catch (error) {
      this.failRun(context, error);
    } finally {
      await Promise.allSettled(session.closers.map(async (close) => close()));
      this.clearLongRunningEvaluation(context.runId);
      this.activeRuns.delete(context.runId);
    }
  }

  private scheduleLongRunningEvaluation(taskRun: TaskRun | null): void {
    if (taskRun === null) {
      return;
    }
    const timer = setTimeout(() => {
      this.longRunningTimers.delete(taskRun.id);
      if (!this.activeRuns.has(taskRun.id)) {
        return;
      }
      this.taskService.evaluateLongRunningPromotion(taskRun.threadId);
    }, 90_000);
    this.longRunningTimers.set(taskRun.id, timer);
  }

  private clearLongRunningEvaluation(runId: string): void {
    const timer = this.longRunningTimers.get(runId);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    this.longRunningTimers.delete(runId);
  }

  private taskBoundShellExecutionService(
    context: RunExecutionContext
  ): import('./deep-agent').AgentExecuteAdapter {
    return {
      executeAgentCommand: async (input) =>
        await this.shellExecutionService.executeAgentCommandAsync({
          ...input,
          threadId: context.taskRun?.threadId ?? context.threadId,
          runId: context.taskRun?.id ?? context.runId
        })
    };
  }

  private requireTaskSchedulerService(): TaskSchedulerService {
    if (this.taskSchedulerService === null) {
      throw new Error('TaskSchedulerService has not been attached.');
    }
    return this.taskSchedulerService;
  }

  private emitTodoEvent(runId: string, candidate: unknown): void {
    const todos = recordUtils.readTodos(candidate);
    if (todos === null) {
      return;
    }
    this.emit({
      type: 'todo_event',
      runId,
      todos
    });
  }

  private emit(event: ChatRunEvent): void {
    this.eventEmitter.emit(RUN_EVENT_NAME, event);
  }

  private logProviderUsage(context: RunExecutionContext, usage: streamConsumers.ProviderUsageAccumulator): void {
    const promptTokens = usage.promptTokens ?? 0;
    const cacheReadTokens = usage.cacheReadTokens ?? 0;
    this.logService.append({
      level: 'info',
      message: 'Deep Agent provider usage recorded.',
      data: {
        provider: context.modelHandle.provider.type,
        providerId: context.modelHandle.provider.id,
        model: context.modelHandle.modelId,
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
        cache_read: usage.cacheReadTokens,
        cache_creation: usage.cacheCreationTokens,
        cache_hit_ratio: promptTokens > 0 ? cacheReadTokens / promptTokens : 0
      }
    });
  }

  private recordProviderTiming(
    phase: 'provider_first_token' | 'provider_completed',
    context: RunExecutionContext,
    providerStartedAtMs: number,
    retryCount: number,
    usage: streamConsumers.ProviderUsageAccumulator
  ): void {
    this.performanceObserverService.record({
      phase,
      label: `${context.modelHandle.provider.id}:${context.modelHandle.modelId}`,
      startedAtMs: providerStartedAtMs,
      durationMs: performance.now() - providerStartedAtMs,
      metadata: {
        providerId: context.modelHandle.provider.id,
        providerType: context.modelHandle.provider.type,
        modelId: context.modelHandle.modelId,
        mode: context.mode,
        retryCount,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens
      }
    });
  }

  private readPendingApproval(interrupts: readonly InterruptPayload[], runId: string): ChatPendingApproval {
    if (interrupts.length > 1) {
      throw new RocDomainError({
        code: 'chat_interrupt_payload_unsupported',
        message: '当前版本暂不支持同一轮运行同时返回多个顶层审批中断。',
        category: 'validation',
        retryable: false,
        userAction: '请调整本轮任务拆分方式后重试。'
      });
    }
    const interrupt = interrupts[0];
    if (interrupt === undefined) {
      throw new RocDomainError({
        code: 'chat_interrupt_payload_invalid',
        message: '运行进入审批中断，但没有收到可恢复的中断负载。',
        category: 'validation',
        retryable: false,
        userAction: '请重新发起本轮任务。'
      });
    }
    const payload = interrupt.payload;
    if (!this.isHitlRequest(payload)) {
      throw new RocDomainError({
        code: 'chat_interrupt_payload_invalid',
        message: '审批中断负载结构无效，无法展示审批请求。',
        category: 'validation',
        retryable: false,
        userAction: '请重新发起本轮任务。'
      });
    }
    return {
      interruptId: interrupt.interruptId,
      ...payload
    };
  }

  private resolveResumeDecisions(request: ChatResumeRunRequest, approval: ChatPendingApproval): HITLResponse['decisions'] {
    if (request.decisions.length !== approval.actionRequests.length) {
      throw new RocDomainError({
        code: 'chat_resume_decision_count_mismatch',
        message: '审批恢复提交的决策数量与待审批动作数量不一致。',
        category: 'validation',
        retryable: false,
        userAction: '请按当前审批卡展示的全部动作重新提交审批。'
      });
    }

    return request.decisions.map((decision, index) => {
      const actionRequest = approval.actionRequests[index];
      const reviewConfig = approval.reviewConfigs[index];
      if (actionRequest === undefined || reviewConfig === undefined) {
        throw new RocDomainError({
          code: 'chat_interrupt_payload_invalid',
          message: '审批中断负载结构无效，无法恢复审批请求。',
          category: 'validation',
          retryable: false,
          userAction: '请重新发起本轮任务。'
        });
      }
      if (reviewConfig.actionName !== actionRequest.name) {
        throw new RocDomainError({
          code: 'chat_interrupt_payload_invalid',
          message: '审批中断负载结构无效，审批动作与决策配置不匹配。',
          category: 'validation',
          retryable: false,
          userAction: '请重新发起本轮任务。'
        });
      }
      if (!reviewConfig.allowedDecisions.includes(decision.type)) {
        throw new RocDomainError({
          code: 'chat_resume_decision_not_allowed',
          message: `审批动作 ${actionRequest.name} 不允许决策类型 ${decision.type}。`,
          category: 'validation',
          retryable: false,
          userAction: '请按审批卡允许的决策类型重新提交。'
        });
      }
      if (this.isBackgroundTaskAction(actionRequest.name)) {
        const result = applyBackgroundTaskToolDecision({
          taskService: this.taskService,
          schedulerService: this.requireTaskSchedulerService(),
          actionName: actionRequest.name,
          actionArgs: actionRequest.args,
          decision
        });
        return {
          ...decision,
          editedAction: {
            name: actionRequest.name,
            args: result
          }
        };
      }
      if (decision.type === 'edit') {
        const editedAction = Reflect.get(decision, 'editedAction');
        const editedActionName =
          typeof editedAction === 'object' && editedAction !== null
            ? Reflect.get(editedAction, 'name')
            : undefined;
        if (editedActionName !== actionRequest.name) {
          throw new RocDomainError({
            code: 'chat_resume_edited_action_mismatch',
            message: `审批动作 ${actionRequest.name} 只允许编辑参数，不允许改成 ${String(editedActionName ?? 'unknown')}。`,
            category: 'validation',
            retryable: false,
            userAction: '请仅编辑当前审批动作的参数后重新提交。'
          });
        }
      }
      return decision;
    });
  }

  private isHitlRequest(value: unknown): value is HITLRequest {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const actionRequests = Reflect.get(value, 'actionRequests');
    const reviewConfigs = Reflect.get(value, 'reviewConfigs');
    return Array.isArray(actionRequests) && Array.isArray(reviewConfigs);
  }

  private isBackgroundTaskAction(
    name: string
  ): name is 'propose_background_task' | 'update_background_task' | 'cancel_background_task' {
    return name === 'propose_background_task' || name === 'update_background_task' || name === 'cancel_background_task';
  }

  private async consumeSessionStreams(
    run: {
      messages: AsyncIterable<unknown>;
      subagents: AsyncIterable<unknown>;
      toolCalls: AsyncIterable<unknown>;
    },
    context: RunExecutionContext,
    session: {
      assistantChunks: string[];
      reasoningChunks: string[];
      usageAccumulator: streamConsumers.ProviderUsageAccumulator;
    },
    onVisibleOutput?: () => void
  ): Promise<void> {
    const taskEvents: Array<{
      threadId: string;
      runId: string;
      type: 'message_delta' | 'tool_call' | 'subagent_started' | 'subagent_completed';
      payload: Record<string, unknown>;
    }> = [];
    const callbacks = {
      emitRuntimeEvent: (event: ChatRunEvent) => this.emit(event),
      emitTodoEvent: (candidate: unknown) => this.emitTodoEvent(context.runId, candidate),
      markVisibleOutput: onVisibleOutput,
      recordTaskEvent: (
        type: 'message_delta' | 'tool_call' | 'subagent_started' | 'subagent_completed',
        payload: Record<string, unknown>
      ) => {
        if (context.taskRun === null) {
          return;
        }
        taskEvents.push({
          threadId: context.taskRun.threadId,
          runId: context.taskRun.id,
          type,
          payload
        });
      }
    };

    try {
      await Promise.all([
        streamConsumers.consumeToolCallStream({
          calls: run.toolCalls as AsyncIterable<unknown>,
          context,
          callbacks
        }),
        streamConsumers.consumeMessageStream({
          messages: run.messages as AsyncIterable<unknown>,
          context,
          assistantChunks: session.assistantChunks,
          reasoningChunks: session.reasoningChunks,
          usageAccumulator: session.usageAccumulator,
          callbacks
        }),
        streamConsumers.consumeSubagentStream({
          subagents: run.subagents as AsyncIterable<unknown>,
          context,
          callbacks
        })
      ]);
    } finally {
      if (taskEvents.length > 0) {
        this.taskService.recordEvents(taskEvents);
        if (context.taskRun !== null) {
          this.taskService.evaluateLongRunningPromotion(context.taskRun.threadId);
        }
      }
    }
  }

  private completeRun(
    context: RunExecutionContext,
    usage: streamConsumers.ProviderUsageAccumulator,
    assistantChunks: readonly string[],
    clearPendingInterrupt = false,
    providerStartedAtMs: number | null = null,
    retryCount = 0
  ): void {
    const assistantMessage = prompt.resolveAssistantMessage([...assistantChunks]);
    const result = prompt.buildProviderExecutionResult({
      modelHandle: context.modelHandle,
      createdAt: context.createdAt,
      startedAtMs: context.startedAtMs,
      inputLength: context.input.length,
      assistantMessage,
      usage
    });
    this.logProviderUsage(context, usage);
    if (providerStartedAtMs !== null) {
      this.recordProviderTiming('provider_completed', context, providerStartedAtMs, retryCount, usage);
    }
    if (context.taskRun !== null) {
      this.taskService.completeRunWithProviderResult({
        runId: context.taskRun.id,
        result
      });
    }
    if (clearPendingInterrupt) {
      this.pendingInterrupts.delete(context.runId);
    }
    this.emit({
      type: 'run_completed',
      runId: context.runId,
      threadId: context.threadId,
      providerId: result.providerId,
      modelId: result.modelId,
      createdAt: context.createdAt,
      durationMs: result.durationMs,
      summary: result.summary,
      assistantMessage: result.assistantMessage
    });
  }

  private failRun(context: RunExecutionContext, error: unknown): void {
    const failure = errorMapping.toRunFailure(error);
    if (context.taskRun !== null) {
      this.taskService.failRunWithProviderError({
        runId: context.taskRun.id,
        providerId: context.modelHandle.provider.id,
        modelId: context.modelHandle.modelId,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable
      });
    }
    this.emit({
      type: 'run_failed',
      runId: context.runId,
      threadId: context.threadId,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable
    });
  }

  private handleInterruptedRun(context: RunExecutionContext, interrupts: readonly InterruptPayload[]): void {
    const approval = this.readPendingApproval(interrupts, context.runId);
    if (context.taskRun !== null) {
      this.pendingInterrupts.set(context.runId, {
        threadId: context.threadId,
        approval
      });
      this.taskService.recordApprovalRequested({
        runId: context.taskRun.id,
        payload: approval
      });
      this.taskService.markRunWaitingUser(context.taskRun.id);
      this.taskService.evaluateLongRunningPromotion(context.taskRun.threadId);
    }
    this.emit({
      type: 'run_interrupted',
      runId: context.runId,
      threadId: context.threadId,
      interruptId: approval.interruptId,
      payload: approval
    });
  }
}
