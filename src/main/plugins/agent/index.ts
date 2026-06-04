import { z } from 'zod';

import type {
  AgentRuntimeStatus,
  ChatCancelRunResult,
  ChatResumeRunRequest,
  ChatResumeRunResult,
  ChatStartRunRequest,
  ChatStartRunResult,
  SessionMessageEntry,
  SessionMessageSearchRequest,
  SessionMessageSearchResult
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { StaticAgentModelFactoryAdapter, type AgentModelFactoryAdapter } from './model-factory-adapter';
import { AgentPluginRuntime } from './runtime';
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

export const agentCapabilityDescriptors = [
  descriptor('agent.status.get', z.object({}), agentRuntimeStatusSchema),
  descriptor('agent.run.start', chatStartRunRequestSchema, chatStartRunResultSchema),
  descriptor('agent.run.cancel', z.object({ runId: z.string() }), chatCancelRunResultSchema),
  descriptor('agent.run.resume', chatResumeRunRequestSchema, chatResumeRunResultSchema),
  descriptor('agent.sessions.list', sessionListInputSchema, z.array(sessionMessageSchema)),
  descriptor('agent.sessions.search', sessionSearchInputSchema, sessionSearchResultSchema)
] as const satisfies readonly CapabilityDescriptor[];

export type AgentPluginOptions = {
  modelFactory?: AgentModelFactoryAdapter;
  status?: AgentRuntimeStatus;
};

export function createAgentPlugin(options: AgentPluginOptions = {}): RocPlugin {
  let runtime: AgentPluginRuntime | null = null;
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Agent',
      description: 'Roc agent runtime plugin.',
      loadPhase: 'critical',
      required: true,
      order: 10,
      dependencies: [],
      capabilities: agentCapabilityDescriptors
    },
    initialize: async (context) => {
      const db = context.database.getConnection();
      applyAgentPluginSchema(db);
      const modelFactory = options.modelFactory === undefined ? new StaticAgentModelFactoryAdapter(blockedModelHandle()) : options.modelFactory;
      runtime = new AgentPluginRuntime({
        eventBus: context.eventBus,
        modelFactory,
        pluginId,
        repository: new AgentSessionRepository(db),
        status: options.status
      });
      registerAgentCapabilities(context, runtime);
    },
    shutdown: async () => {
      runtime = null;
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

export const agentPlugin = createAgentPlugin();

function registerAgentCapabilities(context: RocPluginContext, runtime: AgentPluginRuntime): void {
  context.capabilities.register(pluginId, agentCapabilityDescriptors[0], async () => runtime.getStatus());
  context.capabilities.register(pluginId, agentCapabilityDescriptors[1], async (input) => runtime.startRun(input as ChatStartRunRequest));
  context.capabilities.register(pluginId, agentCapabilityDescriptors[2], async (input) => runtime.cancelRun(input as { runId: string }));
  context.capabilities.register(pluginId, agentCapabilityDescriptors[3], async (input) => runtime.resumeRun(input as ChatResumeRunRequest));
  context.capabilities.register(pluginId, agentCapabilityDescriptors[4], async (input) =>
    runtime.listSessionMessages(input as { threadId: string; limit?: number })
  );
  context.capabilities.register(pluginId, agentCapabilityDescriptors[5], async (input) =>
    runtime.searchSessionMessages(input as SessionMessageSearchRequest)
  );
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
