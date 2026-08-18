import { z } from 'zod';

import { deletedResultSchema } from '../../../shared/schemas/ipc-core';
import {
  skillEnabledRequestSchema,
  skillFilePreviewRequestSchema,
  skillFilePreviewResultSchema,
  skillFileTreeRequestSchema,
  skillFileTreeResultSchema,
  skillImportRequestSchema,
  skillSnapshotSchema
} from '../../../shared/schemas/ipc-mcp-skills';
import type {
  SkillFilePreviewRequest,
  SkillFileTreeRequest,
  SkillImportRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin } from '../../kernel/types';
import { RocPaths } from '../../services/paths';
import { SkillService } from '../../services/skill-service';

const pluginId = '@roc/plugin-skills';
const capabilityVersion = '1.0.0';

const emptyInputSchema = z.object({});
const idInputSchema = z.object({
  id: z.string()
}).strict();

const skillsCapabilityDescriptors = [
  descriptor('skills.list', emptyInputSchema, skillSnapshotSchema.array()),
  descriptor('skills.import', skillImportRequestSchema, skillSnapshotSchema),
  descriptor('skills.setEnabled', skillEnabledRequestSchema, skillSnapshotSchema),
  descriptor('skills.delete', idInputSchema, deletedResultSchema),
  descriptor('skills.files.list', skillFileTreeRequestSchema, skillFileTreeResultSchema),
  descriptor('skills.file.read', skillFilePreviewRequestSchema, skillFilePreviewResultSchema)
] as const satisfies readonly CapabilityDescriptor[];

export type SkillsPluginOptions = {
  rootDir?: string;
};

export function createSkillsPlugin(options: SkillsPluginOptions = {}): RocPlugin {
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Skills',
      description: 'Roc skills plugin.',
      loadPhase: 'critical',
      required: true,
      order: 60,
      dependencies: [],
      capabilities: skillsCapabilityDescriptors
    },
    initialize: async (context) => {
      const paths = new RocPaths(options.rootDir);
      paths.ensureTree();
      const service = new SkillService(paths);
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[0], async () => service.list());
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[1], async (input) =>
        service.importSkill(input as SkillImportRequest)
      );
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[2], async (input) => {
        const request = input as { id: string; enabled: boolean };
        return service.setEnabled(request.id, request.enabled);
      });
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[3], async (input) => {
        service.deleteSkill((input as { id: string }).id);
        return { deleted: true as const };
      });
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[4], async (input) =>
        service.listFiles(input as SkillFileTreeRequest)
      );
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[5], async (input) =>
        service.readFile(input as SkillFilePreviewRequest)
      );
    },
    shutdown: async () => {},
    healthCheck: async () => ({ status: 'healthy' })
  };
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
