import {taskFactsSaveSchema, taskFactsSnapshotSchema, taskFactsViewSchema, taskFactsHistoryRequestSchema,
  taskFactsHistorySchema, researchTaskContextSchema} from '../../../shared/schemas/research-task-facts';
import {researchTaskForChatRequestSchema} from '../../../shared/schemas/research-task-diagnostics';
import {researchTaskRequestSchema} from '../../../shared/schemas/research-tasks';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchTaskFactsService} from './task-facts';
import {notifyResearchTaskChanged} from './task-notifications';

const capabilities = {
  forChat: {name: 'research.task.facts.forChat', version: '1.0.0', inputSchema: researchTaskForChatRequestSchema,
    outputSchema: researchTaskContextSchema.nullable()},
  get: {name: 'research.task.facts.get', version: '1.0.0', inputSchema: researchTaskRequestSchema, outputSchema: taskFactsViewSchema},
  save: {name: 'research.task.facts.save', version: '1.0.0', inputSchema: taskFactsSaveSchema, outputSchema: taskFactsSnapshotSchema},
  history: {name: 'research.task.facts.history', version: '1.0.0', inputSchema: taskFactsHistoryRequestSchema, outputSchema: taskFactsHistorySchema}
};
export const taskFactCapabilities = Object.values(capabilities);
export function registerTaskFactCapabilities(context: RocPluginContext, service: ResearchTaskFactsService): void {
  context.capabilities.register(context.pluginId, capabilities.forChat, async input => service.forChat(researchTaskForChatRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.get, async input => service.get(researchTaskRequestSchema.parse(input)));
  context.capabilities.register(context.pluginId, capabilities.save, async input => {
    const request = taskFactsSaveSchema.parse(input), result = service.save(request);
    notifyResearchTaskChanged(context, request.taskId, request.projectId);
    return result;
  });
  context.capabilities.register(context.pluginId, capabilities.history, async input => service.history(taskFactsHistoryRequestSchema.parse(input)));
}
