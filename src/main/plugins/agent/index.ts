import { z } from 'zod';

import type {
  AgentCapabilityPreview,
  AgentLangSmithSetApiKeyRequest,
  AgentLangSmithSettings,
  AgentRuntimeStatus,
  AppSettings,
  ApprovalMode,
  ActiveChatRun,
  ChatCancelRunResult,
  ChatRunEventsReplayRequest,
  ChatRunEventsReplayResult,
  ChatResumeDecision,
  ChatResumeRunRequest,
  ChatResumeRunResult,
  ChatStartRunRequest,
  ChatStartRunResult,
  DeepAgentConfigPreview,
  McpServerSnapshot,
  SessionMessageEntry,
  SessionMessageSearchRequest,
  SessionMessageSearchResult,
  SequencedChatRunEvent,
  SkillSnapshot,
  Workspace
} from '../../../shared/types';
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
import {
  agentLangSmithConfigSchema,
  AgentLangSmithSettingsStore
} from './langsmith-settings';
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

const enabledCapabilitiesSchema = z.object({
  mcpServers: z.array(z.string()),
  skills: z.array(z.string())
});

const agentCapabilityPreviewInputSchema = enabledCapabilitiesSchema.extend({
  mode: z.enum(['chat', 'task', 'plan'])
});

const chatImageAttachmentSchema = z.object({
  kind: z.literal('image'),
  source: z.enum(['file', 'clipboard', 'drop']),
  name: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z.number().int().positive(),
  path: z.string().min(1).optional(),
  data: z.string().min(1).optional()
}).refine(
  (value) => (value.path === undefined) !== (value.data === undefined),
  'Image attachment must provide exactly one source.'
);

const chatStartRunRequestSchema = z.object({
  input: z.string(),
  mode: z.enum(['chat', 'task', 'plan']),
  enabledCapabilities: enabledCapabilitiesSchema,
  threadId: z.string().nullable().optional(),
  workflowHint: z.enum(['propose_background_task', 'background_task_change']).nullable().optional(),
  taskSource: z.enum(['background_schedule', 'workbench']).nullable().optional(),
  workspacePath: z.string().nullable().optional(),
  shellAllowedCommands: z.array(z.string().trim().min(1)).optional(),
  attachments: z.array(chatImageAttachmentSchema).max(4).optional(),
  dispatchKey: z.string().trim().min(1).optional(),
  explicitSkillIds: z.array(z.string().trim().min(1)).optional()
}) satisfies z.ZodType<ChatStartRunRequest>;

const chatStartRunResultSchema = z.object({
  runId: z.string(),
  mode: z.enum(['chat', 'task', 'plan']),
  threadId: z.string().nullable(),
  providerId: z.string(),
  modelId: z.string(),
  createdAt: z.string()
}) satisfies z.ZodType<ChatStartRunResult>;

const hitlActionSchema = z
  .object({
    name: z.string().trim().min(1),
    args: z.record(z.string(), z.unknown())
  })
  .strict();

const chatResumeDecisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve') }).strict(),
  z
    .object({
      type: z.literal('reject'),
      message: z.string().trim().min(1).optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('edit'),
      editedAction: hitlActionSchema
    })
    .strict()
]) satisfies z.ZodType<ChatResumeDecision>;

const approvalResumeRunRequestSchema = z
  .object({
    kind: z.literal('approval'),
    runId: z.string().trim().min(1),
    threadId: z.string().trim().min(1),
    interruptId: z.string().trim().min(1),
    decisions: z.array(chatResumeDecisionSchema).min(1)
  })
  .strict();

const questionResumeRunRequestSchema = z
  .object({
    kind: z.literal('question'),
    runId: z.string().trim().min(1),
    threadId: z.string().trim().min(1),
    interruptId: z.string().trim().min(1),
    answer: z.string().trim().min(1)
  })
  .strict();

const chatResumeRunRequestSchema = z.discriminatedUnion('kind', [
  approvalResumeRunRequestSchema,
  questionResumeRunRequestSchema
]) satisfies z.ZodType<ChatResumeRunRequest>;

const chatResumeRunResultSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  resumedAt: z.string()
}) satisfies z.ZodType<ChatResumeRunResult>;

const chatCancelRunResultSchema = z.object({
  runId: z.string(),
  cancelled: z.boolean()
}) satisfies z.ZodType<ChatCancelRunResult>;

const chatRunEventsReplayRequestSchema = z.object({
  runId: z.string().trim().min(1),
  afterSequence: z.number().int().min(0)
}) satisfies z.ZodType<ChatRunEventsReplayRequest>;

const sequencedChatRunEventSchema = z.custom<SequencedChatRunEvent>();

const chatRunEventsReplayResultSchema = z.object({
  runId: z.string(),
  events: z.array(sequencedChatRunEventSchema)
}) satisfies z.ZodType<ChatRunEventsReplayResult>;

const activeChatRunSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  status: z.enum(['running', 'recovering', 'waiting_user'])
}) satisfies z.ZodType<ActiveChatRun>;

const chatActiveRunRequestSchema = z.object({
  threadId: z.string().trim().min(1)
});

const sessionListInputSchema = z.object({
  threadId: z.string(),
  limit: z.number().int().positive().optional()
});

const sessionMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  threadTitle: z.string().nullable(),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string(),
  phase: z.enum(['visible', 'pre_compaction_flush']),
  tokenCount: z.number().int().nullable(),
  workspaceHash: z.string().nullable(),
  createdAt: z.string()
}) satisfies z.ZodType<SessionMessageEntry>;

const sessionSearchInputSchema = z.object({
  query: z.string(),
  workspaceScope: z.enum(['current', 'all']),
  workspaceHash: z.string().nullable().optional(),
  threadId: z.string().optional(),
  sinceDays: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional()
}) satisfies z.ZodType<SessionMessageSearchRequest>;

const sessionSearchResultSchema = z.object({
  query: z.string(),
  total: z.number().int(),
  items: z.array(
    sessionMessageSchema.extend({
      snippet: z.string()
    })
  )
}) satisfies z.ZodType<SessionMessageSearchResult>;

const agentRuntimeStatusSchema = z.object({
  deepAgentsPackage: z.enum(['available', 'missing']),
  deepAgentsApi: z.object({
    createDeepAgent: z.boolean()
  }),
  defaultModelConfigured: z.boolean(),
  defaultModelState: z.object({
    status: z.enum(['missing', 'invalid', 'ready']),
    modelId: z.string().nullable(),
    providerId: z.string().nullable(),
    reason: z.string()
  }),
  memoryAccess: z.literal('store_backend'),
  execution: z.enum(['blocked_until_provider_configured', 'ready'])
}) satisfies z.ZodType<AgentRuntimeStatus>;

const agentCapabilityPreviewSchema = z.custom<AgentCapabilityPreview>();

const agentLangSmithSettingsSchema = z
  .object({
    config: agentLangSmithConfigSchema,
    apiKeyStored: z.boolean()
  })
  .strict() satisfies z.ZodType<AgentLangSmithSettings>;

const agentLangSmithSetApiKeySchema = z
  .object({
    apiKey: z.string().trim().min(1)
  })
  .strict() satisfies z.ZodType<AgentLangSmithSetApiKeyRequest>;

const agentLangSmithSettingsGetDescriptor = descriptor(
  'agent.langsmith.settings.get',
  z.object({}),
  agentLangSmithSettingsSchema
);

const agentLangSmithSettingsSaveDescriptor = descriptor(
  'agent.langsmith.settings.save',
  agentLangSmithConfigSchema,
  agentLangSmithSettingsSchema
);

const agentLangSmithSecretSetDescriptor = descriptor(
  'agent.langsmith.secret.set',
  agentLangSmithSetApiKeySchema,
  agentLangSmithSettingsSchema
);

const agentLangSmithSecretClearDescriptor = descriptor(
  'agent.langsmith.secret.clear',
  z.object({}),
  agentLangSmithSettingsSchema
);

const baseAgentCapabilityDescriptors = [
  descriptor('agent.status.get', z.object({}), agentRuntimeStatusSchema),
  descriptor('agent.config.preview', z.object({}), z.custom<DeepAgentConfigPreview>()),
  descriptor('agent.run.start', chatStartRunRequestSchema, chatStartRunResultSchema),
  descriptor('agent.run.cancel', z.object({ runId: z.string() }), chatCancelRunResultSchema),
  descriptor('agent.run.resume', chatResumeRunRequestSchema, chatResumeRunResultSchema),
  descriptor('agent.run.events.list', chatRunEventsReplayRequestSchema, chatRunEventsReplayResultSchema),
  descriptor('agent.run.active.get', chatActiveRunRequestSchema, activeChatRunSchema.nullable()),
  descriptor('agent.sessions.list', sessionListInputSchema, z.array(sessionMessageSchema)),
  descriptor('agent.sessions.search', sessionSearchInputSchema, sessionSearchResultSchema),
  agentLangSmithSettingsGetDescriptor,
  agentLangSmithSettingsSaveDescriptor,
  agentLangSmithSecretSetDescriptor,
  agentLangSmithSecretClearDescriptor
] as const satisfies readonly CapabilityDescriptor[];

const agentCapabilityPreviewDescriptor = descriptor(
  'agent.capability.preview',
  agentCapabilityPreviewInputSchema,
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
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[2], async (input) => runtime.startRun(input as ChatStartRunRequest));
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[3], async (input) => runtime.cancelRun(input as { runId: string }));
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
    runtime.listSessionMessages(input as { threadId: string; limit?: number })
  );
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[8], async (input) =>
    runtime.searchSessionMessages(input as SessionMessageSearchRequest)
  );
  context.capabilities.register(pluginId, agentLangSmithSettingsGetDescriptor, async () =>
    langSmithSettings.getSnapshot()
  );
  context.capabilities.register(pluginId, agentLangSmithSettingsSaveDescriptor, async (input) =>
    langSmithSettings.saveConfig(agentLangSmithConfigSchema.parse(input))
  );
  context.capabilities.register(pluginId, agentLangSmithSecretSetDescriptor, async (input) =>
    langSmithSettings.setApiKey(agentLangSmithSetApiKeySchema.parse(input).apiKey)
  );
  context.capabilities.register(pluginId, agentLangSmithSecretClearDescriptor, async () =>
    langSmithSettings.clearApiKey()
  );
  if (context.capabilities.list().some((capability) => capability.name === agentCapabilityPreviewDescriptor.name)) {
    context.capabilities.register(pluginId, agentCapabilityPreviewDescriptor, async (input) => {
      const request = agentCapabilityPreviewInputSchema.parse(input);
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
