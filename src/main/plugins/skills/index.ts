import { z } from 'zod';

import type {
  SkillFilePreviewRequest,
  SkillFilePreviewResult,
  SkillFileTreeRequest,
  SkillFileTreeResult,
  SkillImportRequest,
  SkillSnapshot
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPlugin } from '../../kernel/types';
import { RocPaths } from '../../services/paths';
import { SkillService } from '../../services/skill-service';

const pluginId = '@roc/plugin-skills';
const capabilityVersion = '1.0.0';

const emptyInputSchema = z.object({});
const skillImportRequestSchema = z.object({
  sourcePath: z.string(),
  id: z.string().optional()
}) satisfies z.ZodType<SkillImportRequest>;
const skillSetEnabledRequestSchema = z.object({
  id: z.string(),
  enabled: z.boolean()
});
const idInputSchema = z.object({
  id: z.string()
});
const skillFileTreeRequestSchema = z.object({
  id: z.string(),
  relativePath: z.string()
}) satisfies z.ZodType<SkillFileTreeRequest>;
const skillFilePreviewRequestSchema = z.object({
  id: z.string(),
  relativePath: z.string(),
  maxBytes: z.number().int().optional()
}) satisfies z.ZodType<SkillFilePreviewRequest>;

const skillsCapabilityDescriptors = [
  descriptor('skills.list', emptyInputSchema, z.custom<SkillSnapshot[]>()),
  descriptor('skills.import', skillImportRequestSchema, z.custom<SkillSnapshot>()),
  descriptor('skills.setEnabled', skillSetEnabledRequestSchema, z.custom<SkillSnapshot>()),
  descriptor('skills.delete', idInputSchema, z.object({ deleted: z.literal(true) })),
  descriptor('skills.files.list', skillFileTreeRequestSchema, z.custom<SkillFileTreeResult>()),
  descriptor('skills.file.read', skillFilePreviewRequestSchema, z.custom<SkillFilePreviewResult>())
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
