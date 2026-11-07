import {
  scientificReviewInputSchema, scientificReviewInspectionSchema, scientificReviewRulesVersion,
  type ScientificReviewInput, type ScientificReviewOutput, type ScientificReviewInspection,
  type ScientificEvidenceReference
} from '../../../../shared/schemas/research-scientific-review';
import type {ResearchStageRun} from '../../../../shared/types';
import type {ResearchRepository} from '../repository';
import {researchContentHash} from '../research-files';
import {relationClaimHash, relationSourceDigest} from '../evidence-relation-repository';
import type {ResearchResponseMatrixSave} from '../../../../shared/schemas/research-response-matrix';
import {researchSkills} from '../research-skills';

export const scientificReviewHash = (value: unknown): string => researchContentHash(JSON.stringify(value));

/** Review records live in the existing immutable role output and frozen execution context. */
export class ResearchScientificReviewService {
  constructor(private readonly repository: ResearchRepository) {}

  capture(projectId: string, artifactId: string): ScientificReviewInput {
    const {manuscript, claims} = this.repository.manuscripts.inspectBundle({projectId, artifactId});
    return scientificReviewInputSchema.parse({schemaVersion: 1, rulesVersion: scientificReviewRulesVersion,
      projectId, manuscript, claims,
      evidence: this.repository.evidence.list(projectId).map(source => this.repository.evidence.inspectEvidence(source.id, projectId)),
      relations: this.repository.evidence.relations.forArtifact(artifactId, projectId)});
  }

  staleReasons(input: ScientificReviewInput): string[] {
    const reasons: string[] = [];
    if (input.rulesVersion !== scientificReviewRulesVersion) reasons.push('rules_changed');
    const cycle = this.repository.reviews.get(input.projectId);
    if (cycle !== null && cycle.manuscriptArtifactId !== input.manuscript.artifactId) reasons.push('manuscript_replaced');
    const manuscript = this.repository.manuscripts.getManuscript(input.manuscript.artifactId);
    const claims = this.repository.evidence.listClaims({projectId: input.projectId, artifactId: input.manuscript.artifactId});
    const selected = input.manuscript.sections.flatMap(section => section.claimIds)
      .map(id => claims.find(claim => claim.id === id));
    if (scientificReviewHash(manuscript) !== scientificReviewHash(input.manuscript) ||
        scientificReviewHash(selected) !== scientificReviewHash(input.claims)) reasons.push('manuscript_or_claim_changed');
    const sources = this.repository.evidence.list(input.projectId)
      .map(source => this.repository.evidence.inspectEvidence(source.id, input.projectId));
    if (scientificReviewHash(sources) !== scientificReviewHash(input.evidence)) reasons.push('evidence_or_source_changed');
    if (scientificReviewHash(this.repository.evidence.relations.forArtifact(input.manuscript.artifactId, input.projectId)) !==
        scientificReviewHash(input.relations)) reasons.push('human_relation_changed');
    return reasons;
  }

  assertCurrent(input: ScientificReviewInput): void {
    if (this.staleReasons(input).length > 0) throw new Error('research_scientific_review_stale');
  }

  /** Follow actual revision inputs, so a new draft cannot silently lose old findings. */
  reportsForManuscript(projectId: string, artifactId: string): ScientificReviewInspection[] {
    const manuscripts = new Set<string>();
    const inheritedReports = new Set<string>();
    const visit = (id: string) => {
      if (manuscripts.has(id)) return;
      if (manuscripts.size >= 10) throw new Error('research_revision_lineage_invalid');
      const artifact = this.repository.getArtifact(id);
      if (artifact.projectId !== projectId || artifact.kind !== 'manuscript') throw new Error('research_revision_lineage_invalid');
      manuscripts.add(id);
      const content = this.repository.runs.getArtifactContent(projectId, id);
      if (content === null) return;
      const run = this.repository.runs.get(content.runId, projectId);
      if (run.stage !== 'revision') return;
      for (const input of this.repository.runs.getContext(run.id).inputs) {
        if (input.artifact.kind === 'manuscript') visit(input.artifact.id);
        if (input.artifact.kind === 'review_report') inheritedReports.add(input.artifact.id);
      }
    };
    visit(artifactId);
    return this.repository.listArtifacts(projectId, 'review').flatMap(artifact => {
      const content = this.repository.runs.getArtifactContent(projectId, artifact.id);
      if (content?.output.scientificReview === undefined) return [];
      const run = this.repository.runs.get(content.runId, projectId);
      const input = this.repository.runs.getContext(run.id).scientificInput;
      if (input === undefined || run.status !== 'completed' ||
          !(inheritedReports.has(artifact.id) || (input.manuscript.artifactId === artifactId && artifact.status !== 'superseded'))) return [];
      return [this.inspect(projectId, artifact.id)];
    });
  }

