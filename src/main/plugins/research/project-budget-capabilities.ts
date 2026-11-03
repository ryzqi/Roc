import {
  researchProjectBudgetRequestSchema, researchProjectBudgetSaveSchema, researchProjectBudgetStatusSchema
} from '../../../shared/schemas/research-project-budget';
import type { RocPluginContext } from '../../kernel/types';
import type { ResearchRepository } from './repository';

const capabilities = {
  get: {
    name: 'research.projectBudget.get', version: '1.0.0', inputSchema: researchProjectBudgetRequestSchema,
    outputSchema: researchProjectBudgetStatusSchema.nullable()
  },
  save: {
    name: 'research.projectBudget.save', version: '1.0.0', inputSchema: researchProjectBudgetSaveSchema,
    outputSchema: researchProjectBudgetStatusSchema
  }
};
export const researchProjectBudgetCapabilities = Object.values(capabilities);

export function registerResearchProjectBudgetCapabilities(context: RocPluginContext, repository: ResearchRepository): void {
  context.capabilities.register(context.pluginId, capabilities.get, async input => {
    const request = researchProjectBudgetRequestSchema.parse(input);
    repository.getProject(request.projectId);
    return repository.tasks.projectBudgets.status(request.projectId);
  });
  context.capabilities.register(context.pluginId, capabilities.save, async input => {
    const request = researchProjectBudgetSaveSchema.parse(input);
    repository.getProject(request.projectId);
    const result = repository.tasks.projectBudgets.save(request);
    void context.eventBus.publish({
      type: 'research.project.budget.updated', source: context.pluginId,
      payload: { projectId: request.projectId }, createdAt: new Date().toISOString()
    }).catch(() => context.logger.warn('research_project_budget_notification_failed', { projectId: request.projectId }));
    return result;
  });
}
