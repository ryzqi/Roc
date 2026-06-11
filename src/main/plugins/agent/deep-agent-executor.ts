import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command, InMemoryStore, MemorySaver } from '@langchain/langgraph';
import type { ClientTool } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import type { ChatRunEvent, FileDeleteResult, ShellExecutionResult, TaskRun, Workspace } from '../../../shared/types';
import { PROPOSE_TOOL_DESCRIPTION, PROPOSE_TOOL_NAME } from '../../../shared/background-task-tool-contract';
import type { RocCapabilityRegistry } from '../../kernel/types';
import { buildDeepAgent } from '../../services/deep-agent/agent-builder';
import { consumeMessageStream, consumeSubagentStream, consumeToolCallStream, createUsageAccumulator } from '../../services/deep-agent/stream-consumers';
import { createRunSubagents } from '../../services/deep-agent/tools';
import { defaultErrorTracker, defaultStepTracker } from '../../services/forge-guardrails';
import { defaultSettings } from '../../services/config/defaults';
import type { WebReadRequest } from '../../services/web-read-service';
import type { RocPaths } from '../../services/paths';
import { createResolveBackgroundTaskTimeTool } from '../../services/deep-agent/background-task-time-tool';
import { cancelInputSchema, updateInputSchema, validateBackgroundTaskPatch } from '../../services/deep-agent/background-task-tools';
import { createBackend } from '../../services/deep-agent/backend';
import * as recordUtils from '../../services/deep-agent/record-utils';
import type { AgentExecuteAdapter } from '../../services/deep-agent/types';
import type { LangChainChatModelHandle } from '../../services/langchain-model-factory';
import { CapacityService } from '../../services/memory/capacity';
import { SecurityScanService } from '../../services/memory/security-scan';
import type { AgentDeepAgentExecutor } from './runtime';

type FinalToolMessageBlock =
  | {
      callId: string;
      name: string;
      phase: 'end';
      output: unknown;
    }
  | {
      callId: string;
      name: string;
      phase: 'error';
      error: unknown;
    };

export type AgentDeepAgentExecutorOptions = {
  capabilities: RocCapabilityRegistry;
  paths: RocPaths;
};

const finalToolMessageNames = new Set(['write_file', 'edit_file']);