  findingRowsIssue(projectId: string, manuscriptArtifactId: string, rows: ResearchResponseMatrixSave['rows'],
    reports = this.reportsForManuscript(projectId, manuscriptArtifactId)): string | null {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.finding === undefined) continue;
      const link = row.finding;
      const key = `${link.artifactId}:${link.findingId}`;
      const report = reports.find(report => report.artifactId === link.artifactId && report.reportHash === link.reportHash);
      const finding = report?.output.kind === 'reviewer' ? report.output.findings.find(finding => finding.id === link.findingId) : undefined;
      if (seen.has(key) || report === undefined || finding === undefined || row.reviewer !== report.producer.role || row.comment !== finding.observation) {
        return 'research_response_finding_invalid';
      }
      seen.add(key);
      if (row.status === 'addressed' || link.reverification !== null) {
        const verified = reports.find(report => report.artifactId === link.reverification?.artifactId && report.reportHash === link.reverification.reportHash);
        if (verified === undefined || verified.status !== 'current' || verified.manuscriptArtifactId !== manuscriptArtifactId ||
            verified.output.kind !== 'verifier') return 'research_response_reverification_required';
        const verifiedClaimIds = new Set(verified.output.suggestions.map(suggestion => suggestion.claimId));
        if (row.locations.length === 0 || row.locations.some(location => !verifiedClaimIds.has(location.claimId))) {
          return 'research_response_reverification_location_invalid';
        }
      }
    }
    return null;
  }

  requireFindingDispositions(projectId: string, manuscriptArtifactId: string): void {
    const reports = this.reportsForManuscript(projectId, manuscriptArtifactId);
    const required = reports.flatMap(report => report.output.kind === 'reviewer'
      ? report.output.findings.map(finding => ({artifactId: report.artifactId, reportHash: report.reportHash, findingId: finding.id})) : []);
    if (required.length === 0) return;
    const receipt = this.repository.responseMatrix.latest(projectId, manuscriptArtifactId);
    if (receipt === null) throw new Error('research_response_findings_unhandled');
    this.repository.responseMatrix.assertReceiptCurrent(receipt);
    if (required.some(finding => !receipt.snapshot.request.rows.some(row => row.status !== 'open' &&
      row.finding?.artifactId === finding.artifactId && row.finding.reportHash === finding.reportHash && row.finding.findingId === finding.findingId))) {
      throw new Error('research_response_findings_unhandled');
    }
  }

  validate(run: ResearchStageRun, input: ScientificReviewInput, output: ScientificReviewOutput): void {
    if (run.stage !== 'review' || run.parentRunId === null || input.projectId !== run.projectId ||
        output.inputHash !== scientificReviewHash(input) ||
        (run.role === 'evidence-reviewer' ? output.kind !== 'verifier' : output.kind !== 'reviewer')) {
      throw new Error('research_scientific_review_binding_invalid');
    }
    const claimIds = input.claims.map(claim => claim.id);
    const assertReferences = (references: ScientificEvidenceReference[]) => {
      for (const reference of references) {
        const source = input.evidence.find(source => source.evidence.id === reference.evidenceId);
        if (source === undefined || source.referenceStatus !== 'recorded' ||
            reference.sourceDigest !== relationSourceDigest(source) || reference.end > source.evidence.excerpt.length ||
            source.evidence.excerpt.slice(reference.start, reference.end) !== reference.quote) {
          throw new Error('research_scientific_locator_invalid');
        }
      }
    };
    if (output.kind === 'verifier') {
      if (output.suggestions.length !== claimIds.length || new Set(output.suggestions.map(item => item.claimId)).size !== claimIds.length) {
        throw new Error('research_scientific_claim_coverage_required');
      }
      for (const suggestion of output.suggestions) {
        const claim = input.claims.find(claim => claim.id === suggestion.claimId);
        if (claim === undefined || claim.version !== suggestion.claimVersion || relationClaimHash(claim) !== suggestion.claimHash) {
          throw new Error('research_scientific_claim_changed');
        }
        const examined = suggestion.coverage.examinedEvidenceIds;
        if (new Set(examined).size !== examined.length || examined.some(id => !input.evidence.some(source => source.evidence.id === id)) ||
            (examined.length !== input.evidence.length && suggestion.coverage.unexaminedReason === null)) {
          throw new Error('research_scientific_search_coverage_required');
        }
        const references = [...suggestion.supporting, ...suggestion.counterevidence, ...suggestion.negativeResults,
          ...suggestion.conditions.flatMap(item => item.references), ...suggestion.alternativeExplanations.flatMap(item => item.references)];
        assertReferences(references);
        if (references.some(reference => !examined.includes(reference.evidenceId))) throw new Error('research_scientific_search_coverage_required');
        const contradictions = input.relations.filter(relation => relation.claimId === claim.id && relation.kind === 'contradicts' &&
          ['proposed', 'confirmed'].includes(relation.status) && relation.source.referenceStatus === 'recorded');
        if (contradictions.some(relation => !suggestion.counterevidence.some(reference => reference.evidenceId === relation.evidenceId))) {
          throw new Error('research_scientific_counterevidence_required');
        }
      }
    } else {
      if (new Set(output.coveredClaimIds).size !== claimIds.length || output.coveredClaimIds.length !== claimIds.length ||
          output.coveredClaimIds.some(id => !claimIds.includes(id)) ||
          (output.findings.length === 0 && output.noFindingsRationale === null) ||
          new Set(output.findings.map(finding => finding.id)).size !== output.findings.length) {
        throw new Error('research_scientific_finding_coverage_required');
      }
      for (const finding of output.findings) {
        if (new Set(finding.claimIds).size !== finding.claimIds.length || finding.claimIds.some(id => !claimIds.includes(id))) {
          throw new Error('research_scientific_claim_changed');
        }
        assertReferences(finding.references);
      }
    }
  }

  inspect(projectId: string, artifactId: string): ScientificReviewInspection {
    const content = this.repository.runs.getArtifactContent(projectId, artifactId);
    if (content?.output.scientificReview === undefined) throw new Error('research_scientific_review_required');
    const run = this.repository.runs.get(content.runId, projectId);
    const context = this.repository.runs.getContext(run.id);
    const input = context.scientificInput;
    if (input === undefined || run.status !== 'completed' || run.taskId === null || run.providerId === null || run.modelId === null) {
      throw new Error('research_scientific_review_binding_invalid');
    }
    const output = content.output.scientificReview;
    this.validate(run, input, output);
    const producer = {taskId: run.taskId, runId: run.id, role: run.role, providerId: run.providerId,
      modelId: run.modelId, modelVersion: run.modelVersion, skillHash: run.skillHash};
    const reasons = this.staleReasons(input);
    if (scientificReviewHash(context.skillPin) !== scientificReviewHash(researchSkills.load('review').pin)) reasons.push('skill_changed');
    return scientificReviewInspectionSchema.parse({schemaVersion: 1, status: reasons.length === 0 ? 'current' : 'stale', reasons,
      authority: 'model_suggestion_requires_human_review', artifactId, manuscriptArtifactId: input.manuscript.artifactId,
      inputHash: scientificReviewHash(input), reportHash: scientificReviewHash({input, output, producer}),
      rulesVersion: input.rulesVersion, producer, input, output});
  }
}
