import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { BaseCheckpointSaver, BaseStore } from '@langchain/langgraph';
import type { ClientTool } from '@langchain/core/tools';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { z } from 'zod';

import type {
  AppSettings,
  BackgroundTask,
  BackgroundTaskPreview,
  BackgroundTaskPreviewRequest,
  ChatRunEvent,
  ChatValidatedImageAttachment,
  FileDeleteResult,
  RunCapabilityManifestV1,
  RunExecutionSnapshotV2,
  TaskDetail,
  TaskRun,
  UpdateBackgroundTaskRequest,
  Workspace
} from '../../../shared/types';
import type { RocCapabilityRegistry } from '../../kernel/types';
import { buildDeepAgent } from '../../services/deep-agent/agent-builder';
import { adaptDeepAgentRun } from '../../services/deep-agent/deep-agent-stream-adapter';
import {
  consumeDeepAgentEventStream,
  createStreamConsumerState,
  createUsageAccumulator
} from '../../services/deep-agent/stream-consumers';
import { createRunSubagents } from '../../services/deep-agent/subagents';
import { defaultErrorTracker, PreviewStore } from '../../services/forge-guardrails';
import { defaultSettings } from '../../services/config/defaults';
import type { WebReadExecutionRequest, WebReadRequest, WebReadResult } from '../../services/web-read-service';
import { webReadToolSchema } from '../../services/web-read-request-schema';
import type { RocPaths } from '../../services/paths';
import { createBackgroundTaskTools } from '../../services/deep-agent/background-task-tools';
import { createResolveBackgroundTaskTimeTool } from '../../services/deep-agent/background-task-time-tool';
import { createBackend } from '../../services/deep-agent/backend';
import { createAskUserTool } from '../../services/deep-agent/ask-user-tool';
import {
  toWorkspaceRelativePath
} from '../../services/deep-agent/filesystem-tool-contract';
import { createRocWindowsCommandTool } from '../../services/deep-agent/command-tool';
import { assembleContextHarness } from '../../services/deep-agent/context/context-assembler';
import type { ContextArtifactStore } from '../../services/deep-agent/context/context-artifact-store';
import type { ContextMaintenanceEvent } from '../../services/deep-agent/context/context-compaction-pipeline';
import {
  createContextTokenCounter,
  deriveContextBudgetProfile
} from '../../services/deep-agent/context/context-token-budget';
import type { ContextBudgetProfile, ContextToolDefinition } from '../../services/deep-agent/context/context-token-budget';
import { loadExplicitSkillContexts } from '../../services/deep-agent/context/explicit-skills';
import { loadReferencedFileContexts } from '../../services/deep-agent/context/referenced-files';
import type { AgentToolEffectStore } from '../../services/deep-agent/tool-effect-store';
import { createToolOutputProjector } from '../../services/deep-agent/tool-output-projection';
import type { AgentExecuteAdapter, StringDynamicStructuredTool } from '../../services/deep-agent/types';
import type { HookRuntime } from '../../services/hooks';
import type { LangChainChatModelHandle } from '../../services/langchain-model-factory';
import { CapacityService } from '../../services/memory/capacity';
import { SecurityScanService } from '../../services/memory/security-scan';
import type { MetricsService } from '../../services/metrics-service';
import type { AgentDeepAgentExecutor } from './runtime';
import type { AgentModelUsageTelemetry } from './run-telemetry';
import { createAgentDeepAgentExecution, type RunOutcome } from './agent-execution';
import { createChatRunEventQueue } from './chat-run-event-queue';
import { createRunInterruptedEvents, projectDeepAgentInterrupts } from './interrupt-projection';

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
    execute(input) {
      let resolveOutcome: (outcome: RunOutcome) => void = () => {};
      let rejectOutcome: (error: unknown) => void = () => {};
      let outcomePublished = false;
      const outcome = new Promise<RunOutcome>((resolve, reject) => {
        resolveOutcome = resolve;
        rejectOutcome = reject;
      });
      const events = (async function* () {
        try {
      const handle = input.modelHandle.langChainHandle;
      if (handle === undefined) {
        throw new Error('agent_deep_agent_model_handle_missing');
      }
      const mode = input.snapshot.mode;
      const workflowHint = input.snapshot.workflowHint;
      const assistantChunks: string[] = [];
      const reasoningChunks: string[] = [];
      const hookDisplayTexts: string[] = [];
      const outcomeText = createOutcomeTextCollector(hookDisplayTexts);
      const successfulToolNamesByBlockId = new Map<string, string>();
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
        collectOutcomeProjection({
          event,
          hookDisplayTexts,
          successfulToolNamesByBlockId
        });
        if (event.type === 'assistant_block' && event.block.kind === 'text' && event.block.text !== undefined) {
          outcomeText.push(event.block.text);
        }
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
      const shellAllowedCommands = input.snapshot.shellAllowedCommands;
      const shellExecutionService = createShellExecutionAdapter({
        capabilities: options.capabilities,
        defaultCwd: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        allowedCommands: shellAllowedCommands,
        abortSignal: executionAbortController.signal,
        runId: input.run.id,
        threadId: input.run.threadId
      });
      const tools = await createExecutorTools({
        capabilities: options.capabilities,
        capabilityManifest: input.snapshot.capabilityManifest,
        enabledCapabilities: input.snapshot.capabilityManifest.resolvedCapabilities,
        runtimeWorkspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        shellExecutionService,
        shellAllowedCommands,
        mode
      });
      const explicitSkillContexts = loadExplicitSkillContexts({
        explicitSkillIds: input.snapshot.explicitSkillIds,
        manifestSkills: input.snapshot.capabilityManifest.skills
      });
      const referencedFileContexts = loadReferencedFileContexts({
        userInput: input.run.userInput,
        workspacePath: runtimeWorkspace?.path ?? null
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
      const mainManifestToolNames = input.snapshot.capabilityManifest.tools
        .filter((tool) => tool.executionScopes.includes('main'))
        .map((tool) => tool.modelVisibleName);
      const contextHarness = assembleContextHarness({
        artifactStore: options.contextArtifactStore,
        mode,
        enabledCapabilities: input.snapshot.capabilityManifest.resolvedCapabilities,
        workflowHint,
        workspacePath: runtimeWorkspace === null ? null : runtimeWorkspace.path,
        memorySources: runtimeBackend.memorySources,
        baseTools: tools.runTools,
        allowedToolNames: mainManifestToolNames,
        searchSessions: request => options.capabilities.invoke('agent.sessions.search', request),
        searchMemory: request => options.capabilities.invoke('memory.entries.search', request),
        remember: request => options.capabilities.invoke('memory.entry.remember', request),
        runId: input.run.id,
        threadId: input.run.threadId,
        explicitSkillContexts,
        referencedFileContexts
      });
      const contextWindowTokens = input.snapshot.budget.contextBudgetTokens;
      if (contextWindowTokens === null) {
        throw new Error('agent_context_budget_missing');
      }
      const contextTokenCounter = createContextTokenCounter(handle.model);
      const contextTools = contextHarness.tools.map((tool): ContextToolDefinition => {
        if (typeof tool.description !== 'string') {
          throw new Error(`agent_tool_description_missing:${tool.name}`);
        }
        return {
          name: tool.name,
          description: tool.description,
          schema: Reflect.get(tool, 'schema')
        };
      });
      const runSubagents = createRunSubagents({
        webReadTool: tools.webReadTool
      });
      const contextBudgetProfiles = await Promise.all([
        deriveContextBudgetProfile({
          contextWindowTokens,
          counter: contextTokenCounter,
          systemPrompt: contextHarness.systemPrompt,
          tools: contextTools
        }),
        deriveContextBudgetProfile({
          contextWindowTokens,
          counter: contextTokenCounter,
          systemPrompt: GENERAL_PURPOSE_SUBAGENT.systemPrompt,
          tools: contextTools
        }),
        ...runSubagents.map((subagent) => {
          if (!('systemPrompt' in subagent) || typeof subagent.systemPrompt !== 'string') {
            throw new Error(`agent_subagent_system_prompt_missing:${subagent.name}`);
          }
          return deriveContextBudgetProfile({
            contextWindowTokens,
            counter: contextTokenCounter,
            systemPrompt: subagent.systemPrompt,
            tools: contextTools
          });
        })
      ]);
      const contextBudgetProfile = selectConservativeContextBudgetProfile(contextBudgetProfiles);
      const emitContextMaintenanceEvent = (event: ContextMaintenanceEvent) => {
        emitRuntimeEvent({
          type: 'context_maintenance',
          runId: input.run.id,
          threadId: input.run.threadId,
          event: event.type,
          mode,
          stage: event.stage,
          ...(event.persistedChars === undefined ? {} : { persistedChars: event.persistedChars }),
          ...(event.removedChars === undefined ? {} : { removedChars: event.removedChars }),
          ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
          ...(event.budgetTokens === undefined ? {} : { budgetTokens: event.budgetTokens }),
          ...(event.estimated === undefined ? {} : { estimated: event.estimated })
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
        }, {
          signal: executionAbortController.signal
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
        snapshot: input.snapshot,
        model: handle.model,
        systemPrompt: contextHarness.systemPrompt,
        backend: runtimeBackend.backend,
        store: options.store,
        memorySources: contextHarness.memorySources,
        skillSources: contextHarness.skillSources,
        subagents: runSubagents,
        tools: contextHarness.tools,
        checkpointer: options.checkpointer,
        contextCompaction: {
          artifactStore: options.contextArtifactStore,
          artifactRecoveryEnabled: mainManifestToolNames.includes('read_context_artifact'),
          budgetProfile: contextBudgetProfile,
          emitEvent: emitContextMaintenanceEvent,
          tokenCounter: contextTokenCounter
        },
        toolEffectStore: options.toolEffectStore,
        hookMiddleware:
          options.hookRuntime === undefined
            ? undefined
            : {
                hookRuntime: options.hookRuntime,
                runContext: hookRunContext,
                emitHookEvent: emitRuntimeEvent,
                initialContexts: initialHookContexts,
                signal: executionAbortController.signal
              }
      });
      const runInput =
        input.resumePayload === undefined
          ? createInitialState(input.run.userInput, input.validatedAttachments)
          : new Command({
              resume: input.resumePayload
            });
      const rawRun = await agent.streamEvents(runInput as never, {
        version: 'v3',
        recursionLimit: 10000,
        configurable: {
          run_id: input.run.id,
          thread_id: input.run.threadId
        },
        signal: executionAbortController.signal
      });
      const projectToolOutput = createToolOutputProjector({
        artifactStore: options.contextArtifactStore,
        runId: input.run.id,
        threadId: input.run.threadId,
        workspaceHash: contextHarness.workspaceIdentity === null ? null : contextHarness.workspaceIdentity.hash
      });
      const run = adaptDeepAgentRun(rawRun, { projectToolOutput });
      const runOutputSettlement = Promise.allSettled([run.output] as const);
      const callbacks = createExecutorCallbacks({
        emitRuntimeEvent
      });
      const streamState = createStreamConsumerState({
        assistantChunks,
        reasoningChunks,
        usageAccumulator
      });
      const consumeRun = (async () => {
        try {
          await consumeDeepAgentEventStream({
            events: run.events,
            runId: input.run.id,
            state: streamState,
            callbacks
          });
          recordPromptCacheMetrics({
            metricsService: options.metricsService,
            modelId: input.modelHandle.modelId,
            mode,
            providerId: input.modelHandle.providerId,
            source: hookRunContext.source,
            usageAccumulator
          });
          const domainInterrupts = streamState.interrupted;
          if (domainInterrupts !== null) {
            const interrupts = projectDeepAgentInterrupts(domainInterrupts);
            for (const event of createRunInterruptedEvents(input.run.id, input.run.threadId, interrupts)) {
              emitRuntimeEvent(event);
            }
            outcomePublished = true;
            resolveOutcome({
              status: 'interrupted',
              interrupts,
              usage: snapshotUsage(usageAccumulator)
            });
          } else {
            const [settledOutput] = await runOutputSettlement;
            if (settledOutput.status === 'rejected') {
              throw settledOutput.reason;
            }
            const finalAssistantText = settledOutput.value;
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
            const finalMessage = outcomeText.finish().trim();
            if (finalMessage.length === 0 && successfulToolNamesByBlockId.size === 0 && hookDisplayTexts.length === 0) {
              throw new Error('agent_model_response_empty');
            }
            outcomePublished = true;
            resolveOutcome({
              status: 'completed',
              finalMessage,
              summarySource: {
                successfulToolNames: [...successfulToolNamesByBlockId.values()]
              },
              usage: snapshotUsage(usageAccumulator)
            });
          }
          eventQueue.close();
        } catch (error) {
          eventQueue.fail(error);
          throw error;
        } finally {
          if (!outcomePublished) {
            input.observeModelUsage(snapshotUsage(usageAccumulator));
          }
        }
      })();
      try {
        for await (const event of eventQueue) {
          yield event;
        }
        await consumeRun;
      } finally {
        executionAbortController.abort(new Error('chat_run_event_consumer_stopped'));
        await consumeRun.catch((error: unknown) => {
          rejectOutcome(error);
        });
        input.abortSignal.removeEventListener('abort', abortFromParent);
      }
        } catch (error) {
          rejectOutcome(error);
          throw error;
        }
      })();
      return createAgentDeepAgentExecution({ events, outcome });
    }
  };
}

function selectConservativeContextBudgetProfile(profiles: readonly ContextBudgetProfile[]): ContextBudgetProfile {
  const first = profiles[0];
  if (first === undefined) {
    throw new Error('agent_context_budget_profile_missing');
  }
  return profiles.slice(1).reduce(
    (selected, candidate) => candidate.modelInputTokens < selected.modelInputTokens ? candidate : selected,
    first
  );
}

function snapshotUsage(usage: ReturnType<typeof createUsageAccumulator>): AgentModelUsageTelemetry {
  const { callUsage, ...tokenUsage } = usage;
  return {
    callCount: callUsage.size,
    ...tokenUsage
  };
}

function collectOutcomeProjection(input: {
  event: ChatRunEvent;
  hookDisplayTexts: string[];
  successfulToolNamesByBlockId: Map<string, string>;
}): void {
  if (input.event.type === 'hook_started' || input.event.type === 'hook_completed') {
    collectHookDisplayText(input.hookDisplayTexts, input.event.hook.additionalContext);
    collectHookDisplayText(input.hookDisplayTexts, input.event.hook.requestContinue);
    return;
  }
  if (input.event.type !== 'assistant_block' || input.event.block.kind !== 'tool_call') {
    return;
  }
  if (input.event.block.phase === 'end') {
    input.successfulToolNamesByBlockId.set(input.event.block.blockId, input.event.block.name);
    return;
  }
  if (input.event.block.phase === 'error') {
    input.successfulToolNamesByBlockId.delete(input.event.block.blockId);
  }
}

function collectHookDisplayText(texts: string[], value: string | null): void {
  if (value !== null && value.length > 0 && !texts.includes(value)) {
    texts.push(value);
  }
}

function createOutcomeTextCollector(hookDisplayTexts: readonly string[]): {
  finish: () => string;
  push: (delta: string) => void;
} {
  const chunks: string[] = [];
  let pendingPrefix = '';
  let prefixResolved = false;

  const consumePrefix = (): void => {
    while (pendingPrefix.length > 0) {
      const matchingHookText = [...hookDisplayTexts]
        .sort((left, right) => right.length - left.length)
        .find((text) => pendingPrefix.startsWith(text));
      if (matchingHookText !== undefined) {
        pendingPrefix = pendingPrefix.slice(matchingHookText.length).trimStart();
        continue;
      }
      if (hookDisplayTexts.some((text) => text.startsWith(pendingPrefix))) {
        return;
      }
      prefixResolved = true;
      chunks.push(pendingPrefix);
      pendingPrefix = '';
    }
  };

  return {
    finish: () => {
      consumePrefix();
      if (!prefixResolved && pendingPrefix.length > 0) {
        chunks.push(pendingPrefix);
        pendingPrefix = '';
      }
      return chunks.join('');
    },
    push: (delta) => {
      if (prefixResolved) {
        chunks.push(delta);
        return;
      }
      pendingPrefix += delta;
      consumePrefix();
    }
  };
}

function recordPromptCacheMetrics(input: {
  metricsService: Pick<MetricsService, 'recordPromptCacheMetrics'> | undefined;
  usageAccumulator: ReturnType<typeof createUsageAccumulator>;
  mode: RunExecutionSnapshotV2['mode'];
  source: 'chat' | 'background_task';
  providerId: string;
  modelId: string;
}): void {
  if (input.metricsService === undefined || input.usageAccumulator.inputTokens === null) {
    return;
  }
  const usage: Parameters<MetricsService['recordPromptCacheMetrics']>[0] = {
    input_tokens: input.usageAccumulator.inputTokens
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

function createWorkspaceFromSnapshot(snapshot: RunExecutionSnapshotV2): Workspace | null {
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
}): Parameters<typeof consumeDeepAgentEventStream>[0]['callbacks'] {
  return {
    emitRuntimeEvent: (event) => {
      input.emitRuntimeEvent(event);
    }
  };
}

async function createExecutorTools(input: {
  capabilities: RocCapabilityRegistry;
  capabilityManifest: RunCapabilityManifestV1;
  enabledCapabilities: TaskRun['enabledCapabilities'];
  runtimeWorkspacePath: string | null;
  shellExecutionService: AgentExecuteAdapter;
  shellAllowedCommands?: readonly string[];
  mode: RunExecutionSnapshotV2['mode'];
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
    ...mcpTools
  ];
  const manifestToolNames = new Set(input.capabilityManifest.tools.map((tool) => tool.modelVisibleName));
  if (manifestToolNames.has('run_shell_command') && (input.shellAllowedCommands === undefined || input.shellAllowedCommands.length > 0)) {
    runTools.splice(3, 0, createRocWindowsCommandTool(input.shellExecutionService));
  }
  const backgroundTaskTools = createManifestAuthorizedBackgroundTaskTools(input);
  if (backgroundTaskTools.length > 0) {
    runTools.splice(2, 0, ...backgroundTaskTools);
  }
  return {
    runTools,
    webReadTool
  };
}

function createManifestAuthorizedBackgroundTaskTools(input: {
  capabilities: RocCapabilityRegistry;
  capabilityManifest: RunCapabilityManifestV1;
  enabledCapabilities: TaskRun['enabledCapabilities'];
  runtimeWorkspacePath: string | null;
}): ClientTool[] {
  const previewStore = new PreviewStore();
  const taskAdapter = {
    createBackgroundTaskPreview: async (request: BackgroundTaskPreviewRequest) =>
      await input.capabilities.invoke<BackgroundTaskPreviewRequest, BackgroundTaskPreview>('task.background.preview', request),
    createBackgroundTask: async (request: BackgroundTaskPreviewRequest) =>
      await input.capabilities.invoke<BackgroundTaskPreviewRequest, BackgroundTask>('task.background.create', request),
    readBackgroundTask: async (taskId: string) =>
      await input.capabilities.invoke<{ taskId: string }, TaskDetail>('task.detail.get', { taskId }),
    updateBackgroundTask: async (request: UpdateBackgroundTaskRequest) =>
      await input.capabilities.invoke<UpdateBackgroundTaskRequest, BackgroundTask>('task.background.update', request),
    cancelBackgroundTask: async (taskId: string) =>
      await input.capabilities.invoke<{ id: string }, BackgroundTask>('task.background.cancel', { id: taskId })
  };
  const schedulerAdapter = {
    refreshTask: () => {},
    registerTask: () => {},
    unregisterTask: () => {}
  };
  const toolDependencies = {
    enabledCapabilities: input.enabledCapabilities,
    previewStore,
    runtimeWorkspacePath: input.runtimeWorkspacePath,
    taskAdapter,
    schedulerAdapter
  };
  const candidates: ClientTool[] = [
    createResolveBackgroundTaskTimeTool(),
    ...createBackgroundTaskTools({ ...toolDependencies, toolMode: 'all' }),
    ...createBackgroundTaskTools({ ...toolDependencies, toolMode: 'change' })
  ];
  const manifestToolNames = new Set(input.capabilityManifest.tools.map((tool) => tool.modelVisibleName));
  const seenToolNames = new Set<string>();
  return candidates.filter((tool) => {
    if (!manifestToolNames.has(tool.name)) {
      return false;
    }
    if (seenToolNames.has(tool.name)) {
      return false;
    }
    seenToolNames.add(tool.name);
    return true;
  });
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

function isBackgroundTaskWorkflow(snapshot: RunExecutionSnapshotV2): boolean {
  return snapshot.workflowHint === 'propose_background_task' || snapshot.workflowHint === 'background_task_change';
}

function requireWorkbenchSourceForBackgroundTaskWorkflow(snapshot: RunExecutionSnapshotV2): void {
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
    description: '读取公开网页正文，返回来源、Jina 代理、抓取时间、内容哈希、不可信标记与正文。',
    schema,
    func: async (request, _runManager, config) => {
      const result = await capabilities.invoke<WebReadExecutionRequest, WebReadResult>('web.read', {
        ...request,
        signal: config?.signal
      });
      return JSON.stringify(result, null, 2);
    }
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

function createShellExecutionAdapter(input: {
  capabilities: RocCapabilityRegistry;
  defaultCwd: string | null;
  allowedCommands?: readonly string[];
  abortSignal: AbortSignal;
  runId: string;
  threadId: string;
}): AgentExecuteAdapter {
  return {
    executeAgentCommand: async ({ command, cwd }) => {
      const requestCwd = cwd === undefined ? input.defaultCwd : cwd;
      if (requestCwd === null) {
        throw new Error('agent_workspace_required_for_shell');
      }
      const result = await input.capabilities.invoke<
        import('../../../shared/types').ShellExecutionRequest,
        import('../../../shared/types').ShellExecutionResult
      >('shell.execute', {
        command,
        cwd: requestCwd,
        source: 'agent',
        signal: input.abortSignal,
        runId: input.runId,
        threadId: input.threadId,
        allowedCommands: input.allowedCommands === undefined ? undefined : [...input.allowedCommands]
      });
      return {
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        output: formatShellOutput(result),
        truncated: result.truncated === true,
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
