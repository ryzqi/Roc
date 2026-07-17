import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import type { ClientTool } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import type {
  AppSettings,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatRunEvent,
  ChatRunMode,
  ChatValidatedImageAttachment,
  FileDeleteResult,
  RunCapabilityManifestV1,
  RunExecutionSnapshotV1,
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
import { createBackend } from '../../services/deep-agent/backend';
import { createAskUserTool } from '../../services/deep-agent/ask-user-tool';
import {
  createRocFilesystemPermissions,
  createRocReadOnlyFilesystemPermissions,
  toWorkspaceRelativePath
} from '../../services/deep-agent/filesystem-tool-contract';
import { createRocWindowsCommandTool } from '../../services/deep-agent/command-tool';
import { assembleContextHarness } from '../../services/deep-agent/context/context-assembler';
import type { ContextArtifactStore } from '../../services/deep-agent/context/context-artifact-store';
import type { ContextMaintenanceEvent } from '../../services/deep-agent/context/context-compaction-pipeline';
import { loadExplicitSkillContexts } from '../../services/deep-agent/context/explicit-skills';
import type { AgentToolEffectStore } from '../../services/deep-agent/tool-effect-store';
import { createToolOutputProjector, type ToolOutputProjector } from '../../services/deep-agent/tool-output-projection';
import type { AgentExecuteAdapter, StringDynamicStructuredTool } from '../../services/deep-agent/types';
import type { HookRuntime } from '../../services/hooks';
import type { LangChainChatModelHandle } from '../../services/langchain-model-factory';
import { CapacityService } from '../../services/memory/capacity';
import { SecurityScanService } from '../../services/memory/security-scan';
import type { MetricsService } from '../../services/metrics-service';
import type { AgentDeepAgentExecutor } from './runtime';
import { createChatRunEventQueue } from './chat-run-event-queue';
import {
  readFinalAssistantText,
  readInterrupted,
  readRunInterruptedEvent
} from './deep-agent-final-output';

export type AgentDeepAgentExecutorOptions = {
  capabilities: RocCapabilityRegistry;
  checkpointer: BaseCheckpointSaver;
  contextArtifactStore: ContextArtifactStore;
  getMemorySettings?: () => AppSettings['memory'];
  hookRuntime?: Pick<HookRuntime, 'runEvent'>;
  metricsService?: Pick<MetricsService, 'recordPromptCacheMetrics'>;
  paths: RocPaths;
  store: BaseStore;
  toolEffectStore: AgentToolEffectStore;
};

export function createAgentDeepAgentExecutor(options: AgentDeepAgentExecutorOptions): AgentDeepAgentExecutor {
  return {
    execute: async function* (input) {
      const handle = input.modelHandle.langChainHandle;
      if (handle === undefined) {
        throw new Error('agent_deep_agent_model_handle_missing');
      }
      const mode = readExecutorMode(input.snapshot);
      const workflowHint = input.snapshot.workflowHint;
      const assistantChunks: string[] = [];
      const reasoningChunks: string[] = [];
      const usageAccumulator = createUsageAccumulator();
      const eventQueue = createChatRunEventQueue();
      const executionAbortController = new AbortController();
      const abortFromParent = () => executionAbortController.abort(input.abortSignal.reason);
      if (input.abortSignal.aborted) {
        abortFromParent();
      } else {
        input.abortSignal.addEventListener('abort', abortFromParent, { once: true });
      }
      const emitRuntimeEvent = (event: ChatRunEvent): void => {
        if (eventQueue.push(event)) {
          return;
        }
        const overflow = new Error('chat_run_event_queue_overflow');
        executionAbortController.abort(overflow);
        throw overflow;
      };

      const runtimeWorkspace = createWorkspaceFromSnapshot(input.snapshot);
      requireWorkbenchSourceForBackgroundTaskWorkflow(input.snapshot);
      const hookRunContext = {
        runId: input.run.id,
        threadId: input.run.threadId,
        workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        cwd: runtimeWorkspace === null ? options.paths.root : runtimeWorkspace.path,
        source: isBackgroundTaskWorkflow(input.snapshot) ? ('background_task' as const) : ('chat' as const),
        modelId: input.modelHandle.modelId,
        workflowHint
      };
      const shellExecutionService = createShellExecutionAdapter(options.capabilities, runtimeWorkspace === null ? null : runtimeWorkspace.path);
      const tools = await createExecutorTools({
        capabilities: options.capabilities,
        capabilityManifest: input.snapshot.capabilityManifest,
        enabledCapabilities: input.snapshot.capabilityManifest.resolvedCapabilities,
        backgroundTaskToolMode: mode === 'plan' ? null : readBackgroundTaskToolMode(input.snapshot),
        runtimeWorkspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        shellExecutionService,
        mode
      });
      const explicitSkillContexts = loadExplicitSkillContexts({
        explicitSkillIds: input.snapshot.explicitSkillIds,
        manifestSkills: input.snapshot.capabilityManifest.skills
      });
      const runtimeBackend = createRuntimeBackend({
        capabilities: options.capabilities,
        getMemorySettings: options.getMemorySettings,
        handle,
        paths: options.paths,
        selectedSkillIds: [
          ...input.snapshot.capabilityManifest.resolvedCapabilities.skills,
          ...explicitSkillContexts.map((skill) => skill.id)
        ],
        store: options.store,
        workspace: runtimeWorkspace
      });
      const contextHarness = assembleContextHarness({
        mode,
        enabledCapabilities: input.snapshot.capabilityManifest.resolvedCapabilities,
        workflowHint,
        workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        memorySources: runtimeBackend.memorySources,
        baseTools: tools.runTools,
        searchSessions: request => options.capabilities.invoke('agent.sessions.search', request),
        explicitSkillContexts
      });
      const emitContextMaintenanceEvent = (event: ContextMaintenanceEvent) => {
        emitRuntimeEvent({
          type: 'context_maintenance',
          runId: input.run.id,
          threadId: input.run.threadId,
          event: event.type,
          mode,
          stage: event.stage,
          ...(event.persistedChars === undefined ? {} : { persistedChars: event.persistedChars }),
          ...(event.removedChars === undefined ? {} : { removedChars: event.removedChars })
        });
      };
      const initialHookContexts: string[] = [];
      if (options.hookRuntime !== undefined) {
        const sessionStart = await options.hookRuntime.runEvent({
          schemaVersion: 1,
          event: 'SessionStart',
          runId: input.run.id,
          threadId: input.run.threadId,
          workspacePath: hookRunContext.workspacePath,
          cwd: hookRunContext.cwd,
          triggeredAt: new Date().toISOString(),
          payload: {
            source: hookRunContext.source,
            modelId: input.modelHandle.modelId,
            workflowHint: hookRunContext.workflowHint
          }
        });
        for (const event of sessionStart.events) {
          emitRuntimeEvent(event);
        }
        if (sessionStart.blocked) {
          eventQueue.fail(new Error(sessionStart.blockReason === null ? 'Blocked by SessionStart hook.' : sessionStart.blockReason));
          try {
            for await (const event of eventQueue) {
              yield event;
            }
          } finally {
            input.abortSignal.removeEventListener('abort', abortFromParent);
          }
          return;
        }
        initialHookContexts.push(...sessionStart.additionalContexts);
      }
      const agent = buildDeepAgent({
        mode,
        model: handle.model,
        systemPrompt: contextHarness.systemPrompt,
        backend: runtimeBackend.backend,
        store: options.store,
        memorySources: contextHarness.memorySources,
        skillSources: contextHarness.skillSources,
        subagents: createRunSubagents({
          webReadTool: tools.webReadTool
        }),
        tools: contextHarness.tools,
        filesystemPermissions:
          mode === 'plan'
            ? createRocReadOnlyFilesystemPermissions()
            : createRocFilesystemPermissions(),
        workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        interruptOn: readInterruptPolicy(input.snapshot.capabilityManifest, input.snapshot),
        checkpointer: options.checkpointer,
        workflowHint,
        contextBudgetTokens:
          input.snapshot.budget.contextBudgetTokens === null ? undefined : input.snapshot.budget.contextBudgetTokens,
        contextCompaction: {
          artifactStore: options.contextArtifactStore,
          emitEvent: emitContextMaintenanceEvent,
          mode,
          runId: input.run.id,
          threadId: input.run.threadId,
          workspaceHash: contextHarness.workspaceIdentity === null ? null : contextHarness.workspaceIdentity.hash
        },
        toolEffectIdempotency: {
          runId: input.run.id,
          threadId: input.run.threadId,
          store: options.toolEffectStore
        },
        hookMiddleware:
          options.hookRuntime === undefined
            ? undefined
            : {
                hookRuntime: options.hookRuntime,
                runContext: hookRunContext,
                emitHookEvent: emitRuntimeEvent,
                initialContexts: initialHookContexts
              }
      });
      const runInput =
        input.resumePayload === undefined
          ? createInitialState(input.run.userInput, input.validatedAttachments)
          : new Command({
              resume: input.resumePayload
            });
      const run = await agent.streamEvents(runInput as never, {
        version: 'v3',
        configurable: {
          run_id: input.run.id,
          thread_id: input.run.threadId
        },
        signal: executionAbortController.signal
      });
      const taskRun = input.run;
      const callbacks = createExecutorCallbacks({
        emitRuntimeEvent,
        projectToolOutput: createToolOutputProjector({
          artifactStore: options.contextArtifactStore,
          runId: input.run.id,
          threadId: input.run.threadId,
          workspaceHash: contextHarness.workspaceIdentity === null ? null : contextHarness.workspaceIdentity.hash
        })
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
          recordPromptCacheMetrics({
            metricsService: options.metricsService,
            modelId: input.modelHandle.modelId,
            mode,
            providerId: input.modelHandle.providerId,
            source: hookRunContext.source,
            usageAccumulator
          });
          if (readInterrupted(run)) {
            emitRuntimeEvent(readRunInterruptedEvent(run, input.run.id, input.run.threadId));
          } else {
            const output = await Promise.resolve(run.output);
            const finalAssistantText = readFinalAssistantText(output);
            if (assistantChunks.join('').trim().length === 0 && finalAssistantText !== null) {
              assistantChunks.push(finalAssistantText);
              emitRuntimeEvent({
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
          }
          eventQueue.close();
        } catch (error) {
          eventQueue.fail(error);
          throw error;
        }
      })();
      try {
        for await (const event of eventQueue) {
          yield event;
        }
        await consumeRun;
      } finally {
        executionAbortController.abort(new Error('chat_run_event_consumer_stopped'));
        await consumeRun.catch(() => undefined);
        input.abortSignal.removeEventListener('abort', abortFromParent);
      }
    }
  };
}

function recordPromptCacheMetrics(input: {
  metricsService: Pick<MetricsService, 'recordPromptCacheMetrics'> | undefined;
  usageAccumulator: ReturnType<typeof createUsageAccumulator>;
  mode: ChatRunMode;
  source: 'chat' | 'background_task';
  providerId: string;
  modelId: string;
}): void {
  if (input.metricsService === undefined || input.usageAccumulator.promptTokens === null) {
    return;
  }
  const usage: Parameters<MetricsService['recordPromptCacheMetrics']>[0] = {
    input_tokens: input.usageAccumulator.promptTokens
  };
  if (input.usageAccumulator.cacheReadTokens !== null) {
    usage.cache_read_tokens = input.usageAccumulator.cacheReadTokens;
  }
  if (input.usageAccumulator.cacheCreationTokens !== null) {
    usage.cache_creation_tokens = input.usageAccumulator.cacheCreationTokens;
  }
  input.metricsService.recordPromptCacheMetrics(usage, {
    mode: input.mode,
    source: input.source,
    providerId: input.providerId,
    modelId: input.modelId
  });
}

function readInterruptPolicy(
  manifest: RunCapabilityManifestV1,
  snapshot: RunExecutionSnapshotV1
): NonNullable<Parameters<typeof buildDeepAgent>[0]['interruptOn']> | undefined {
  const backgroundTaskInterrupts = createBackgroundTaskInterruptPolicy(snapshot);
  const interruptOn: NonNullable<Parameters<typeof buildDeepAgent>[0]['interruptOn']> = {};
  for (const tool of manifest.tools) {
    if (tool.approvalPolicy.kind === 'required') {
      interruptOn[tool.modelVisibleName] = {
        allowedDecisions: tool.approvalPolicy.allowedDecisions
      };
    }
  }
  if (backgroundTaskInterrupts === undefined) {
    return Object.keys(interruptOn).length === 0 ? undefined : interruptOn;
  }
  return {
    ...interruptOn,
    ...backgroundTaskInterrupts
  };
}

function createBackgroundTaskInterruptPolicy(
  snapshot: RunExecutionSnapshotV1
): NonNullable<Parameters<typeof buildDeepAgent>[0]['interruptOn']> | undefined {
  if (!isBackgroundTaskWorkflow(snapshot) || snapshot.runOrigin !== 'workbench_creation') {
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

function createInitialState(input: string, attachments: readonly ChatValidatedImageAttachment[] | undefined): unknown {
  if (attachments !== undefined && attachments.length > 0) {
    return {
      messages: [
        new HumanMessage({
          content: [
            { type: 'text', text: input },
            ...attachments.map((attachment) => ({
              type: 'image' as const,
              mimeType: attachment.mediaType,
              data: attachment.base64
            }))
          ]
        })
      ],
      forge_error_tracker: defaultErrorTracker()
    };
  }
  return {
    messages: [new HumanMessage(input)],
    forge_error_tracker: defaultErrorTracker()
  };
}

function createWorkspaceFromSnapshot(snapshot: RunExecutionSnapshotV1): Workspace | null {
  if (snapshot.workspace === null) {
    return null;
  }
  return {
    id: 'snapshot-workspace',
    path: snapshot.workspace.path,
    displayName: snapshot.workspace.path,
    lastOpenedAt: new Date().toISOString(),
    trustState: 'trusted'
  };
}

function createExecutorCallbacks(input: {
  emitRuntimeEvent: (event: ChatRunEvent) => void;
  projectToolOutput: ToolOutputProjector;
}): Parameters<typeof consumeMessageStream>[0]['callbacks'] {
  return {
    emitRuntimeEvent: (event) => {
      input.emitRuntimeEvent(event);
    },
    emitTodoEvent: () => {},
    projectToolOutput: input.projectToolOutput,
    recordTaskEvent: () => {}
  };
}

async function createExecutorTools(input: {
  capabilities: RocCapabilityRegistry;
  capabilityManifest: RunCapabilityManifestV1;
  enabledCapabilities: TaskRun['enabledCapabilities'];
  backgroundTaskToolMode: 'all' | 'change' | null;
  runtimeWorkspacePath: string | null;
  shellExecutionService: AgentExecuteAdapter;
  mode: ChatRunMode;
}): Promise<{
  runTools: ClientTool[];
  webReadTool: StringDynamicStructuredTool;
}> {
  const webReadTool = createWebReadTool(input.capabilities);
  const askUserTool = createAskUserTool();
  const mcpTools = await loadSelectedMcpTools(input.capabilities, input.capabilityManifest);
  if (input.mode === 'plan') {
    return {
      runTools: [webReadTool, askUserTool, ...mcpTools],
      webReadTool
    };
  }
  const runTools: ClientTool[] = [
    webReadTool,
    askUserTool,
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
        createBackgroundTask: async (request) =>
          await input.capabilities.invoke<BackgroundTaskPreviewRequest, BackgroundTask>('task.background.create', request),
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
  capabilityManifest: RunCapabilityManifestV1
): Promise<ClientTool[]> {
  const selectedTools = capabilityManifest.tools.filter((tool) => tool.provenance.kind === 'mcp');
  if (selectedTools.length === 0) {
    return [];
  }
  const tools = await capabilities.invoke<{}, unknown[]>('mcp.tools.get', {});
  return tools.flatMap((tool): ClientTool[] => {
    if (!isClientTool(tool)) {
      return [];
    }
    const modelVisibleName = resolveManifestMcpToolName(tool.name, selectedTools);
    if (modelVisibleName === null) {
      return [];
    }
    tool.name = modelVisibleName;
    return [tool];
  });
}

function isBackgroundTaskWorkflow(snapshot: RunExecutionSnapshotV1): boolean {
  return snapshot.workflowHint === 'propose_background_task' || snapshot.workflowHint === 'background_task_change';
}

function readBackgroundTaskToolMode(snapshot: RunExecutionSnapshotV1): 'all' | 'change' | null {
  if (snapshot.workflowHint === 'propose_background_task') {
    return 'all';
  }
  if (snapshot.workflowHint === 'background_task_change') {
    return 'change';
  }
  return null;
}

function requireWorkbenchSourceForBackgroundTaskWorkflow(snapshot: RunExecutionSnapshotV1): void {
  if (!isBackgroundTaskWorkflow(snapshot)) {
    return;
  }
  if (snapshot.runOrigin !== 'workbench_creation') {
    throw new Error('background_task_workbench_source_required');
  }
}

function isClientTool(value: unknown): value is ClientTool {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'name') === 'string';
}

function resolveManifestMcpToolName(
  runtimeName: string,
  selectedTools: RunCapabilityManifestV1['tools']
): string | null {
  for (const tool of selectedTools) {
    if (tool.provenance.kind !== 'mcp') {
      continue;
    }
    if (tool.provenance.serverId === 'exa-hosted' && isExaHostedWebSearchName(runtimeName)) {
      return tool.modelVisibleName === 'web_search' ? tool.modelVisibleName : null;
    }
    if (runtimeName === `${tool.provenance.serverId}__${tool.modelVisibleName}`) {
      return tool.modelVisibleName;
    }
  }
  return null;
}

function readExecutorMode(snapshot: RunExecutionSnapshotV1): ChatRunMode {
  return snapshot.mode === 'run' ? 'chat' : snapshot.mode;
}

function isExaHostedWebSearchName(name: string): boolean {
  return (
    name === 'web_search' ||
    name === 'web_search_exa' ||
    name === 'web_search_advanced_exa' ||
    name === 'exa-hosted__web_search_exa' ||
    name === 'exa-hosted__web_search_advanced_exa'
  );
}

function createWebReadTool(capabilities: RocCapabilityRegistry): StringDynamicStructuredTool {
  const schema = webReadToolSchema;
  return new DynamicStructuredTool<typeof schema, WebReadRequest, WebReadRequest, string>({
    name: 'web_read',
    description: '读取公开网页正文，返回适合继续分析的文本内容。',
    schema,
    func: async (request) => await capabilities.invoke<WebReadRequest, string>('web.read', request)
  });
}

function createDeleteFileTool(capabilities: RocCapabilityRegistry): StringDynamicStructuredTool {
  const schema = z.object({
    file_path: z.string().trim().min(1)
  });
  return new DynamicStructuredTool<typeof schema, { file_path: string }, { file_path: string }, string>({
    name: 'delete_file',
    description: '删除 /workspace/... 下的文件或空目录，会先写入恢复点；仅当确实需要删除目标时使用。',
    schema,
    func: async (request) => {
      const relativePath = toWorkspaceRelativePath(request.file_path);
      if (!relativePath.ok) {
        throw new Error(relativePath.error);
      }
      return JSON.stringify(
        await capabilities.invoke<{ relativePath: string }, FileDeleteResult>('files.delete', {
          relativePath: relativePath.relativePath
        }),
        null,
        2
      );
    }
  });
}

function createRuntimeBackend(input: {
  capabilities: RocCapabilityRegistry;
  getMemorySettings?: () => AppSettings['memory'];
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
  const memorySettings = input.getMemorySettings === undefined ? defaultSettings.memory : input.getMemorySettings();
  return createBackend({
    workspaceService: workspaceService as Parameters<typeof createBackend>[0]['workspaceService'],
    paths: input.paths,
    store: input.store,
    securityScan: new SecurityScanService(memorySettings.securityScan),
    capacity: new CapacityService(memorySettings.charLimits),
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
