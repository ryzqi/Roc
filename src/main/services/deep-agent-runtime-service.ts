import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import { Command, InMemoryStore, MemorySaver, type BaseStore, type InterruptPayload } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { HITLRequest, HITLResponse } from 'langchain';
import type {
  ChatPendingApproval,
  ChatResumeRunRequest,
  ChatResumeRunResult,
  ChatRunEvent,
  ChatStartRunRequest,
  ChatStartRunResult,
  AppSettings,
  TaskRun
} from '../../shared/types';
import type { AgentService } from './agent-service';
import type { DatabaseService } from './database-service';
import { RocDomainError } from './errors';
import type { FileService } from './file-service';
import type { LangChainModelFactory } from './langchain-model-factory';
import type { LogService } from './log-service';
import type { ConsolidatorService } from './memory/consolidator';
import type { PrecompactionService } from './memory/precompaction';
import type { MemoryService } from './memory-service';
import type { MetricsService } from './metrics-service';
import type { SessionArchiveService } from './memory/session-archive';
import type { McpService } from './mcp-service';
import type { PerformanceObserverService } from './performance-observer-service';
import type { RocPaths } from './paths';
import type { ShellExecutionService } from './shell-execution-service';
import type { TaskSchedulerService } from './task-scheduler-service';
import type { TaskService } from './task-service';
import type { WebReadService } from './web-read-service';
import type { WorkspaceService } from './workspace-service';
import { defaultErrorTracker, defaultStepTracker } from './forge-guardrails';
import { executeWithProviderRequestRetry, isRetryableProviderRequestFailure } from './provider-request-retry';
import { applyBackgroundTaskToolDecision } from './deep-agent/background-task-tools';
import {
  createDeepAgentSession,
  errorMapping,
  prompt,
  recordUtils,
  redact,
  RUN_EVENT_NAME,
  streamConsumers,
  type ActiveRun,
  type DeepAgentSession,
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
    private readonly memoryService: MemoryService,
    private readonly consolidatorService: ConsolidatorService,
    private readonly precompactionService: PrecompactionService,
    private readonly sessionArchiveService: SessionArchiveService,
    private readonly agentService: AgentService,
    private readonly workspaceService: WorkspaceService,
    private readonly fileService: FileService,
    private readonly mcpService: McpService,
    private readonly webReadService: WebReadService,
    private readonly shellExecutionService: ShellExecutionService,
    private readonly paths: RocPaths,
    private readonly getMemorySettings: () => AppSettings['memory'],
    private readonly performanceObserverService: PerformanceObserverService,
    private readonly logService: LogService,
    private readonly metricsService: MetricsService
  ) {
    void databaseService;
    this.store = new InMemoryStore();
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
    const traceId = `trace_${randomUUID()}`;
    const agentInput = this.prependWorkflowHintContext(request, input);
    const taskRun = this.createTaskRunIfNeeded(request, input, modelHandle.modelId);
    const threadId = request.mode === 'task' && taskRun !== null ? taskRun.threadId : prompt.resolveThreadId(request.threadId);
    const runId = request.mode === 'task' && taskRun !== null ? taskRun.id : `chat_${randomUUID()}`;
    const abortController = new AbortController();
    this.metricsService.incrementCounter('agent.run.started', {
      mode: request.mode,
      providerId: modelHandle.provider.id
    });
    const activeRun: ActiveRun = {
      abortController,
      createdAt,
      enabledCapabilities: request.enabledCapabilities,
      modelHandle,
      mode: request.mode,
      runId,
      taskRun,
      threadId,
      workflowHint: request.workflowHint ?? null
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
      agentInput,
      input,
      startedAtMs: Date.now(),
      traceId
    };
    this.logService.info('Agent run started.', {
      service: 'deep-agent-runtime',
      component: 'startRun',
      traceId,
      runId,
      threadId,
      metadata: {
        mode: request.mode,
        modelId: modelHandle.modelId,
        providerId: modelHandle.provider.id,
        workflowHint: request.workflowHint ?? null
      }
    });
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
      threadId: resumeContext.threadId,
      workflowHint: null
    };
    this.activeRuns.set(request.runId, activeRun);

    const resumedAt = new Date().toISOString();
    const traceId = `trace_${randomUUID()}`;
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
      agentInput: resumeContext.taskRun.userInput,
      input: resumeContext.taskRun.userInput,
      startedAtMs: Date.now(),
      traceId
    };
    this.logService.info('Agent run resumed.', {
      service: 'deep-agent-runtime',
      component: 'resumeRun',
      traceId,
      runId: request.runId,
      threadId: request.threadId,
      metadata: {
        interruptId: pending.approval.interruptId,
        modelId: resumeContext.modelHandle.modelId,
        providerId: resumeContext.modelHandle.provider.id
      }
    });
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
    } catch (error) {
      this.logService.warn('Failed to retrieve task run.', {
        service: 'deep-agent-runtime',
        component: 'readResumeContext',
        runId,
        threadId,
        metadata: {
          error: String(error)
        }
      });
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
    this.taskService.recordAgentCapabilityManifest({
      threadId: run.threadId,
      runId: run.id,
      preview: capabilityPreview
    });
    return run;
  }

  private prependWorkflowHintContext(request: ChatStartRunRequest, input: string): string {
    if (request.workflowHint !== 'background_task_change' || request.mode !== 'task' || typeof request.threadId !== 'string') {
      return input;
    }
    const task = this.taskService.listBackgroundTasks().find((candidate) => candidate.threadId === request.threadId);
    if (task === undefined) {
      return input;
    }
    return [
      `[系统] 当前后台任务 ID：${task.id}。请先调用 read_background_task 读取完整定义，再根据用户请求调用 update_background_task 或 cancel_background_task。`,
      '',
      '[用户最新请求]',
      input
    ].join('\n');
  }

  private async executeRun(context: RunExecutionContext): Promise<void> {
    this.sessionArchiveService.recordUserInput(context.threadId, context.input);
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
          getMemorySettings: this.getMemorySettings,
          consolidatorService: this.consolidatorService,
          memoryService: this.memoryService,
          sessionArchiveService: this.sessionArchiveService,
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
              messages: [new HumanMessage(context.agentInput)],
              ...createInitialForgeGuardrailsState()
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
          await this.maybeRunPrecompactionFlush(context, session, context.input);
        } finally {
          await Promise.allSettled(session.closers.map(async (close) => close()));
        }
      }, {
        labels: {
          mode: context.mode,
          providerId: context.modelHandle.provider.id
        },
        metricsService: this.metricsService,
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
      this.activeRuns.delete(context.runId);
    }
  }

  private async executeResume(context: RunExecutionContext, resumePayload: HITLResponse): Promise<void> {
    const session = await createDeepAgentSession({
      agentService: this.agentService,
      context,
      fileService: this.fileService,
      getCheckpointer: () => this.getOrCreateCheckpointer(),
      getMemorySettings: this.getMemorySettings,
      consolidatorService: this.consolidatorService,
      memoryService: this.memoryService,
      sessionArchiveService: this.sessionArchiveService,
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
      await this.maybeRunPrecompactionFlush(context, session, context.input);
    } catch (error) {
      this.failRun(context, error);
    } finally {
      await Promise.allSettled(session.closers.map(async (close) => close()));
      this.activeRuns.delete(context.runId);
    }
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

  private async maybeRunPrecompactionFlush(
    context: RunExecutionContext,
    session: DeepAgentSession,
    previousUserInput: string
  ): Promise<void> {
    const usage = session.usageAccumulator;
    let usedTokens = 0;
    if (usage.totalTokens !== null) {
      usedTokens = usage.totalTokens;
    } else if (usage.promptTokens !== null) {
      usedTokens = usage.promptTokens;
    }
    const contextWindow = this.precompactionService.contextWindowTokens();
    const ratio = contextWindow > 0 ? usedTokens / contextWindow : 0;
    if (!this.precompactionService.shouldTrigger(context.threadId, ratio, usedTokens)) {
      return;
    }

    try {
      const flushPrompt = this.precompactionService.buildFlushPrompt({ ratio, tokensUsed: usedTokens, contextWindow });
      const flushInput = `${flushPrompt}\n\nPrevious user input:\n${previousUserInput}`;
      this.sessionArchiveService.recordUserInput(context.threadId, flushInput, 'pre_compaction_flush');
      const flushSession = await createDeepAgentSession({
        agentService: this.agentService,
        context,
        fileService: this.fileService,
        getCheckpointer: () => this.getOrCreateCheckpointer(),
        getMemorySettings: this.getMemorySettings,
        consolidatorService: this.consolidatorService,
        memoryService: this.memoryService,
        sessionArchiveService: this.sessionArchiveService,
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
        const run = await flushSession.agent.streamEvents(
          {
            messages: [new HumanMessage(flushInput)],
            ...createInitialForgeGuardrailsState()
          },
          {
            version: 'v3',
            configurable: flushSession.configurable,
            signal: context.abortController.signal,
            recursionLimit: 8
          }
        );

        await this.consumeSessionStreams(run, context, flushSession, undefined, {
          visible: false,
          phase: 'pre_compaction_flush'
        });
        if (run.interrupted) {
          return;
        }
        await Promise.resolve(run.output);
        const assistantMessage = prompt.resolveAssistantMessage([...flushSession.assistantChunks]);
        if (assistantMessage.length > 0) {
          this.sessionArchiveService.recordAssistantMessage(
            context.threadId,
            assistantMessage,
            flushSession.usageAccumulator.completionTokens,
            'pre_compaction_flush'
          );
        }
        this.precompactionService.markFlushed(context.threadId, ratio, usedTokens);
      } finally {
        await Promise.allSettled(flushSession.closers.map(async (close) => close()));
      }
    } catch (error) {
      this.logService.warn('Pre-compaction flush failed; continuing user run.', {
        service: 'deep-agent-runtime',
        component: 'runPreCompactionFlush',
        traceId: context.traceId,
        runId: context.runId,
        threadId: context.threadId,
        metadata: {
          threadId: context.threadId,
          error: String(error)
        }
      });
    }
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
    this.logService.info('Deep Agent provider usage recorded.', {
      service: 'deep-agent-runtime',
      component: 'logProviderUsage',
      traceId: context.traceId,
      runId: context.runId,
      threadId: context.threadId,
      metadata: {
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
  ): name is 'update_background_task' | 'cancel_background_task' {
    return name === 'update_background_task' || name === 'cancel_background_task';
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
    onVisibleOutput?: () => void,
    options: { visible: boolean; phase: 'visible' | 'pre_compaction_flush' } = { visible: true, phase: 'visible' }
  ): Promise<void> {
    const taskEvents: Array<{
      threadId: string;
      runId: string;
      type: 'message_delta' | 'reasoning_delta' | 'tool_call' | 'subagent_started' | 'subagent_completed' | 'guardrail_nudge';
      payload: Record<string, unknown>;
    }> = [];
    const callbacks = {
      emitRuntimeEvent: (event: ChatRunEvent) => {
        if (options.visible) {
          this.emit(event);
        }
      },
      emitTodoEvent: (candidate: unknown) => {
        if (options.visible) {
          this.emitTodoEvent(context.runId, candidate);
        }
      },
      markVisibleOutput: () => {
        if (options.visible) {
          onVisibleOutput?.();
        }
      },
      recordSessionToolCall: (name: string, input: unknown, output: unknown) => {
        this.sessionArchiveService.recordToolCall(context.threadId, name, input, output, options.phase);
      },
      recordTaskEvent: (
        type: 'message_delta' | 'reasoning_delta' | 'tool_call' | 'subagent_started' | 'subagent_completed' | 'guardrail_nudge',
        payload: Record<string, unknown>
      ) => {
        if (!options.visible || context.taskRun === null) {
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
    if (assistantMessage.length > 0) {
      this.sessionArchiveService.recordAssistantMessage(context.threadId, assistantMessage, usage.completionTokens);
    }
    const result = prompt.buildProviderExecutionResult({
      modelHandle: context.modelHandle,
      createdAt: context.createdAt,
      startedAtMs: context.startedAtMs,
      inputLength: context.agentInput.length,
      assistantMessage,
      usage
    });
    this.logProviderUsage(context, usage);
    this.metricsService.incrementCounter('agent.run.completed', {
      mode: context.mode,
      providerId: context.modelHandle.provider.id
    });
    this.metricsService.recordHistogram('agent.run.duration_ms', Date.now() - context.startedAtMs, {
      mode: context.mode,
      providerId: context.modelHandle.provider.id
    });
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
    const logError = toRedactedLogError(error, failure.message);
    this.metricsService.incrementCounter('agent.run.failed', {
      errorCode: failure.code,
      mode: context.mode,
      providerId: context.modelHandle.provider.id
    });
    this.logService.error('Agent run failed.', logError, {
      service: 'deep-agent-runtime',
      component: 'failRun',
      traceId: context.traceId,
      runId: context.runId,
      threadId: context.threadId,
      error: {
        code: failure.code,
        message: failure.message,
        category: failure.retryable ? 'retryable' : 'permanent',
        stack: logError.stack
      },
      metadata: {
        mode: context.mode,
        modelId: context.modelHandle.modelId,
        providerId: context.modelHandle.provider.id,
        diagnostic: failure.diagnostic,
        suggestion: failure.suggestion
      }
    });
    if (context.taskRun !== null) {
      this.taskService.failRunWithProviderError({
        runId: context.taskRun.id,
        providerId: context.modelHandle.provider.id,
        modelId: context.modelHandle.modelId,
        code: failure.code,
        diagnostic: failure.diagnostic,
        message: failure.message,
        retryable: failure.retryable,
        suggestion: failure.suggestion
      });
    }
    this.emit({
      type: 'run_failed',
      runId: context.runId,
      threadId: context.threadId,
      code: failure.code,
      diagnostic: failure.diagnostic,
      message: failure.message,
      retryable: failure.retryable,
      suggestion: failure.suggestion
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

function toRedactedLogError(error: unknown, message: string): Error {
  const logError = new Error(message);
  if (error instanceof Error && error.stack !== undefined) {
    logError.stack = redact(error.stack);
  }
  return logError;
}

function createInitialForgeGuardrailsState(): {
  forge_error_tracker: ReturnType<typeof defaultErrorTracker>;
  forge_step_tracker: ReturnType<typeof defaultStepTracker>;
} {
  return {
    forge_error_tracker: defaultErrorTracker(),
    forge_step_tracker: defaultStepTracker()
  };
}
