import {
  researchFigureConsistencySaveSchema, researchFigureConsistencyInspectSchema, researchFigureConsistencyInspectionSchema,
  type ResearchFigureConsistencySave, type ResearchFigureConsistencyReceipt, type ResearchFigureConsistencyInspect,
  type ResearchFigureConsistencyInspection, type ResearchFigureConsistencyMaterial
} from '../../../shared/schemas/research-figure-consistency';
import {researchFigureDataPath, researchFigureDataTraceSchema, researchFigureDataFileSchema} from '../../../shared/schemas/research-figure-data';
import {requireResearchHuman} from '../../services/research-human-context';
import {relationClaimHash} from './evidence-relation-repository';
import {researchContentHash} from './research-files';
import {calculateConsistencyValue} from './consistency-calculation';
import {figureDataLocation, selectFigureData} from './figure-consistency-material';
import type {ResearchRepository} from './repository';
import type {ResearchFigureService} from './figure-service';
import type {ResearchExperimentResultService} from './experiment-result-service';

export class ResearchFigureConsistencyService {
  constructor(private readonly research: ResearchRepository, private readonly figures: Pick<ResearchFigureService, 'verify' | 'readRunFile'>,
    private readonly results: Pick<ResearchExperimentResultService, 'evidence'>) {}
  private async source(projectId: string, artifactId: string) {
    this.research.figureConsistency.scope(projectId, artifactId);
    const figure = this.research.figures.forArtifact(this.research.getArtifact(artifactId));
    await this.figures.verify(projectId, figure.id);
    const run = this.research.figureRuns.get(projectId, figure.runId);
    const file = run.files.find(file => file.area === 'output' && file.path === researchFigureDataPath);
    if (file === undefined) throw new Error('research_figure_data_trace_required');
    const {bytes} = await this.figures.readRunFile({projectId, runId: run.id, area: 'output', path: file.path});
    const trace = researchFigureDataTraceSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (researchContentHash(JSON.stringify(trace)) !== file.sha256 || trace.rendererHash !== figure.validation.rendererHash ||
      !run.files.some(entry => entry.area === 'input' && entry.path === run.request.sourcePath && entry.sha256 === trace.sourceHash)) {
      throw new Error('research_figure_consistency_source_changed');
    }
    const {area: _area, ...traceFile} = file;
    const reference = {file: researchFigureDataFileSchema.parse(traceFile), sourceHash: trace.sourceHash,
      rendererHash: trace.rendererHash, compiledSpecHash: trace.compiledSpecHash};
    return {figure, run, trace, reference};
  }
  async save(input: ResearchFigureConsistencySave): Promise<ResearchFigureConsistencyReceipt> {
    const request = researchFigureConsistencySaveSchema.parse(input);
    requireResearchHuman('research.figureConsistency.save', request.projectId);
    const source = await this.source(request.projectId, request.artifactId);
    if (source.figure.id !== request.figure.id || source.figure.manifestHash !== request.figure.manifestHash ||
      source.reference.file.sha256 !== request.figure.traceHash) throw new Error('research_figure_consistency_source_changed');
    const material: ResearchFigureConsistencyMaterial = {figure: source.figure, run: source.run, trace: source.reference, mappings: []};
    for (const binding of request.bindings) {
      const selected = selectFigureData(source.trace, binding), {items: _items, ...mark} = selected.mark;
      const claim = this.research.evidence.getClaim(binding.claimId);
      if (claim.projectId !== request.projectId || claim.artifactId !== request.artifactId || claim.subjectType !== 'figure') {
        throw new Error('research_figure_consistency_project_mismatch');
      }
      if (relationClaimHash(claim) !== binding.expectedClaimHash) throw new Error('research_consistency_claim_changed');
      if (!claim.evidenceIds.includes(binding.evidenceId)) throw new Error('research_consistency_evidence_required');
      const result = await this.results.evidence({projectId: request.projectId, evidenceId: binding.evidenceId});
      if (result === null || result.metricId !== binding.metricId || result.receipt.snapshot.id !== binding.resultId ||
        result.receipt.snapshotHash !== binding.resultHash) throw new Error('research_consistency_metric_invalid');
      material.mappings.push({mark, item: selected.item, claim,
        evidence: this.research.evidence.getEvidence(binding.evidenceId, request.projectId),
        result: result.receipt, calculation: calculateConsistencyValue(binding, String(selected.value), result.receipt)});
    }
    const current = await this.source(request.projectId, request.artifactId);
    if (JSON.stringify(current.reference) !== JSON.stringify(source.reference) || JSON.stringify(current.figure) !== JSON.stringify(source.figure)) {
      throw new Error('research_figure_consistency_source_changed');
    }
    return this.research.figureConsistency.save(request, material, current.trace);
  }
  async inspect(input: ResearchFigureConsistencyInspect): Promise<ResearchFigureConsistencyInspection> {
    const request = researchFigureConsistencyInspectSchema.parse(input);
    const {snapshot, readAt} = this.research.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId, expectedVersion: null});
    const source = await this.source(request.projectId, request.artifactId);
    const review = this.research.figureConsistency.latest(request.projectId, request.artifactId);
    const locations: ResearchFigureConsistencyInspection['report']['locations'] = [];
    if (review !== null) {
      if (JSON.stringify(review.snapshot.material.trace) !== JSON.stringify(source.reference) ||
        review.snapshot.request.figure.manifestHash !== source.figure.manifestHash) throw new Error('research_figure_consistency_source_changed');
      for (let index = 0; index < review.snapshot.request.bindings.length; index++) {
        const binding = review.snapshot.request.bindings[index], material = review.snapshot.material.mappings[index];
        const claim = snapshot.claims.find(item => item.id === binding.claimId);
        const evidence = this.research.evidence.inspectEvidence(binding.evidenceId, request.projectId);
        if (evidence.referenceStatus !== 'recorded' || JSON.stringify(evidence.evidence) !== JSON.stringify(material.evidence)) {
          throw new Error('research_consistency_source_changed');
        }
        const result = await this.results.evidence({projectId: request.projectId, evidenceId: binding.evidenceId});
        if (result === null || result.metricId !== binding.metricId || result.receipt.snapshot.id !== binding.resultId ||
          result.receipt.snapshotHash !== binding.resultHash || JSON.stringify(result.receipt) !== JSON.stringify(material.result)) {
          throw new Error('research_consistency_source_changed');
        }
        selectFigureData(source.trace, binding);
        locations.push({binding, calculation: material.calculation,
          current: claim !== undefined && relationClaimHash(claim) === binding.expectedClaimHash && claim.evidenceIds.includes(binding.evidenceId)});
      }
    }
    const selected = request.page.markName === null ? null : source.trace.marks.find(mark => mark.name === request.page.markName);
    if (selected === undefined) throw new Error('research_figure_consistency_mark_not_found');
    let numericLocations = 0;
    for (const mark of source.trace.marks) for (const item of mark.items) {
      for (const field of Object.values(mark.directFields)) if (Object.hasOwn(item.numericFields, field)) numericLocations++;
    }
    const mapped = new Set(locations.filter(item => item.current).map(item => figureDataLocation(item.binding)));
    const current = await this.source(request.projectId, request.artifactId);
    const currentSnapshot = this.research.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId, expectedVersion: null});
    if (JSON.stringify(current.reference) !== JSON.stringify(source.reference) || JSON.stringify(current.figure) !== JSON.stringify(source.figure)) {
      throw new Error('research_figure_consistency_source_changed');
    }
    if (currentSnapshot.snapshot.version !== snapshot.version) throw new Error('research_consistency_artifact_changed');
    const report = {projectId: request.projectId, artifactId: request.artifactId, artifactVersion: snapshot.version,
      figure: source.figure, trace: source.reference,
      marks: source.trace.marks.map(({items, ...mark}) => ({...mark, itemCount: items.length})),
      page: request.page, items: selected === null ? [] : selected.items.slice(request.page.offset, request.page.offset + request.page.limit),
      total: selected === null ? 0 : selected.items.length, review, locations,
      counts: {numericLocations, unmapped: numericLocations - mapped.size,
        consistent: locations.filter(item => item.current && item.calculation.consistent).length,
        inconsistent: locations.filter(item => item.current && !item.calculation.consistent).length,
        changed: locations.filter(item => !item.current).length}};
    const reportHash = researchContentHash(JSON.stringify(report));
    return researchFigureConsistencyInspectionSchema.parse({
      status: request.expectedHash === null || request.expectedHash === reportHash ? 'current' : 'stale', report, reportHash, readAt
    });
  }
}
