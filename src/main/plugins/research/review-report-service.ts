import {createHash} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {researchReviewReportGetSchema,researchReviewReportBodySchema,researchReviewReportInspectionSchema,
  type ResearchReviewReportInspection} from '../../../shared/schemas/research-review-report';
import type {ResearchReviewScreeningAuthority} from '../../../shared/schemas/research-review-screening';
import type {ResearchReviewFullTextAuthority} from '../../../shared/schemas/research-review-fulltext-screening';
import type {RankedLiteratureRecord} from '../../../shared/schemas/literature-search-pool';
import type {ResearchRepository} from './repository';
import type {ResearchReviewCorpusRepository} from './review-corpus-repository';
import type {ResearchReviewDeduplicationRepository} from './review-deduplication-repository';
import type {ResearchReviewScreeningFreeze} from './review-screening-freeze';
import type {ResearchReviewFullTextFreeze} from './review-fulltext-freeze';
import type {ResearchReviewStudiesRepository} from './review-studies-repository';
import type {ResearchReviewSearchService} from './review-search-service';
import type {ResearchReviewExtractionRepository} from './review-extraction-repository';
import type {ResearchReviewQualityPlanRepository} from './review-quality-plan-repository';
import type {ResearchReviewQualityAssessmentRepository} from './review-quality-assessment-repository';
const hash=(value:string):string=>createHash('sha256').update(value).digest('hex');
const sealed=<T>(value:{snapshot:T;snapshotHash:string}|null):{snapshot:T;snapshotHash:string}|null=>
  value===null?null:{snapshot:value.snapshot,snapshotHash:value.snapshotHash};

