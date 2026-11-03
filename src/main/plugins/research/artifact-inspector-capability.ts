import {RocDomainError} from '../../services/errors';
import type {RocPluginContext} from '../../kernel/types';
import {researchArtifactInspectRequestSchema, researchArtifactInspectResultSchema} from '../../../shared/schemas/research-artifact-inspector';
import type {ResearchRepository} from './repository';

export const researchArtifactInspectorCapability = {
  name: 'research.artifacts.inspect', version: '1.0.0',
  inputSchema: researchArtifactInspectRequestSchema, outputSchema: researchArtifactInspectResultSchema
};

export function registerResearchArtifactInspectorCapability(context: RocPluginContext, repository: Pick<ResearchRepository, 'inspectArtifact'>): void {
  context.capabilities.register(context.pluginId, researchArtifactInspectorCapability, async input => {
    try {
      return repository.inspectArtifact(researchArtifactInspectRequestSchema.parse(input));
    } catch (error) {
      if (error instanceof Error) {
        const code = error.message;
        if (code === 'research_artifact_project_mismatch' || code === 'research_evidence_project_mismatch') {
          throw new RocDomainError({code, message: '工件或证据不属于当前项目。', category: 'permission', retryable: false});
        }
        if (code.startsWith('research_artifact_not_found:') || code.startsWith('research_project_not_found:') || code === 'research_evidence_not_found') {
          throw new RocDomainError({code: code.split(':')[0],
            message: '工件、项目或关联证据不存在。', category: 'not_found', retryable: false});
        }
        if (code === 'research_evidence_integrity_invalid') {
          throw new RocDomainError({code, message: '证据原文与保存的内容校验值不一致。', category: 'degraded', retryable: false});
        }
      }
      throw error;
    }
  });
}