export function createAgentDeepAgentExecutor(options: AgentDeepAgentExecutorOptions): AgentDeepAgentExecutor {
  const store = new InMemoryStore();
  const checkpointer = new MemorySaver();
  return {
    execute: async function* (input) {
      const handle = input.modelHandle.langChainHandle;
      if (handle === undefined) {
        throw new Error('agent_deep_agent_model_handle_missing');
      }
      const closers: Array<() => Promise<void>> = [];
      const assistantChunks: string[] = [];
      const reasoningChunks: string[] = [];
      const usageAccumulator = createUsageAccumulator();

      const workspace = await options.capabilities.invoke<{}, Workspace | null>('workspace.getCurrent', {});
      const tools = await createExecutorTools({
        capabilities: options.capabilities,
        enabledCapabilities: input.request.enabledCapabilities
      });
      const runtimeBackend = createRuntimeBackend({
        capabilities: options.capabilities,
        handle,
        paths: options.paths,
        selectedSkillIds: input.request.enabledCapabilities.skills,
        workspace
      });
      const systemPrompt = [
        'You are Roc, a long-running personal assistant on Windows. Be concise; claim only inspected evidence.',
        workspace === null
          ? 'Workspace: not selected.'
          : `Workspace: ${workspace.path}\nDefault cwd: selected Roc workspace root; use /workspace/ for Deep Agents file tools.`,
        `Capabilities: mcp=${input.request.enabledCapabilities.mcpServers.join(',') || 'none'};skills=${input.request.enabledCapabilities.skills.join(',') || 'none'};untrusted_context_policy=external_content_reference_only`
      ].filter((section) => section.length > 0).join('\n\n');
      const agent = buildDeepAgent({
        model: handle.model,
        systemPrompt,
        backend: runtimeBackend.backend,
        store,
        memorySources: [],
        skillSources: input.request.enabledCapabilities.skills.length === 0 ? [] : ['/skills/'],
        subagents: createRunSubagents({
          webReadTool: tools.webReadTool
        }),
        tools: tools.runTools,
        filesystemPermissions: undefined,
        interruptOn:
          input.request.workflowHint === 'propose_background_task'
            ? undefined
            : await readInterruptPolicy(options.capabilities, input.request.enabledCapabilities),
        checkpointer,
        providerType: handle.runtime.providerType,
        workflowHint: input.request.workflowHint ?? null,
        contextBudgetTokens: handle.runtime.contextBudgetTokens
      });
      const runInput =
        input.resumePayload === undefined
          ? createInitialState(input.request.input)
          : new Command({
              resume: input.resumePayload
            });
      const run = await agent.streamEvents(runInput as never, {
        version: 'v3',
        configurable: {
          run_id: input.run.id,
          thread_id: input.run.threadId
        },
        signal: input.abortSignal
      });
      const eventQueue = createChatRunEventQueue();
      const taskRun = input.run;
      const callbacks = createExecutorCallbacks({
        emitRuntimeEvent: eventQueue.push
      });
      const consumeRun = (async () => {
        try {
          await Promise.all([
            consumeToolCallStream({
              calls: run.toolCalls as AsyncIterable<unknown>,
              context: {
                runId: input.run.id,
                taskRun
              },
              callbacks
            }),
            consumeMessageStream({
              messages: run.messages as AsyncIterable<unknown>,
              context: {
                runId: input.run.id,
                taskRun
              },
              assistantChunks,
              reasoningChunks,
              usageAccumulator,
              callbacks
            }),
            consumeSubagentStream({
              subagents: run.subagents as AsyncIterable<unknown>,
              context: {
                runId: input.run.id,
                taskRun
              },
              callbacks
            })
          ]);
          if (readInterrupted(run)) {
            eventQueue.push(readRunInterruptedEvent(run, input.run.id, input.run.threadId));
          } else {
            const output = await Promise.resolve(run.output);
            const finalAssistantText = readFinalAssistantText(output);
            if (assistantChunks.join('').trim().length === 0 && finalAssistantText !== null) {
              assistantChunks.push(finalAssistantText);
              eventQueue.push({
                type: 'assistant_block',
                runId: input.run.id,
                block: {
                  kind: 'text',
                  blockId: `text-${input.run.id}`,
                  phase: 'delta',
                  text: finalAssistantText
                }
              });
            }
            readFinalToolBlockEvents(output, input.run.id).forEach((event) => eventQueue.push(event));
          }
          eventQueue.close();
        } catch (error) {
          eventQueue.fail(error);
        } finally {
          await Promise.allSettled(closers.map(async (close) => close()));
        }
      })();
      for await (const event of eventQueue) {
        yield event;
      }
      await consumeRun;
    }
  };
}

async function readInterruptPolicy(
  capabilities: RocCapabilityRegistry,
  enabledCapabilities: TaskRun['enabledCapabilities']
): Promise<NonNullable<Parameters<typeof buildDeepAgent>[0]['interruptOn']> | undefined> {
  if (!capabilities.list().some((capability) => capability.name === 'agent.capability.preview')) {
    return undefined;
  }
  const preview = await capabilities.invoke<
    TaskRun['enabledCapabilities'],
    { interruptOn: NonNullable<Parameters<typeof buildDeepAgent>[0]['interruptOn']> }
  >('agent.capability.preview', enabledCapabilities);
  return preview.interruptOn;
}

function createInitialState(input: string): unknown {
  return {
    messages: [new HumanMessage(input)],
    forge_error_tracker: defaultErrorTracker(),
    forge_step_tracker: defaultStepTracker()
  };
}

function readInterrupted(run: unknown): boolean {
  return typeof run === 'object' && run !== null && Reflect.get(run, 'interrupted') === true;
}

