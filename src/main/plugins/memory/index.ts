import { z } from 'zod';

import type {
  MemoryFileWriteOutcome,
  MemoryFileWriteRequest,
  MemoryKind,
  MemoryScope,
  MemoryStatus
} from '../../../shared/types';
import type { CapabilityDescriptor, EventSubscription, RocPlugin, RocPluginContext } from '../../kernel/types';
import { defaultSettings } from '../../services/config/defaults';
import { AutoMemoryWriter, isAgentRunCompletedPayload } from '../../services/memory/auto-memory-writer';
import { AutoMemoryAuditRepository } from '../../services/memory/auto-memory-audit-repository';
import { RocSqliteStore } from '../../services/memory/sqlite-store';
import {
  MemoryStoreRepository,
  type MemoryStoreRepositorySettings,
  type MemoryWorkspaceContext
} from './memory-store-repository';

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

const autoMemoryAuditRecordSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  action: z.enum([
    'accepted',
    'rejected',
    'duplicate_skipped',
    'conflict_rejected',
    'maintenance_merged',
    'maintenance_deleted',
    'write_failed'
  ]),
  type: z.enum([
    'user_preference',
    'workspace_fact',
    'decision',
    'pitfall',
    'verification',
    'transient_task_result'
  ]),
  scope: memoryScopeSchema,
  confidence: z.enum(['high', 'medium', 'low']),
  key: z.string(),
  summary: z.string(),
  sourceRunId: z.string(),
  reason: z.string(),
  workspacePath: z.string().nullable(),
  targetPath: z.string().nullable()
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
  }),
  autoMemory: z.object({
    enabled: z.boolean(),
    auditRetentionDays: z.number().int(),
    recent: z.array(autoMemoryAuditRecordSchema)
  })
}) satisfies z.ZodType<MemoryStatus>;

const snapshotPreviewSchema = z.object({
  text: z.string()
});

const memoryCapabilityDescriptors = [
  descriptor('memory.status.get', z.object({}), memoryStatusSchema),
  descriptor('memory.file.read', memoryFileReadInputSchema, z.string().nullable()),
  descriptor('memory.file.write', memoryFileWriteInputSchema, memoryFileWriteOutcomeSchema),
  descriptor('memory.snapshot.preview', z.object({}), snapshotPreviewSchema)
] as const satisfies readonly CapabilityDescriptor[];

export type MemoryPluginOptions = {
  workspace?: {
    path: string;
    label: string;
  } | null;
  getWorkspace?: () => MemoryWorkspaceContext | null;
  getMemorySettings?: () => MemoryStoreRepositorySettings;
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
      const db = context.database.getConnection();
      const auditRepository = new AutoMemoryAuditRepository(db);
      const getWorkspace = createMemoryWorkspaceProvider(options);
      const getMemorySettings =
        options.getMemorySettings === undefined ? () => defaultSettings.memory : options.getMemorySettings;
      const repository = new MemoryStoreRepository({
        store: new RocSqliteStore(db),
        getWorkspace,
        getMemorySettings,
        auditRepository
      });
      const autoMemoryWriter = new AutoMemoryWriter({
        repository,
        auditRepository,
        getMemorySettings,
        logger: context.logger
      });
      registerMemoryCapabilities(context, repository);
      subscriptions = [
        context.eventBus.subscribe('agent.run.completed', async (event) => {
          if (!isAgentRunCompletedPayload(event.payload)) {
            throw new Error('agent_run_completed_payload_invalid');
          }
          try {
            auditRepository.prune(getMemorySettings().autoMemory.auditRetentionDays);
            await autoMemoryWriter.handleAgentRunCompleted(event.payload, event.createdAt);
          } catch (error) {
            context.logger.warn('memory_auto_write_failed', {
              error: error instanceof Error ? error.message : String(error)
            });
          }
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

function createMemoryWorkspaceProvider(options: MemoryPluginOptions): () => MemoryWorkspaceContext | null {
  if (options.workspace !== undefined && options.getWorkspace !== undefined) {
    throw new Error('memory_workspace_source_conflict');
  }
  if (options.getWorkspace !== undefined) {
    return options.getWorkspace;
  }
  const workspace = options.workspace === undefined ? null : options.workspace;
  return () => workspace;
}

function registerMemoryCapabilities(context: RocPluginContext, repository: MemoryStoreRepository): void {
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
