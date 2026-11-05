import type {z} from 'zod';
import {
  researchFigureConsistencySaveSchema, researchFigureConsistencyReceiptSchema, researchFigureConsistencyHistorySchema,
  researchFigureConsistencyHistoryResultSchema, researchFigureConsistencyInspectSchema, researchFigureConsistencyInspectionSchema
} from '../../../shared/schemas/research-figure-consistency';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {ResearchFigureConsistencyService} from './figure-consistency-service';
import type {ResearchFigureConsistencyRepository} from './figure-consistency-repository';
import {consistencyErrors} from './consistency-capabilities';

function descriptor<I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> {
  return {name, version: '1.0.0', inputSchema, outputSchema};
}
const capabilities = {
  save: descriptor('research.figureConsistency.save', researchFigureConsistencySaveSchema, researchFigureConsistencyReceiptSchema),
  history: descriptor('research.figureConsistency.history', researchFigureConsistencyHistorySchema, researchFigureConsistencyHistoryResultSchema),
  inspect: descriptor('research.figureConsistency.inspect', researchFigureConsistencyInspectSchema, researchFigureConsistencyInspectionSchema)
};
export const researchFigureConsistencyCapabilities = Object.values(capabilities);
export function registerResearchFigureConsistencyCapabilities(context: RocPluginContext,
  service: ResearchFigureConsistencyService, repository: ResearchFigureConsistencyRepository): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, action: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await action(capability.inputSchema.parse(input));}
      catch (error) {
        if (!(error instanceof Error) || error instanceof RocDomainError) throw error;
        const code = error.name === 'ZodError' || error instanceof SyntaxError ?
          'research_figure_consistency_contract_invalid' : error.message.split(':')[0];
        const detail = errors[code];
        if (detail === undefined) throw error;
        throw new RocDomainError({code, ...detail, retryable: false});
      }
    });
  }
  register(capabilities.save, input => service.save(input));
  register(capabilities.history, input => repository.history(input));
  register(capabilities.inspect, input => service.inspect(input));
}
const errors: typeof consistencyErrors = {
  ...consistencyErrors,
  research_figure_consistency_contract_invalid: {message: '图稿数值映射或回执不符合合同。', category: 'validation'},
  research_figure_consistency_encoding_unsupported: {message: '请选择实际场景数据的直接字段编码；条件或表达式须另行核查。', category: 'validation'},
  research_figure_consistency_value_required: {message: '所选场景项没有该字段的有限数值。', category: 'validation'},
  research_figure_consistency_duplicate_location: {message: '同一场景项和编码通道不能重复映射。', category: 'validation'},
  research_figure_consistency_project_mismatch: {message: '图稿、主张或来源不属于当前项目。', category: 'permission'},
  research_figure_consistency_figure_required: {message: '请选择实际发布的图稿工件。', category: 'validation'},
  research_figure_consistency_source_changed: {message: '图稿场景数据或来源版本已变化，请重新核查。', category: 'conflict'},
  research_figure_consistency_request_conflict: {message: '重试身份或图稿映射内容与已保存请求不同。', category: 'conflict'},
  research_figure_consistency_version_conflict: {message: '图稿映射已有新版本，请重新读取。', category: 'conflict'},
  research_figure_consistency_snapshot_invalid: {message: '图稿数值审核回执校验失败。', category: 'degraded'},
  research_figure_consistency_mark_not_found: {message: '所选编译 mark 不在当前图稿中。', category: 'not_found'},
  research_figure_data_trace_required: {message: '图稿缺少实际场景数据回执。', category: 'degraded'},
  research_figure_snapshot_changed: {message: '图稿冻结文件已变化。', category: 'conflict'},
  research_figure_manifest_changed: {message: '图稿清单已变化。', category: 'conflict'},
  research_figure_not_found: {message: '图稿不存在。', category: 'not_found'}
};
