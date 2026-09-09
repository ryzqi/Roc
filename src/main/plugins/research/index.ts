import { z } from 'zod';

import {
  researchProjectCreateRequestSchema,
  researchProjectIdRequestSchema,
  researchProjectListRequestSchema,
  researchProjectSchema,
  researchProjectUpdateRequestSchema,
  researchWorkflowSnapshotSchema,
  researchWorkflowTransitionRequestSchema
} from '../../../shared/schemas/research';
import type { CapabilityDescriptor, RocPlugin, RocPluginContext } from '../../kernel/types';
import { ResearchRepository } from './repository';

const pluginId = '@roc/plugin-research';
const capabilityVersion = '1.0.0';

const researchCapabilityDescriptors = [
  descriptor('research.projects.list', researchProjectListRequestSchema, researchProjectSchema.array()),
  descriptor('research.projects.get', researchProjectIdRequestSchema, researchProjectSchema),
  descriptor('research.projects.create', researchProjectCreateRequestSchema, researchProjectSchema),
  descriptor('research.projects.update', researchProjectUpdateRequestSchema, researchProjectSchema),
  descriptor('research.workflow.get', researchProjectIdRequestSchema, researchWorkflowSnapshotSchema),
  descriptor('research.workflow.transition', researchWorkflowTransitionRequestSchema, researchWorkflowSnapshotSchema)
] as const satisfies readonly CapabilityDescriptor[];

export function createResearchPlugin(): RocPlugin {
  let repository: ResearchRepository | null = null;
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Research Workbench',
      description: '科研项目、阶段流程和 Provenance 基础能力。',
      loadPhase: 'critical',
      required: true,
      order: 55,
      dependencies: ['@roc/plugin-agent', '@roc/plugin-workspace'],
      capabilities: researchCapabilityDescriptors
    },
    initialize: async (context: RocPluginContext) => {
      repository = new ResearchRepository(context.database.getConnection());
      context.capabilities.register(pluginId, researchCapabilityDescriptors[0], async () => repository!.listProjects());
      context.capabilities.register(pluginId, researchCapabilityDescriptors[1], async (input) => repository!.getProject((input as { id: string }).id));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[2], async (input) => repository!.createProject(input as never));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[3], async (input) => repository!.updateProject(input as never));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[4], async (input) => repository!.getWorkflow((input as { id: string }).id));
      context.capabilities.register(pluginId, researchCapabilityDescriptors[5], async (input) => repository!.transitionWorkflow(input as never));
    },
    shutdown: async () => {
      repository = null;
    },
    healthCheck: async () => ({ status: 'healthy' })
  };
}

function descriptor<TInput, TOutput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: capabilityVersion, inputSchema, outputSchema };
}

