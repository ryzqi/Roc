import { HumanMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { BaseStore } from '@langchain/langgraph';
import type { ClientTool } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import type {
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatRunEvent,
  ChatStartRunRequest,
  FileDeleteResult,
  TaskDetail,
  TaskRun,
  UpdateBackgroundTaskRequest,
  Workspace
} from '../../../shared/types';
import type { RocCapabilityRegistry } from '../../kernel/types';
import { buildDeepAgent } from '../../services/deep-agent/agent-builder';
import { consumeMessageStream, consumeSubagentStream, consumeToolCallStream, createUsageAccumulator } from '../../services/deep-agent/stream-consumers';
import { createRunSubagents } from '../../services/deep-agent/tools';
import { defaultErrorTracker, PreviewStore } from '../../services/forge-guardrails';
import { defaultSettings } from '../../services/config/defaults';
import type { WebReadRequest } from '../../services/web-read-service';
import { webReadToolSchema } from '../../services/web-read-request-schema';
import type { RocPaths } from '../../services/paths';
import { createBackgroundTaskTools } from '../../services/deep-agent/background-task-tools';
import { createResolveBackgroundTaskTimeTool } from '../../services/deep-agent/background-task-time-tool';
import { createBackend, createRocFilesystemPermissions } from '../../services/deep-agent/backend';
import { createRocWindowsCommandTool } from '../../services/deep-agent/command-tool';
import { buildSystemPrompt } from '../../services/deep-agent/prompt';
import type { AgentExecuteAdapter } from '../../services/deep-agent/types';
import type { LangChainChatModelHandle } from '../../services/langchain-model-factory';
import { CapacityService } from '../../services/memory/capacity';
import { SecurityScanService } from '../../services/memory/security-scan';
import type { AgentDeepAgentExecutor } from './runtime';
import { createChatRunEventQueue } from './chat-run-event-queue';
import {
  readFinalAssistantText,
  readFinalToolBlockEvents,
  readInterrupted,
  readRunInterruptedEvent
} from './deep-agent-final-output';

export type AgentDeepAgentExecutorOptions = {
  capabilities: RocCapabilityRegistry;
  paths: RocPaths;
  store: BaseStore;
};

export function createAgentDeepAgentExecutor(options: AgentDeepAgentExecutorOptions): AgentDeepAgentExecutor {
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
      const runtimeWorkspace = resolveRuntimeWorkspace(input.request, workspace);
      requireWorkbenchSourceForBackgroundTaskWorkflow(input.request);
      const shellExecutionService = createShellExecutionAdapter(options.capabilities, runtimeWorkspace === null ? null : runtimeWorkspace.path);
      const tools = await createExecutorTools({
        capabilities: options.capabilities,
        enabledCapabilities: input.request.enabledCapabilities,
        backgroundTaskToolMode: readBackgroundTaskToolMode(input.request),
        runtimeWorkspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        shellExecutionService
      });
      const runtimeBackend = createRuntimeBackend({
        capabilities: options.capabilities,
        handle,
        paths: options.paths,
        selectedSkillIds: input.request.enabledCapabilities.skills,
        store: options.store,
        workspace: runtimeWorkspace
      });
      const systemPrompt = buildSystemPrompt({
        enabledCapabilities: input.request.enabledCapabilities,
        workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        workflowHint: input.request.workflowHint === undefined ? null : input.request.workflowHint
      });
      const agent = buildDeepAgent({
        model: handle.model,
        systemPrompt,
        backend: runtimeBackend.backend,
        store: options.store,
        memorySources: runtimeBackend.memorySources,
        skillSources: input.request.enabledCapabilities.skills.length === 0 ? [] : ['/skills/'],
        subagents: createRunSubagents({
          webReadTool: tools.webReadTool
        }),
        tools: tools.runTools,
        filesystemPermissions: createRocFilesystemPermissions(),
        workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        interruptOn: await readInterruptPolicy(options.capabilities, input.request.enabledCapabilities, input.request),
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
  enabledCapabilities: TaskRun['enabledCapabilities'],
  request: ChatStartRunRequest
): Promise<NonNullable<Parameters<typeof buildDeepAgent>[0]['interruptOn']> | undefined> {
  const backgroundTaskInterrupts = createBackgroundTaskInterruptPolicy(request);
  if (!capabilities.list().some((capability) => capability.name === 'agent.capability.preview')) {
    return backgroundTaskInterrupts;
  }
  const preview = await capabilities.invoke<
    TaskRun['enabledCapabilities'],
    { interruptOn: NonNullable<Parameters<typeof buildDeepAgent>[0]['interruptOn']> }
  >('agent.capability.preview', enabledCapabilities);
  if (backgroundTaskInterrupts === undefined) {
    return preview.interruptOn;
  }
  return {
    ...preview.interruptOn,
    ...backgroundTaskInterrupts
  };
}

function createBackgroundTaskInterruptPolicy(
  request: ChatStartRunRequest
): NonNullable<Parameters<typeof buildDeepAgent>[0]['interruptOn']> | undefined {
  if (!isBackgroundTaskWorkflow(request) || request.taskSource !== 'workbench') {
    return undefined;
  }
  return {
    update_background_task: {
      allowedDecisions: ['approve', 'edit', 'reject']
    },
    cancel_background_task: {
      allowedDecisions: ['approve', 'edit', 'reject']
    }
  };
}

function createInitialState(input: string): unknown {
  return {
    messages: [new HumanMessage(input)],
    forge_error_tracker: defaultErrorTracker()
  };
}

function resolveRuntimeWorkspace(request: ChatStartRunRequest, currentWorkspace: Workspace | null): Workspace | null {
  if (request.workspacePath === undefined || request.workspacePath === null) {
    return currentWorkspace;
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

function createExecutorCallbacks(input: { emitRuntimeEvent: (event: ChatRunEvent) => void }): Parameters<typeof consumeMessageStream>[0]['callbacks'] {
  return {
    emitRuntimeEvent: (event) => {
      input.emitRuntimeEvent(event);
    },
    emitTodoEvent: () => {},
    recordTaskEvent: () => {}
  };
}

async function createExecutorTools(input: {
  capabilities: RocCapabilityRegistry;
  enabledCapabilities: TaskRun['enabledCapabilities'];
  backgroundTaskToolMode: 'all' | 'change' | null;
  runtimeWorkspacePath: string | null;
  shellExecutionService: AgentExecuteAdapter;
}): Promise<{
  runTools: ClientTool[];
  webReadTool: DynamicStructuredTool<any, any, any, string>;
}> {
  const webReadTool = createWebReadTool(input.capabilities);
  const mcpTools = await loadSelectedMcpTools(input.capabilities, input.enabledCapabilities);
  const runTools: ClientTool[] = [
    webReadTool,
    createDeleteFileTool(input.capabilities),
    createRocWindowsCommandTool(input.shellExecutionService),
    ...mcpTools
  ];
  if (input.backgroundTaskToolMode !== null) {
    const backgroundTaskTools = createBackgroundTaskTools({
      enabledCapabilities: input.enabledCapabilities,
      previewStore: new PreviewStore(),
      runtimeWorkspacePath: input.runtimeWorkspacePath,
      toolMode: input.backgroundTaskToolMode,
      taskAdapter: {
        createBackgroundTaskPreview: async (request) =>
          await input.capabilities.invoke<BackgroundTaskPreviewRequest, BackgroundTaskPreview>('task.background.preview', request),
        createBackgroundTask: async (preview) =>
          await input.capabilities.invoke<BackgroundTaskPreview, BackgroundTask>('task.background.create', preview),
        readBackgroundTask: async (taskId) =>
          await input.capabilities.invoke<{ taskId: string }, TaskDetail>('task.detail.get', { taskId }),
        updateBackgroundTask: async (request) =>
          await input.capabilities.invoke<UpdateBackgroundTaskRequest, BackgroundTask>('task.background.update', request),
        cancelBackgroundTask: async (taskId) =>
          await input.capabilities.invoke<{ id: string }, BackgroundTask>('task.background.cancel', { id: taskId })
      },
      schedulerAdapter: {
        refreshTask: () => {},
        registerTask: () => {},
        unregisterTask: () => {}
      }
    });
    if (input.backgroundTaskToolMode === 'all') {
      runTools.splice(2, 0, createResolveBackgroundTaskTimeTool(), ...backgroundTaskTools);
    } else {
      runTools.splice(2, 0, ...backgroundTaskTools);
    }
  }
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

function isBackgroundTaskWorkflow(request: ChatStartRunRequest): boolean {
  return request.workflowHint === 'propose_background_task' || request.workflowHint === 'background_task_change';
}

function readBackgroundTaskToolMode(request: ChatStartRunRequest): 'all' | 'change' | null {
  if (request.workflowHint === 'propose_background_task') {
    return 'all';
  }
  if (request.workflowHint === 'background_task_change') {
    return 'change';
  }
  return null;
}

function requireWorkbenchSourceForBackgroundTaskWorkflow(request: ChatStartRunRequest): void {
  if (!isBackgroundTaskWorkflow(request)) {
    return;
  }
  if (request.taskSource !== 'workbench') {
    throw new Error('background_task_workbench_source_required');
  }
}

function isClientTool(value: unknown): value is ClientTool {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'name') === 'string';
}

function normalizeMcpToolName(name: string, enabledServerIds: readonly string[]): string | null {
  if (
    enabledServerIds.includes('exa-hosted') &&
    (name === 'web_search' ||
      name === 'web_search_exa' ||
      name === 'web_search_advanced_exa' ||
      name === 'exa-hosted__web_search_exa' ||
      name === 'exa-hosted__web_search_advanced_exa')
  ) {
    return 'web_search';
  }
  return enabledServerIds.some((serverId) => name.startsWith(`${serverId}__`)) ? name : null;
}

function createWebReadTool(capabilities: RocCapabilityRegistry): DynamicStructuredTool<any, any, any, string> {
  const schema = webReadToolSchema;
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

function createRuntimeBackend(input: {
  capabilities: RocCapabilityRegistry;
  handle: LangChainChatModelHandle;
  paths: RocPaths;
  selectedSkillIds: readonly string[];
  store: BaseStore;
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
  return createBackend({
    workspaceService: workspaceService as Parameters<typeof createBackend>[0]['workspaceService'],
    paths: input.paths,
    store: input.store,
    securityScan: new SecurityScanService(defaultSettings.memory.securityScan),
    capacity: new CapacityService(defaultSettings.memory.charLimits),
    selectedSkillIds: input.selectedSkillIds
  });
}

function createShellExecutionAdapter(capabilities: RocCapabilityRegistry, defaultCwd: string | null): AgentExecuteAdapter {
  return {
    executeAgentCommand: async ({ command, cwd }) => {
      const requestCwd = cwd === undefined ? defaultCwd : cwd;
      if (requestCwd === null) {
        throw new Error('agent_workspace_required_for_shell');
      }
      const result = await capabilities.invoke<
        { command: string; cwd?: string; source: 'agent' },
        import('../../../shared/types').ShellExecutionResult
      >('shell.execute', {
        command,
        cwd: requestCwd,
        source: 'agent'
      });
      return {
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        output: formatShellOutput(result),
        truncated: false,
        usedRtk: result.usedRtk,
        bypassReason: result.bypassReason
      };
    }
  };
}

function formatShellOutput(result: import('../../../shared/types').ShellExecutionResult): string {
  const output = [result.stdout, result.stderr].filter((value) => value.length > 0).join('\n');
  if (output.length === 0) {
    return `<no output>\n\nExit code: ${result.exitCode}`;
  }
  return result.exitCode === 0 ? output : `${output.trimEnd()}\n\nExit code: ${result.exitCode}`;
}
