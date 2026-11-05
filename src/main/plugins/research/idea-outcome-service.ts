import {
  researchIdeaOutcomeSaveSchema, researchIdeaOutcomeGetSchema,
  type ResearchIdeaOutcomeSave, type ResearchIdeaOutcomeGet, type ResearchIdeaOutcomeMaterial, type ResearchIdeaOutcomeReceipt
} from '../../../shared/schemas/research-idea-outcomes';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ResearchRepository} from './repository';
import type {ResearchExperimentResultService} from './experiment-result-service';

export class ResearchIdeaOutcomeService {
  constructor(private readonly research: ResearchRepository, private readonly results: ResearchExperimentResultService) {}

  async save(input: ResearchIdeaOutcomeSave): Promise<ResearchIdeaOutcomeReceipt> {
    const request = researchIdeaOutcomeSaveSchema.parse(input);
    requireResearchHuman('research.ideaOutcomes.save', request.projectId);
    if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
    const material = await this.material(request);
    return this.research.ideaOutcomes.save(request, material);
  }
  async get(input: ResearchIdeaOutcomeGet): Promise<ResearchIdeaOutcomeReceipt> {
    const request = researchIdeaOutcomeGetSchema.parse(input), receipt = this.research.ideaOutcomes.get(request);
    const material = await this.material(receipt.snapshot.request);
    if (JSON.stringify(material) !== JSON.stringify(receipt.snapshot.material)) throw new Error('research_idea_outcome_material_changed');
    return receipt;
  }
  private async material(request: ResearchIdeaOutcomeSave): Promise<ResearchIdeaOutcomeMaterial> {
    const plan = this.research.ideaPlans.get({projectId: request.projectId, artifactId: request.artifactId,
      versionId: request.plan.versionId, expectedHash: request.plan.versionHash});
    if (plan.freeze === null || plan.freezeHash !== request.plan.freezeHash) throw new Error('research_idea_outcome_frozen_plan_required');
    const metrics = plan.version.request.body.metrics;
    if (request.metrics.length !== metrics.length || request.metrics.some(mapping => !metrics.some(metric => metric.id === mapping.plannedMetricId))) {
      throw new Error('research_idea_outcome_metric_mapping_invalid');
    }
    const result = await this.results.get({projectId: request.projectId, ...request.result});
    const run = this.research.experiments.get(request.projectId, result.snapshot.execution.runId);
    if (run.status !== 'completed' || run.startedAt === null || run.endedAt === null) throw new Error('research_idea_outcome_material_changed');
    const evidence: ResearchIdeaOutcomeMaterial['evidence'] = [], differences: ResearchIdeaOutcomeMaterial['differences'] = [];
    for (const metric of metrics) {
      const mapping = request.metrics.find(item => item.plannedMetricId === metric.id)!;
      if (mapping.kind === 'missing') {
        differences.push({plannedMetricId: metric.id, fields: ['missing_metric']});
        continue;
      }
      const source = this.research.evidence.getEvidence(mapping.evidenceId, request.projectId);
      const trace = await this.results.evidence({projectId: request.projectId, evidenceId: mapping.evidenceId});
      if (trace === null || trace.receipt.snapshot.id !== result.snapshot.id || trace.receipt.snapshotHash !== result.snapshotHash) {
        throw new Error('research_idea_outcome_result_evidence_required');
      }
      const definition = result.snapshot.request.definitions.find(item => item.id === trace.metricId);
      if (definition === undefined) throw new Error('research_idea_outcome_result_evidence_required');
      const fields = (['definition', 'unit', 'direction'] as const).filter(field => metric[field] !== definition[field]);
      if (fields.length > 0) differences.push({plannedMetricId: metric.id, fields});
      evidence.push(source);
    }
    if ((differences.length > 0) !== (request.verdict === 'not_comparable')) throw new Error('research_idea_outcome_comparability_conflict');
    return {plan: {version: plan.version, versionHash: plan.versionHash, freeze: plan.freeze, freezeHash: plan.freezeHash},
      result, executionTime: {startedAt: run.startedAt, endedAt: run.endedAt}, evidence, differences};
  }
}
