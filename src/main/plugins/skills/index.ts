import { z } from 'zod';

import { deletedResultSchema } from '../../../shared/schemas/ipc-core';
import {
  builtinSkillsAutoUpdateRequestSchema,
  builtinSkillsCheckRequestSchema,
  builtinSkillsCheckResultSchema,
  builtinSkillsStatusSchema
} from '../../../shared/schemas/builtin-skills';
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
import { BuiltinSkillsService } from '../../services/builtin-skills/service';
import { RocPaths } from '../../services/paths';
import { SkillService } from '../../services/skill-service';

const pluginId = '@roc/plugin-skills';
const capabilityVersion = '1.0.0';

/** Kernel event published after a bundled install or an upstream sync changed the skill list. */
export const builtinSkillsUpdatedEventType = 'skills.builtin.updated';

const emptyInputSchema = z.object({});
const idInputSchema = z.object({
  id: z.string()
}).strict();
const sourceInputSchema = z.object({
  sourceId: z.string().min(1)
}).strict();

const skillsCapabilityDescriptors = [
  descriptor('skills.list', emptyInputSchema, skillSnapshotSchema.array()),
  descriptor('skills.import', skillImportRequestSchema, skillSnapshotSchema),
  descriptor('skills.setEnabled', skillEnabledRequestSchema, skillSnapshotSchema),
  descriptor('skills.delete', idInputSchema, deletedResultSchema),
  descriptor('skills.files.list', skillFileTreeRequestSchema, skillFileTreeResultSchema),
  descriptor('skills.file.read', skillFilePreviewRequestSchema, skillFilePreviewResultSchema),
  descriptor('skills.builtin.status', emptyInputSchema, builtinSkillsStatusSchema),
  descriptor('skills.builtin.check', builtinSkillsCheckRequestSchema, builtinSkillsCheckResultSchema),
  descriptor('skills.builtin.autoUpdate', builtinSkillsAutoUpdateRequestSchema, builtinSkillsStatusSchema),
  descriptor('skills.builtin.restore', sourceInputSchema, builtinSkillsStatusSchema)
] as const satisfies readonly CapabilityDescriptor[];

export type SkillsPluginOptions = {
  rootDir?: string;
  /** Directory holding the vendored snapshot (`resources/builtin-skills` in dev and packaged). */
  bundledRoot?: string;
};

export function createSkillsPlugin(options: SkillsPluginOptions = {}): RocPlugin {
  let builtinSkills: BuiltinSkillsService | null = null;
  /**
   * Bundled-snapshot installation is kicked off during `initialize` but **not awaited**: the
   * kernel registers IPC handlers after all critical plugins initialize, and the renderer boots
   * before that. Blocking here for a 35 MB extract+copy pushed the IPC registration past the
   * renderer's first `window:get-state` call, which left the shell stuck on its boot gate.
   *
   * Capabilities that depend on the installed list await this promise instead, so "skills exist"
   * is still a guarantee for callers; only the *kernel start* is no longer on the critical path.
   */
  let installed: Promise<void> | null = null;

  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Skills',
      description: 'Roc skills plugin, including the bundled upstream skill sources.',
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
      const builtin = new BuiltinSkillsService({
        skillsDir: paths.skillsDir,
        statePath: `${paths.configDir}/builtin-skills.json`,
        bundledRoot: options.bundledRoot ?? '',
        logger: context.logger,
        onUpdated: (status) => {
          void context.eventBus
            .publish({
              type: builtinSkillsUpdatedEventType,
              source: pluginId,
              payload: status,
              createdAt: new Date().toISOString()
            })
            .catch((error: unknown) => {
              context.logger.warn('Built-in skills update event failed.', {
                error: error instanceof Error ? error.message : String(error)
              });
            });
        }
      });
      builtinSkills = builtin;

      // A failure here must not take the skills plugin down: user skills still list.
      installed = builtin.ensureInstalled().catch((error: unknown) => {
        context.logger.warn('Built-in skills could not be installed from the bundled snapshot.', {
          error: error instanceof Error ? error.message : String(error)
        });
      });
      builtin.start();

      const awaitInstalled = async (): Promise<void> => {
        await installed;
      };

      context.capabilities.register(pluginId, skillsCapabilityDescriptors[0], async () => {
        await awaitInstalled();
        return service.list();
      });
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
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[6], async () => builtin.status());
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[7], async (input) => {
        await awaitInstalled();
        return await builtin.check(input as { force?: boolean });
      });
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[8], async (input) =>
        builtin.setAutoUpdate((input as { autoUpdate: boolean }).autoUpdate)
      );
      context.capabilities.register(pluginId, skillsCapabilityDescriptors[9], async (input) => {
        await awaitInstalled();
        return await builtin.restore((input as { sourceId: string }).sourceId);
      });
    },
    shutdown: async () => {
      builtinSkills?.shutdown();
      builtinSkills = null;
    },
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
