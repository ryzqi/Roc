import type {ResearchExperimentResultReceipt} from '../../../shared/schemas/research-experiment-results';
import type {ResearchIdeaOutcomeReceipt, ResearchIdeaOutcomeHistoryResult} from '../../../shared/schemas/research-idea-outcomes';
import {assertExperimentMetricEvidence} from './experiment-result-evidence';
import type {ResearchRepository} from './repository';

/** Only exact result references connect an assessment to the manuscript's exported sources. */
export function captureExportIdeaOutcomes(repository: ResearchRepository, projectId: string,
  results: ResearchExperimentResultReceipt[]): ResearchIdeaOutcomeReceipt[] {
  return results.flatMap(result => {
    const current = repository.experimentResults.get({projectId, resultId: result.snapshot.id, expectedHash: result.snapshotHash});
    if (JSON.stringify(current) !== JSON.stringify(result)) throw new Error('research_export_sources_changed');
    return repository.ideaOutcomes.forResult(projectId, result.snapshot.id).map(receipt => {
      const {request, material} = receipt.snapshot;
      const plan = repository.ideaPlans.get({projectId, artifactId: request.artifactId,
        versionId: request.plan.versionId, expectedHash: request.plan.versionHash});
      if (plan.freeze === null || JSON.stringify({version: plan.version, versionHash: plan.versionHash,
        freeze: plan.freeze, freezeHash: plan.freezeHash}) !== JSON.stringify(material.plan) ||
        JSON.stringify(result) !== JSON.stringify(material.result)) throw new Error('research_idea_outcome_material_changed');
      const run = repository.experiments.get(projectId, result.snapshot.execution.runId);
      if (run.status !== 'completed' || run.startedAt !== material.executionTime.startedAt ||
        run.endedAt !== material.executionTime.endedAt) throw new Error('research_idea_outcome_material_changed');
      for (const evidence of material.evidence) {
        const currentEvidence = repository.evidence.getEvidence(evidence.id, projectId);
        if (JSON.stringify(currentEvidence) !== JSON.stringify(evidence)) throw new Error('research_idea_outcome_material_changed');
        const metadata = repository.evidence.sourceMetadata(projectId, evidence.id);
        if (metadata === null) throw new Error('research_result_evidence_changed');
        assertExperimentMetricEvidence(currentEvidence, metadata, result);
      }
      const body = plan.version.request.body;
      const planEvidenceIds = [...body.novelty.comparisons.map(item => item.evidenceId),
        ...(body.observation.kind === 'after_data' ? body.observation.evidenceIds : []),
        ...(body.sampleSize.kind === 'calculated' ? body.sampleSize.evidenceIds : [])];
      for (const evidenceId of planEvidenceIds) repository.evidence.getEvidence(evidenceId, projectId);
      return receipt;
    });
  });
}

export function captureExportIdeaOutcomeHistory(repository: ResearchRepository,
  receipt: ResearchIdeaOutcomeReceipt): ResearchIdeaOutcomeHistoryResult {
  const request = {projectId: receipt.snapshot.request.projectId, artifactId: receipt.snapshot.request.artifactId,
    versionId: receipt.snapshot.request.plan.versionId, offset: 0, limit: 100};
  const history = repository.ideaOutcomes.history(request);
  while (history.items.length < history.total) {
    const page = repository.ideaOutcomes.history({...request, offset: history.items.length});
    history.items.push(...page.items);
  }
  return history;
}
