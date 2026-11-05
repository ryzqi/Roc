import {
  researchCitationCoverageRequestSchema, researchCitationCoverageBodySchema,
  researchCitationCoverageInspectionSchema,
  type ResearchCitationCoverageRequest, type ResearchCitationCoverageBody,
  type ResearchCitationCoverageInspection
} from '../../../shared/schemas/research-citation-coverage';
import {relationClaimHash, relationSourceDigest} from './evidence-relation-repository';
import {researchContentHash} from './research-files';
import type {ResearchRepository} from './repository';

/** Inspect registered paragraphs and citations; human relations remain the authority for support. */
export class ResearchCitationCoverageService {
  constructor(private readonly repository: ResearchRepository) {}

  inspect(input: ResearchCitationCoverageRequest): ResearchCitationCoverageInspection {
    const request = researchCitationCoverageRequestSchema.parse(input);
    const bundle = this.repository.manuscripts.inspectBundle({projectId: request.projectId, artifactId: request.artifactId});
    const {snapshot, readAt} = this.repository.inspectArtifact({
      projectId: request.projectId, artifactId: request.artifactId, expectedVersion: null
    });
    const sources: ResearchCitationCoverageBody['sources'] = bundle.evidence.map(evidence => {
      const source = this.repository.evidence.inspectEvidence(evidence.id, request.projectId);
      const locations = source.sourceLocator?.locations;
      const libraryItemId = source.sourceLocator !== null ?
        this.repository.documents.get(source.sourceLocator.documentId).libraryItemId :
        evidence.sourceType === 'literature' ? evidence.sourceId : null;
      const item = libraryItemId === null ? null : this.repository.library.get(libraryItemId);
      return {
        source, manuscriptCitationKey: evidence.id,
        locationLevel: locations === undefined || locations.length === 0 ? 'locator' :
          locations.some(location => location.bbox !== null) ? 'region' : 'page',
        bibliography: item === null ? null : {
          itemId: item.id, revision: item.revision, archived: item.archived, entry: item.bibliography
        }
      };
    });
    const bySource = new Map(sources.map(source => [source.source.evidence.id, source]));
    const byClaim = new Map(bundle.claims.map(claim => [claim.id, claim]));
    const directnessReviews = this.repository.citationReviews.forArtifact(request.projectId, request.artifactId);
    const paragraphs: ResearchCitationCoverageBody['paragraphs'] = bundle.manuscript.sections.flatMap((section, sectionIndex) =>
      section.claimIds.map((claimId, paragraphIndex) => {
        const claim = byClaim.get(claimId);
        if (claim === undefined) throw new Error('research_claim_not_found');
        const relations = snapshot.relations.filter(relation => relation.claimId === claim.id);
        const issues: ResearchCitationCoverageBody['paragraphs'][number]['issues'] = [];
        if (claim.subjectType === 'figure') issues.push({kind: 'figure_claim_in_body', subjectId: claim.id});
        const currentRelations = relations.filter(relation => {
          if (relation.status !== 'confirmed') return false;
          const source = this.repository.evidence.inspectEvidence(relation.evidenceId, request.projectId);
          if (relation.claimHash !== relationClaimHash(claim) || relation.claimVersion !== claim.version ||
              relation.sourceDigest !== relationSourceDigest(source) || source.referenceStatus !== 'recorded') {
            issues.push({kind: 'changed_relation', subjectId: relation.id});
            return false;
          }
          if (relation.kind === 'contradicts') issues.push({kind: 'confirmed_contradiction', subjectId: relation.id});
          return true;
        });
        const citations = claim.evidenceIds.map(evidenceId => {
          const source = bySource.get(evidenceId);
          if (source === undefined) throw new Error('research_evidence_not_found');
          if (source.bibliography?.archived === true) issues.push({kind: 'archived_bibliography', subjectId: evidenceId});
          const supporting = currentRelations.filter(relation =>
            relation.evidenceId === evidenceId && (relation.kind === 'supports' || relation.kind === 'qualifies'));
          const supportReview: ResearchCitationCoverageBody['paragraphs'][number]['citations'][number]['supportReview'] =
            supporting.some(relation => relation.kind === 'supports') ? 'confirmed' :
            supporting.length > 0 ? 'qualified' : 'unreviewed';
          if (supportReview === 'unreviewed') issues.push({kind: 'unreviewed_support', subjectId: evidenceId});
          const receipt = directnessReviews.find(review =>
            review.snapshot.request.claimId === claim.id && review.snapshot.request.evidenceId === evidenceId);
          const directnessReview = receipt === undefined ? null : {receipt,
            current: receipt.snapshot.material.claimHash === relationClaimHash(claim) &&
              receipt.snapshot.material.sourceDigest === relationSourceDigest(source.source)};
          if (directnessReview === null) issues.push({kind: 'unreviewed_directness', subjectId: evidenceId});
          else if (!directnessReview.current) issues.push({kind: 'changed_directness', subjectId: directnessReview.receipt.snapshot.id});
          else if (directnessReview.receipt.snapshot.request.directness === 'indirect') issues.push({kind: 'indirect_citation', subjectId: evidenceId});
          else if (directnessReview.receipt.snapshot.request.directness === 'unsupported') issues.push({kind: 'unsupported_citation', subjectId: evidenceId});
          return {evidenceId, manuscriptCitationKey: source.manuscriptCitationKey, supportReview,
            supportRelationIds: supporting.map(relation => relation.id), directnessReview};
        });
        return {sectionIndex, sectionTitle: section.title, paragraphIndex, claim, relations, citations, issues};
      }));
    const citations = paragraphs.flatMap(paragraph => paragraph.citations);
    const report = researchCitationCoverageBodySchema.parse({
      schemaVersion: 2, projectId: request.projectId, artifactId: request.artifactId,
      artifactVersion: snapshot.version, manuscript: bundle.manuscript, sources, paragraphs,
      counts: {paragraphs: paragraphs.length, citations: citations.length,
        humanReviewedCitations: citations.filter(citation => citation.supportReview !== 'unreviewed').length,
        qualifiedCitations: citations.filter(citation => citation.supportReview === 'qualified').length,
        paragraphsWithIssues: paragraphs.filter(paragraph => paragraph.issues.length > 0).length,
        directCitations: citations.filter(c => c.directnessReview?.current && c.directnessReview.receipt.snapshot.request.directness === 'direct').length,
        indirectCitations: citations.filter(c => c.directnessReview?.current && c.directnessReview.receipt.snapshot.request.directness === 'indirect').length,
        unsupportedCitations: citations.filter(c => c.directnessReview?.current && c.directnessReview.receipt.snapshot.request.directness === 'unsupported').length,
        unreviewedDirectnessCitations: citations.filter(c => !c.directnessReview?.current).length}
    });
    const reportHash = researchContentHash(JSON.stringify(report));
    return researchCitationCoverageInspectionSchema.parse({
      status: request.expectedHash === null || request.expectedHash === reportHash ? 'current' : 'stale',
      report, reportHash, readAt
    });
  }
}
