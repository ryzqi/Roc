import {scientificQueryResultSchema} from '../../../shared/schemas/research-scientific-query';
import {tool, ToolInputParsingException, type StructuredToolInterface} from '@langchain/core/tools';
import {z} from 'zod';
import type {RocCapabilityRegistry} from '../../kernel/types';
import {scientificSearchToolRequestSchema,
  type ScientificSearchResult} from '../../../shared/schemas/research-scientific-search';
import {scientificContextBudgetSchema, scientificContextResultSchema,
  type ScientificContextResult} from '../../../shared/schemas/research-scientific-context';
import {scientificStatementSchema, scientificEvidenceResultSchema,
  type ScientificStatement} from '../../../shared/schemas/research-scientific-evidence';
import type {ResearchSourceLocator} from '../../../shared/schemas/research-source-locator';
import {researchContentHash} from '../research/research-files';

export const scientificToolNames = {
  search: 'research_search_scientific_knowledge',
  context: 'research_read_scientific_context',
  validate: 'research_validate_scientific_evidence'
} as const;
type Names = {search: string; context: string; validate: string};
type QuoteSource = {evidenceId: string; text: string; sourceLocator: ResearchSourceLocator};
const quoteSelectionSchema = z.object({
  id: z.string().min(1).max(2048), kind: z.literal('quote'),
  sourceId: z.string().min(1).max(2048).describe('sourceId from the selected context hit source or passage'),
  text: z.string().min(1).max(32_000).describe('Copy a unique exact excerpt, preserving newlines, punctuation and hyphenation')
}).strict();
const sourceSelectionSchema = z.object({
  id: z.string().min(1).max(2048), kind: z.literal('quote'),
  sourceId: z.string().min(1).max(2048).describe('sourceId from the selected context hit source or passage'),
  selection: z.literal('source').describe('Select the complete original source; host returns its exact text and offsets')
}).strict();

