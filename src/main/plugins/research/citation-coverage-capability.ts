import {researchCitationCoverageRequestSchema, researchCitationCoverageInspectionSchema} from '../../../shared/schemas/research-citation-coverage';
import {RocDomainError} from '../../services/errors';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchCitationCoverageService} from './citation-coverage-service';

export const researchCitationCoverageCapability = {
  name: 'research.manuscript.citationCoverage', version: '1.0.0',
  inputSchema: researchCitationCoverageRequestSchema, outputSchema: researchCitationCoverageInspectionSchema
};

export function registerResearchCitationCoverageCapability(context: RocPluginContext, service: ResearchCitationCoverageService): void {
  context.capabilities.register(context.pluginId, researchCitationCoverageCapability, async input => {
    try {
      return service.inspect(researchCitationCoverageRequestSchema.parse(input));
    } catch (error) {
      if (error instanceof RocDomainError) throw error;
      const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
      const known: Record<string, {message: string; category: 'permission' | 'validation' | 'conflict' | 'not_found' | 'degraded'}> = {
        research_manuscript_project_mismatch: {message: '正文不属于当前项目。', category: 'permission'},
        research_artifact_project_mismatch: {message: '工件不属于当前项目。', category: 'permission'},
        research_evidence_project_mismatch: {message: '证据不属于当前项目。', category: 'permission'},
        research_manuscript_artifact_required: {message: '请选择已保存的正文工件。', category: 'validation'},
        research_manuscript_required: {message: '先保存正文，再检查引用覆盖。', category: 'validation'},
        research_manuscript_stale: {message: '主张或正文来源已变化，请重新保存正文后检查。', category: 'conflict'},
        research_evidence_reference_superseded: {message: '引用来源已失效，请重新捕获证据并保存正文。', category: 'conflict'},
        research_evidence_integrity_invalid: {message: '证据原文与内容校验值不一致。', category: 'degraded'},
        research_artifact_not_found: {message: '正文工件不存在。', category: 'not_found'},
        research_project_not_found: {message: '项目不存在。', category: 'not_found'},
        research_evidence_not_found: {message: '引用证据不存在。', category: 'not_found'}
      };
      const detail = known[code];
      if (detail !== undefined) throw new RocDomainError({code, ...detail, retryable: false});
      throw error;
    }
  });
}
