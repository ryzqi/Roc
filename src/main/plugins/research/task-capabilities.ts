import type { z } from 'zod';
import {
  researchTaskRequestSchema, researchTaskSchema, researchTaskExecutionSchema, researchTaskContinueRequestSchema
} from '../../../shared/schemas/research-tasks';
import { researchStageRunSchema } from '../../../shared/schemas/research-runs';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchTaskRepository } from './research-task-repository';
import type { ResearchTaskController } from './task-controller';
import type { ResearchTaskDiagnosticsService } from './task-diagnostics';
import { researchTaskDiagnosticsSchema, researchTaskForChatRequestSchema } from '../../../shared/schemas/research-task-diagnostics';

const capabilities = {
  get: descriptor('research.task.get', researchTaskSchema),
  executions: descriptor('research.task.executions', researchTaskExecutionSchema.array()),
  cancel: descriptor('research.task.cancel', researchTaskSchema),
  pause: descriptor('research.task.pause', researchTaskSchema),
  restoreApproval: descriptor('research.task.restoreApproval', researchTaskSchema),
  diagnostics: descriptor('research.task.diagnostics', researchTaskDiagnosticsSchema),
  forChat: {
    name: 'research.task.forChat', version: '1.0.0', inputSchema: researchTaskForChatRequestSchema,
    outputSchema: researchTaskDiagnosticsSchema.nullable()
  },
  continueTask: {
    name: 'research.task.continue', version: '1.0.0', inputSchema: researchTaskContinueRequestSchema, outputSchema: researchStageRunSchema
  }
};
export const researchTaskCapabilities = Object.values(capabilities);

export function registerResearchTaskCapabilities(
  context: RocPluginContext, tasks: ResearchTaskRepository, controller: ResearchTaskController, diagnostics: ResearchTaskDiagnosticsService
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
  context.capabilities.register(context.pluginId, capabilities.restoreApproval, async input =>
    controller.restoreApproval(researchTaskRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.diagnostics, async input =>
    diagnostics.get(researchTaskRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.forChat, async input =>
    diagnostics.forChat(researchTaskForChatRequestSchema.parse(input)));
}

function descriptor<T>(name: string, outputSchema: z.ZodType<T>): CapabilityDescriptor<
  z.infer<typeof researchTaskRequestSchema>, T
> {
  return { name, version: '1.0.0', inputSchema: researchTaskRequestSchema, outputSchema };
}