/** Keep full receipts in this run. Model arguments select handles; they never replace source data or project scope. */
export function createScientificTools(input: {
  capabilities: RocCapabilityRegistry; projectId: string; signal: AbortSignal; assertActive?: () => void;
}, names: Names = scientificToolNames): StructuredToolInterface[] {
  const searches = new Map<string, ScientificSearchResult>();
  const contexts = new Map<string, {searchId: string; context: ScientificContextResult; sources: Map<string, QuoteSource>}>();
  const active = () => {input.signal.throwIfAborted(); input.assertActive?.();};
  const invoke = async (name: string, request: unknown): Promise<unknown> => {
    active();
    const result = await input.capabilities.invoke(name, request, input.signal);
    active();
    return result;
  };
  const remember = <T>(map: Map<string, T>, key: string, value: T, limit: number) => {
    map.delete(key); map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value!);
  };
  const search = (searchId: string) => {
    const saved = searches.get(searchId);
    if (!saved) throw new ToolInputParsingException(`research_scientific_search_handle_missing: run ${names.search} again.`);
    return saved;
  };
  return [
    tool(async request => {
      const result = scientificQueryResultSchema.parse(await invoke('research.knowledge.scientificQuery',
        {...request, projectId: input.projectId}));
      if (result.projectId !== input.projectId) throw new Error('research_scientific_tool_project_mismatch');
      const rounds = result.rounds.map(round => {
        if (round.plan.scope.projectId !== input.projectId) throw new Error('research_scientific_tool_project_mismatch');
        const searchId = `scientific-search:${researchContentHash(JSON.stringify(round))}`;
        remember(searches, searchId, round, 8);
        return {searchId, plan: round.plan, snapshotId: round.snapshot.id,
          generationCount: round.snapshot.generations.length, channels: round.channels,
          candidates: round.candidates.map(c => ({id: c.id, paperId: c.paperId, objectId: c.objectId,
            objectType: c.objectType, title: c.title})),
          hits: round.hits.map(c => ({id: c.id, paperId: c.paperId, objectId: c.objectId,
            objectType: c.objectType, title: c.title, preview: c.content.slice(0, 400), contentChars: c.content.length}))};
      });
      return {...rounds[0], rounds, retrievalReceiptId: result.retrievalReceiptId,
        sourceRefs: result.sourceRefs, degradation: result.degradation, stopReason: result.stopReason,
        legacyHits: result.legacy?.hits.map(hit => ({chunkId: hit.chunkId, documentId: hit.documentId,
          title: hit.title, preview: hit.content.slice(0, 400)})) ?? [],
        supportStatus: 'requires_validation', nextStep: names.context};
    }, {name: names.search,
      description: '检索当前项目的论文、表格行、公式、图和引用。返回每轮本次运行的searchId及真实候选ID，来源身份可持久化但searchId不可跨会话使用；用上下文工具读取完整来源，再验证句子。预览不是已验证结论。',
      schema: scientificSearchToolRequestSchema}),
    tool(async ({searchId, candidateIds, budget}) => {
      active();
      const result = scientificContextResultSchema.parse(await invoke('research.knowledge.scientificContext',
        {search: search(searchId), candidateIds, budget}));
      if (result.projectId !== input.projectId) throw new Error('research_scientific_tool_project_mismatch');
      const sources = new Map<string, QuoteSource>();
      const sourceId = (evidenceId: string, text: string, sourceLocator: ResearchSourceLocator) => {
        const id = `scientific-source:${researchContentHash(JSON.stringify([result.id, evidenceId, text, sourceLocator]))}`;
        sources.set(id, {evidenceId, text, sourceLocator});
        return id;
      };
      const evidence = result.evidence.map(e => ({...e,
        hits: e.hits.map(h => ({...h, sources: h.sources.map(s => ({...s,
          sourceId: sourceId(e.id, s.text, s.locator)}))})),
        passages: e.passages.map(p => ({...p, sourceId: sourceId(e.id, p.text, p.sourceLocator)}))}));
      remember(contexts, result.id, {searchId, context: result, sources}, 16);
      return structuredClone({contextId: result.id, ...result, evidence,
        supportStatus: 'requires_validation', nextStep: names.validate});
    }, {name: names.context,
      description: '从本次searchId读取预算内完整科学对象、原Cell、公式、原文段落与图片哈希。sources和passages含sourceId，quote推荐选择sourceId与selection:"source"，宿主返回完整原文；需要短引文时逐字复制text。candidateIds省略时使用命中；版本变化会拒绝。回答前用contextId验证具体句子。',
      schema: z.object({searchId: z.string().min(1), candidateIds: z.array(z.string().min(1)).max(100).default([]),
        budget: scientificContextBudgetSchema.default(scientificContextBudgetSchema.parse({}))}).strict()}),
    tool(async ({searchId, contextId, statements}) => {
      active();
      const saved = contexts.get(contextId);
      if (!saved || saved.searchId !== searchId) {
        throw new ToolInputParsingException(`research_scientific_context_handle_missing: run ${names.context} with this searchId.`);
      }
      const resolvedQuotes: Array<{statementId: string; sourceId: string} & QuoteSource & {start: number; end: number}> = [];
      const resolved: ScientificStatement[] = statements.map(statement => {
        if (!('sourceId' in statement)) return statement;
        const source = saved.sources.get(statement.sourceId);
        if (!source) throw new ToolInputParsingException(
          `research_scientific_quote_source_handle_missing: use a sourceId from this ${names.context} result.`);
        const text = 'selection' in statement ? source.text : statement.text;
        const start = source.text.indexOf(text);
        if (start < 0) throw new ToolInputParsingException(
          'research_scientific_quote_text_missing: copy exact source text, preserving newlines, punctuation and hyphenation.');
        if (source.text.indexOf(text, start + 1) >= 0) throw new ToolInputParsingException(
          'research_scientific_quote_text_ambiguous: copy a longer exact excerpt that occurs once in this source.');
        const end = start + text.length;
        resolvedQuotes.push({statementId: statement.id, sourceId: statement.sourceId,
          evidenceId: source.evidenceId, text, sourceLocator: source.sourceLocator, start, end});
        return {id: statement.id, kind: 'quote', evidenceId: source.evidenceId, text,
          sourceLocator: source.sourceLocator, start, end};
      });
      const result = scientificEvidenceResultSchema.parse(await invoke('research.knowledge.scientificEvidence',
        {search: search(searchId), context: saved.context, statements: resolved}));
      return resolvedQuotes.length ? structuredClone({...result, resolvedQuotes}) : result;
    }, {name: names.validate,
      description: '回答前重新核对全部来源、版本、Cell、公式和图片字节，再验证具体句子。quote推荐{id,kind:"quote",sourceId,selection:"source"}，直接选择完整原文，宿主返回text、定位和UTF-16偏移。短引文可用{id,kind:"quote",sourceId,text}逐字复制唯一片段；缺失或重复文本会报错。也接受精确sourceLocator/start/end。最终直接引文必须逐字来自返回text；改写只能明确标为转述。table_value只验证原始Cell值；equation只验证完整原LaTeX。自由claim和比较返回证据不足，inference必须保留推断标记。来源有效不代表科学结论已审核。',
      schema: z.object({searchId: z.string().min(1), contextId: z.string().min(1),
        statements: z.array(z.union([sourceSelectionSchema, quoteSelectionSchema, scientificStatementSchema])).max(100)}).strict()})
  ];
}