function readRunInterruptedEvent(run: unknown, runId: string, threadId: string): ChatRunEvent {
  const interrupts = typeof run === 'object' && run !== null ? Reflect.get(run, 'interrupts') : undefined;
  const firstInterrupt = Array.isArray(interrupts) ? interrupts[0] : undefined;
  if (typeof firstInterrupt !== 'object' || firstInterrupt === null) {
    throw new Error('agent_interrupt_payload_missing');
  }
  const interruptId = Reflect.get(firstInterrupt, 'interruptId');
  const payload = Reflect.get(firstInterrupt, 'payload');
  if (typeof interruptId !== 'string' || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('agent_interrupt_payload_invalid');
  }
  return {
    type: 'run_interrupted',
    runId,
    threadId,
    interruptId,
    payload: payload as never
  };
}

function readFinalAssistantText(output: unknown): string | null {
  if (!recordUtils.isRecord(output)) {
    return null;
  }
  const messages = recordUtils.readRecordValue(output, 'messages');
  if (!Array.isArray(messages)) {
    return null;
  }
  const lastMessage = messages[messages.length - 1];
  if (lastMessage === undefined) {
    return null;
  }
  return readAssistantMessageText(lastMessage);
}

function readFinalToolBlockEvents(output: unknown, runId: string): ChatRunEvent[] {
  if (!recordUtils.isRecord(output)) {
    return [];
  }
  const messages = recordUtils.readRecordValue(output, 'messages');
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.flatMap((message): ChatRunEvent[] => {
    const toolMessage = readFinalToolMessage(message);
    if (toolMessage === null) {
      return [];
    }
    return [
      {
        type: 'assistant_block',
        runId,
        block: {
          kind: 'tool_call',
          blockId: `tool-${toolMessage.callId}`,
          callId: toolMessage.callId,
          name: toolMessage.name,
          phase: toolMessage.phase,
          ...(toolMessage.phase === 'end'
            ? { output: toolMessage.output }
            : { error: toolMessage.error })
        }
      }
    ];
  });
}

function readFinalToolMessage(message: unknown): FinalToolMessageBlock | null {
  if (!isToolMessageLike(message)) {
    return null;
  }
  const callId = readToolMessageCallId(message);
  if (callId === null) {
    return null;
  }
  const name = readToolMessageName(message);
  if (name === null || !finalToolMessageNames.has(name)) {
    return null;
  }
  const output = readToolMessageOutput(message);
  if (readToolMessageStatus(message) === 'error') {
    return {
      callId,
      name,
      phase: 'error',
      error: output
    };
  }
  return {
    callId,
    name,
    phase: 'end',
    output
  };
}

function isToolMessageLike(message: unknown): boolean {
  if (ToolMessage.isInstance(message)) {
    return true;
  }
  if (!recordUtils.isRecord(message)) {
    return false;
  }
  const role = readLowercaseString(recordUtils.readRecordValue(message, 'role'));
  if (role !== null) {
    return role === 'tool';
  }
  const type = readLowercaseString(recordUtils.readRecordValue(message, 'type'));
  return type === 'tool' || type === 'toolmessage';
}

function readToolMessageCallId(message: unknown): string | null {
  if (ToolMessage.isInstance(message)) {
    return message.tool_call_id;
  }
  if (!recordUtils.isRecord(message)) {
    return null;
  }
  const snakeCase = recordUtils.readNonEmptyString(recordUtils.readRecordValue(message, 'tool_call_id'));
  if (snakeCase !== null) {
    return snakeCase;
  }
  return recordUtils.readNonEmptyString(recordUtils.readRecordValue(message, 'toolCallId'));
}

function readToolMessageName(message: unknown): string | null {
  if (ToolMessage.isInstance(message)) {
    return message.name === undefined ? null : message.name;
  }
  if (!recordUtils.isRecord(message)) {
    return null;
  }
  return recordUtils.readNonEmptyString(recordUtils.readRecordValue(message, 'name'));
}

