import {
  researchConsistencySaveSchema, researchConsistencyInspectSchema, researchConsistencyInspectionSchema,
  type ResearchConsistencySave, type ResearchConsistencyReceipt, type ResearchConsistencyInspect, type ResearchConsistencyInspection
} from '../../../shared/schemas/research-consistency';
import {requireResearchHuman} from '../../services/research-human-context';
import {relationClaimHash} from './evidence-relation-repository';
import {researchContentHash} from './research-files';
import {calculateConsistency, consistencyNumericLocations} from './consistency-calculation';
import type {ResearchRepository} from './repository';
import type {ResearchExperimentResultService} from './experiment-result-service';

export class ResearchConsistencyService {
  constructor(private readonly research: ResearchRepository, private readonly results: Pick<ResearchExperimentResultService, 'evidence'>) {}
  async save(input: ResearchConsistencySave): Promise<ResearchConsistencyReceipt> {
    const request = researchConsistencySaveSchema.parse(input);
    requireResearchHuman('research.consistency.save', request.projectId);
    this.research.consistency.scope(request.projectId, request.artifactId);
    const material: ResearchConsistencyReceipt['snapshot']['material'] = [];
    for (const binding of request.bindings) {
      const claim = this.research.evidence.getClaim(binding.claimId);
      if (claim.projectId !== request.projectId || claim.artifactId !== request.artifactId) throw new Error('research_consistency_project_mismatch');
      if (relationClaimHash(claim) !== binding.expectedClaimHash) throw new Error('research_consistency_claim_changed');
      if (!claim.evidenceIds.includes(binding.evidenceId)) throw new Error('research_consistency_evidence_required');
      if (this.research.getArtifact(request.artifactId).kind === 'manuscript') {
        const bundle = this.research.manuscripts.inspectBundle(request);
        if (!bundle.claims.some(item => item.id === claim.id)) throw new Error('research_consistency_claim_required');
      }
      const trace = await this.results.evidence({projectId: request.projectId, evidenceId: binding.evidenceId});
      if (trace === null || trace.metricId !== binding.metricId || trace.receipt.snapshot.id !== binding.resultId ||
        trace.receipt.snapshotHash !== binding.resultHash) throw new Error('research_consistency_metric_invalid');
      material.push({claim, evidence: this.research.evidence.getEvidence(binding.evidenceId, request.projectId),
        result: trace.receipt, calculation: calculateConsistency(binding, claim.content, trace.receipt)});
    }
    return this.research.consistency.save(request, material);
  }
  async inspect(input: ResearchConsistencyInspect): Promise<ResearchConsistencyInspection> {
    const request = researchConsistencyInspectSchema.parse(input);
    const {snapshot, readAt} = this.research.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId, expectedVersion: null});
    const review = this.research.consistency.latest(request.projectId, request.artifactId);
    const locations: ResearchConsistencyInspection['report']['locations'] = [];
    if (review !== null) {
      for (let index = 0; index < review.snapshot.request.bindings.length; index++) {
        const binding = review.snapshot.request.bindings[index], material = review.snapshot.material[index];
        const claim = snapshot.claims.find(item => item.id === binding.claimId);
        const source = this.research.evidence.inspectEvidence(binding.evidenceId, request.projectId);
        if (source.referenceStatus !== 'recorded' || JSON.stringify(source.evidence) !== JSON.stringify(material.evidence)) {
          throw new Error('research_consistency_source_changed');
        }
        const trace = await this.results.evidence({projectId: request.projectId, evidenceId: binding.evidenceId});
        if (trace === null || trace.metricId !== binding.metricId || trace.receipt.snapshotHash !== binding.resultHash) {
          throw new Error('research_consistency_source_changed');
        }
        locations.push({binding, calculation: material.calculation,
          current: claim !== undefined && relationClaimHash(claim) === binding.expectedClaimHash &&
            claim.evidenceIds.includes(binding.evidenceId)});
      }
    }
    const mapped = new Set(locations.filter(item => item.current).map(({binding}) => `${binding.claimId}:${binding.start}:${binding.end}`));
    const unmappedLocations = snapshot.claims.flatMap(claim => consistencyNumericLocations(claim.content)
      .filter(token => !mapped.has(`${claim.id}:${token.start}:${token.end}`)).map(token => ({claimId: claim.id, ...token})));
    const unmappedClaimIds = [...new Set(unmappedLocations.map(item => item.claimId))];
    const current = this.research.inspectArtifact({projectId: request.projectId, artifactId: request.artifactId, expectedVersion: null});
    if (current.snapshot.version !== snapshot.version) throw new Error('research_consistency_artifact_changed');
    const report = {schemaVersion: 1 as const, projectId: request.projectId, artifactId: request.artifactId,
      artifactVersion: snapshot.version, review, locations, unmappedClaimIds, unmappedLocations,
      counts: {mapped: locations.length, consistent: locations.filter(item => item.current && item.calculation.consistent).length,
        inconsistent: locations.filter(item => item.current && !item.calculation.consistent).length,
        changed: locations.filter(item => !item.current).length, unmappedClaims: unmappedClaimIds.length, unmappedValues: unmappedLocations.length}};
    const reportHash = researchContentHash(JSON.stringify(report));
    return researchConsistencyInspectionSchema.parse({status: request.expectedHash === null || request.expectedHash === reportHash ? 'current' : 'stale',
      report, reportHash, readAt});
  }
}
