import { z } from 'zod';

import type {
  AgentRuntimeStatus,
  AppSettings,
  ApprovalMode,
  McpServerSnapshot,
  SkillSnapshot,
  Workspace
} from '../../../shared/types';
import {
  agentCapabilityPreviewRequestSchema,
  agentCapabilityPreviewSchema,
  agentLangSmithConfigSchema,
  agentLangSmithSetApiKeyRequestSchema,
  agentLangSmithSettingsSchema,
  agentRuntimeStatusSchema,
  deepAgentConfigPreviewSchema,
  sessionListInputSchema,
  sessionMessageSchema,
  sessionMessageSearchRequestSchema,
  sessionMessageSearchResultSchema
} from '../../../shared/schemas/agent';
import {
  activeChatRunSchema,
  chatActiveRunRequestSchema,
  chatCancelRunRequestSchema,
  chatCancelRunResultSchema,
  chatResumeRunRequestSchema,
  chatResumeRunResultSchema,
  chatRunEventsReplayRequestSchema,
  chatRunEventsReplayResultSchema,
  chatStartRunRequestSchema,
  chatStartRunResultSchema
} from '../../../shared/schemas/chat';
import { applyMemoryDatabaseSchema } from '../../infrastructure/database-schemas';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { ContextArtifactStore } from '../../services/deep-agent/context/context-artifact-store';
import { AgentLangSmithRunTracingManager } from '../../services/deep-agent/langsmith-tracing';
import { RocSqliteCheckpointer } from '../../services/deep-agent/sqlite-checkpointer';
import { AgentToolEffectStore } from '../../services/deep-agent/tool-effect-store';
import type { HookRuntime } from '../../services/hooks';
import type { MetricsService } from '../../services/metrics-service';
import { RocSqliteStore } from '../../services/memory/sqlite-store';
import type { RocPaths } from '../../services/paths';
import { buildAgentCapabilityPreview, buildDeepAgentConfigPreview } from './capability-preview';
import { createAgentDeepAgentExecutor } from './deep-agent-executor';
import { AgentLangSmithSettingsStore } from './langsmith-settings';
import { AgentLangSmithTraceSessionRepository } from './langsmith-trace-session-repository';
import { StaticAgentModelFactoryAdapter, type AgentModelFactoryAdapter } from './model-factory-adapter';
import { AgentRunEventLog } from './run-event-log';
import type { AgentCapabilityPreviewProvider, AgentDeepAgentExecutor } from './runtime';
import { AgentPluginRuntime } from './runtime';
import type { AgentLifecycleHookEmitter } from './runtime-types';
import { applyAgentPluginSchema } from './schema';
import { AgentSessionRepository } from './session-repository';

const pluginId = '@roc/plugin-agent';
const capabilityVersion = '1.0.0';

const emptyInputSchema = z.object({}).strict();

const agentLangSmithSettingsGetDescriptor = descriptor(
  'agent.langsmith.settings.get',
  emptyInputSchema,
  agentLangSmithSettingsSchema
);

const agentLangSmithSettingsSaveDescriptor = descriptor(
  'agent.langsmith.settings.save',
  agentLangSmithConfigSchema,
  agentLangSmithSettingsSchema
);

const agentLangSmithSecretSetDescriptor = descriptor(
  'agent.langsmith.secret.set',
  agentLangSmithSetApiKeyRequestSchema,
  agentLangSmithSettingsSchema
);

const agentLangSmithSecretClearDescriptor = descriptor(
  'agent.langsmith.secret.clear',
  emptyInputSchema,
  agentLangSmithSettingsSchema
);

const baseAgentCapabilityDescriptors = [
  descriptor('agent.status.get', emptyInputSchema, agentRuntimeStatusSchema),
  descriptor('agent.config.preview', emptyInputSchema, deepAgentConfigPreviewSchema),
  descriptor('agent.run.start', chatStartRunRequestSchema, chatStartRunResultSchema),
  descriptor('agent.run.cancel', chatCancelRunRequestSchema, chatCancelRunResultSchema),
  descriptor('agent.run.resume', chatResumeRunRequestSchema, chatResumeRunResultSchema),
  descriptor('agent.run.events.list', chatRunEventsReplayRequestSchema, chatRunEventsReplayResultSchema),
  descriptor('agent.run.active.get', chatActiveRunRequestSchema, activeChatRunSchema.nullable()),
  descriptor('agent.sessions.list', sessionListInputSchema, z.array(sessionMessageSchema)),
  descriptor('agent.sessions.search', sessionMessageSearchRequestSchema, sessionMessageSearchResultSchema),
  agentLangSmithSettingsGetDescriptor,
  agentLangSmithSettingsSaveDescriptor,
  agentLangSmithSecretSetDescriptor,
  agentLangSmithSecretClearDescriptor
] as const satisfies readonly CapabilityDescriptor[];

