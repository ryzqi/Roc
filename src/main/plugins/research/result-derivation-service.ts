import {
  researchResultDerivationRequestSchema, researchResultDerivationSchema,
  type ResearchResultDerivationRequest, type ResearchResultDerivation
} from '../../../shared/schemas/research-result-derivation';
import type {ResearchExperimentResultReceipt} from '../../../shared/schemas/research-experiment-results';
import type {ResearchExperimentResultService} from './experiment-result-service';
import type {ResearchRepository} from './repository';
import {experimentMetricSource} from './experiment-result-evidence';
import {calculateConsistency} from './consistency-calculation';
import {relationClaimHash} from './evidence-relation-repository';
import {buildMetricFigureSources} from './metric-figure-source';
import {writeBibliography, type BibliographyEntry} from './bibliography';
import {escapeLatex} from './latex-source';
import {manuscriptBibliographyEntry} from './manuscript-bibliography';
import type {ResearchClaim} from '../../../shared/types';

type Row = ResearchResultDerivation['rows'][number];
type ResultRef = ResearchResultDerivation['result'];
type Manuscript = NonNullable<ResearchResultDerivation['manuscript']>;
const reference = ({snapshot, snapshotHash}: ResearchExperimentResultReceipt): ResultRef => ({
  resultId: snapshot.id, expectedHash: snapshotHash
});

/** Recheck reviewed results before projecting values into editable research materials. */
export class ResearchResultDerivationService {
  constructor(private readonly research: ResearchRepository,
    private readonly results: Pick<ResearchExperimentResultService, 'get' | 'compare'>) {}

  async preview(input: ResearchResultDerivationRequest): Promise<ResearchResultDerivation> {
    const request = researchResultDerivationRequestSchema.parse(input);
    const {projectId, resultId, expectedHash, metricIds, previous} = request;
    const result = {resultId, expectedHash};
    const comparison = previous === undefined ? null : await this.results.compare({projectId, left: previous, right: result});
    const receipt = comparison?.right ?? await this.results.get({projectId, ...result});
    const rows = this.rows(receipt, metricIds);
    const manuscript = this.manuscript(request, receipt, comparison?.left ?? null, rows);
    return researchResultDerivationSchema.parse({
      result, previous: comparison === null ? null : {...reference(comparison.left), differences: comparison.differences},
      execution: receipt.snapshot.execution, methods: methodsDraft(receipt), rows,
      figures: buildMetricFigureSources({...reference(receipt), inputHash: receipt.snapshot.execution.inputHash}, rows), manuscript, responseDraft: this.response(request, rows)
    });
  }

  private rows(receipt: ResearchExperimentResultReceipt, metricIds?: string[]): Row[] {
    const rows: Row[] = [];
    for (const [ordinal, metric] of receipt.snapshot.result.metrics.entries()) {
      if (metricIds !== undefined && !metricIds.includes(metric.id)) continue;
      const definition = receipt.snapshot.request.definitions.find(item => item.id === metric.id);
      if (definition === undefined || definition.unit !== metric.unit) throw new Error('research_result_definition_mismatch');
      rows.push({ordinal, metric, definition, source: experimentMetricSource(receipt, metric.id).metadata,
        evidenceId: this.research.experimentResults.findCapturedMetric(receipt, metric.id)?.id ?? null});
    }
    if (metricIds !== undefined && rows.length !== metricIds.length) throw new Error('research_result_metric_not_found');
    return rows;
  }

