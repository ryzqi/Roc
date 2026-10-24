import { tool } from 'langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import { createLiteratureTools } from '../agent/literature-tools';
import { researchOwnedExperimentStartSchema } from '../../../shared/schemas/research-experiments';
import { researchOwnedFigureStartSchema } from '../../../shared/schemas/research-figures';
import { researchOwnedExportPrepareSchema } from '../../../shared/schemas/research-exports';
import { researchProductionInputContentSchema, researchProductionInputReadSchema, researchProductionInputSchema,
  type ResearchProductionInput } from '../../../shared/schemas/research-production-inputs';
import type { ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult, ResearchStageRun } from '../../../shared/types';
import type { RocCapabilityRegistry } from '../../kernel/types';
import type { ResearchProductionEffectService } from './production-effects';
import type { ResearchRepository } from './repository';
import type { ResearchExecutionContext } from './run-repository';

export function createResearchRoleTools(input: {
  run: ResearchStageRun;
  context: ResearchExecutionContext;
  repository: ResearchRepository;
  capabilities: RocCapabilityRegistry;
  signal: AbortSignal;
  effects?: ResearchProductionEffectService;
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
  const effects = () => {
    assertActive();
    if (input.effects === undefined) throw new Error('research_production_effects_unavailable');
    return input.effects;
  };
  const after = <T>(value: T): T => { assertActive(); return value; };
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
    read_workspace_file: () => tool(async ({ path, offset, limit }) => {
      const file = await effects().readWorkspaceFile(input.run.id, input.run.projectId, path);
      return after({ path: file.path, sha256: file.sha256, revision: file.revision, ...page(file.content, offset, limit) });
    }, { name: 'read_workspace_file', description: '读取当前项目内的脚本或数据文本。项目身份由服务绑定；结果按字符分页。',
      schema: z.object({ path: z.string().min(1), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }).strict() }),
    save_workspace_file: () => tool(async ({ path, content, expectedHash }) => {
      const file = await effects().saveWorkspaceFile(input.run.id, input.run.projectId, { path, content, expectedHash });
      return after({ path: file.path, sha256: file.sha256, size: file.size, revision: file.revision });
    }, { name: 'save_workspace_file', description: '按 expectedHash 写入当前项目脚本或数据。新建传 null；冲突或取消后的迟到写入会被拒绝。',
      schema: z.object({ path: z.string().min(1), content: z.string().max(1024 * 1024), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable() }).strict() }),
    start_experiment: () => tool(async (request) => {
      const started = await effects().startExperiment(input.run.id, input.run.projectId, request);
      return after(summarizeExperiment(started));
    }, { name: 'start_experiment', description: '启动当前项目的脚本实验。项目和运行身份由服务绑定；相同 requestId 重复提交返回已有运行。',
      schema: researchOwnedExperimentStartSchema }),
    start_figure: () => tool(async (request) => {
      const started = await effects().startFigure(input.run.id, input.run.projectId, request);
      return after(summarizeExperiment(started));
    }, { name: 'start_figure', description: '启动当前项目的图稿渲染。项目和运行身份由服务绑定；相同 requestId 重复提交返回已有运行。',
      schema: researchOwnedFigureStartSchema }),
    get_experiment: () => tool(async ({ experimentId }) => {
      return after(summarizeExperiment(effects().getExperiment(input.run.id, input.run.projectId, experimentId)));
    }, { name: 'get_experiment', description: '读取本次运行创建的实验或绘图执行状态，不含二进制内容。',
      schema: z.object({ experimentId: z.string().min(1) }).strict() }),
    publish_experiment: () => tool(async ({ experimentId }) => {
      const published = await effects().publishExperiment(input.run.id, input.run.projectId, experimentId);
      return after(summarizeExperiment(published));
    }, { name: 'publish_experiment', description: '发布本次运行完成的实验。取消或替换后的迟到发布会被拒绝。',
      schema: z.object({ experimentId: z.string().min(1) }).strict() }),
    publish_figure: () => tool(async ({ experimentId, replacesFigureId }) => {
      const published = await effects().publishFigure(input.run.id, input.run.projectId, experimentId, replacesFigureId);
      return after({ figureId: published.id, artifactId: published.artifactId, runId: published.runId, status: published.status, replacesFigureId: published.replacesFigureId });
    }, { name: 'publish_figure', description: '把本次运行完成的绘图执行为图稿。replacesFigureId 指向被替换的草稿；取消后不能发布。',
      schema: z.object({ experimentId: z.string().min(1), replacesFigureId: z.string().min(1).nullable() }).strict() }),
    read_template_file: () => tool(async ({ templateId, path, offset, limit }) => {
      const file = await effects().readTemplateFile(input.run.id, input.run.projectId, { templateId, path });
      return after({ path: file.path, sha256: file.sha256, ...page(file.content, offset, limit) });
    }, { name: 'read_template_file', description: '读取当前项目已导入模板中的可编辑文本。',
      schema: z.object({ templateId: z.string().min(1), path: z.string().min(1), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }).strict() }),
    save_template_file: () => tool(async ({ templateId, path, content, expectedHash }) => {
      const file = await effects().saveTemplateFile(input.run.id, input.run.projectId, { templateId, path, content, expectedHash });
      return after({ path: file.path, sha256: file.sha256, size: file.size });
    }, { name: 'save_template_file', description: '按 expectedHash 修改当前项目模板。新建传 null；版本冲突或取消后的迟到写入会被拒绝。',
      schema: z.object({ templateId: z.string().min(1), path: z.string().min(1), content: z.string().max(1024 * 1024),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable() }).strict() }),
    compile_template: () => tool(async ({ templateId }) => {
      const template = await effects().compileTemplate(input.run.id, input.run.projectId, templateId);
      return after({ templateId: template.id, revision: template.revision, status: template.status, errors: template.errors });
    }, { name: 'compile_template', description: '编译当前项目模板。取消后的迟到编译结果不会写回。',
      schema: z.object({ templateId: z.string().min(1) }).strict() }),
    prepare_export: () => tool(async (request) => {
      const started = await effects().prepareExport(input.run.id, input.run.projectId, request);
      return after(summarizeExport(started));
    }, { name: 'prepare_export', description: '准备当前项目的最终导出。项目和运行身份由服务绑定；相同 requestId 重复提交返回已有作业。',
      schema: researchOwnedExportPrepareSchema }),
    get_export: () => tool(async ({ exportId }) => {
      return after(summarizeExport(effects().getExport(input.run.id, input.run.projectId, exportId)));
    }, { name: 'get_export', description: '读取本次运行创建的导出作业状态。',
      schema: z.object({ exportId: z.string().min(1) }).strict() }),
    publish_export: () => tool(async ({ exportId, replacesExportId }) => {
      const published = await effects().publishExport(input.run.id, input.run.projectId, exportId, replacesExportId);
      return after(summarizeExport(published));
    }, { name: 'publish_export', description: '把本次运行准备好的导出关联到审核闸门。不能交付最终文件或宣称已批准。',
      schema: z.object({ exportId: z.string().min(1), replacesExportId: z.string().min(1).nullable() }).strict() })
  };
  const literatureTools = createLiteratureTools(input.capabilities, {
    owner: `stage:${input.run.id}`, projectId: input.run.projectId, runId: input.run.id, signal: input.signal, assertActive
  }, { search: 'search_literature', read: 'read_literature_search', add: 'add_literature', get: 'get_literature_import', cancel: 'cancel_literature_import' });
  for (const entry of literatureTools) factories[entry.name] = () => entry;
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

function summarizeExperiment(run: { id: string; request: { requestId: string }; ownerRunId: string | null; status: string; error: string | null; artifactId: string | null; files: unknown[] }) {
  return { experimentId: run.id, requestId: run.request.requestId, ownerRunId: run.ownerRunId, status: run.status, error: run.error,
    artifactId: run.artifactId, fileCount: run.files.length };
}

function summarizeExport(record: { id: string; request: { requestId: string }; ownerRunId: string | null; status: string; error: string | null; artifactId: string | null; approval: string }) {
  return { exportId: record.id, requestId: record.request.requestId, ownerRunId: record.ownerRunId, status: record.status, error: record.error,
    artifactId: record.artifactId, approval: record.approval };
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
