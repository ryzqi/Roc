import {tool, ToolInputParsingException, type StructuredToolInterface} from '@langchain/core/tools';
import type {RocCapabilityRegistry} from '../../kernel/types';
import type {ResearchRepository} from './repository';
import {paperDeepKnowledgeRequestSchema} from '../../../shared/schemas/research-paper-deep-knowledge';
import {scientificExtractionJobSchema} from '../../../shared/schemas/research-scientific-extraction';
import {paperCardKnowledgeReadRequestSchema, paperCardKnowledgeSchema} from '../../../shared/schemas/research-paper-card-knowledge';

export function createRoleDeepKnowledgeTools(input: {projectId: string; frozen: boolean; signal: AbortSignal;
  repository: ResearchRepository; capabilities: RocCapabilityRegistry; assertActive(): void}): StructuredToolInterface[] {
  const guard = (documentId: string): void => {
    input.assertActive();
    if (input.frozen) throw new ToolInputParsingException('research_scientific_frozen_review_scope: use the frozen review evidence only.');
    input.repository.scientificExtraction.authorizeDocument(input.projectId, documentId);
  };
  const invoke = async (capability: string, request: {documentId: string}): Promise<unknown> => {
    guard(request.documentId);
    try {
      const result = await input.capabilities.invoke(capability, {...request, projectId: input.projectId}, input.signal);
      guard(request.documentId);
      return result;
    } catch (error) {input.assertActive(); throw error;}
  };
  const boundJob = (job: ReturnType<typeof scientificExtractionJobSchema.parse>, documentId: string): void => {
    if (job.snapshot.projectId !== input.projectId || job.snapshot.source.paperIR.identity.documentId !== documentId) {
      throw new Error('research_deep_tool_binding_invalid');
    }
  };
  return [tool(async request => {
    const job = scientificExtractionJobSchema.parse(await invoke('research.knowledge.deepRequest', request));
    boundJob(job, request.documentId);
    const {documentId: _documentId, ...selection} = request;
    if (JSON.stringify(job.snapshot.deepRequest) !== JSON.stringify(selection)) throw new Error('research_deep_tool_binding_invalid');
    return job;
  }, {name: 'request_paper_deep_knowledge',
    description: '按阅读、写作或比较目标请求当前项目论文深读；限定相关章节/对象和维度，返回异步作业，不等待生成。普通概览先读现有知识；缺失内容仍unknown，生成不等于人工审核。',
    schema: paperDeepKnowledgeRequestSchema.omit({projectId: true})}), tool(async request => {
    const result = paperCardKnowledgeSchema.parse(await invoke('research.knowledge.deepRead', request));
    if (result.documentId !== request.documentId || result.currentPaperIR &&
      result.currentPaperIR.identity.documentId !== request.documentId) throw new Error('research_deep_tool_binding_invalid');
    for (const job of [result.latestJob, result.publishedJob]) if (job) boundJob(job, request.documentId);
    if (request.generationId !== null && result.publishedJob && result.publishedJob.id !== request.generationId) {
      throw new Error('research_deep_tool_binding_invalid');
    }
    return {...result, scientificApproval: 'unreviewed',
      instruction: '保留作者陈述、来源推导、模型推断与unknown；stale不能作当前证据，正式写作须核对原文Evidence和人工Claim支持。'};
  }, {name: 'read_paper_deep_knowledge', description: '读取本项目论文已有结构化和深读知识、原始科学对象与缺口。generationId为null读取当前发布；缺失时按问题请求深读，禁止把旧发布当成当前支持。',
    schema: paperCardKnowledgeReadRequestSchema.omit({projectId: true})})];
}