const agentCapabilityPreviewDescriptor = descriptor(
  'agent.capability.preview',
  agentCapabilityPreviewRequestSchema,
  agentCapabilityPreviewSchema
);

const agentCapabilityDescriptors = [
  ...baseAgentCapabilityDescriptors,
  agentCapabilityPreviewDescriptor
] as const satisfies readonly CapabilityDescriptor[];

export type AgentPluginOptions = {
  capabilityPreview?: {
    deleteFileApprovalModeProvider: () => ApprovalMode;
    mcpApprovalModeProvider: () => ApprovalMode;
  };
  deepAgentExecutor?: {
    appVersion: string;
    paths: RocPaths;
    getMemorySettings?: () => AppSettings['memory'];
    hookRuntime?: Pick<HookRuntime, 'runEvent'>;
    metricsService?: Pick<MetricsService, 'recordPromptCacheMetrics'>;
  } | AgentDeepAgentExecutor;
  modelFactory?: AgentModelFactoryAdapter;
  status?: AgentRuntimeStatus;
  statusProvider?: () => AgentRuntimeStatus;
};

export function createAgentPlugin(options: AgentPluginOptions = {}): RocPlugin {
  let runtime: AgentPluginRuntime | null = null;
  const capabilities =
    options.capabilityPreview === undefined ? baseAgentCapabilityDescriptors : agentCapabilityDescriptors;
  const capabilityDependencies = resolveCapabilityDependencies(options);
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Agent',
      description: 'Roc agent runtime plugin.',
      loadPhase: 'critical',
      required: true,
      order: 10,
      dependencies: resolveDependencies(options),
      ...(capabilityDependencies.length === 0 ? {} : { capabilityDependencies }),
      capabilities
    },
    initialize: async (context) => {
      const langSmithSettings = new AgentLangSmithSettingsStore(context.config, context.secrets);
      langSmithSettings.initialize();
      const db = context.database.getAgentConnection();
      applyAgentPluginSchema(db);
      const langSmithTraceSessions = new AgentLangSmithTraceSessionRepository(db);
      const langSmithTracingManager = createAgentLangSmithTracingManager(
        langSmithSettings,
        options.deepAgentExecutor,
        langSmithTraceSessions
      );
      const modelFactory = options.modelFactory === undefined ? new StaticAgentModelFactoryAdapter(blockedModelHandle()) : options.modelFactory;
      const runEventLog = new AgentRunEventLog(db);
      const repository = new AgentSessionRepository(db, { runEventLog });
      repository.reconcileStartupRuns();
      if (langSmithTracingManager !== null) {
        for (const terminal of langSmithTraceSessions.listTerminalRuns()) {
          let error: string | null = null;
          if (terminal.status === 'failed') {
            error = 'agent_run_failed_before_trace_cleanup';
          } else if (terminal.status === 'interrupted') {
            error = 'agent_run_interrupted_on_startup_reconciliation';
          }
          try {
            await langSmithTracingManager.finishRun({
              error,
              runId: terminal.runId,
              status: terminal.status
            });
          } catch {
            try {
              repository.recordNotificationFailure('agent_langsmith_trace_finish_failed');
            } catch {
              context.logger.warn('agent_langsmith_trace_finish_metric_failed');
            }
          }
        }
      }
      runtime = new AgentPluginRuntime({
        capabilityPreviewProvider: createCapabilityPreviewProvider(context, options),
        deepAgentExecutor: resolveDeepAgentExecutor(
          context,
          options.deepAgentExecutor,
          langSmithTracingManager
        ),
        eventBus: context.eventBus,
        lifecycleHooks: resolveLifecycleHooks(context, options.deepAgentExecutor),
        modelFactory,
        pluginId,
        repository,
        runEventLog,
        ...(langSmithTracingManager === null ? {} : { tracingLifecycle: langSmithTracingManager }),
        status: options.status,
        statusProvider: options.statusProvider,
        workspaceProvider: async () => await context.capabilities.invoke<{}, Workspace | null>('workspace.getCurrent', {})
      });
      registerAgentCapabilities(context, runtime, options, langSmithSettings);
    },
    shutdown: async () => {
      if (runtime !== null) {
        await runtime.shutdown();
      }
      runtime = null;
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

function createCapabilityPreviewProvider(
  context: RocPluginContext,
  options: AgentPluginOptions
): AgentCapabilityPreviewProvider | undefined {
  if (options.capabilityPreview === undefined) {
    return undefined;
  }
  const capabilityPreviewOptions = options.capabilityPreview;
  return async ({ explicitSkillIds, mode, requestedCapabilities, runtimeStatus, shellAllowedCommands, workflowHint }) =>
    buildAgentCapabilityPreview({
      deleteFileApprovalMode: capabilityPreviewOptions.deleteFileApprovalModeProvider(),
      explicitSkillIds,
      mcpApprovalMode: capabilityPreviewOptions.mcpApprovalModeProvider(),
      mcpServers: await context.capabilities.invoke<{}, McpServerSnapshot[]>('mcp.listServers', {}),
      mode,
      requestedCapabilities,
      shellAllowedCommands,
      runtimeStatus,
      skills: await context.capabilities.invoke<{}, SkillSnapshot[]>('skills.list', {}),
      workflowHint
    });
}

function resolveDeepAgentExecutor(
  context: RocPluginContext,
  option: AgentPluginOptions['deepAgentExecutor'],
  langSmithTracingManager: AgentLangSmithRunTracingManager | null
): AgentDeepAgentExecutor | undefined {
  if (option === undefined) {
    return undefined;
  }
  if ('execute' in option) {
    return option;
  }
  if (langSmithTracingManager === null) {
    throw new Error('agent_langsmith_tracing_manager_missing');
  }
  const agentDb = context.database.getAgentConnection();
  const memoryDb = context.database.getMemoryConnection();
  applyMemoryDatabaseSchema(memoryDb);
  return createAgentDeepAgentExecutor({
    capabilities: context.capabilities,
    checkpointer: new RocSqliteCheckpointer(agentDb),
    contextArtifactStore: new ContextArtifactStore(agentDb),
    getMemorySettings: option.getMemorySettings,
    hookRuntime: option.hookRuntime,
    langSmithTracingProvider: (correlation) => langSmithTracingManager.getRunTracing(correlation),
    metricsService: option.metricsService,
    paths: option.paths,
    store: new RocSqliteStore(memoryDb),
    toolEffectStore: new AgentToolEffectStore(agentDb)
  });
}

function resolveLifecycleHooks(
  context: RocPluginContext,
  option: AgentPluginOptions['deepAgentExecutor']
): AgentLifecycleHookEmitter | undefined {
  if (option === undefined || 'execute' in option) {
    return undefined;
  }
  const hookRuntime = option.hookRuntime;
  if (hookRuntime === undefined) {
    return undefined;
  }
  return {
    emitSessionEnd: async (input) => {
      const workspacePath = input.request.workspacePath === undefined ? null : input.request.workspacePath;
      const outcome = await hookRuntime.runEvent({
        schemaVersion: 1,
        event: 'SessionEnd',
        runId: input.runId,
        threadId: input.threadId,
        workspacePath,
        cwd: workspacePath === null ? option.paths.root : workspacePath,
        triggeredAt: new Date().toISOString(),
        payload: {
          status: input.status,
          error: input.error
        }
      }, {
        signal: input.signal
      });
      for (const event of outcome.events) {
        await context.eventBus.publish({
          type: 'agent.chat.run-event',
          source: pluginId,
          payload: event,
          createdAt: new Date().toISOString()
        });
      }
    }
  };
}

function resolveDependencies(options: AgentPluginOptions): string[] {
  const dependencies = new Set<string>();
  dependencies.add('@roc/plugin-workspace');
  if (options.capabilityPreview !== undefined) {
    dependencies.add('@roc/plugin-mcp');
    dependencies.add('@roc/plugin-skills');
  }
  if (options.deepAgentExecutor !== undefined && !('execute' in options.deepAgentExecutor)) {
    dependencies.add('@roc/plugin-mcp');
    dependencies.add('@roc/plugin-skills');
    dependencies.add('@roc/plugin-runtime-tools');
  }
  return [...dependencies];
}

function resolveCapabilityDependencies(options: AgentPluginOptions): string[] {
  if (options.deepAgentExecutor !== undefined && !('execute' in options.deepAgentExecutor)) {
    return ['@roc/plugin-task'];
  }
  return [];
}

function registerAgentCapabilities(
  context: RocPluginContext,
  runtime: AgentPluginRuntime,
  options: AgentPluginOptions,
  langSmithSettings: AgentLangSmithSettingsStore
): void {
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[0], async () => runtime.getStatus());
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[1], async () =>
    buildDeepAgentConfigPreview({
      deleteFileApprovalMode: options.capabilityPreview?.deleteFileApprovalModeProvider() ?? 'default',
      runtimeStatus: runtime.getStatus(),
      mode: 'chat'
    })
  );
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[2], async (input) =>
    runtime.startRun(chatStartRunRequestSchema.parse(input))
  );
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[3], async (input) =>
    runtime.cancelRun(chatCancelRunRequestSchema.parse(input))
  );
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[4], async (input) =>
    runtime.resumeRun(chatResumeRunRequestSchema.parse(input))
  );
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[5], async (input) =>
    runtime.listRunEvents(chatRunEventsReplayRequestSchema.parse(input))
  );
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[6], async (input) =>
    runtime.getActiveRun(chatActiveRunRequestSchema.parse(input))
  );
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[7], async (input) =>
    runtime.listSessionMessages(sessionListInputSchema.parse(input))
  );
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[8], async (input) =>
    runtime.searchSessionMessages(sessionMessageSearchRequestSchema.parse(input))
  );
  context.capabilities.register(pluginId, agentLangSmithSettingsGetDescriptor, async () =>
    langSmithSettings.getSnapshot()
  );
  context.capabilities.register(pluginId, agentLangSmithSettingsSaveDescriptor, async (input) =>
    langSmithSettings.saveConfig(agentLangSmithConfigSchema.parse(input))
  );
  context.capabilities.register(pluginId, agentLangSmithSecretSetDescriptor, async (input) =>
    langSmithSettings.setApiKey(agentLangSmithSetApiKeyRequestSchema.parse(input).apiKey)
  );
  context.capabilities.register(pluginId, agentLangSmithSecretClearDescriptor, async () =>
    langSmithSettings.clearApiKey()
  );
  if (context.capabilities.list().some((capability) => capability.name === agentCapabilityPreviewDescriptor.name)) {
    context.capabilities.register(pluginId, agentCapabilityPreviewDescriptor, async (input) => {
      const request = agentCapabilityPreviewRequestSchema.parse(input);
      return await runtime.getCapabilityPreview({
        mode: request.mode,
        requestedCapabilities: {
          mcpServers: request.mcpServers,
          skills: request.skills
        }
      });
    });
  }
}

function createAgentLangSmithTracingManager(
  settings: AgentLangSmithSettingsStore,
  option: AgentPluginOptions['deepAgentExecutor'],
  sessions: AgentLangSmithTraceSessionRepository
): AgentLangSmithRunTracingManager | null {
  if (option === undefined || 'execute' in option) {
    return null;
  }
  return new AgentLangSmithRunTracingManager({
    appVersion: option.appVersion,
    getRuntimeSettings: () => {
      const runtimeSettings = settings.getRuntimeSettings();
      if (runtimeSettings === null) {
        return null;
      }
      return {
        apiKey: runtimeSettings.apiKey,
        projectName: runtimeSettings.config.projectName
      };
    },
    sessions
  });
}

function descriptor<TInput, TOutput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> {
  return {
    name,
    version: capabilityVersion,
    inputSchema,
    outputSchema
  };
}

function blockedModelHandle(): { providerId: string; modelId: string } {
  return {
    providerId: 'unconfigured',
    modelId: 'unconfigured'
  };
}
