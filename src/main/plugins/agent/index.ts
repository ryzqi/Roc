import { z } from 'zod';

import type {
  AgentCapabilityPreview,
  AgentRuntimeStatus,
  ApprovalMode,
  ChatCancelRunResult,
  ChatResumeRunRequest,
  ChatResumeRunResult,
  ChatStartRunRequest,
  ChatStartRunResult,
  EnabledCapabilities,
  McpServerSnapshot,
  SessionMessageEntry,
  SessionMessageSearchRequest,
  SessionMessageSearchResult,
  SkillSnapshot
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { buildAgentCapabilityPreview } from './capability-preview';
import { StaticAgentModelFactoryAdapter, type AgentModelFactoryAdapter } from './model-factory-adapter';
import { AgentPluginRuntime, type AgentCapabilityPreviewProvider } from './runtime';
import { applyAgentPluginSchema } from './schema';
import { AgentSessionRepository } from './session-repository';

const pluginId = '@roc/plugin-agent';
const capabilityVersion = '1.0.0';

const enabledCapabilitiesSchema = z.object({
  mcpServers: z.array(z.string()),
  skills: z.array(z.string())
});

const chatStartRunRequestSchema = z.object({
  input: z.string(),
  mode: z.enum(['chat', 'task']),
  enabledCapabilities: enabledCapabilitiesSchema,
  threadId: z.string().nullable().optional(),
  workflowHint: z.enum(['propose_background_task', 'background_task_change']).nullable().optional()
}) satisfies z.ZodType<ChatStartRunRequest>;

const chatStartRunResultSchema = z.object({
  runId: z.string(),
  mode: z.enum(['chat', 'task']),
  threadId: z.string().nullable(),
  providerId: z.string(),
  modelId: z.string(),
  createdAt: z.string()
}) satisfies z.ZodType<ChatStartRunResult>;

const chatResumeRunRequestSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  interruptId: z.string().optional(),
  decisions: z.array(z.custom<ChatResumeRunRequest['decisions'][number]>())
}) satisfies z.ZodType<ChatResumeRunRequest>;

const chatResumeRunResultSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  resumedAt: z.string()
}) satisfies z.ZodType<ChatResumeRunResult>;

const chatCancelRunResultSchema = z.object({
  runId: z.string(),
  cancelled: z.boolean()
}) satisfies z.ZodType<ChatCancelRunResult>;

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
  createdAt: z.string()
}) satisfies z.ZodType<SessionMessageEntry>;

const sessionSearchInputSchema = z.object({
  query: z.string(),
  workspaceScope: z.enum(['current', 'global', 'all']),
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

const baseAgentCapabilityDescriptors = [
  descriptor('agent.status.get', z.object({}), agentRuntimeStatusSchema),
  descriptor('agent.run.start', chatStartRunRequestSchema, chatStartRunResultSchema),
  descriptor('agent.run.cancel', z.object({ runId: z.string() }), chatCancelRunResultSchema),
  descriptor('agent.run.resume', chatResumeRunRequestSchema, chatResumeRunResultSchema),
  descriptor('agent.sessions.list', sessionListInputSchema, z.array(sessionMessageSchema)),
  descriptor('agent.sessions.search', sessionSearchInputSchema, sessionSearchResultSchema)
] as const satisfies readonly CapabilityDescriptor[];

const agentCapabilityPreviewDescriptor = descriptor(
  'agent.capability.preview',
  enabledCapabilitiesSchema,
  agentCapabilityPreviewSchema
);

export const agentCapabilityDescriptors = [
  ...baseAgentCapabilityDescriptors,
  agentCapabilityPreviewDescriptor
] as const satisfies readonly CapabilityDescriptor[];

export type AgentPluginOptions = {
  capabilityPreview?: {
    approvalModeProvider: () => ApprovalMode;
  };
  modelFactory?: AgentModelFactoryAdapter;
  status?: AgentRuntimeStatus;
  statusProvider?: () => AgentRuntimeStatus;
};

export function createAgentPlugin(options: AgentPluginOptions = {}): RocPlugin {
  let runtime: AgentPluginRuntime | null = null;
  const capabilities =
    options.capabilityPreview === undefined ? baseAgentCapabilityDescriptors : agentCapabilityDescriptors;
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Agent',
      description: 'Roc agent runtime plugin.',
      loadPhase: 'critical',
      required: true,
      order: 10,
      dependencies: options.capabilityPreview === undefined ? [] : ['@roc/plugin-mcp', '@roc/plugin-skills'],
      capabilities
    },
    initialize: async (context) => {
      const db = context.database.getConnection();
      applyAgentPluginSchema(db);
      const modelFactory = options.modelFactory === undefined ? new StaticAgentModelFactoryAdapter(blockedModelHandle()) : options.modelFactory;
      runtime = new AgentPluginRuntime({
        capabilityPreviewProvider: createCapabilityPreviewProvider(context, options),
        eventBus: context.eventBus,
        modelFactory,
        pluginId,
        repository: new AgentSessionRepository(db),
        status: options.status,
        statusProvider: options.statusProvider
      });
      registerAgentCapabilities(context, runtime);
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
  return async ({ requestedCapabilities, runtimeStatus }) =>
    buildAgentCapabilityPreview({
      approvalMode: capabilityPreviewOptions.approvalModeProvider(),
      mcpServers: await context.capabilities.invoke<{}, McpServerSnapshot[]>('mcp.listServers', {}),
      requestedCapabilities,
      runtimeStatus,
      skills: await context.capabilities.invoke<{}, SkillSnapshot[]>('skills.list', {})
    });
}

export const agentPlugin = createAgentPlugin();

function registerAgentCapabilities(context: RocPluginContext, runtime: AgentPluginRuntime): void {
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[0], async () => runtime.getStatus());
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[1], async (input) => runtime.startRun(input as ChatStartRunRequest));
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[2], async (input) => runtime.cancelRun(input as { runId: string }));
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[3], async (input) => runtime.resumeRun(input as ChatResumeRunRequest));
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[4], async (input) =>
    runtime.listSessionMessages(input as { threadId: string; limit?: number })
  );
  context.capabilities.register(pluginId, baseAgentCapabilityDescriptors[5], async (input) =>
    runtime.searchSessionMessages(input as SessionMessageSearchRequest)
  );
  if (context.capabilities.list().some((capability) => capability.name === agentCapabilityPreviewDescriptor.name)) {
    context.capabilities.register(pluginId, agentCapabilityPreviewDescriptor, async (input) =>
      runtime.getCapabilityPreview(input as EnabledCapabilities)
    );
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
