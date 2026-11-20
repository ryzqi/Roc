import { ResearchDiagramService } from './diagram-service';
import { researchDiagramCapability, registerResearchDiagramCapability } from './diagram-capabilities';
import type { RocPluginContext } from '../../kernel/types';
import { ResearchProseLintService } from './prose-lint-service';
import { registerResearchProseCapabilities, researchProseCapabilities } from './prose-lint-capabilities';
import { ResearchCitationCoverageService } from './citation-coverage-service';
import { registerResearchCitationCoverageCapability } from './citation-coverage-capability';
import { registerResearchCitationReviewCapabilities } from './citation-review-capabilities';
import { ResearchConsistencyService } from './consistency-service';
import { registerResearchConsistencyCapabilities } from './consistency-capabilities';
import { ResearchJournalComplianceService } from './journal-compliance-service';
import { registerResearchJournalComplianceCapabilities } from './journal-compliance-capabilities';
import { registerResearchResponseMatrixCapabilities } from './response-matrix-capabilities';
import type { ResearchPluginOptions } from './research-plugin-options';
import type { ResearchPluginLifecycle } from './research-plugin-lifecycle';
import type { ResearchProductionServices } from './research-plugin-production';

export function registerResearchWriting(
  context: RocPluginContext, options: ResearchPluginOptions,
  lifecycle: ResearchPluginLifecycle, production: ResearchProductionServices
): void {
  const { researchRepository, researchFigures, researchResults, toolchain } = production;
  let diagrams: ResearchDiagramService | null = null;
  let prose: ResearchProseLintService | null = null;
  lifecycle.provide(context, 'diagram', [researchDiagramCapability], child => {
    diagrams = new ResearchDiagramService(researchRepository);
    registerResearchDiagramCapability(child, diagrams);
    return diagrams;
  }, async () => {
    try { await diagrams?.shutdown(); } finally { diagrams = null; }
  });
  lifecycle.provide(context, 'prose', researchProseCapabilities, child => {
    prose = new ResearchProseLintService(researchRepository, toolchain, options.proseRoot ?? null);
    registerResearchProseCapabilities(child, prose);
    return prose;
  }, async () => {
    try { await prose?.shutdown(); } finally { prose = null; }
  });
  registerResearchCitationCoverageCapability(context, new ResearchCitationCoverageService(researchRepository));
  registerResearchCitationReviewCapabilities(context, researchRepository.citationReviews);
  registerResearchJournalComplianceCapabilities(context,
    new ResearchJournalComplianceService(researchRepository, researchFigures), researchRepository.journalCompliance);
  registerResearchResponseMatrixCapabilities(context, researchRepository.responseMatrix);
  registerResearchConsistencyCapabilities(context, new ResearchConsistencyService(researchRepository, researchResults), researchRepository.consistency);
}