  private manuscript(request: ResearchResultDerivationRequest, receipt: ResearchExperimentResultReceipt,
    previous: ResearchExperimentResultReceipt | null, rows: Row[]): Manuscript | null {
    if (request.manuscript === undefined) return null;
    const {projectId, manuscript} = request;
    const {artifactId} = manuscript;
    const inspected = this.research.inspectArtifact({projectId, ...manuscript});
    if (inspected.status !== 'current') throw new Error('research_result_derivation_manuscript_changed');
    const bundle = this.research.manuscripts.inspectBundle({projectId, artifactId});
    const preview: Manuscript = {...manuscript, changes: [], paragraphs: [], bibliography: '', issues: []};
    if (previous === null || previous.snapshot.id === receipt.snapshot.id) return preview;
    const reviewed = this.research.consistency.latest(projectId, artifactId);
    for (const binding of reviewed?.snapshot.request.bindings ?? []) {
      if (binding.resultId !== previous.snapshot.id || binding.resultHash !== previous.snapshotHash) continue;
      const row = rows.find(item => item.metric.id === binding.metricId);
      if (row === undefined) continue;
      const {claimId, metricId} = binding;
      const issue = (reason: Manuscript['issues'][number]['reason']) => preview.issues.push({metricId, claimId, reason});
      const definition = previous.snapshot.request.definitions.find(item => item.id === metricId);
      if (definition?.unit !== row.definition.unit || definition.definition !== row.definition.definition ||
          definition.direction !== row.definition.direction) {
        issue('definition_changed');
        continue;
      }
      const claim = bundle.claims.find(item => item.id === claimId);
      if (claim === undefined || relationClaimHash(claim) !== binding.expectedClaimHash) {
        issue('location_changed');
        continue;
      }
      const oldEvidence = this.research.experimentResults.findCapturedMetric(previous, metricId);
      if (oldEvidence?.id !== binding.evidenceId || !claim.evidenceIds.includes(binding.evidenceId)) {
        issue('source_changed');
        continue;
      }
      try {
        const calculated = calculateConsistency(binding, claim.content, receipt);
        preview.changes.push({binding, before: calculated.observedText, after: calculated.expectedText,
          result: reference(receipt), evidenceId: row.evidenceId});
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'research_consistency_calculation_range') throw error;
        issue('unrepresentable_value');
      }
    }
    this.projectParagraphs(projectId, bundle.claims, preview);
    return preview;
  }

  private projectParagraphs(projectId: string, claims: ResearchClaim[], preview: Manuscript): void {
    const entries = new Map<string, BibliographyEntry>();
    const entry = (id: string) => manuscriptBibliographyEntry(this.research.evidence.getEvidence(id, projectId), this.research.library);
    for (const claim of claims) {
      const changes = preview.changes.filter(change => change.binding.claimId === claim.id)
        .sort((left, right) => right.binding.start - left.binding.start);
      if (changes.length === 0) continue;
      const {id: claimId, content: before} = claim;
      let after = before;
      for (const {binding, after: value} of changes) after = after.slice(0, binding.start) + value + after.slice(binding.end);
      const paragraph: Manuscript['paragraphs'][number] = {claimId, expectedClaimHash: relationClaimHash(claim), before, after, replacement: null};
      const replacements = changes.flatMap(change => change.evidenceId === null ? [] : [[change.binding.evidenceId, change.evidenceId] as const]);
      if (changes.length === replacements.length) {
        const linked = new Map(replacements);
        const evidenceIds = [...new Set(claim.evidenceIds.map(id => linked.get(id) ?? id))];
        const citationKeys = [...new Set(evidenceIds.map(id => entry(id).citationKey))];
        for (const id of linked.values()) entries.set(id, entry(id));
        paragraph.replacement = {latex: `${escapeLatex(after)}\\cite{${citationKeys.join(',')}}`, evidenceIds, citationKeys};
      }
      preview.paragraphs.push(paragraph);
    }
    if (entries.size > 0) preview.bibliography = writeBibliography([...entries.values()], 'bibtex');
  }

  private response(request: ResearchResultDerivationRequest, rows: Row[]): ResearchResultDerivation['responseDraft'] {
    if (request.commentId === undefined) return null;
    const review = this.research.responseMatrix.latest(request.projectId, request.manuscript!.artifactId);
    const row = review?.snapshot.request.rows.find(item => item.commentId === request.commentId);
    if (review === null || row === undefined) throw new Error('research_result_derivation_comment_not_found');
    const values = rows.map(({definition, metric}) => `${definition.label}: ${metric.value} ${metric.unit} (n=${metric.sampleSize})`).join('、');
    return {reviewId: review.snapshot.id, reviewHash: review.snapshotHash,
      row: {...row, status: 'open', locations: [], evidenceIds: [...new Set(rows.flatMap(item => item.evidenceId ?? []))].slice(0, 50),
        response: `感谢审阅。本次实验记录的指标为 ${values.slice(0, 10000)}。`}};
  }
}

function methodsDraft(receipt: ResearchExperimentResultReceipt): string {
  const {execution, request} = receipt.snapshot;
  const seed = execution.seed === null ? '' : `。运行记录的种子为 ${execution.seed}`;
  return [
    `方法：${request.method.name}。${request.method.rationale}`,
    `实际执行使用 ${execution.engine}，从 ${execution.source.path} 运行，读取 ${execution.inputs.length} 个冻结输入文件并写入 ${execution.output.path}${seed}。`,
    `假设：${request.method.assumptions}。局限：${request.method.limitations}`
  ].join('\n');
}
