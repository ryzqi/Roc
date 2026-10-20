import { z } from 'zod';

import { researchProseLintReportSchema, researchProseLintRequestSchema } from '../../../shared/schemas/research-prose';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { ResearchProseLintService } from './prose-lint-service';

const capabilities = {
  lint: descriptor('research.prose.lint', researchProseLintRequestSchema, researchProseLintReportSchema)
};

export const researchProseCapabilities = Object.values(capabilities);

export function registerResearchProseCapabilities(context: RocPluginContext, prose: ResearchProseLintService): void {
  context.capabilities.register(context.pluginId, capabilities.lint, async (input) => {
    try {
      return await prose.lint(capabilities.lint.inputSchema.parse(input));
    } catch (error) { throw mapProseLintError(error); }
  });
}

function descriptor<TInput, TOutput>(name: string, inputSchema: z.ZodType<TInput>, outputSchema: z.ZodType<TOutput>): CapabilityDescriptor<TInput, TOutput> {
  return { name, version: '1.0.0', inputSchema, outputSchema };
}

/**
 * 工具链缺 Vale 时给一句能执行的话，而不是把内部错误码抛到界面上。
 *
 * 这里只有一种降级情形，而且它是**可修的**：工具链还没重建。工具链整体缺失走的是同一族错误码
 * （`research_toolchain_unavailable` / `research_toolchain_version_mismatch`），已经在
 * `plugin-capability-adapter` 与其他科研能力里统一处理，所以只映射本域特有的一种。
 */
function mapProseLintError(error: unknown): never {
  if (error instanceof RocDomainError) throw error;
  const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
  if (code === 'research_prose_lint_unavailable') {
    throw new RocDomainError({
      code,
      message: '随包工具链里没有文稿检查器，请重建科研工具链后重试。',
      category: 'degraded',
      retryable: false
    });
  }
  if (code === 'research_prose_artifact_kind_invalid') {
    throw new RocDomainError({
      code,
      message: '只有正文产物可以检查文稿。',
      category: 'validation',
      retryable: false
    });
  }
  // 正文存在但不可检查：这几种都不是故障，而是「还没到那一步」，要说清楚差什么。
  if (code === 'research_manuscript_required') {
    throw new RocDomainError({
      code,
      message: '这个正文产物还没有正文内容，先生成正文再检查。',
      category: 'validation',
      retryable: false
    });
  }
  if (code === 'research_manuscript_stale') {
    throw new RocDomainError({
      code,
      message: '正文已经变了，先重新保存文稿再检查。',
      category: 'conflict',
      retryable: false
    });
  }
  throw error;
}
