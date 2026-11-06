import type { z } from 'zod';
import {
  researchTaskRequestSchema, researchTaskSchema, researchTaskExecutionSchema, researchTaskContinueRequestSchema,
  researchTaskEventsRequestSchema, researchTaskEventsPageSchema, researchTaskListRequestSchema, researchTaskListPageSchema
} from '../../../shared/schemas/research-tasks';
import { researchStageRunSchema } from '../../../shared/schemas/research-runs';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchTaskRepository } from './research-task-repository';
import type { ResearchTaskController } from './task-controller';
import type { ResearchTaskDiagnosticsService } from './task-diagnostics';
import { researchTaskDiagnosticsSchema, researchTaskForChatRequestSchema } from '../../../shared/schemas/research-task-diagnostics';
import {taskExecutionDiagnosticsRequestSchema, taskExecutionObservationsSchema, taskDiagnosticsExportSchema} from '../../../shared/schemas/research-task-observability';
import type {ResearchTaskDiagnosticsExporter} from './task-diagnostics-export';
import { notifyResearchTaskChanged } from './task-notifications';

const capabilities = {
  list: {
    name: 'research.task.list', version: '1.0.0', inputSchema: researchTaskListRequestSchema, outputSchema: researchTaskListPageSchema
  },
  get: descriptor('research.task.get', researchTaskSchema),
  executions: descriptor('research.task.executions', researchTaskExecutionSchema.array()),
  cancel: descriptor('research.task.cancel', researchTaskSchema),
  pause: descriptor('research.task.pause', researchTaskSchema),
  restoreApproval: descriptor('research.task.restoreApproval', researchTaskSchema),
  diagnostics: descriptor('research.task.diagnostics', researchTaskDiagnosticsSchema),
  exportDiagnostics: descriptor('research.task.diagnostics.export', taskDiagnosticsExportSchema),
  executionDiagnostics: {name: 'research.task.diagnostics.execution', version: '1.0.0', inputSchema: taskExecutionDiagnosticsRequestSchema, outputSchema: taskExecutionObservationsSchema},
  forChat: {
    name: 'research.task.forChat', version: '1.0.0', inputSchema: researchTaskForChatRequestSchema,
    outputSchema: researchTaskDiagnosticsSchema.nullable()
  },
  events: {
    name: 'research.task.events', version: '1.0.0', inputSchema: researchTaskEventsRequestSchema, outputSchema: researchTaskEventsPageSchema
  },
  continueTask: {
    name: 'research.task.continue', version: '1.0.0', inputSchema: researchTaskContinueRequestSchema, outputSchema: researchStageRunSchema
  }
};
export const researchTaskCapabilities = Object.values(capabilities);

export function registerResearchTaskCapabilities(
  context: RocPluginContext, tasks: ResearchTaskRepository, controller: ResearchTaskController, diagnostics: ResearchTaskDiagnosticsService, exporter: ResearchTaskDiagnosticsExporter
): void {
  context.capabilities.register(context.pluginId, capabilities.list, async input =>
    tasks.list(researchTaskListRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.get, async input => {
    const request = researchTaskRequestSchema.parse(input);
    return tasks.get(request.taskId, request.projectId);
  });
  context.capabilities.register(context.pluginId, capabilities.executions, async input => {
    const request = researchTaskRequestSchema.parse(input);
    return tasks.executions(request.taskId, request.projectId);
  });
  action(capabilities.cancel, request => controller.cancel(request));
  action(capabilities.pause, request => controller.pause(request));
  action(capabilities.continueTask, request => controller.continueTask(request));
  action(capabilities.restoreApproval, request => controller.restoreApproval(request));
  context.capabilities.register(context.pluginId, capabilities.diagnostics, async input =>
    diagnostics.get(researchTaskRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.executionDiagnostics, async input =>
    diagnostics.inspectExecution(taskExecutionDiagnosticsRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.exportDiagnostics, async input =>
    exporter.export(researchTaskRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.forChat, async input =>
    diagnostics.forChat(researchTaskForChatRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.events, async input =>
    tasks.events(researchTaskEventsRequestSchema.parse(input)));

  function action<TInput extends { taskId: string; projectId: string }, TOutput>(
    capability: CapabilityDescriptor<TInput, TOutput>, run: (request: TInput) => TOutput | Promise<TOutput>
  ): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      const request = capability.inputSchema.parse(input);
      tasks.get(request.taskId, request.projectId);
      try { return await run(request); }
      finally { notifyResearchTaskChanged(context, request.taskId, request.projectId); }
    });
  }
}

function descriptor<T>(name: string, outputSchema: z.ZodType<T>): CapabilityDescriptor<
  z.infer<typeof researchTaskRequestSchema>, T
> {
  return { name, version: '1.0.0', inputSchema: researchTaskRequestSchema, outputSchema };
}
