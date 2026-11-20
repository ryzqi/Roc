import type {z} from 'zod';
import * as s from '../../../shared/schemas/research-wiki-pages';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {ResearchWikiRepository} from './wiki-repository';
import type {ResearchPaperCards} from './paper-card-service';
import {paperCardKnowledgeReadRequestSchema, paperCardKnowledgeSchema} from '../../../shared/schemas/research-paper-card-knowledge';
import {getCapabilityAbortSignal} from '../../kernel/capability-cancellation';
import {scientificKnowledgeSearchSchema, scientificKnowledgeSearchResultSchema} from '../../../shared/schemas/research-scientific-knowledge-search';
import type {ScientificExtractionService} from './scientific-extraction-service';

const descriptor = <I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> =>
  ({name: `research.wiki.${name}`, version: '1.0.0', inputSchema, outputSchema});
const capabilities = {
  search: descriptor('search', s.wikiSearchSchema, s.wikiSearchResultSchema),
  knowledgeSearch: descriptor('knowledge.search', scientificKnowledgeSearchSchema, scientificKnowledgeSearchResultSchema),
  read: descriptor('read', s.wikiPageRequestSchema, s.wikiPageSchema),
  create: descriptor('create', s.wikiCreateSchema, s.wikiPageSchema),
  save: descriptor('save', s.wikiSaveSchema, s.wikiPageSchema),
  draft: descriptor('draft', s.wikiSaveSchema, s.wikiPageSchema),
  compile: descriptor('compile', s.wikiCompileSchema, s.wikiSummarySchema),
  rollback: descriptor('rollback', s.wikiRollbackSchema, s.wikiPageSchema),
  history: descriptor('history', s.wikiHistorySchema, s.wikiRevisionSchema.omit({sections: true}).array()),
  revision: descriptor('revision', s.wikiRevisionReadSchema, s.wikiRevisionSchema),
  follow: descriptor('follow', s.wikiFollowSchema, s.wikiPageSchema),
  section: descriptor('section', s.wikiSectionReadSchema, s.wikiSectionDetailSchema),
  resynthesize: descriptor('resynthesize', s.wikiResynthesizeSchema, s.wikiPageSchema),
  retryPaper: descriptor('paper.retry', s.wikiPageRequestSchema, s.wikiPageSchema),
  paperKnowledge: descriptor('paper.knowledge', paperCardKnowledgeReadRequestSchema, paperCardKnowledgeSchema)
};
export const researchWikiCapabilities = Object.values(capabilities);
export function registerResearchWikiCapabilities(context: RocPluginContext, wiki: ResearchWikiRepository,
  papers: ResearchPaperCards, scientific?: Pick<ScientificExtractionService, 'search'>): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await run(input);} catch (error) {
        if (error instanceof Error && error.message.startsWith('wiki_')) {
          const messages: Record<string, string> = {
            wiki_revision_conflict: '页面已更新，请刷新后重试。', wiki_basis_changed: '原始依据已改变，请重新读取页面。',
            wiki_human_section_protected: '助手不能覆盖人工维护的章节。', wiki_current_sources_required: '请先更新页面并引用本页有效的原始证据。',
            wiki_page_not_found: '当前项目中未找到此 Wiki 页面。', wiki_revision_not_found: '此修订不存在。',
            wiki_link_not_found: '页面没有此链接。', wiki_project_mismatch: 'Wiki 引用不属于当前项目。',
            wiki_page_too_large: '页面超过内容上限，请拆分主题。',
            wiki_context_budget: '完整来源超过本次综合预算，请缩小章节范围。',
            wiki_scientific_section_budget: '完整科学事实超过章节上限，请拆分章节。',
            wiki_scientific_proposal_invalid: '科学草稿与原始数值、实验条件或来源引用不一致。',
            wiki_scientific_reference_invalid: '科学草稿引用了未提供或失效的知识。',
            wiki_scientific_synthesis_required: '请使用结构化科学综合更新此章节。'
          };
          throw new RocDomainError({code: error.message, message: messages[error.message] ?? 'Wiki 操作失败，请检查来源后重试。', category: 'conflict', retryable: false});
        }
        throw error;
      }
    });
  }
  register(capabilities.search, q => wiki.search(q.projectId, q.query, q.offset));
  register(capabilities.knowledgeSearch, q => {
    if (!scientific) throw new Error('research_scientific_search_unavailable');
    return scientific.search(q, getCapabilityAbortSignal());
  });
  register(capabilities.read, q => wiki.readCurrent(q.projectId, q.pageId, getCapabilityAbortSignal()));
  register(capabilities.create, q => wiki.createCurrent(q, getCapabilityAbortSignal()));
  register(capabilities.save, q => wiki.saveCurrent(q, 'human', getCapabilityAbortSignal()));
  register(capabilities.draft, q => wiki.saveCurrent(q, 'assistant', getCapabilityAbortSignal()));
  register(capabilities.compile, q => wiki.recompile(q.projectId, q.pageId, q.expectedRevision));
  register(capabilities.rollback, q => wiki.rollback(q));
  register(capabilities.history, q => wiki.history(q.projectId, q.pageId, q.offset));
  register(capabilities.revision, q => wiki.revision(q.projectId, q.pageId, q.revision));
  register(capabilities.follow, q => {
    wiki.follow(q.projectId, q.pageId, q.expectedRevision, q.targetPageId);
    return wiki.readCurrent(q.projectId, q.targetPageId, getCapabilityAbortSignal());
  });
  register(capabilities.section, q => wiki.readSectionCurrent(q, getCapabilityAbortSignal()));
  register(capabilities.resynthesize, q => wiki.resynthesize(q, getCapabilityAbortSignal()));
  register(capabilities.retryPaper, q => {
    papers.retry(q.projectId, q.pageId); return wiki.read(q.projectId, q.pageId);
  });
  register(capabilities.paperKnowledge, q => papers.readKnowledge(q, getCapabilityAbortSignal()));
}
