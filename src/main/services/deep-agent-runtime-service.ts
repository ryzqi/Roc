import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createDeepAgent } from 'deepagents';
import { HumanMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import { Command, MemorySaver, type InterruptPayload } from '@langchain/langgraph';
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
import { RocDomainError } from './errors';
import type { LangChainModelFactory } from './langchain-model-factory';
import type { MemoryService } from './memory-service';
import type { McpService } from './mcp-service';
import type { RocPaths } from './paths';
import type { ShellExecutionService } from './shell-execution-service';
import type { TaskService } from './task-service';
import type { WebReadService } from './web-read-service';
import type { WorkspaceService } from './workspace-service';
import {
  createBackend,
  errorMapping,
  prompt,
  recordUtils,
  redact,
  RUN_EVENT_NAME,
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
    private readonly memoryService: MemoryService,
    private readonly agentService: AgentService,
    private readonly workspaceService: WorkspaceService,
    private readonly mcpService: McpService,
    private readonly webReadService: WebReadService,
    private readonly shellExecutionService: ShellExecutionService,
    private readonly paths: RocPaths
  ) {}

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
      modelHandle: await this.langChainModelFactory.createChatModelByModelId(taskRun.modelId, { streaming: true }),
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
    const assistantChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const closers: Array<() => Promise<void>> = [];

    try {
      const interruptOn =
        context.taskRun === null ? undefined : this.agentService.getCapabilityPreview(context.enabledCapabilities).interruptOn;
      const { subagents, tools: runTools } = await this.createRunTools(context, closers);
      const agent = createDeepAgent({
        model: context.modelHandle.model,
        systemPrompt: prompt.buildSystemPrompt(context.enabledCapabilities),
        backend: createBackend(this.workspaceService, this.paths, this.taskBoundShellExecutionService(context)),
        skills: context.enabledCapabilities.skills.map((skillId) => `/skills/${skillId}/`),
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
        this.consumeMessages(run.messages as AsyncIterable<unknown>, context, assistantChunks, reasoningChunks),
        this.consumeToolCalls(run.toolCalls as AsyncIterable<unknown>, context),
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
        assistantMessage
      });
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
      this.activeRuns.delete(context.runId);
    }
  }

  private async createRunTools(
    context: RunExecutionContext,
    closers: Array<() => Promise<void>>
  ): Promise<{ subagents: RuntimeSubagent[]; tools: ClientTool[] }> {
    const memorySearchTool = tools.createMemorySearchTool(this.memoryService);
    const memoryGetTool = tools.createMemoryGetTool(this.memoryService);
    const webReadTool = tools.createWebReadTool(this.webReadService);
    const runTools: ClientTool[] = [memorySearchTool, memoryGetTool, webReadTool];
    const webSearchTool = await tools.createWebSearchTool({
      mcpService: this.mcpService,
      enabledCapabilities: context.enabledCapabilities,
      closers
    });
    if (webSearchTool !== null) {
      runTools.unshift(webSearchTool);
    }
    return {
      subagents: tools.createRunSubagents({
        memoryGetTool,
        memorySearchTool,
        webReadTool
      }),
      tools: runTools
    };
  }

  private async executeResume(context: RunExecutionContext, resumePayload: HITLResponse): Promise<void> {
    const assistantChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const closers: Array<() => Promise<void>> = [];

    try {
      const interruptOn =
        context.taskRun === null ? undefined : this.agentService.getCapabilityPreview(context.enabledCapabilities).interruptOn;
      const { subagents, tools: runTools } = await this.createRunTools(context, closers);
      const agent = createDeepAgent({
        model: context.modelHandle.model,
        systemPrompt: prompt.buildSystemPrompt(context.enabledCapabilities),
        backend: createBackend(this.workspaceService, this.paths, this.taskBoundShellExecutionService(context)),
        skills: context.enabledCapabilities.skills.map((skillId) => `/skills/${skillId}/`),
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
        this.consumeMessages(run.messages as AsyncIterable<unknown>, context, assistantChunks, reasoningChunks),
        this.consumeToolCalls(run.toolCalls as AsyncIterable<unknown>, context),
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
        assistantMessage
      });
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
    reasoningChunks: string[]
  ): Promise<void> {
    for await (const message of messages) {
      const textStream = recordUtils.readAsyncIterable(recordUtils.readRecordValue(message, 'text'));
      const reasoningSource = this.readReasoningSource(message);
      const tasks: Array<Promise<void>> = [];

      if (textStream !== null) {
        tasks.push(
          this.consumeStringStream(textStream, (delta) => {
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
          })
        );
      }

      if (reasoningSource !== null) {
        tasks.push(
          this.consumeReasoningSource(reasoningSource, context, reasoningChunks)
        );
      }

      await Promise.all(tasks);
    }
  }

  private readReasoningSource(message: unknown): ReasoningSource | null {
    const standardReasoning = this.readReasoningFallbackValue(recordUtils.readRecordValue(message, 'reasoning'));
    if (standardReasoning !== null) {
      return standardReasoning;
    }

    const directFallback = this.readReasoningFallbackValue(recordUtils.readRecordValue(message, 'reasoning_content'));
    if (directFallback !== null) {
      return directFallback;
    }
    const camelCaseFallback = this.readReasoningFallbackValue(recordUtils.readRecordValue(message, 'reasoningContent'));
    if (camelCaseFallback !== null) {
      return camelCaseFallback;
    }

    const blockValues = this.readReasoningBlockValues(recordUtils.readRecordValue(message, 'content'));
    if (blockValues.length === 0) {
      return null;
    }
    return {
      kind: 'values',
      values: blockValues
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

  private readReasoningBlockValues(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.flatMap((block) => this.readReasoningBlockText(block));
  }

  private readReasoningBlockText(block: unknown): string[] {
    if (!recordUtils.isRecord(block)) {
      return [];
    }
    const type = recordUtils.readNonEmptyString(recordUtils.readRecordValue(block, 'type'));
    if (type !== 'reasoning' && type !== 'reasoning_content') {
      return [];
    }

    const values: string[] = [];
    const text = recordUtils.readNonEmptyString(recordUtils.readRecordValue(block, 'text'));
    if (text !== null) {
      values.push(text);
    }
    const reasoningText = recordUtils.readNonEmptyString(recordUtils.readRecordValue(block, 'reasoning_content'));
    if (reasoningText !== null) {
      values.push(reasoningText);
    }
    return values;
  }

  private async consumeReasoningSource(
    source: ReasoningSource,
    context: RunExecutionContext,
    reasoningChunks: string[]
  ): Promise<void> {
    if (source.kind === 'stream') {
      await this.consumeStringStream(source.stream, (delta) => {
        reasoningChunks.push(delta);
        this.emit({
          type: 'reasoning_delta',
          runId: context.runId,
          delta
        });
      });
      return;
    }

    for (const delta of source.values) {
      reasoningChunks.push(delta);
      this.emit({
        type: 'reasoning_delta',
        runId: context.runId,
        delta
      });
    }
  }

  private async consumeToolCalls(calls: AsyncIterable<unknown>, context: RunExecutionContext): Promise<void> {
    for await (const call of calls) {
      const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(call, 'name')) ?? 'unknown_tool';
      const input = await Promise.resolve(recordUtils.readRecordValue(call, 'input'));
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

  private async consumeSubagents(subagents: AsyncIterable<unknown>, context: RunExecutionContext): Promise<void> {
    for await (const subagent of subagents) {
      const name = recordUtils.readNonEmptyString(recordUtils.readRecordValue(subagent, 'name')) ?? 'subagent';
      const taskInput = await Promise.resolve(recordUtils.readRecordValue(subagent, 'taskInput'));
      const summary = recordUtils.readNonEmptyString(taskInput) ?? null;
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

  private emit(event: ChatRunEvent): void {
    this.eventEmitter.emit(RUN_EVENT_NAME, event);
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
