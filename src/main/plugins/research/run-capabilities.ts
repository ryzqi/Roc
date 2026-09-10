import type { z } from 'zod';
import {
  researchArtifactContentRequestSchema, researchArtifactContentSchema, researchStagePoliciesRequestSchema,
  researchStagePolicySchema, researchStageRunIdRequestSchema, researchStageRunRetryRequestSchema,
  researchStageRunSchema, researchStageRunStartRequestSchema, researchStageRunsRequestSchema
} from '../../../shared/schemas/research-runs';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchRunRepository } from './run-repository';
import type { ResearchStageRuntime } from './stage-runtime';

const capabilities = {
  policies: descriptor('research.workflow.policies', researchStagePoliciesRequestSchema, researchStagePolicySchema.array()),
  savePolicy: descriptor('research.workflow.savePolicy', researchStagePolicySchema, researchStagePolicySchema),
  start: descriptor('research.workflow.startRun', researchStageRunStartRequestSchema, researchStageRunSchema),
  get: descriptor('research.workflow.getRun', researchStageRunIdRequestSchema, researchStageRunSchema),
  list: descriptor('research.workflow.listRuns', researchStageRunsRequestSchema, researchStageRunSchema.array()),
  cancel: descriptor('research.workflow.cancelRun', researchStageRunIdRequestSchema, researchStageRunSchema),
  retry: descriptor('research.workflow.retryRun', researchStageRunRetryRequestSchema, researchStageRunSchema),
  content: descriptor('research.artifacts.content', researchArtifactContentRequestSchema, researchArtifactContentSchema.nullable())
};

export const researchRunCapabilities = Object.values(capabilities);

export function registerResearchRunCapabilities(context: RocPluginContext, repository: ResearchRunRepository, runtime: ResearchStageRuntime): void {
  function register<TInput, TOutput>(capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput): void {
    context.capabilities.register(context.pluginId, capability, async (input) => run(capability.inputSchema.parse(input)));
  }
  register(capabilities.policies, (request) => repository.listPolicies(request.projectId));
  register(capabilities.savePolicy, (request) => repository.savePolicy(request));
  register(capabilities.start, (request) => runtime.start(request));
  register(capabilities.get, (request) => repository.get(request.runId, request.projectId));
  register(capabilities.list, (request) => repository.list(request));
  register(capabilities.cancel, (request) => runtime.cancel(request));
  register(capabilities.retry, (request) => runtime.retry(request));
  register(capabilities.content, (request) => repository.getArtifactContent(request.projectId, request.artifactId));
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