function readToolMessageStatus(message: unknown): 'success' | 'error' | null {
  const status = ToolMessage.isInstance(message)
    ? message.status
    : recordUtils.isRecord(message)
      ? readLowercaseString(recordUtils.readRecordValue(message, 'status'))
      : null;
  return status === 'success' || status === 'error' ? status : null;
}

function readToolMessageOutput(message: unknown): unknown {
  if (ToolMessage.isInstance(message)) {
    return readToolContentValue(message.content);
  }
  if (!recordUtils.isRecord(message)) {
    return null;
  }
  return readToolContentValue(recordUtils.readRecordValue(message, 'content'));
}

function readToolContentValue(content: unknown): unknown {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const summary = recordUtils.readMessageContentSummary({ content });
    if (summary.hasVisibleText) {
      return summary.visibleText;
    }
  }
  return content;
}

function readAssistantMessageText(message: unknown): string | null {
  if (!recordUtils.isRecord(message) || !isAssistantMessage(message)) {
    return null;
  }
  if (recordUtils.isNonAssistantTextMessage(message) || recordUtils.isSummarizationMessage(message)) {
    return null;
  }
  const contentSummary = recordUtils.readMessageContentSummary(message);
  if (!contentSummary.hasVisibleText) {
    return null;
  }
  const trimmed = contentSummary.visibleText.trim();
  if (recordUtils.classifyStreamedAssistantText(trimmed) !== 'assistant') {
    return null;
  }
  return trimmed.length === 0 ? null : trimmed;
}

function isAssistantMessage(message: Record<string, unknown>): boolean {
  const role = readLowercaseString(recordUtils.readRecordValue(message, 'role'));
  if (role !== null) {
    return role === 'assistant' || role === 'ai';
  }
  const type = readLowercaseString(recordUtils.readRecordValue(message, 'type'));
  return type === 'assistant' || type === 'ai' || type === 'aimessage';
}

function readLowercaseString(value: unknown): string | null {
  const text = recordUtils.readNonEmptyString(value);
  return text === null ? null : text.toLowerCase();
}

function createExecutorCallbacks(input: { emitRuntimeEvent: (event: ChatRunEvent) => void }): Parameters<typeof consumeMessageStream>[0]['callbacks'] {
  return {
    emitRuntimeEvent: (event) => {
      input.emitRuntimeEvent(event);
    },
    emitTodoEvent: () => {},
    recordTaskEvent: () => {}
  };
}

