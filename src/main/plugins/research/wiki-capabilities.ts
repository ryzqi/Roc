import type {z} from 'zod';
import * as s from '../../../shared/schemas/research-wiki-pages';
import type {CapabilityDescriptor, RocPluginContext} from '../../kernel/types';
import {RocDomainError} from '../../services/errors';
import type {ResearchWikiRepository} from './wiki-repository';
import type {ResearchPaperCards} from './paper-card-service';

const descriptor = <I, O>(name: string, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): CapabilityDescriptor<I, O> =>
  ({name: `research.wiki.${name}`, version: '1.0.0', inputSchema, outputSchema});
const capabilities = {
  search: descriptor('search', s.wikiSearchSchema, s.wikiSearchResultSchema),
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
  retryPaper: descriptor('paper.retry', s.wikiPageRequestSchema, s.wikiPageSchema)
};
export const researchWikiCapabilities = Object.values(capabilities);
export function registerResearchWikiCapabilities(context: RocPluginContext, wiki: ResearchWikiRepository, papers: ResearchPaperCards): void {
  function register<I, O>(capability: CapabilityDescriptor<I, O>, run: (input: I) => O | Promise<O>): void {
    context.capabilities.register(context.pluginId, capability, async input => {
      try {return await run(capability.inputSchema.parse(input));} catch (error) {
        if (error instanceof Error && error.message.startsWith('wiki_')) {
          const messages: Record<string, string> = {
            wiki_revision_conflict: '页面已更新，请刷新后重试。', wiki_basis_changed: '原始依据已改变，请重新读取页面。',
            wiki_human_section_protected: '助手不能覆盖人工维护的章节。', wiki_current_sources_required: '请先更新页面并引用本页有效的原始证据。',
            wiki_page_not_found: '当前项目中未找到此 Wiki 页面。', wiki_revision_not_found: '此修订不存在。',
            wiki_link_not_found: '页面没有此链接。', wiki_project_mismatch: 'Wiki 引用不属于当前项目。',
            wiki_page_too_large: '页面超过内容上限，请拆分主题。'
          };
          throw new RocDomainError({code: error.message, message: messages[error.message] ?? 'Wiki 操作失败，请检查来源后重试。', category: 'conflict', retryable: false});
        }
        throw error;
      }
    });
  }
  register(capabilities.search, q => wiki.search(q.projectId, q.query, q.offset));
  register(capabilities.read, q => wiki.read(q.projectId, q.pageId));
  register(capabilities.create, q => wiki.create(q));
  register(capabilities.save, q => wiki.save(q, 'human'));
  register(capabilities.draft, q => wiki.save(q, 'assistant'));
  register(capabilities.compile, q => wiki.recompile(q.projectId, q.pageId, q.expectedRevision));
  register(capabilities.rollback, q => wiki.rollback(q));
  register(capabilities.history, q => wiki.history(q.projectId, q.pageId, q.offset));
  register(capabilities.revision, q => wiki.revision(q.projectId, q.pageId, q.revision));
  register(capabilities.follow, q => wiki.follow(q.projectId, q.pageId, q.expectedRevision, q.targetPageId));
  register(capabilities.section, q => wiki.readSection(q));
  register(capabilities.resynthesize, q => wiki.resynthesize(q));
  register(capabilities.retryPaper, q => {
    papers.retry(q.projectId, q.pageId); return wiki.read(q.projectId, q.pageId);
  });
}
