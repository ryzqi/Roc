import type { z } from 'zod';
import { researchProductionInputContentSchema, researchProductionInputReadSchema, researchProductionInputRequestSchema,
  researchProductionInputSchema } from '../../../shared/schemas/research-production-inputs';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { ResearchProductionInputService } from './production-input-service';
import {researchProductionReviewRequestSchema, researchProductionReviewReadSchema} from '../../../shared/schemas/research-production-review';
import {RocDomainError} from '../../services/errors';
import type {RocErrorCategory} from '../../../shared/types';

const inspect = descriptor('research.artifacts.inspectProduction', researchProductionInputRequestSchema, researchProductionInputSchema);
const read = descriptor('research.artifacts.readProductionFile', researchProductionInputReadSchema, researchProductionInputContentSchema);
const inspectReview = descriptor('research.artifacts.inspectProductionReview', researchProductionReviewRequestSchema, researchProductionInputSchema);
const readReview = descriptor('research.artifacts.readProductionReviewFile', researchProductionReviewReadSchema, researchProductionInputContentSchema);
export const researchProductionInputCapabilities = [inspect, read, inspectReview, readReview];

export function registerResearchProductionInputCapabilities(context: RocPluginContext, service: ResearchProductionInputService): void {
  context.capabilities.register(context.pluginId, inspect, async (value) => {
    const input = inspect.inputSchema.parse(value);
    return await service.inspect(input.projectId, input.artifactId);
  });
  context.capabilities.register(context.pluginId, read, async (value) => await service.read(read.inputSchema.parse(value)));
  context.capabilities.register(context.pluginId, inspectReview, async value =>
    reviewBoundary(() => service.inspectReview(inspectReview.inputSchema.parse(value))));
  context.capabilities.register(context.pluginId, readReview, async value =>
    reviewBoundary(() => service.readReview(readReview.inputSchema.parse(value))));
}

const reviewErrors: Record<string, {message: string; category: RocErrorCategory}> = {
  research_production_review_changed: {category: 'conflict', message: '生产工件版本已变化，请刷新工件重新核对。'},
  research_production_snapshot_changed: {category: 'conflict', message: '生产文件版本已变化，请刷新工件重新核对。'},
  research_production_review_unavailable: {category: 'permission', message: '当前工件不在可读取的人工审核范围内。'},
  research_project_archived: {category: 'permission', message: '项目已归档，无法读取生产审核文件。'},
  research_production_artifact_superseded: {category: 'permission', message: '生产工件已被替代，请核对当前工件。'},
  research_artifact_project_mismatch: {category: 'permission', message: '生产工件不属于当前项目。'},
  research_production_project_mismatch: {category: 'permission', message: '生产工件不属于当前项目。'},
  research_production_preview_limit: {category: 'validation', message: '文件超过 4 MiB 预览上限。'},
  research_production_file_not_found: {category: 'not_found', message: '保存的生产文件不存在。'},
  research_artifact_not_found: {category: 'not_found', message: '生产工件不存在。'},
  research_project_not_found: {category: 'not_found', message: '科研项目不存在。'},
  research_production_artifact_required: {category: 'validation', message: '该工件没有生产文件。'},
  research_experiment_manifest_changed: {category: 'degraded', message: '实验文件与保存的发布版本不一致。'},
  research_figure_manifest_changed: {category: 'degraded', message: '图稿文件与保存的发布版本不一致。'},
  research_experiment_snapshot_changed: {category: 'degraded', message: '实验文件与保存的内容校验值不一致。'},
  research_figure_snapshot_changed: {category: 'degraded', message: '图稿文件与保存的内容校验值不一致。'},
  research_export_snapshot_changed: {category: 'degraded', message: '导出文件与保存的内容校验值不一致。'},
  research_production_input_closed: {category: 'degraded', message: '生产文件读取器已关闭。'}
};

async function reviewBoundary<T>(readValue: () => Promise<T>): Promise<T> {
  try { return await readValue(); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.name === 'ZodError') throw new RocDomainError({code: 'research_production_review_input_invalid',
      category: 'validation', message: '生产审核请求缺少有效版本、文件校验值或相对路径。', retryable: false});
    const nativeCode = (error as NodeJS.ErrnoException).code;
    if (nativeCode === 'ENOENT') throw new RocDomainError({code: 'research_production_file_missing',
      category: 'not_found', message: '保存的生产文件或发布清单缺失。', retryable: false});
    if (nativeCode === 'EACCES' || nativeCode === 'EPERM') throw new RocDomainError({code: 'research_production_file_denied',
      category: 'permission', message: '当前无法访问保存的生产文件。', retryable: false});
    const code = error.message.split(':')[0], detail = reviewErrors[code];
    if (detail === undefined) throw error;
    throw new RocDomainError({code, ...detail, retryable: false});
  }
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}