/** Read one database snapshot; frozen counts and human data are separate from live reference state and disk verification. */
export class ResearchReviewReportService {
  constructor(private readonly db:Database,private readonly repository:ResearchRepository,
    private readonly corpora:ResearchReviewCorpusRepository,private readonly searches:ResearchReviewSearchService,
    private readonly deduplication:ResearchReviewDeduplicationRepository,private readonly titles:ResearchReviewScreeningFreeze,
    private readonly fullTexts:ResearchReviewFullTextFreeze,private readonly studies:ResearchReviewStudiesRepository,
    private readonly extractions:ResearchReviewExtractionRepository,private readonly qualityPlans:ResearchReviewQualityPlanRepository,
    private readonly assessments:ResearchReviewQualityAssessmentRepository) {}
  get(input:{projectId:string;corpusId:string}):ResearchReviewReportInspection {
    const request=researchReviewReportGetSchema.parse(input);
    return this.db.transaction(()=>{
      const corpus=this.corpora.get(request),dedup=this.deduplication.get(request);
      const title=this.titles.getPhase({...request,phase:'title_abstract'}),full=this.fullTexts.getPhase({...request,phase:'full_text'});
      const protocol=this.repository.systematicReviews.get({projectId:request.projectId,versionId:corpus.snapshot.request.versionId});
      if(dedup.freeze===null||dedup.freezeHash===null||title.freeze===null||title.freezeHash===null||
        full.freeze===null||full.freezeHash===null)throw new Error('research_review_screening_not_frozen');
      if(protocol.freeze===null||protocol.freezeHash===null)throw new Error('research_review_snapshot_invalid');
      const grouping=this.studies.get(request),pools=new Map<string,RankedLiteratureRecord[]>();
      const queries=corpus.snapshot.sources.map(source=>{
        const search=this.searches.get({projectId:request.projectId,reviewSearchId:source.reviewSearchId});
        if(search.snapshotHash!==source.snapshotHash||search.receiptHash!==source.receiptHash)throw new Error('research_review_corpus_snapshot_invalid');
        if(source.poolHash!==null)pools.set(source.reviewSearchId,this.searches.readFullPool({
          projectId:request.projectId,reviewSearchId:source.reviewSearchId}).pool.records);
        return {source,search};
      });
      const records=corpus.snapshot.hits.map(hit=>{
        const record=pools.get(hit.reviewSearchId)?.[hit.recordIndex];
        if(record===undefined||hash(JSON.stringify(record))!==hit.recordHash)throw new Error('research_review_corpus_snapshot_invalid');
        return {hit,record};
      });
      const fields=this.extractions.list(request),plans=this.qualityPlans.list(request);
      const evidenceTable=full.freeze.authority.items.filter(item=>item.status==='included').map(item=>{
        const extraction=fields.find(value=>value.snapshot.request.hitId===item.hit.id)??null;
        const plan=extraction===null?null:plans.find(value=>value.snapshot.request.extractionId===extraction.snapshot.id)??null;
        const assessment=plan===null?null:this.assessments.get({...request,extractionId:plan.snapshot.request.extractionId,qualityPlanId:plan.snapshot.id});
        return {hit:item.hit,extraction,qualityPlan:plan,assessment};
      });
      const exclusion=(item:ResearchReviewScreeningAuthority['items'][number]|ResearchReviewFullTextAuthority['items'][number],
        phase:'title_abstract'|'full_text')=>{
        const criterion=protocol.version.body.exclusionCriteria.find(value=>value.id===item.primaryExclusionCriterionId);
        if(criterion===undefined)throw new Error('research_review_screening_snapshot_invalid');
        return {hit:item.hit,phase,criterion,decisions:item.decisions,arbitration:item.arbitration,binding:'binding' in item?item.binding:null};
      };
      const titleCounts=title.freeze.authority.counts,fullCounts=full.freeze.authority.counts;
      const body=researchReviewReportBodySchema.parse({
        format:'roc.review-report.v1',...request,basis:{protocolVersionHash:protocol.versionHash,protocolFreezeHash:protocol.freezeHash,
          corpusHash:corpus.snapshotHash,dedupFreezeHash:dedup.freezeHash,titleFreezeHash:title.freezeHash,fullFreezeHash:full.freezeHash},
        protocol:{version:protocol.version,freeze:protocol.freeze},deduplication:dedup.freeze,title:title.freeze,fullText:full.freeze,
        studyGrouping:sealed(grouping),counts:{
          identifiedRecords:dedup.freeze.identifiedRecords,removedDuplicates:dedup.freeze.removedDuplicates,
          recordsScreened:titleCounts.recordsToScreen,recordsExcluded:titleCounts.excluded,reportsSought:fullCounts.reportsToSeek,
          reportsNotRetrieved:fullCounts.not_retrieved,reportsAssessed:fullCounts.included+fullCounts.excluded,
          reportsExcluded:fullCounts.excluded,includedReports:fullCounts.included,includedStudies:grouping===null?null:grouping.includedStudies
        },searchCoverageComplete:corpus.searchCoverageComplete,queries,records,
        exclusions:[...title.freeze.authority.items.filter(item=>item.status==='excluded').map(item=>exclusion(item,'title_abstract')),
          ...full.freeze.authority.items.filter(item=>item.status==='excluded').map(item=>exclusion(item,'full_text'))],
        evidenceTable:evidenceTable.map(item=>({hit:item.hit,extraction:sealed(item.extraction),qualityPlan:sealed(item.qualityPlan),assessment:sealed(item.assessment)}))
      });
      return researchReviewReportInspectionSchema.parse({
        body,bodyHash:hash(JSON.stringify(body)),currentProtocol:corpus.currentProtocol,sourcesCurrent:full.sourcesCurrent,
        evidenceStatus:evidenceTable.map(item=>({hitId:item.hit.id,
          extraction:item.extraction===null?null:{isLatest:item.extraction.isLatest,currentProtocol:item.extraction.currentProtocol,referenceStatus:item.extraction.referenceStatus},
          qualityPlan:item.qualityPlan===null?null:{currentExtraction:item.qualityPlan.currentExtraction,currentProtocol:item.qualityPlan.currentProtocol,referenceStatus:item.qualityPlan.referenceStatus},
          assessment:item.assessment===null?null:{isLatest:item.assessment.isLatest,currentExtraction:item.assessment.currentExtraction,
            currentProtocol:item.assessment.currentProtocol,referenceStatus:item.assessment.referenceStatus}
        }))
      });
    })();
  }
}
