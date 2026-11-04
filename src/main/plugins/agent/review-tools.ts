import type {StructuredToolInterface} from '@langchain/core/tools';
import {tool} from 'langchain';
import {z} from 'zod';
import type {ResearchToolDescriptor} from './research-tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import {getCapabilityOperationContext} from '../../kernel/capability-operation-context';
import {
  researchReviewProtocolGetRequestSchema, researchReviewProtocolListRequestSchema,
  type ResearchReviewProtocolInspection
} from '../../../shared/schemas/research-systematic-review';
import {
  researchReviewSearchGetSchema, researchReviewSearchListSchema, researchReviewSearchPoolRequestSchema,
  type ResearchReviewSearchInspection
} from '../../../shared/schemas/research-review-search';
import {
  researchReviewCorpusGetSchema, researchReviewCorpusListSchema, researchReviewCorpusHitRequestSchema,
  type ResearchReviewCorpusInspection
} from '../../../shared/schemas/research-review-corpus';
import {
  researchReviewScreeningPlanGetSchema, researchReviewScreeningSuggestionCreateSchema,
  researchReviewScreeningSuggestionListSchema, type ResearchReviewScreeningFrozenPhase
} from '../../../shared/schemas/research-review-screening';
import {
  researchReviewFullTextSuggestionCreateSchema, researchReviewFullTextSuggestionListSchema,
  type ResearchReviewFullTextFrozenPhase
} from '../../../shared/schemas/research-review-fulltext-screening';
import {researchReviewFullTextBindingGetSchema} from '../../../shared/schemas/research-review-fulltext';
import {researchReviewExtractionGetSchema} from '../../../shared/schemas/research-review-extraction';
import {
  researchReviewQualityPlanGetSchema, researchReviewQualityAssessmentGetSchema
} from '../../../shared/schemas/research-review-quality';
import {researchReviewReportGetSchema, type ResearchReviewReportInspection} from '../../../shared/schemas/research-review-report';

export const REVIEW_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  {name: 'research_review_read', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: ['main', 'subagent']},
  {name: 'research_review_suggest_title', scope: 'app', effectClass: 'external_call', riskLevel: 'low', executionScopes: ['main']},
  {name: 'research_review_suggest_fulltext', scope: 'app', effectClass: 'external_call', riskLevel: 'low', executionScopes: ['main']}
];

const pagination = {
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(30)
};
const corpusTarget = researchReviewCorpusGetSchema.omit({projectId: true});
const readSchema = z.discriminatedUnion('kind', [
  researchReviewProtocolListRequestSchema.omit({projectId: true}).extend({kind: z.literal('protocols')}),
  researchReviewProtocolGetRequestSchema.omit({projectId: true}).extend({kind: z.literal('protocol')}),
  researchReviewSearchListSchema.omit({projectId: true}).extend({kind: z.literal('searches')}),
  researchReviewSearchGetSchema.omit({projectId: true}).extend({kind: z.literal('search')}),
  researchReviewSearchPoolRequestSchema.omit({projectId: true}).extend({kind: z.literal('search_pool')}),
  researchReviewCorpusListSchema.omit({projectId: true}).extend({kind: z.literal('corpora')}),
  corpusTarget.extend({kind: z.literal('corpus'), ...pagination}),
  researchReviewCorpusHitRequestSchema.omit({projectId: true}).extend({kind: z.literal('hit')}),
  researchReviewScreeningPlanGetSchema.omit({projectId: true}).extend({kind: z.literal('screening_plan')}),
  corpusTarget.extend({kind: z.literal('title_phase'), ...pagination}),
  corpusTarget.extend({kind: z.literal('fulltext_phase'), ...pagination}),
  researchReviewScreeningSuggestionListSchema.omit({projectId: true, phase: true}).extend({kind: z.literal('title_suggestions')}),
  researchReviewFullTextSuggestionListSchema.omit({projectId: true, phase: true}).extend({kind: z.literal('fulltext_suggestions')}),
  researchReviewFullTextBindingGetSchema.omit({projectId: true}).extend({kind: z.literal('fulltext_binding')}),
  researchReviewExtractionGetSchema.omit({projectId: true}).extend({kind: z.literal('extraction')}),
  researchReviewQualityPlanGetSchema.omit({projectId: true}).extend({kind: z.literal('quality_plan')}),
  researchReviewQualityAssessmentGetSchema.omit({projectId: true}).extend({kind: z.literal('quality_assessment')}),
  corpusTarget.extend({kind: z.literal('studies')}),
  researchReviewReportGetSchema.omit({projectId: true}).extend({
    kind: z.literal('report'), section: z.enum(['counts', 'queries', 'records', 'exclusions', 'evidence']), ...pagination
  })
]);

