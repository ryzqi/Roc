import type { z } from 'zod';
import {
  researchTaskRequestSchema, researchTaskSchema, researchTaskExecutionSchema, researchTaskContinueRequestSchema
} from '../../../shared/schemas/research-tasks';
import { researchStageRunSchema } from '../../../shared/schemas/research-runs';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchTaskRepository } from './research-task-repository';
import type { ResearchTaskController } from './task-controller';

const capabilities = {
  get: descriptor('research.task.get', researchTaskSchema),
  executions: descriptor('research.task.executions', researchTaskExecutionSchema.array()),
  cancel: descriptor('research.task.cancel', researchTaskSchema),
  pause: descriptor('research.task.pause', researchTaskSchema),
  continueTask: {
    name: 'research.task.continue', version: '1.0.0', inputSchema: researchTaskContinueRequestSchema, outputSchema: researchStageRunSchema
  }
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
  context.capabilities.register(context.pluginId, capabilities.pause, async input =>
    await controller.pause(researchTaskRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.continueTask, async input =>
    controller.continueTask(researchTaskContinueRequestSchema.parse(input)));
}

function descriptor<T>(name: string, outputSchema: z.ZodType<T>): CapabilityDescriptor<
  z.infer<typeof researchTaskRequestSchema>, T
> {
  return { name, version: '1.0.0', inputSchema: researchTaskRequestSchema, outputSchema };
}
