import type { z } from 'zod';
import {
  researchTaskRequestSchema, researchTaskSchema, researchTaskExecutionSchema
} from '../../../shared/schemas/research-tasks';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchTaskRepository } from './research-task-repository';
import type { ResearchTaskController } from './task-controller';

const capabilities = {
  get: descriptor('research.task.get', researchTaskSchema),
  executions: descriptor('research.task.executions', researchTaskExecutionSchema.array()),
  cancel: descriptor('research.task.cancel', researchTaskSchema)
};
export const researchTaskCapabilities = Object.values(capabilities);

export function registerResearchTaskCapabilities(
  context: RocPluginContext, tasks: ResearchTaskRepository, controller: ResearchTaskController
): void {
  context.capabilities.register(context.pluginId, capabilities.get, async input => {
    const request = researchTaskRequestSchema.parse(input);
    return tasks.get(request.taskId, request.projectId);
  });
  context.capabilities.register(context.pluginId, capabilities.executions, async input => {
    const request = researchTaskRequestSchema.parse(input);
    return tasks.executions(request.taskId, request.projectId);
  });
  context.capabilities.register(context.pluginId, capabilities.cancel, async input =>
    await controller.cancel(researchTaskRequestSchema.parse(input)));
}

function descriptor<T>(name: string, outputSchema: z.ZodType<T>): CapabilityDescriptor<
  z.infer<typeof researchTaskRequestSchema>, T
> {
  return { name, version: '1.0.0', inputSchema: researchTaskRequestSchema, outputSchema };
}
