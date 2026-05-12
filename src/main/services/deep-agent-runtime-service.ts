import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createDeepAgent } from 'deepagents';
import { HumanMessage } from '@langchain/core/messages';
import type { ClientTool } from '@langchain/core/tools';
import type {
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

export class DeepAgentRuntimeService {
  private readonly eventEmitter = new EventEmitter();
  private readonly activeRuns = new Map<string, ActiveRun>();

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
      startedAtMs: Date.now(),
      enabledCapabilities: request.enabledCapabilities
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
      const { subagents, tools: runTools } = await this.createRunTools(context, closers);
      const agent = createDeepAgent({
        model: context.modelHandle.model,
        systemPrompt: prompt.buildSystemPrompt(context.enabledCapabilities),
        backend: createBackend(this.workspaceService, this.paths, this.taskBoundShellExecutionService(context)),
        skills: context.enabledCapabilities.skills.map((skillId) => `/skills/${skillId}/`),
        subagents,
        tools: runTools
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
      const reasoningStream = recordUtils.readAsyncIterable(recordUtils.readRecordValue(message, 'reasoning'));
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

      if (reasoningStream !== null) {
        tasks.push(
          this.consumeStringStream(reasoningStream, (delta) => {
            reasoningChunks.push(delta);
            this.emit({
              type: 'reasoning_delta',
              runId: context.runId,
              delta
            });
          })
        );
      }

      await Promise.all(tasks);
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
}
