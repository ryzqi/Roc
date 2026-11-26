import {tool} from 'langchain';
import {claimComparisonToolSchema} from '../../../shared/schemas/research-claim-comparison';
import {z} from 'zod';
import type {StructuredToolInterface} from '@langchain/core/tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import type {ResearchToolDescriptor} from './research-tools';
import {wikiCreateSchema, wikiSaveSchema, wikiSearchSchema, wikiUpdateSourcesSchema, wikiSectionReadSchema, wikiResynthesizeSchema, type WikiPage, type WikiSearchResult} from '../../../shared/schemas/research-wiki-pages';
import {scientificEntitySearchSchema, scientificFactSearchSchema, scientificRelationSearchSchema,
  scientificKnowledgeSearchResultSchema} from '../../../shared/schemas/research-scientific-knowledge-search';

const readNames = ['research_wiki_search', 'research_wiki_search_entities', 'research_wiki_search_facts', 'research_wiki_search_relations',
  'research_wiki_read', 'research_wiki_read_relations', 'research_wiki_follow', 'research_wiki_lint', 'research_wiki_read_section', 'research_compare_claims'];
export const WIKI_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  ...readNames.map(name => ({name, scope: 'app' as const, effectClass: 'none' as const, riskLevel: 'low' as const,
    executionScopes: ['main', 'subagent'] as ResearchToolDescriptor['executionScopes']})),
  ...['research_wiki_create', 'research_wiki_draft', 'research_wiki_resynthesize', 'research_wiki_update_sources', 'research_wiki_retry_paper'].map(name => ({name, scope: 'app' as const,
    effectClass: 'external_call' as const, riskLevel: 'low' as const, executionScopes: ['main'] as ResearchToolDescriptor['executionScopes']}))
];
const id = z.string().trim().min(1).max(300);
const {projectId: _projectId, ...createFields} = wikiCreateSchema.shape;
const createSchema = z.object(createFields).strict();
const pageSchema = z.object({pageId: id, offset: z.number().int().min(0).max(100).default(0)}).strict();
const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max)}… [截断]` : value;

/** Paginated navigation over derived drafts; all factual citations still target original evidence. */
export function createWikiTools(input: {projectId: string; signal: AbortSignal; capabilities: RocCapabilityRegistry}): StructuredToolInterface[] {
  const visited = new Set<string>();
  const invoke = async <T>(name: string, request: object): Promise<T> => {
    input.signal.throwIfAborted();
    const result = await input.capabilities.invoke<unknown, T>(`research.wiki.${name}`, {...request, projectId: input.projectId}, input.signal);
    input.signal.throwIfAborted();return result;
  };
  const read = async <T>(action: () => Promise<T>): Promise<T> => {
    return await action();
  };
  const projectPage = (page: WikiPage, offset: number): unknown => {
    const key = `${page.page.id}:${page.page.revision}:${offset}`;
    if (visited.has(key)) throw new Error('wiki_page_already_read: use the prior result or another section offset');
    visited.add(key);
    const sections = page.current?.sections.slice(offset, offset + 3) ?? [];
    const evidenceIds = new Set(sections.flatMap(section => section.evidenceIds));
    return {derived: true, scientificReview: 'Wiki 草稿不代表人工科学审核；事实必须引用下列原始 evidenceId，并核查原文。',
      page: page.page, basisDigest: page.basisDigest, paperJob: page.paperJob,
      sections: sections.map(({dependencies: _dependencies, ...section}) => ({...section, body: clip(section.body, 1200),
        evidenceIds: section.evidenceIds.slice(0, 10), claimIds: section.claimIds.slice(0, 10), links: section.links.slice(0, 10)})),
      nextOffset: (page.current?.sections.length ?? 0) > offset + 3 ? offset + 3 : null,
      sources: page.sources.filter(source => evidenceIds.has(source.evidenceId)).slice(0, 8)
        .map(source => ({...source, excerpt: clip(source.excerpt, 400)})),
      sourcesTruncated: [...evidenceIds].length > 8,
      lint: page.lint.slice(0, 8), lintTruncated: page.lint.length > 8, links: page.links.slice(0, 8),
      fallback: '证据不足、来源失效或原句问题：使用 research_search_scientific_knowledge 与 research_validate_scientific_evidence 核验，只有原始 knowledge chunkId 才能交给 research_capture_evidence；不要把 Wiki 文字当成新证据。'};
  };
  return [
    ...([
      {kind: 'entity', name: 'entities', schema: scientificEntitySearchSchema.omit({projectId: true, kind: true}),
        description: '按原始名称及显式别名分页查找当前项目的科研实体。exactMatch只表示名称匹配，不合并跨论文身份；用返回ID查事实和关系。'},
      {kind: 'fact', name: 'facts', schema: scientificFactSearchSchema.omit({projectId: true, kind: true}),
        description: '按Method/Model、Dataset、Metric及实验条件分页查找来源有效的科研事实。保留原值、单位、unknown条件和原始PDF定位；科学支持仍未审核。'},
      {kind: 'relation', name: 'relations', schema: scientificRelationSearchSchema.omit({projectId: true, kind: true}),
        description: '按实体端点和有来源的关系类型分页查找科研关系与有意义邻居。返回原始证据，不把相似名称当成关系。'}
    ] as const).map(({kind, name, schema, description}) => tool(async request => {
      const result = scientificKnowledgeSearchResultSchema.parse(await invoke('knowledge.search', {...request, kind}));
      if (result.projectId !== input.projectId || result.kind !== kind) throw new Error('research_scientific_tool_project_mismatch');
      return {...result, supportStatus: 'requires_validation',
        nextStep: '使用命中的documentId检索原始科学对象，再通过research_read_scientific_context及research_validate_scientific_evidence核查；来源有效不等于科学确认。'};
    }, {name: `research_wiki_search_${name}`, description,
      schema})),
    tool(async request => {
      input.signal.throwIfAborted();
      return input.capabilities.invoke('research.claims.compare', {...request, projectId: input.projectId});
    }, {name: 'research_compare_claims', description: '比较两个准确主张版本的实验条件。条件差异不能认定矛盾，unknown 返回不可判定；可比的相反结论只产生未审核冲突候选，不确认任何科学关系。引用原始 evidenceIds。',
      schema: claimComparisonToolSchema}),
    tool(request => read(async () => {
      const result = await invoke<WikiSearchResult>('search', request);
      const {offset} = request;
      return {...result, derived: true, pages: result.pages.slice(0, 10),
        nextOffset: result.pages.length > 10 ? offset + 10 : result.nextOffset,
        scientificReview: '章节命中只用于导航；通过 research_wiki_read_section 深入读取，再核查原始 Evidence。',
        fallback: '无命中时使用 research_search_scientific_knowledge 检索原文，依据原轮次读取上下文和验证证据。'};
    }), {name: 'research_wiki_search', description: '搜索当前项目的持久 Wiki 草稿标题与正文，供综述导航。事实和原句问题仍先检索原文。',
      schema: wikiSearchSchema.omit({projectId: true})}),
    tool(({pageId, offset}) => read(async () => projectPage(await invoke<WikiPage>('read', {pageId}), offset)), {
      name: 'research_wiki_read', description: '分页读取派生草稿、修订和依据摘要。每次 3 节，按 nextOffset 继续；检查 lint 和原始 evidenceId。相同修订/页码不可重复访问。', schema: pageSchema}),
    tool(request => invoke('section', request), {name: 'research_wiki_read_section',
      description: '按准确修订深入读取一节草稿，字符预算最多 6000。paperSources 是原文定位，使用 research_read_knowledge_context 核验；摘要不能捕获为 Evidence。',
      schema: wikiSectionReadSchema.omit({projectId: true})}),
    tool(async request => {
      const result = await invoke<WikiPage>('resynthesize', request);
      return {page: result.page, basisDigest: result.basisDigest, lint: result.lint.slice(0, 10)};
    }, {name: 'research_wiki_resynthesize', description: '对最多 3 节 stale 助手正文执行增量重新综合。先读最新修订和 basisDigest；只用当前原始依据，保留人工内容，结果仍未审核。',
      schema: wikiResynthesizeSchema.omit({projectId: true})}),
    tool(async request => {
      const result = await invoke<WikiPage>('updateSources', request);
      return {page: result.page, basisDigest: result.basisDigest, lint: result.lint};
    }, {name: 'research_wiki_update_sources', description: '把新增或更新论文代次加入指定助手章节，只重新综合这些章节。先读当前 revision/basisDigest 和准确 generationId；保留人工章节及旧修订，结果仍未人工审核。',
      schema: wikiUpdateSourcesSchema.omit({projectId: true})}),
    tool(async request => ({relations: await invoke('relations', request), scientificApproval: 'unreviewed'}), {name: 'research_wiki_read_relations',
      description: '读取当前 Wiki 的有来源关系及跨论文条件比较。关系是未审核候选；条件不完整时不得宣称相互矛盾或合并实体。',
      schema: z.object({pageId: id}).strict()}),
    tool(async request => {
      const result = await invoke<WikiPage>('paper.retry', request);
      return {page: result.page, paperJob: result.paperJob};
    }, {name: 'research_wiki_retry_paper', description: '默认模型配置修复后，重试当前来源页的自动 Paper Card。不会改写人工或助手正文。',
      schema: z.object({pageId: id}).strict()}),
    tool(request => read(async () => projectPage(await invoke<WikiPage>('follow', request), 0)), {
      name: 'research_wiki_follow', description: '沿已读取修订中的真实页面链接跳转；传原页的准确 revision。无法沿不存在的链接或其他项目导航。',
      schema: z.object({pageId: id, expectedRevision: z.number().int().positive(), targetPageId: id}).strict()}),
    tool(({pageId, offset}) => read(async () => {
      const page = await invoke<WikiPage>('read', {pageId});
      return {page: page.page, issues: page.lint.slice(offset, offset + 20),
        nextOffset: page.lint.length > offset + 20 ? offset + 20 : null,
        scope: '仅结构、依赖及已记录反对关系候选检查；不能验证语义支持或代替人工审核。'};
    }), {name: 'research_wiki_lint', description: '检查来源过期、依赖缺失、断链、无引用章节和反对关系候选。科学支持仍需原始关系审核。', schema: pageSchema}),
    tool(async request => {
      const result = await invoke<WikiPage>('create', request);
      return {page: result.page, instruction: '来源摘录正在编译；之后读取页面，再依据准确原文综合草稿。'};
    }, {name: 'research_wiki_create', description: '用准确的已捕获 evidenceId/claimId 创建主题、比较或争议草稿。捕获证据会自动创建来源页；不能把 Wiki 文本回灌成证据。',
      schema: createSchema}),
    tool(async request => {
      const result = await invoke<WikiPage>('draft', request);
      return {page: result.page, basisDigest: result.basisDigest, lint: result.lint.slice(0, 10)};
    }, {name: 'research_wiki_draft', description: '保存一节助手综合草稿。先读取当前页，用准确 revision/basisDigest 及有效原始 evidenceId；每个事实在正文标明证据。不能覆盖人工章节，不能确认科学支持。',
      schema: wikiSaveSchema.omit({projectId: true})})
  ];
}
