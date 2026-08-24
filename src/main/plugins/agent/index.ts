import { z } from 'zod';
import type { BaseStore } from '@langchain/langgraph';

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
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { ContextArtifactStore } from '../../services/deep-agent/context/context-artifact-store';
import { RocSqliteCheckpointer } from '../../services/deep-agent/sqlite-checkpointer';
import { AgentToolEffectStore } from '../../services/deep-agent/tool-effect-store';
import type { HookRuntime } from '../../services/hooks';
import type { MetricsService } from '../../services/metrics-service';
import type { RocPaths } from '../../services/paths';
import type { SelfConfigService } from '../../services/self-config';
import { buildAgentCapabilityPreview, buildDeepAgentConfigPreview } from './capability-preview';
import { createAgentDeepAgentExecutor } from './deep-agent-executor';
import { StaticAgentModelFactoryAdapter, type AgentModelFactoryAdapter } from './model-factory-adapter';
import { AgentRunEventLog } from './run-event-log';
import type { AgentCapabilityPreviewProvider, AgentDeepAgentExecutor } from './runtime';
import { AgentPluginRuntime } from './runtime';
import type { AgentLifecycleHookEmitter } from './runtime-types';
import { AgentSessionRepository } from './session-repository';

const pluginId = '@roc/plugin-agent';
const capabilityVersion = '1.0.0';

const emptyInputSchema = z.object({}).strict();

const baseAgentCapabilityDescriptors = [
  descriptor('agent.status.get', emptyInputSchema, agentRuntimeStatusSchema),
  descriptor('agent.config.preview', emptyInputSchema, deepAgentConfigPreviewSchema),
  descriptor('agent.run.start', chatStartRunRequestSchema, chatStartRunResultSchema),
  descriptor('agent.run.cancel', chatCancelRunRequestSchema, chatCancelRunResultSchema),
  descriptor('agent.run.resume', chatResumeRunRequestSchema, chatResumeRunResultSchema),
  descriptor('agent.run.events.list', chatRunEventsReplayRequestSchema, chatRunEventsReplayResultSchema),
  descriptor('agent.run.active.get', chatActiveRunRequestSchema, activeChatRunSchema.nullable()),
  descriptor('agent.sessions.list', sessionListInputSchema, z.array(sessionMessageSchema)),
  descriptor('agent.sessions.search', sessionMessageSearchRequestSchema, sessionMessageSearchResultSchema)
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
    memoryStore: BaseStore;
    paths: RocPaths;
    getMemorySettings?: () => AppSettings['memory'];
    hookRuntime?: Pick<HookRuntime, 'runEvent'>;
    metricsService?: Pick<MetricsService, 'recordPromptCacheMetrics'>;
    selfConfigService?: SelfConfigService;
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
      const db = context.database.getConnection();
      const modelFactory = options.modelFactory === undefined ? new StaticAgentModelFactoryAdapter(blockedModelHandle()) : options.modelFactory;
      const runEventLog = new AgentRunEventLog(db);
      const repository = new AgentSessionRepository(db, { runEventLog });
      repository.reconcileStartupRuns();
      runtime = new AgentPluginRuntime({
        capabilityPreviewProvider: createCapabilityPreviewProvider(context, options),
        deepAgentExecutor: resolveDeepAgentExecutor(context, options.deepAgentExecutor),
        eventBus: context.eventBus,
        lifecycleHooks: resolveLifecycleHooks(context, options.deepAgentExecutor),
        modelFactory,
        pluginId,
        repository,
        runEventLog,
        status: options.status,
        statusProvider: options.statusProvider,
        workspaceProvider: async () => await context.capabilities.invoke<{}, Workspace | null>('workspace.getCurrent', {})
      });
      registerAgentCapabilities(context, runtime, options);
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
  const selfConfigAvailable = isSelfConfigAvailable(options.deepAgentExecutor);
  return async ({ explicitSkillIds, mode, requestedCapabilities, runtimeStatus, shellAllowedCommands, workflowHint }) =>
    buildAgentCapabilityPreview({
      deleteFileApprovalMode: capabilityPreviewOptions.deleteFileApprovalModeProvider(),
      explicitSkillIds,
      mcpApprovalMode: capabilityPreviewOptions.mcpApprovalModeProvider(),
      mcpServers: await context.capabilities.invoke<{}, McpServerSnapshot[]>('mcp.listServers', {}),
      mode,
      requestedCapabilities,
      selfConfigAvailable,
      shellAllowedCommands,
      runtimeStatus,
      skills: await context.capabilities.invoke<{}, SkillSnapshot[]>('skills.list', {}),
      workflowHint
    });
}

// manifest 只能宣称执行器真的会绑定的工具：roc_self_config 依赖注入的 SelfConfigService。
function isSelfConfigAvailable(option: AgentPluginOptions['deepAgentExecutor']): boolean {
  if (option === undefined || 'execute' in option) {
    return false;
  }
  return option.selfConfigService !== undefined;
}

function resolveDeepAgentExecutor(
  context: RocPluginContext,
  option: AgentPluginOptions['deepAgentExecutor']
): AgentDeepAgentExecutor | undefined {
  if (option === undefined) {
    return undefined;
  }
  if ('execute' in option) {
    return option;
  }
  const agentDb = context.database.getConnection();
  return createAgentDeepAgentExecutor({
    capabilities: context.capabilities,
    checkpointer: new RocSqliteCheckpointer(agentDb),
    contextArtifactStore: new ContextArtifactStore(agentDb),
    getMemorySettings: option.getMemorySettings,
    hookRuntime: option.hookRuntime,
    metricsService: option.metricsService,
    paths: option.paths,
    store: option.memoryStore,
    selfConfigService: option.selfConfigService,
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

// memory 插件反向依赖 agent，不能放进 dependencies（会成环），只能声明为运行时能力依赖。
function resolveCapabilityDependencies(options: AgentPluginOptions): string[] {
  if (options.deepAgentExecutor !== undefined && !('execute' in options.deepAgentExecutor)) {
    return ['@roc/plugin-task', '@roc/plugin-memory'];
  }
  return [];
}

function registerAgentCapabilities(
  context: RocPluginContext,
  runtime: AgentPluginRuntime,
  options: AgentPluginOptions
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