function createChatRunEventQueue(): AsyncIterable<ChatRunEvent> & {
  close: () => void;
  fail: (error: unknown) => void;
  push: (event: ChatRunEvent) => void;
} {
  const events: ChatRunEvent[] = [];
  let closed = false;
  let failure: unknown = null;
  let waiting:
    | {
        resolve: (result: IteratorResult<ChatRunEvent>) => void;
        reject: (error: unknown) => void;
      }
    | null = null;

  const queue = {
    push: (event: ChatRunEvent): void => {
      if (closed || failure !== null) {
        return;
      }
      if (waiting !== null) {
        const current = waiting;
        waiting = null;
        current.resolve({
          done: false,
          value: event
        });
        return;
      }
      events.push(event);
    },
    close: (): void => {
      if (closed || failure !== null) {
        return;
      }
      closed = true;
      if (waiting !== null) {
        const current = waiting;
        waiting = null;
        current.resolve({
          done: true,
          value: undefined
        });
      }
    },
    fail: (error: unknown): void => {
      if (closed || failure !== null) {
        return;
      }
      failure = error;
      if (waiting !== null) {
        const current = waiting;
        waiting = null;
        current.reject(error);
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<ChatRunEvent> {
      return {
        next: async (): Promise<IteratorResult<ChatRunEvent>> => {
          const event = events.shift();
          if (event !== undefined) {
            return {
              done: false,
              value: event
            };
          }
          if (failure !== null) {
            throw failure;
          }
          if (closed) {
            return {
              done: true,
              value: undefined
            };
          }
          return await new Promise<IteratorResult<ChatRunEvent>>((resolve, reject) => {
            waiting = {
              resolve,
              reject
            };
          });
        }
      };
    }
  };
  return queue;
}

async function createExecutorTools(input: {
  capabilities: RocCapabilityRegistry;
  enabledCapabilities: TaskRun['enabledCapabilities'];
}): Promise<{
  runTools: ClientTool[];
  webReadTool: DynamicStructuredTool<any, any, any, string>;
}> {
  const webReadTool = createWebReadTool(input.capabilities);
  const mcpTools = await loadSelectedMcpTools(input.capabilities, input.enabledCapabilities);
  const runTools: ClientTool[] = [
    webReadTool,
    createDeleteFileTool(input.capabilities),
    createResolveBackgroundTaskTimeTool(),
    ...createApprovalPreviewTools(),
    createConfirmWithUserTool(),
    ...mcpTools
  ];
  return {
    runTools,
    webReadTool
  };
}

async function loadSelectedMcpTools(
  capabilities: RocCapabilityRegistry,
  enabledCapabilities: TaskRun['enabledCapabilities']
): Promise<ClientTool[]> {
  if (enabledCapabilities.mcpServers.length === 0) {
    return [];
  }
  const tools = await capabilities.invoke<{}, unknown[]>('mcp.tools.get', {});
  return tools.flatMap((tool): ClientTool[] => {
    if (!isClientTool(tool)) {
      return [];
    }
    const normalizedName = normalizeMcpToolName(tool.name, enabledCapabilities.mcpServers);
    if (normalizedName === null) {
      return [];
    }
    tool.name = normalizedName;
    return [tool];
  });
}

function isClientTool(value: unknown): value is ClientTool {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'name') === 'string';
}

function normalizeMcpToolName(name: string, enabledServerIds: readonly string[]): string | null {
  if (enabledServerIds.includes('exa-hosted') && (name === 'web_search' || name === 'web_search_exa' || name === 'web_search_advanced_exa')) {
    return 'web_search';
  }
  return enabledServerIds.some((serverId) => name.startsWith(`${serverId}__`)) ? name : null;
}

function createWebReadTool(capabilities: RocCapabilityRegistry): DynamicStructuredTool<any, any, any, string> {
  const schema = z.object({
    url: z.string().url(),
    responseMode: z.enum(['markdown', 'readerlm-v2']).default('markdown'),
    timeoutSeconds: z.number().int().min(1).max(120).default(20),
    noCache: z.boolean().default(false)
  });
  return new DynamicStructuredTool<typeof schema, WebReadRequest, WebReadRequest, string>({
    name: 'web_read',
    description: '读取公开网页正文，返回适合继续分析的文本内容。',
    schema,
    func: async (request) => await capabilities.invoke<WebReadRequest, string>('web.read', request)
  });
}

function createDeleteFileTool(capabilities: RocCapabilityRegistry): DynamicStructuredTool<any, any, any, string> {
  const schema = z.object({
    relativePath: z.string().trim().min(1)
  });
  return new DynamicStructuredTool<typeof schema, { relativePath: string }, { relativePath: string }, string>({
    name: 'delete_file',
    description: '仅删除工作区内文件或空目录，会先写入恢复点；仅当确实需要删除目标时使用。',
    schema,
    func: async (request) =>
      JSON.stringify(await capabilities.invoke<{ relativePath: string }, FileDeleteResult>('files.delete', request), null, 2)
  });
}

function createConfirmWithUserTool(): DynamicStructuredTool<any, any, any, string> {
  const schema = z.strictObject({
    summary: z.string().min(1).max(1000)
  });
  return new DynamicStructuredTool<typeof schema, { summary: string }, { summary: string }, string>({
    name: 'confirm_with_user',
    description: '把刚才完成的工作总结成一句话给用户。',
    schema,
    func: async ({ summary }) => JSON.stringify({ ok: true, summary }, null, 2)
  });
}

function createApprovalPreviewTools(): Array<DynamicStructuredTool<any, any, any, string>> {
  return [
    new DynamicStructuredTool({
      name: PROPOSE_TOOL_NAME,
      description: PROPOSE_TOOL_DESCRIPTION,
      schema: z.strictObject({
        goal: z.string().min(1),
        trigger: z.unknown(),
        workspacePath: z.string().min(1)
      }),
      func: async (rawInput) =>
        JSON.stringify(
          {
            kind: PROPOSE_TOOL_NAME,
            request: rawInput,
            risk: 'high',
            requiredFields: ['decision']
          },
          null,
          2
        )
    }),
    new DynamicStructuredTool<typeof updateInputSchema, z.infer<typeof updateInputSchema>, z.infer<typeof updateInputSchema>, string>({
      name: 'update_background_task',
      description: '提议修改已有后台任务。只返回审批预览，用户批准前不会修改任务。',
      schema: updateInputSchema,
      func: async (rawInput) => JSON.stringify(createUpdatePayload(rawInput), null, 2)
    }),
    new DynamicStructuredTool<typeof cancelInputSchema, z.infer<typeof cancelInputSchema>, z.infer<typeof cancelInputSchema>, string>({
      name: 'cancel_background_task',
      description: '提议取消已有后台任务。只返回审批请求，用户批准前不会取消任务。',
      schema: cancelInputSchema,
      func: async (rawInput) =>
        JSON.stringify(
          {
            kind: 'cancel_background_task',
            request: cancelInputSchema.parse(rawInput),
            risk: 'high',
            requiredFields: ['decision']
          },
          null,
          2
        )
    })
  ];
}

function createUpdatePayload(rawInput: unknown): Record<string, unknown> {
  const parsed = updateInputSchema.parse(rawInput);
  validateBackgroundTaskPatch(parsed.patch);
  return {
    kind: 'update_background_task',
    request: parsed,
    risk: 'high',
    requiredFields: ['decision']
  };
}

function createRuntimeBackend(input: {
  capabilities: RocCapabilityRegistry;
  handle: LangChainChatModelHandle;
  paths: RocPaths;
  selectedSkillIds: readonly string[];
  workspace: Workspace | null;
}): ReturnType<typeof createBackend> {
  const workspaceService = {
    getCurrentWorkspace: () =>
      input.workspace === null
        ? null
        : {
            path: input.workspace.path,
            label: input.workspace.displayName
          }
  };
  const shellExecutionService: AgentExecuteAdapter = {
    executeAgentCommand: async ({ command, cwd }) => {
      const result = await input.capabilities.invoke<
        { command: string; cwd?: string; source: 'agent' },
        ShellExecutionResult
      >('shell.execute', {
        command,
        cwd,
        source: 'agent'
      });
      return {
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        output: formatShellOutput(result),
        truncated: false,
        usedRtk: result.usedRtk
      };
    }
  };
  return createBackend({
    workspaceService: workspaceService as Parameters<typeof createBackend>[0]['workspaceService'],
    paths: input.paths,
    shellExecutionService,
    securityScan: new SecurityScanService(defaultSettings.memory.securityScan),
    capacity: new CapacityService(defaultSettings.memory.charLimits),
    consolidatorService: {
      scheduleForFile: () => {}
    } as unknown as Parameters<typeof createBackend>[0]['consolidatorService'],
    activeModelHandle: input.handle,
    selectedSkillIds: input.selectedSkillIds
  });
}

function formatShellOutput(result: ShellExecutionResult): string {
  const output = [result.stdout, result.stderr].filter((value) => value.length > 0).join('\n');
  if (output.length === 0) {
    return `<no output>\n\nExit code: ${result.exitCode}`;
  }
  return result.exitCode === 0 ? output : `${output.trimEnd()}\n\nExit code: ${result.exitCode}`;
}