/** The harness owns project and operation identity; every write is only a proposal. */
export function createReviewTools(input: {
  capabilities: RocCapabilityRegistry;
  projectId: string;
  signal: AbortSignal;
}): StructuredToolInterface[] {
  const invoke = async <T>(name: string, request: object): Promise<T> => {
    input.signal.throwIfAborted();
    const result = await input.capabilities.invoke<unknown, T>(name, {...request, projectId: input.projectId});
    input.signal.throwIfAborted();
    return result;
  };
  return [
    tool(async target => await read(target, invoke), {
      name: 'research_review_read',
      description: '读取当前项目真实的系统综述协议、查询回执、原始记录、筛选状态、全文绑定、人工提取/质量评价和报表。'
        + '先列协议，再用返回的精确版本/语料/条目 ID 读取；列表 capped=true 时不能推断遗漏项不存在。'
        + '分页 total 是真实总数，page 只是所选部分；snapshotHash/bodyHash 校验完整保存内容，并非分页结果。'
        + 'missing、null、旧来源、未审核研究数和失败查询都必须保留；建议不算人工决定。counts 是内部计数，不表示正式 PRISMA 模板适用性。',
      schema: readSchema
    }),
    tool(async request => await invoke('research.reviewScreening.suggest', {
      ...request, phase: 'title_abstract', requestId: proposalRequestId('research_review_suggest_title')
    }), {
      name: 'research_review_suggest_title',
      description: '对准确语料条目提出标题/摘要筛选建议。先读冻结协议、筛选计划和原始 hit，按声明准则明确给出 include/exclude/uncertain 与理由。'
        + '缺失摘要不能补造。来源和幂等身份由主进程记录；不提交人工决定、不仲裁、不冻结。',
      schema: researchReviewScreeningSuggestionCreateSchema.omit({projectId: true, requestId: true, phase: true})
    }),
    tool(async request => await invoke('research.reviewFullTextScreening.suggest', {
      ...request, phase: 'full_text', requestId: proposalRequestId('research_review_suggest_fulltext')
    }), {
      name: 'research_review_suggest_fulltext',
      description: '对标题轮已纳入、已明确绑定真实原文的准确报告提出全文资格建议。先读取协议、全文状态、精确 binding 和原文，'
        + '携带准确计划/标题冻结/绑定哈希及声明准则；来源变化或未取回会失败。人工最终决定、仲裁、冻结由研究者完成。',
      schema: researchReviewFullTextSuggestionCreateSchema.omit({projectId: true, requestId: true, phase: true})
    })
  ];
}

function proposalRequestId(toolName: string): string {
  const operation = getCapabilityOperationContext();
  if (operation === undefined || operation.toolName !== toolName) {
    throw new Error('research_review_screening_tool_context_required');
  }
  return operation.idempotencyKey;
}

