import type { z } from 'zod';

import {
  researchIdeaCanvasGetRequestSchema,
  researchIdeaCanvasHistoryRequestSchema,
  researchIdeaCanvasSaveRequestSchema,
  researchIdeaCanvasSchema,
  researchIdeaPromoteRequestSchema,
  researchIdeaPromotionSchema
} from '../../../shared/schemas/research-ideas';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchIdeaRepository } from './idea-repository';

const capabilities = {
  save: descriptor('research.ideas.save', researchIdeaCanvasSaveRequestSchema, researchIdeaCanvasSchema),
  get: descriptor('research.ideas.get', researchIdeaCanvasGetRequestSchema, researchIdeaCanvasSchema.nullable()),
  history: descriptor('research.ideas.history', researchIdeaCanvasHistoryRequestSchema, researchIdeaCanvasSchema.array()),
  promote: descriptor('research.ideas.promote', researchIdeaPromoteRequestSchema, researchIdeaPromotionSchema)
};

export const researchIdeaCapabilities = Object.values(capabilities);

export function registerResearchIdeaCapabilities(context: RocPluginContext, repository: ResearchIdeaRepository): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async (input) => run(capability.inputSchema.parse(input)));
  }
  register(capabilities.save, (request) => repository.save(request));
  register(capabilities.get, (request) => repository.get(request.artifactId));
  register(capabilities.history, (request) => repository.history(request.artifactId));
  register(capabilities.promote, (request) => repository.promote(request));
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
