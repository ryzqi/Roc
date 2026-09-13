import { tool } from 'langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import { researchLiteratureSearchRequestSchema } from '../../../shared/schemas/research';
import { researchProductionInputContentSchema, researchProductionInputReadSchema, researchProductionInputSchema,
  type ResearchProductionInput } from '../../../shared/schemas/research-production-inputs';
import type { ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult, ResearchLiterature, ResearchStageRun } from '../../../shared/types';
import type { RocCapabilityRegistry } from '../../kernel/types';
import type { ResearchRepository } from './repository';
import type { ResearchExecutionContext } from './run-repository';

export function createResearchRoleTools(input: {
  run: ResearchStageRun;
  context: ResearchExecutionContext;
  repository: ResearchRepository;
  capabilities: RocCapabilityRegistry;
  signal: AbortSignal;
}): StructuredToolInterface[] {
  const assertActive = () => {
    input.signal.throwIfAborted();
    const run = input.repository.runs.requireActive(input.run.id, input.run.projectId);
    if (run.status !== 'running') throw new Error('research_run_not_current');
  };
  const requireInput = (artifactId: string) => {
    assertActive();
    const artifact = input.context.inputs.find((entry) => entry.artifact.id === artifactId);
    if (artifact === undefined) throw new Error('research_artifact_not_in_run_inputs');
    return artifact;
  };
  const factories: Record<string, () => StructuredToolInterface> = {
    inspect_production_input: () => tool(async ({ artifactId, section, offset, limit }) => {
      requireInput(artifactId);
      const result = researchProductionInputSchema.parse(await input.capabilities.invoke('research.artifacts.inspectProduction', {
        projectId: input.run.projectId, artifactId
      }));
      assertActive();
      if (result.artifact.id !== artifactId || result.artifact.projectId !== input.run.projectId) throw new Error('research_production_project_mismatch');
      return { artifactId, section, ...page(JSON.stringify(productionSection(result, section)), offset, limit) };
    }, { name: 'inspect_production_input', description: '查看本次已批准生产输入的实际运行、文件清单或环境摘要。section 选择 summary、files 或 environment，结果按字符分页。',
      schema: z.object({ artifactId: z.string().min(1), section: z.enum(['summary', 'files', 'environment']),
        offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }).strict() }),
    read_production_input_file: () => tool(async ({ artifactId, area, path, offset, limit }) => {
      requireInput(artifactId);
      const result = researchProductionInputContentSchema.parse(await input.capabilities.invoke('research.artifacts.readProductionFile', {
        projectId: input.run.projectId, artifactId, area, path
      }));
      assertActive();
      if (result.file.area !== area || result.file.path !== path) throw new Error('research_production_file_mismatch');
      const binary = result.encoding === 'base64' || result.content.includes('\0') || result.file.path.toLowerCase().endsWith('.pdf');
      if (binary) return { artifactId, file: result.file, binary: true, message: '此文件为二进制；使用对应预览检查视觉内容。' };
      return { artifactId, file: result.file, binary: false, ...page(result.content, offset, limit) };
    }, { name: 'read_production_input_file', description: '按 inspect_production_input 的文件清单读取已批准输入中的文本日志、数据或源码。area/path 必须来自清单；二进制只返回元数据。',
      schema: z.object({ artifactId: z.string().min(1), area: researchProductionInputReadSchema.shape.area, path: researchProductionInputReadSchema.shape.path,
        offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }).strict() }),
    read_review_report: () => tool(async ({ artifactId, offset, limit }) => {
      assertActive();
      const report = input.context.reviewReports.find((entry) => entry.artifactId === artifactId);
      if (report === undefined) throw new Error('research_review_report_not_in_context');
      return { artifactId, ...page(JSON.stringify(report), offset, limit) };
    }, { name: 'read_review_report', description: '综合角色分页读取本轮已完成的独立评审报告。',
      schema: z.object({ artifactId: z.string().min(1), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }).strict() }),
    search_knowledge: () => tool(async ({ query, limit }) => {
      assertActive();
      const result = await input.capabilities.invoke<ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult>('research.knowledge.search', {
        projectId: input.run.projectId, query, limit, embeddingConfigId: null
      });
      assertActive();
      return { ...result, hits: result.hits.map((hit) => ({ ...hit, content: hit.content.slice(0, 8000), contentChars: hit.content.length })) };
    }, { name: 'search_knowledge', description: '检索本项目与全局文献材料，返回真实 chunkId 和来源定位。',
      schema: z.object({ query: z.string().trim().min(1).max(1000), limit: z.number().int().min(1).max(10) }).strict() }),
    capture_evidence: () => tool(async ({ chunkId }) => {
      assertActive();
      const evidence = input.repository.evidence.capture({ projectId: input.run.projectId, chunkId });
      return { ...evidence, excerpt: evidence.excerpt.slice(0, 8000), excerptChars: evidence.excerpt.length };
    }, { name: 'capture_evidence', description: '从真实知识库片段保存带定位的证据快照，返回可用于主张的 evidenceId。',
      schema: z.object({ chunkId: z.string().min(1) }).strict() }),
    list_evidence: () => tool(async ({ offset, limit }) => {
      assertActive();
      const evidence = input.repository.evidence.list(input.run.projectId);
      return { total: evidence.length, items: evidence.slice(offset, offset + limit).map((entry) => ({
        ...entry, excerpt: entry.excerpt.slice(0, 2000), excerptChars: entry.excerpt.length
      })) };
    }, { name: 'list_evidence', description: '分页读取本项目已保存证据及其准确 ID、定位和原文。',
      schema: z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20) }).strict() }),
    read_artifact: () => tool(async ({ artifactId, offset, limit }) => {
      const artifact = requireInput(artifactId);
      return { artifactId, ...page(JSON.stringify(artifact), offset, limit) };
    }, { name: 'read_artifact', description: '分页读取本次运行固定的已批准输入产物，保留其原始内容和证据引用。',
      schema: z.object({ artifactId: z.string().min(1), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }).strict() }),
    search_literature: () => tool(async (request) => {
      assertActive();
      const records = await input.capabilities.invoke<typeof request, ResearchLiterature[]>('research.literature.search', request);
      assertActive();
      return records.map((record) => ({ ...record, abstract: record.abstract?.slice(0, 4000) ?? null }));
    }, { name: 'search_literature', description: '通过开放学术 API 查找文献；真实摘要自动进入全局知识库，之后可检索和捕获证据。',
      schema: researchLiteratureSearchRequestSchema })
  };
  return input.run.toolNames.map((name) => {
    const factory = factories[name];
    if (factory === undefined) throw new Error('research_role_tool_unavailable');
    return factory();
  });
}

function page(content: string, offset: number, limit: number) {
  return { content: content.slice(offset, offset + limit), totalChars: content.length,
    nextOffset: offset + limit < content.length ? offset + limit : null };
}

function productionSection(input: ResearchProductionInput, section: 'summary' | 'files' | 'environment'): unknown {
  if (section === 'files') return input.files;
  const source = input.source;
  if (source.kind === 'export') {
    if (section === 'environment') return { toolchainHash: source.execution.toolchainHash, detailsFile: { area: 'bundle', path: 'manifest.json' } };
    return { artifact: input.artifact, kind: source.kind, exportId: source.execution.id, request: source.execution.request,
      sourceHash: source.execution.sourceHash, status: source.execution.status, createdAt: source.execution.createdAt, endedAt: source.execution.endedAt };
  }
  if (section === 'environment') return source.execution.environment;
  return { artifact: input.artifact, kind: source.kind, runId: source.execution.id, request: source.execution.request,
    inputHash: source.execution.inputHash, status: source.execution.status, startedAt: source.execution.startedAt, endedAt: source.execution.endedAt,
    ...(source.kind === 'figure' ? { figureId: source.figure.id, validation: source.figure.validation } : {}) };
}
