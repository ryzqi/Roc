import type {z} from 'zod';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {RocErrorCategory} from '../../../shared/types';
import {
  resourceAssociationSaveSchema, resourceAssociationResultSchema, resourceAssociationReadSchema,
  resourceAssociationHistorySchema, resourceAssociationHistoryResultSchema, resourceTargetsSchema, resourceTargetsResultSchema
} from '../../../shared/schemas/research-resource-associations';
import type {ResearchResourceAssociationRepository} from './resource-association-repository';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  save: descriptor('research.resourceAssociations.save', resourceAssociationSaveSchema, resourceAssociationResultSchema),
  read: descriptor('research.resourceAssociations.read', resourceAssociationReadSchema, resourceAssociationResultSchema),
  history: descriptor('research.resourceAssociations.history', resourceAssociationHistorySchema, resourceAssociationHistoryResultSchema),
  targets: descriptor('research.resourceAssociations.targets', resourceTargetsSchema, resourceTargetsResultSchema)
};
export const researchResourceAssociationCapabilities = Object.values(capabilities);
const failures: Record<string, {message: string; category: RocErrorCategory}> = {
  research_resource_association_request_conflict: {message: '关联请求标识已用于其他内容。', category: 'conflict'},
  research_resource_association_not_found: {message: '资源关联不存在。', category: 'not_found'},
  research_resource_association_snapshot_invalid: {message: '保存的资源关联校验失败。', category: 'degraded'},
  research_resource_association_source_invalid: {message: '请选择哈希一致的成功资源观察。', category: 'validation'},
  research_resource_target_changed: {message: '论文或实验版本已变化，请重新选择。', category: 'conflict'},
  research_resource_target_unavailable: {message: '请选择当前项目未归档论文或已完成的托管实验。', category: 'validation'},
  research_resource_not_found: {message: '资源观察不属于当前项目或已不存在。', category: 'not_found'},
  research_resource_snapshot_invalid: {message: '保存的资源观察校验失败。', category: 'degraded'},
  research_experiment_not_found: {message: '托管实验不存在。', category: 'not_found'},
  research_experiment_project_mismatch: {message: '实验不属于当前项目。', category: 'permission'},
  research_experiment_snapshot_invalid: {message: '保存的实验记录校验失败。', category: 'degraded'},
  research_human_required: {message: '资源关联需要当前窗口的人工操作。', category: 'permission'},
  research_human_project_mismatch: {message: '人工操作身份不属于当前项目。', category: 'permission'},
  research_project_archived: {message: '归档项目不能新增资源关联。', category: 'permission'}
};
export function registerResearchResourceAssociationCapabilities(context: RocPluginContext,
  repository: ResearchResourceAssociationRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, action: (input: I) => O): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return action(capability.inputSchema.parse(input));}
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        const failure = failures[code];
        if (failure === undefined) throw error;
        throw new RocDomainError({code, ...failure, retryable: false});
      }
    });
  }
  register(capabilities.save, input => repository.save(input));
  register(capabilities.read, input => repository.read(input));
  register(capabilities.history, input => repository.history(input));
  register(capabilities.targets, input => repository.targets(input));
}