async function read(
  target: z.infer<typeof readSchema>,
  invoke: <T>(name: string, request: object) => Promise<T>
): Promise<unknown> {
  const {kind, ...request} = target;
  switch (target.kind) {
    case 'protocols': {
      const items = await invoke<ResearchReviewProtocolInspection[]>('research.reviewProtocol.list', request);
      return {limit: target.limit, capped: items.length === target.limit, items};
    }
    case 'protocol': return await invoke('research.reviewProtocol.get', request);
    case 'searches': {
      const items = await invoke<ResearchReviewSearchInspection[]>('research.reviewSearch.list', request);
      return {limit: target.limit, capped: items.length === target.limit, items};
    }
    case 'search': return await invoke('research.reviewSearch.get', request);
    case 'search_pool': return await invoke('research.reviewSearch.pool', request);
    case 'corpora': {
      const items = await invoke<ResearchReviewCorpusInspection[]>('research.reviewCorpus.list', request);
      return {
        limit: target.limit, capped: items.length === target.limit,
        items: items.map(corpus => ({
          corpusId: corpus.snapshot.id, snapshotHash: corpus.snapshotHash, versionId: corpus.snapshot.request.versionId,
          currentProtocol: corpus.currentProtocol, identifiedRecords: corpus.identifiedRecords,
          queryCount: corpus.queryCount, searchCoverageComplete: corpus.searchCoverageComplete
        }))
      };
    }
    case 'corpus': {
      const corpus = await invoke<ResearchReviewCorpusInspection>('research.reviewCorpus.get', {corpusId: target.corpusId});
      const {hits, ...basis} = corpus.snapshot;
      return {
        basis, snapshotHash: corpus.snapshotHash, currentProtocol: corpus.currentProtocol,
        identifiedRecords: corpus.identifiedRecords, queryCount: corpus.queryCount,
        searchCoverageComplete: corpus.searchCoverageComplete, page: page(hits, target)
      };
    }
    case 'hit': return await invoke('research.reviewCorpus.hit', request);
    case 'screening_plan': return await invoke('research.reviewScreening.getPlan', request);
    case 'title_phase': {
      const phase = await invoke<ResearchReviewScreeningFrozenPhase>('research.reviewScreening.phase', {
        corpusId: target.corpusId, phase: 'title_abstract'
      });
      return {
        plan: phase.plan, phase: phase.phase, counts: phase.counts, reviewHash: phase.reviewHash, freezeHash: phase.freezeHash,
        frozenAt: phase.freeze?.frozenAt ?? null, page: page(phase.items, target),
        frozenAuthorityPage: phase.freeze === null ? null : page(phase.freeze.authority.items, target)
      };
    }
    case 'fulltext_phase': {
      const phase = await invoke<ResearchReviewFullTextFrozenPhase>('research.reviewFullTextScreening.phase', {
        corpusId: target.corpusId, phase: 'full_text'
      });
      return {
        plan: phase.plan, phase: phase.phase, titleFreezeHash: phase.titleFreezeHash, counts: phase.counts,
        reviewHash: phase.reviewHash, freezeHash: phase.freezeHash, frozenAt: phase.freeze?.frozenAt ?? null,
        page: page(phase.items, target),
        frozenAuthorityPage: phase.freeze === null ? null : page(phase.freeze.authority.items, target)
      };
    }
    case 'title_suggestions': return await invoke('research.reviewScreening.suggestions', {...request, phase: 'title_abstract'});
    case 'fulltext_suggestions': return await invoke('research.reviewFullTextScreening.suggestions', {...request, phase: 'full_text'});
    case 'fulltext_binding': return await invoke('research.reviewFullText.get', request);
    case 'extraction': return await invoke('research.reviewExtraction.get', request);
    case 'quality_plan': return await invoke('research.reviewQuality.getPlan', request);
    case 'quality_assessment': return await invoke('research.reviewQuality.getAssessment', request);
    case 'studies': return await invoke('research.reviewStudies.get', request);
    case 'report': {
      const report = await invoke<ResearchReviewReportInspection>('research.reviewReport.get', {corpusId: target.corpusId});
      const basis = {
        projectId: report.body.projectId, corpusId: report.body.corpusId, bodyHash: report.bodyHash,
        basis: report.body.basis, counts: report.body.counts, currentProtocol: report.currentProtocol,
        sourcesCurrent: report.sourcesCurrent, searchCoverageComplete: report.body.searchCoverageComplete
      };
      switch (target.section) {
        case 'counts': return basis;
        case 'queries': return {...basis, section: target.section, page: page(report.body.queries, target)};
        case 'records': return {...basis, section: target.section, page: page(report.body.records, target)};
        case 'exclusions': return {...basis, section: target.section, page: page(report.body.exclusions, target)};
        case 'evidence': return {
          ...basis, section: target.section,
          page: page(report.body.evidenceTable.map((item, index) => ({...item, referenceStatus: report.evidenceStatus[index]})), target)
        };
      }
    }
  }
}

function page<T>(items: T[], request: {offset: number; limit: number}): {
  offset: number; limit: number; total: number; hasMore: boolean; items: T[]
} {
  return {
    offset: request.offset, limit: request.limit, total: items.length, hasMore: request.offset + request.limit < items.length,
    items: items.slice(request.offset, request.offset + request.limit)
  };
}
