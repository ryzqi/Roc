import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { Command, MemorySaver, type BaseStore, type InterruptPayload } from '@langchain/langgraph';
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
import type { RocPaths } from './paths';
import type { ShellExecutionService } from './shell-execution-service';
import type { TaskService } from './task-service';
import type { WebReadService } from './web-read-service';
import type { WorkspaceService } from './workspace-service';
import { executeWithProviderRequestRetry, isRetryableProviderRequestFailure } from './provider-request-retry';
import {
  buildDeepAgent,
  createBackend,
  errorMapping,
  prompt,
  recordUtils,
  redact,
  RUN_EVENT_NAME,
  SqliteLangGraphStore,
  tools,
  type ActiveRun,
  type RunExecutionContext,
  type RuntimeSubagent
} from './deep-agent';

type ReasoningSource =
  | {
      kind: 'stream';
      stream: AsyncIterable<unknown>;
    }
  | {
      kind: 'values';
      values: string[];
    };

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
  private readonly checkpointer = new MemorySaver();
  private readonly store: BaseStore;
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
    databaseService: DatabaseService,
    private readonly agentService: AgentService,
    private readonly workspaceService: WorkspaceService,
    private readonly fileService: FileService,
    private readonly mcpService: McpService,
    private readonly webReadService: WebReadService,
    private readonly shellExecutionService: ShellExecutionService,
    private readonly paths: RocPaths,
    private readonly logService: LogService
  ) {
    this.store = new SqliteLangGraphStore(databaseService);
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
      streaming: true,
      cacheTtl: request.mode === 'task' ? '1h' : undefined
    });
    const createdAt = new Date().toISOString();
    const taskRun = this.createTaskRunIfNeeded(request, input, modelHandle.modelId);
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
      input,
      startedAtMs: Date.now()
    };
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
    const resumePayload: HITLResponse = {
      decisions: [request.decision]
    };
    this.taskService.recordApprovalDecision({
      runId: resumeContext.taskRun.id,
      payload: {
        interruptId: pending.approval.interruptId,
        decision: request.decision
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
        streaming: true,
        cacheTtl: '1h'
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

  private async executeRun(context: RunExecutionContext): Promise<void> {
    try {
      let attemptProducedVisibleOutput = false;
      await executeWithProviderRequestRetry(async () => {
        attemptProducedVisibleOutput = false;
        const assistantChunks: string[] = [];
        const reasoningChunks: string[] = [];
        const usageAccumulator = createUsageAccumulator();
        const closers: Array<() => Promise<void>> = [];

        try {
          const interruptOn =
            context.taskRun === null
              ? undefined
              : this.agentService.getCapabilityPreview(context.enabledCapabilities).interruptOn;
          const { subagents, tools: runTools } = await this.createRunTools(context, closers);
          const runtimeBackend = createBackend({
            workspaceService: this.workspaceService,
            paths: this.paths,
            shellExecutionService: this.taskBoundShellExecutionService(context),
            store: this.store
          });
          const skillSources = context.enabledCapabilities.skills.map((skillId) => `/skills/${skillId}/`);
          const agent = buildDeepAgent({
            model: context.modelHandle.model,
            systemPrompt: prompt.buildSystemPrompt(context.enabledCapabilities),
            backend: runtimeBackend.backend,
            store: this.store,
            skillSources,
            subagents,
            tools: runTools,
            interruptOn,
            checkpointer: context.taskRun === null ? undefined : this.checkpointer
          });
          const run = await agent.streamEvents(
            {
              messages: [new HumanMessage(context.input)]
            },
            {
              version: 'v3',
              configurable: {
                thread_id: context.threadId,
                run_id: context.runId
              },
              signal: context.abortController.signal
            }
          );

          await Promise.all([
            this.consumeToolCalls(run.toolCalls as AsyncIterable<unknown>, context, () => {
              attemptProducedVisibleOutput = true;
            }),
            this.consumeMessages(
              run.messages as AsyncIterable<unknown>,
              context,
              assistantChunks,
              reasoningChunks,
              usageAccumulator,
              () => {
                attemptProducedVisibleOutput = true;
              }
            ),
            this.consumeSubagents(run.subagents as AsyncIterable<unknown>, context, () => {
              attemptProducedVisibleOutput = true;
            })
          ]);

          if (run.interrupted) {
            const approval = this.readPendingApproval(run.interrupts, context.runId);
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
            return;
          }

          await Promise.resolve(run.output);
          const assistantMessage = prompt.resolveAssistantMessage(assistantChunks);
          const result = prompt.buildProviderExecutionResult({
            modelHandle: context.modelHandle,
            createdAt: context.createdAt,
            startedAtMs: context.startedAtMs,
            inputLength: context.input.length,
            assistantMessage,
            usage: usageAccumulator
          });
          this.logProviderUsage(context, usageAccumulator);
          if (context.taskRun !== null) {
            this.taskService.completeRunWithProviderResult({
              runId: context.taskRun.id,
              result
            });
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
        } finally {
          await Promise.allSettled(closers.map(async (close) => close()));
        }
      }, {
        signal: context.abortController.signal,
        shouldRetry: (error) => !attemptProducedVisibleOutput && isRetryableProviderRequestFailure(error)
      });
    } catch (error) {
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
    } finally {
      this.activeRuns.delete(context.runId);
    }
  }

  private async createRunTools(
    context: RunExecutionContext,
    closers: Array<() => Promise<void>>
  ): Promise<{ subagents: RuntimeSubagent[]; tools: ClientTool[] }> {
    const webReadTool = tools.createWebReadTool(this.webReadService);
    const deleteFileTool = tools.createDeleteFileTool(this.fileService);
    const runTools: ClientTool[] = [webReadTool, deleteFileTool];
    const webSearchTool = await tools.createWebSearchTool({
      mcpService: this.mcpService,
      enabledCapabilities: context.enabledCapabilities,
      closers
    });
    if (webSearchTool !== null) {
      runTools.push(webSearchTool);
    }
    return {
      subagents: tools.createRunSubagents({
        webReadTool
      }),
      tools: runTools
    };
  }

  private async executeResume(context: RunExecutionContext, resumePayload: HITLResponse): Promise<void> {
    const assistantChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const usageAccumulator = createUsageAccumulator();
    const closers: Array<() => Promise<void>> = [];

    try {
      const interruptOn =
        context.taskRun === null ? undefined : this.agentService.getCapabilityPreview(context.enabledCapabilities).interruptOn;
      const { subagents, tools: runTools } = await this.createRunTools(context, closers);
      const runtimeBackend = createBackend({
        workspaceService: this.workspaceService,
        paths: this.paths,
        shellExecutionService: this.taskBoundShellExecutionService(context),
        store: this.store
      });
      const skillSources = context.enabledCapabilities.skills.map((skillId) => `/skills/${skillId}/`);
      const agent = buildDeepAgent({
        model: context.modelHandle.model,
        systemPrompt: prompt.buildSystemPrompt(context.enabledCapabilities),
        backend: runtimeBackend.backend,
        store: this.store,
        skillSources,
        subagents,
        tools: runTools,
        interruptOn,
        checkpointer: context.taskRun === null ? undefined : this.checkpointer
      });
      const run = await agent.streamEvents(new Command({ resume: resumePayload }), {
        version: 'v3',
        configurable: {
          thread_id: context.threadId,
          run_id: context.runId
        },
        signal: context.abortController.signal
      });

      await Promise.all([
        this.consumeToolCalls(run.toolCalls as AsyncIterable<unknown>, context),
        this.consumeMessages(
          run.messages as AsyncIterable<unknown>,
          context,
          assistantChunks,
          reasoningChunks,
          usageAccumulator
        ),
        this.consumeSubagents(run.subagents as AsyncIterable<unknown>, context)
      ]);

      if (run.interrupted) {
        const approval = this.readPendingApproval(run.interrupts, context.runId);
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
        return;
      }

      await Promise.resolve(run.output);
      const assistantMessage = prompt.resolveAssistantMessage(assistantChunks);
      const result = prompt.buildProviderExecutionResult({
        modelHandle: context.modelHandle,
        createdAt: context.createdAt,
        startedAtMs: context.startedAtMs,
        inputLength: context.input.length,
        assistantMessage,
        usage: usageAccumulator
      });
      this.logProviderUsage(context, usageAccumulator);
      if (context.taskRun !== null) {
        this.taskService.completeRunWithProviderResult({
          runId: context.taskRun.id,
          result
        });
      }
      this.pendingInterrupts.delete(context.runId);
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
    } catch (error) {
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
    } finally {
      await Promise.allSettled(closers.map(async (close) => close()));
    }
  }

  private taskBoundShellExecutionService(context: RunExecutionContext): {
    executeAgentCommand: (input: { command: string; cwd?: string }) => ReturnType<
      import('./shell-execution-service').ShellExecutionService['executeAgentCommand']
    >;
  } {
    return {
      executeAgentCommand: (input) =>
        this.shellExecutionService.executeAgentCommand({
          ...input,
          threadId: context.taskRun?.threadId ?? context.threadId,
          runId: context.taskRun?.id ?? context.runId
        })
    };
  }

  private async consumeMessages(
    messages: AsyncIterable<unknown>,
    context: RunExecutionContext,
    assistantChunks: string[],
    reasoningChunks: string[],
    usageAccumulator: ProviderUsageAccumulator,
    onVisibleOutput?: () => void
  ): Promise<void> {
    for await (const message of messages) {
      updateUsageAccumulator(usageAccumulator, message);
      const textStream = recordUtils.readAsyncIterable(recordUtils.readRecordValue(message, 'text'));
      const reasoningSource = this.readReasoningSource(message);
      const canStreamAssistantText = textStream !== null && !recordUtils.isNonAssistantTextMessage(message);

      const consumeAssistantText = () =>
        this.consumeVisibleTextStream(
          textStream as AsyncIterable<unknown>,
          (delta) => {
            onVisibleOutput?.();
            assistantChunks.push(delta);
            if (context.taskRun !== null) {
              this.taskService.recordEvent({
                threadId: context.taskRun.threadId,
                runId: context.taskRun.id,
                type: 'message_delta',
                payload: {
                  role: 'assistant',
                  delta
                }
              });
            }
            this.emit({
              type: 'message_delta',
              runId: context.runId,
              delta
            });
          });

      const consumeReasoning = () =>
        this.consumeReasoningSource(
          reasoningSource as ReasoningSource,
          context,
          reasoningChunks,
          onVisibleOutput
        );

      const tasks: Array<Promise<void>> = [];
      if (canStreamAssistantText) {
        tasks.push(consumeAssistantText());
      }
      if (reasoningSource !== null) {
        tasks.push(consumeReasoning());
      }
      await Promise.all(tasks);

      if (reasoningSource === null && reasoningChunks.length === 0) {
        const trailingReasoning = await this.readReasoningFromOutput(message);
        if (trailingReasoning !== null) {
          await this.consumeVisibleTextStream(
            createStringAsyncIterable([trailingReasoning]),
            (delta) => {
              onVisibleOutput?.();
              reasoningChunks.push(delta);
              this.emit({
                type: 'reasoning_delta',
                runId: context.runId,
                delta
              });
            }
          );
        }
      }
    }
  }

  private async readReasoningFromOutput(message: unknown): Promise<string | null> {
    return await recordUtils.readReasoningFromMessageOutput(recordUtils.readRecordValue(message, 'output'));
  }

  private readReasoningSource(message: unknown): ReasoningSource | null {
    const standardReasoning = this.readReasoningFallbackValue(recordUtils.readRecordValue(message, 'reasoning'));
    if (standardReasoning !== null) {
      return standardReasoning;
    }

    const values = recordUtils.readReasoningTextValues(message);
    if (values.length === 0) {
      return null;
    }
    return {
      kind: 'values',
      values
    };
  }

  private readReasoningFallbackValue(value: unknown): ReasoningSource | null {
    const stream = recordUtils.readAsyncIterable(value);
    if (stream !== null) {
      return {
        kind: 'stream',
        stream
      };
    }
    const text = recordUtils.readNonEmptyString(value);
    if (text === null) {
      return null;
    }
    return {
      kind: 'values',
      values: [text]
    };
  }

  private async consumeReasoningSource(
    source: ReasoningSource,
    context: RunExecutionContext,
    reasoningChunks: string[],
    onVisibleOutput?: () => void
  ): Promise<void> {
    if (source.kind === 'stream') {
      await this.consumeVisibleTextStream(
        source.stream,
        (delta) => {
          onVisibleOutput?.();
          reasoningChunks.push(delta);
          this.emit({
            type: 'reasoning_delta',
            runId: context.runId,
            delta
          });
        }
      );
      return;
    }

    await this.consumeVisibleTextStream(
      createStringAsyncIterable(source.values),
      (delta) => {
        onVisibleOutput?.();
        reasoningChunks.push(delta);
        this.emit({
          type: 'reasoning_delta',
          runId: context.runId,
          delta
        });
      }
    );
  }

  private async consumeToolCalls(
    calls: AsyncIterable<unknown>,
    context: RunExecutionContext,
    onVisibleOutput?: () => void
  ): Promise<void> {
    for await (const call of calls) {
      const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(call, 'name')) ?? 'unknown_tool';
      const input = await Promise.resolve(recordUtils.readRecordValue(call, 'input'));
      onVisibleOutput?.();
      this.emit({
        type: 'tool_event',
        runId: context.runId,
        event: 'start',
        name,
        data: input
      });
      if (context.taskRun !== null) {
        this.taskService.recordEvent({
          threadId: context.taskRun.threadId,
          runId: context.taskRun.id,
          type: 'tool_call',
          payload: {
            name,
            status: 'start',
            input
          }
        });
      }
      this.emitTodoEvent(context.runId, input);

      try {
        const output = await Promise.resolve(recordUtils.readRecordValue(call, 'output'));
        onVisibleOutput?.();
        this.emit({
          type: 'tool_event',
          runId: context.runId,
          event: 'end',
          name,
          data: output
        });
        if (context.taskRun !== null) {
          this.taskService.recordEvent({
            threadId: context.taskRun.threadId,
            runId: context.taskRun.id,
            type: 'tool_call',
            payload: {
              name,
              status: 'end',
              output
            }
          });
        }
        this.emitTodoEvent(context.runId, output);
      } catch (error) {
        const message = error instanceof Error ? redact(error.message) : 'Tool 执行失败。';
        onVisibleOutput?.();
        this.emit({
          type: 'tool_event',
          runId: context.runId,
          event: 'error',
          name,
          data: message
        });
        if (context.taskRun !== null) {
          this.taskService.recordEvent({
            threadId: context.taskRun.threadId,
            runId: context.taskRun.id,
            type: 'tool_call',
            payload: {
              name,
              status: 'error',
              error: message
            }
          });
        }
      }
    }
  }

  private async consumeSubagents(
    subagents: AsyncIterable<unknown>,
    context: RunExecutionContext,
    onVisibleOutput?: () => void
  ): Promise<void> {
    for await (const subagent of subagents) {
      const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(subagent, 'name')) ?? 'subagent';
      const taskInput = await Promise.resolve(recordUtils.readRecordValue(subagent, 'taskInput'));
      const summary = recordUtils.readNonEmptyString(taskInput) ?? null;
      onVisibleOutput?.();
      this.emit({
        type: 'subagent_event',
        runId: context.runId,
        subagent: name,
        status: 'started',
        summary
      });
      if (context.taskRun !== null) {
        this.taskService.recordEvent({
          threadId: context.taskRun.threadId,
          runId: context.taskRun.id,
          type: 'subagent_started',
          payload: {
            name,
            summary
          }
        });
      }

      try {
        await Promise.resolve(recordUtils.readRecordValue(subagent, 'output'));
        onVisibleOutput?.();
        this.emit({
          type: 'subagent_event',
          runId: context.runId,
          subagent: name,
          status: 'completed',
          summary
        });
        if (context.taskRun !== null) {
          this.taskService.recordEvent({
            threadId: context.taskRun.threadId,
            runId: context.taskRun.id,
            type: 'subagent_completed',
            payload: {
              name,
              summary
            }
          });
        }
      } catch (error) {
        const failureSummary = error instanceof Error ? redact(error.message) : summary;
        onVisibleOutput?.();
        this.emit({
          type: 'subagent_event',
          runId: context.runId,
          subagent: name,
          status: 'failed',
          summary: failureSummary
        });
      }
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

  private async consumeStringStream(stream: AsyncIterable<unknown>, onDelta: (delta: string) => void): Promise<void> {
    for await (const item of stream) {
      const text = recordUtils.readNonEmptyString(item);
      if (text !== null) {
        onDelta(text);
      }
    }
  }

  private async consumeVisibleTextStream(
    stream: AsyncIterable<unknown>,
    onDelta: (delta: string) => void
  ): Promise<void> {
    let pending = '';
    let released = false;
    let suppressMessage = false;

    await this.consumeStringStream(stream, (delta) => {
      if (suppressMessage) {
        return;
      }

      if (released) {
        onDelta(delta);
        return;
      }

      pending += delta;
      const classification = recordUtils.classifyStreamedAssistantText(pending);
      if (classification === 'non_assistant') {
        pending = '';
        suppressMessage = true;
        return;
      }
      if (classification === 'pending') {
        return;
      }

      released = true;
      if (pending.length > 0) {
        onDelta(pending);
      }
      pending = '';
    });

    if (!released && !suppressMessage && pending.length > 0) {
      onDelta(pending);
    }
  }

  private emit(event: ChatRunEvent): void {
    this.eventEmitter.emit(RUN_EVENT_NAME, event);
  }

  private logProviderUsage(context: RunExecutionContext, usage: ProviderUsageAccumulator): void {
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

  private readPendingApproval(interrupts: readonly InterruptPayload[], runId: string): ChatPendingApproval {
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

  private isHitlRequest(value: unknown): value is HITLRequest {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const actionRequests = Reflect.get(value, 'actionRequests');
    const reviewConfigs = Reflect.get(value, 'reviewConfigs');
    return Array.isArray(actionRequests) && Array.isArray(reviewConfigs);
  }
}

async function* createStringAsyncIterable(values: readonly string[]): AsyncGenerator<string> {
  for (const value of values) {
    yield value;
  }
}

type ProviderUsageAccumulator = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

function createUsageAccumulator(): ProviderUsageAccumulator {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null
  };
}

function updateUsageAccumulator(target: ProviderUsageAccumulator, message: unknown): void {
  const usageMetadata = recordUtils.readRecordValue(message, 'usage_metadata');
  const inputTokens = readNonNegativeInteger(recordUtils.readRecordValue(usageMetadata, 'input_tokens'));
  const outputTokens = readNonNegativeInteger(recordUtils.readRecordValue(usageMetadata, 'output_tokens'));
  const totalTokens = readNonNegativeInteger(recordUtils.readRecordValue(usageMetadata, 'total_tokens'));
  const inputTokenDetails = recordUtils.readRecordValue(usageMetadata, 'input_token_details');
  const cacheReadTokens = readNonNegativeInteger(recordUtils.readRecordValue(inputTokenDetails, 'cache_read'));
  const cacheCreationTokens = readNonNegativeInteger(recordUtils.readRecordValue(inputTokenDetails, 'cache_creation'));

  if (inputTokens !== null) {
    target.promptTokens = inputTokens;
  }
  if (outputTokens !== null) {
    target.completionTokens = outputTokens;
  }
  if (totalTokens !== null) {
    target.totalTokens = totalTokens;
  }
  if (cacheReadTokens !== null) {
    target.cacheReadTokens = cacheReadTokens;
  }
  if (cacheCreationTokens !== null) {
    target.cacheCreationTokens = cacheCreationTokens;
  }
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
