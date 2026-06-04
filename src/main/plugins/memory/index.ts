import { z } from 'zod';

import type {
  MemoryFileWriteOutcome,
  MemoryFileWriteRequest,
  MemoryKind,
  MemoryScope,
  MemoryStatus
} from '../../../shared/types';
import type { CapabilityDescriptor, EventSubscription, RocPlugin, RocPluginContext } from '../../kernel/types';
import {
  isAgentRunCompletedPayload,
  isAgentSessionArchivedPayload,
  MemoryConsolidatorAdapter
} from './consolidator-adapter';
import { MemoryRepository } from './memory-repository';
import { applyMemoryPluginSchema } from './schema';

const pluginId = '@roc/plugin-memory';
const capabilityVersion = '1.0.0';

const memoryScopeSchema = z.enum(['global', 'workspace']) satisfies z.ZodType<MemoryScope>;
const memoryKindSchema = z.enum(['user', 'agents', 'memory']) satisfies z.ZodType<MemoryKind>;

const memoryFileReadInputSchema = z.object({
  scope: memoryScopeSchema,
  kind: memoryKindSchema
});

const memoryFileWriteInputSchema = z.object({
  scope: memoryScopeSchema,
  kind: memoryKindSchema,
  content: z.string()
}) satisfies z.ZodType<MemoryFileWriteRequest>;

const memoryFileMetaSchema = z.object({
  scope: memoryScopeSchema,
  kind: memoryKindSchema,
  exists: z.boolean(),
  charCount: z.number().int(),
  charLimit: z.number().int(),
  absolutePath: z.string(),
  effective: z.boolean(),
  updatedAt: z.string().nullable()
});

const securityScanIssueSchema = z.object({
  category: z.enum(['prompt_injection', 'credential', 'ssh_backdoor', 'invisible_unicode']),
  pattern: z.string(),
  matchExcerpt: z.string()
});

const memoryFileWriteOutcomeSchema = z.union([
  z.object({
    ok: z.literal(true),
    meta: memoryFileMetaSchema
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['security_scan', 'capacity_exceeded', 'invalid_path', 'workspace_required']),
    detail: z.string(),
    chars: z.number().int().optional(),
    limit: z.number().int().optional(),
    issues: z.array(securityScanIssueSchema).optional()
  })
]) satisfies z.ZodType<MemoryFileWriteOutcome>;

const memoryStatusSchema = z.object({
  root: z.string(),
  workspaceHash: z.string().nullable(),
  workspaceLabel: z.string().nullable(),
  files: z.array(memoryFileMetaSchema),
  snapshot: z.object({
    enabled: z.boolean(),
    totalChars: z.number().int(),
    totalLimit: z.number().int()
  }),
  sessionMessages: z.object({
    totalRows: z.number().int(),
    retentionDays: z.number().int(),
    oldestAt: z.string().nullable()
  }),
  fullTextIndex: z.object({
    healthy: z.boolean(),
    status: z.literal('ready')
  })
}) satisfies z.ZodType<MemoryStatus>;

const snapshotPreviewSchema = z.object({
  text: z.string()
});

export const memoryCapabilityDescriptors = [
  descriptor('memory.status.get', z.object({}), memoryStatusSchema),
  descriptor('memory.file.read', memoryFileReadInputSchema, z.string().nullable()),
  descriptor('memory.file.write', memoryFileWriteInputSchema, memoryFileWriteOutcomeSchema),
  descriptor('memory.snapshot.preview', z.object({}), snapshotPreviewSchema)
] as const satisfies readonly CapabilityDescriptor[];

export type MemoryPluginOptions = {
  memoryRoot?: string;
  workspace?: {
    path: string;
    label: string;
  } | null;
};

export function createMemoryPlugin(options: MemoryPluginOptions = {}): RocPlugin {
  let subscriptions: EventSubscription[] = [];
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Memory',
      description: 'Roc memory plugin.',
      loadPhase: 'critical',
      required: true,
      order: 20,
      dependencies: ['@roc/plugin-agent'],
      capabilities: memoryCapabilityDescriptors
    },
    initialize: async (context) => {
      const memoryRoot = resolveMemoryRoot(options, context);
      const db = context.database.getConnection();
      applyMemoryPluginSchema(db);
      const repository = new MemoryRepository({
        db,
        memoryRoot,
        workspace: options.workspace
      });
      const consolidator = new MemoryConsolidatorAdapter(repository);
      registerMemoryCapabilities(context, repository);
      subscriptions = [
        context.eventBus.subscribe('agent.run.completed', (event) => {
          if (!isAgentRunCompletedPayload(event.payload)) {
            throw new Error('agent_run_completed_payload_invalid');
          }
          consolidator.handleAgentRunCompleted(event.payload);
        }),
        context.eventBus.subscribe('agent.session.archived', (event) => {
          if (!isAgentSessionArchivedPayload(event.payload)) {
            throw new Error('agent_session_archived_payload_invalid');
          }
          consolidator.handleAgentSessionArchived(event.payload);
        })
      ];
    },
    shutdown: async () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      subscriptions = [];
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

export const memoryPlugin = createMemoryPlugin();

function registerMemoryCapabilities(context: RocPluginContext, repository: MemoryRepository): void {
  context.capabilities.register(pluginId, memoryCapabilityDescriptors[0], async () => repository.status());
  context.capabilities.register(pluginId, memoryCapabilityDescriptors[1], async (input) =>
    repository.readFile(input as { scope: MemoryScope; kind: MemoryKind })
  );
  context.capabilities.register(pluginId, memoryCapabilityDescriptors[2], async (input) =>
    repository.writeFile(input as MemoryFileWriteRequest)
  );
  context.capabilities.register(pluginId, memoryCapabilityDescriptors[3], async () => repository.buildSnapshotPreview());
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

function resolveMemoryRoot(options: MemoryPluginOptions, context: RocPluginContext): string {
  if (options.memoryRoot !== undefined) {
    return options.memoryRoot;
  }
  const configured = context.config.get<string>('memory.root');
  if (configured === null || configured.trim().length === 0) {
    throw new Error('memory_root_missing');
  }
  return configured;
}
