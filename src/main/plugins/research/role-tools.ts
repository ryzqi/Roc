import { tool } from 'langchain';
import { ToolInputParsingException, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import { createLiteratureTools } from '../agent/literature-tools';
import { researchOwnedExperimentStartSchema, researchExperimentEnvironmentRequestSchema,
  researchExperimentEnvironmentSchema, researchExperimentFileRequestSchema } from '../../../shared/schemas/research-experiments';
import { researchOwnedFigureStartSchema, researchFigureRendererEnvironmentSchema } from '../../../shared/schemas/research-figures';
import { researchOwnedExportPrepareSchema } from '../../../shared/schemas/research-exports';
import { researchProductionInputContentSchema, researchProductionInputReadSchema, researchProductionInputSchema,
  type ResearchProductionInput } from '../../../shared/schemas/research-production-inputs';
import type { ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult, ResearchStageRun } from '../../../shared/types';
import type { RocCapabilityRegistry } from '../../kernel/types';
import { RocDomainError } from '../../services/errors';
import type { ResearchProductionEffectService } from './production-effects';
import type { ResearchRepository } from './repository';
import type { ResearchExecutionContext } from './run-repository';
import { requireConfirmedSearchStrategy } from './search-strategy';
import {relationClaimHash, relationSourceDigest} from './evidence-relation-repository';
import {knowledgeSearchView} from './knowledge-consumption';

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
    if (JSON.stringify(run.toolNames) !== JSON.stringify(input.run.toolNames) || run.skillHash !== input.run.skillHash ||
        JSON.stringify(input.context) !== JSON.stringify(input.repository.runs.getContext(run.id))) {
      throw new Error('research_role_tool_binding_invalid');
    }
  };
  assertActive();
  const requireInput = (artifactId: string) => {
    assertActive();
    const artifact = input.context.inputs.find((entry) => entry.artifact.id === artifactId);
    if (artifact === undefined) {
      // Semantic argument validation is recoverable by the model; runtime fencing above remains fatal.
      throw new ToolInputParsingException(`research_artifact_not_in_run_inputs: use only approved artifact IDs ${JSON.stringify(input.context.inputs.map(entry => entry.artifact.id))}. Paper IDs and evidence IDs are not artifact IDs.`);
    }
    return artifact;
  };
  const requireProductionInput = (artifactId: string) => {
    const entry = requireInput(artifactId);
    if (!['experiment_run', 'figure', 'export_package'].includes(entry.artifact.kind)) {
      throw new ToolInputParsingException(`research_production_artifact_required: artifact ${artifactId} has kind ${entry.artifact.kind}. Production tools accept only experiment_run, figure, or export_package inputs. Use read_artifact for manuscript and other structured artifact content; use read_workspace_file for project source files.`);
    }
    return entry;
  };
  const effects = () => {
    assertActive();
    if (input.effects === undefined) throw new Error('research_production_effects_unavailable');
    return input.effects;
  };
  const after = <T>(value: T): T => { assertActive(); return value; };
  const scientificInput = input.run.stage === 'review' && input.run.parentRunId !== null
    ? input.context.scientificInput : undefined;
  const reportReadRanges = new Map<string, Array<{start: number; end: number}>>();
  const frozenEvidence = (evidenceId: string) => {
    const source = scientificInput?.evidence.find(source => source.evidence.id === evidenceId);
    if (source === undefined) {
      throw new ToolInputParsingException('research_evidence_not_in_run_inputs: use list_evidence to obtain an exact evidenceId from this review\'s frozen inputs. IDs from manuscript references or other project material may not be available to this review.');
    }
    return source;
  };
  const factories: Record<string, () => StructuredToolInterface> = {
    read_source_migrations: () => tool(async ({evidenceId, offset, limit}) => {
      assertActive();
      const records = input.repository.evidence.sourceMigrations.list({projectId: input.run.projectId, evidenceId});
      return {evidenceId, ...page(JSON.stringify(records), offset, limit)};
    }, {name: 'read_source_migrations', description: '分页读取本项目同文档重解析的固定定位候选、用户捕获或拒绝决定及当前目标状态。候选与新位置均不表示科学支持已确认。',
      schema: z.object({evidenceId: z.string().min(1), offset: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(8000)}).strict()}),
    read_source_replacements: () => tool(async ({evidenceId, offset, limit}) => {
      assertActive();
      const records = input.repository.evidence.sourceReplacements.list({projectId: input.run.projectId, evidenceId});
      return {evidenceId, ...page(JSON.stringify(records), offset, limit)};
    }, {name: 'read_source_replacements', description: '分页读取本项目用户明确选定的文档替代或实验重跑前后关联、两端固定来源及完整输入/环境/输出快照。包含该证据作为前序或新来源的记录；选择时needs_review与当前来源状态分开，不表示科学等价或当前人工批准。',
      schema: z.object({evidenceId: z.string().min(1), offset: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(8000)}).strict()}),
    inspect_evidence_source: () => tool(async ({evidenceId, offset, limit, quote}) => {
      assertActive();
      const source = scientificInput === undefined ? input.repository.evidence.inspectEvidence(evidenceId, input.run.projectId)
        : frozenEvidence(evidenceId);
      const sourceDigest = relationSourceDigest(source), excerpt = source.evidence.excerpt;
      let start = Math.min(offset, excerpt.length), end = Math.min(start + limit, excerpt.length);
      const exactQuote = quote !== undefined && quote !== null;
      if (exactQuote) {
        start = excerpt.indexOf(quote);
        if (start < 0) {
          throw new ToolInputParsingException('research_evidence_quote_not_found: quote must be copied verbatim from this evidence.excerpt in the frozen review input, including whitespace. Metadata and source-file text outside that excerpt are not citation targets. Read excerptPage with offset/limit, then retry with an exact quote or copy its reference.');
        }
        if (excerpt.indexOf(quote, start + 1) >= 0) {
          throw new ToolInputParsingException('research_evidence_quote_ambiguous: quote occurs more than once in this evidence.excerpt. Include enough surrounding verbatim context to identify one occurrence, or use offset/limit to copy the intended excerptPage.reference.');
        }
        end = start + quote.length;
      }
      // JSON content offsets are not evidence.excerpt offsets. Expose the raw page's exact
      // reference so a reviewer can copy it without counting escaped JSON or UTF-16 units.
      return {evidenceId, sourceDigest, referenceStatus: source.referenceStatus,
        excerptPage: {mode: exactQuote ? 'quote' : 'page', totalChars: excerpt.length,
          nextOffset: !exactQuote && end < excerpt.length ? end : null,
          reference: start < end ? {evidenceId, sourceDigest, start, end, quote: excerpt.slice(start, end)} : null},
        ...page(JSON.stringify(source), offset, limit)};
    }, {name: 'inspect_evidence_source', description: '读取固定证据。quote传原文中足够且唯一的精确片段（保留空白），返回其准确excerptPage.reference；不匹配或不唯一会明确报错。quote省略或null时，offset/limit对原文excerptPage分页。科学引用完整复制reference的sourceDigest/start/end/quote，不能截短quote后沿用整页偏移。start/end是evidence.excerpt内UTF-16偏移，不是JSON或源文件位置。content另按offset/limit分页展示JSON元数据，其nextOffset与excerptPage.nextOffset互不相干；quote查找只针对excerpt，不受元数据分页影响。superseded来源只能核查历史，不能当作当前支持。',
      schema: z.object({evidenceId: z.string().min(1), offset: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(8000),
        quote: z.string().min(1).max(8000).nullable().optional()}).strict()}),
    list_evidence_relations: () => tool(async ({claimId, offset, limit}) => {
      assertActive();
      if (scientificInput !== undefined && claimId !== null && !scientificInput.claims.some(claim => claim.id === claimId)) {
        throw new ToolInputParsingException('research_claim_not_in_run_inputs: use an exact claim ID from this review\'s frozen manuscript, available through read_artifact. Use claimId: null to list only frozen relations and obtain their claim IDs. Historical IDs and shortened prefixes are not available in this review.');
      }
      const relations = (() => {
        if (scientificInput !== undefined) return scientificInput.relations.filter(relation => claimId === null || relation.claimId === claimId);
        try {
          return input.repository.evidence.relations.list({projectId: input.run.projectId, claimId});
        } catch (error) {
          if (error instanceof Error && error.message === 'research_claim_not_found') {
            throw new ToolInputParsingException('research_claim_not_found: claimId must be an exact claim ID, not an evidence ID or artifact ID. Use claimId: null to list all relations in this project and obtain their claim IDs.');
          }
          throw error;
        }
      })();
      return {total: relations.length, items: relations.slice(offset, offset + limit).map(relation => ({
        id: relation.id, claimId: relation.claimId, claimVersion: relation.claimVersion,
        evidenceId: relation.evidenceId, kind: relation.kind, status: relation.status, condition: relation.condition,
        version: relation.version, sourceDigest: relation.sourceDigest, proposer: relation.proposer,
        reviewer: relation.reviewer, reviewedAt: relation.reviewedAt, invalidatedReason: relation.invalidatedReason,
        excerpt: relation.source.evidence.excerpt.slice(0, 2000), excerptChars: relation.source.evidence.excerpt.length
      }))};
    }, {name: 'list_evidence_relations', description: '分页读取本项目真实主张关系。claimId传null读取全部关系，或传返回的准确主张ID；不能传evidenceId或artifactId。proposed是推断，historical未经语义审核，confirmed仅表示所列用户审核了捕获版本；不能把关联或模型解释当作人工确认。',
      schema: z.object({claimId: z.string().min(1).nullable(), offset: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(20)}).strict()}),
    inspect_production_input: () => tool(async ({ artifactId, section, offset, limit }) => {
      requireProductionInput(artifactId);
      const result = researchProductionInputSchema.parse(await input.capabilities.invoke('research.artifacts.inspectProduction', {
        projectId: input.run.projectId, artifactId
      }));
      assertActive();
      if (result.artifact.id !== artifactId || result.artifact.projectId !== input.run.projectId) throw new Error('research_production_project_mismatch');
      return { artifactId, section, ...page(JSON.stringify(productionSection(result, section)), offset, limit) };
    }, { name: 'inspect_production_input', description: '仅查看本次已批准 experiment_run、figure、export_package 输入的实际运行、文件清单或环境摘要；稿件使用 read_artifact。section 选择 summary、files 或 environment，结果按字符分页。',
      schema: z.object({ artifactId: z.string().min(1), section: z.enum(['summary', 'files', 'environment']),
        offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }).strict() }),
    read_production_input_file: () => tool(async ({ artifactId, area, path, offset, limit }) => {
      requireProductionInput(artifactId);
      const content = await input.capabilities.invoke('research.artifacts.readProductionFile', {
        projectId: input.run.projectId, artifactId, area, path
      }).catch((error: unknown) => {
        assertActive();
        if (error instanceof Error && error.message === 'research_production_file_not_found') {
          throw new ToolInputParsingException('research_production_file_not_found: area/path must exactly match a file in this approved artifact manifest. Use inspect_production_input with section: "files" to obtain the actual area/path; do not infer paths from prose or evidence titles. No file content was read.');
        }
        throw error;
      });
      const result = researchProductionInputContentSchema.parse(content);
      assertActive();
      if (result.file.area !== area || result.file.path !== path) throw new Error('research_production_file_mismatch');
      const binary = result.encoding === 'base64' || result.content.includes('\0') || result.file.path.toLowerCase().endsWith('.pdf');
      if (binary) return { artifactId, file: result.file, binary: true, message: '此文件为二进制；使用对应预览检查视觉内容。' };
      return { artifactId, file: result.file, binary: false, ...page(result.content, offset, limit) };
    }, { name: 'read_production_input_file', description: '仅按 inspect_production_input 的文件清单读取已批准 experiment_run、figure、export_package 输入中的文本日志、数据或源码。稿件使用 read_artifact，项目源码使用 read_workspace_file。area/path 必须来自清单；二进制只返回元数据。',
      schema: z.object({ artifactId: z.string().min(1), area: researchProductionInputReadSchema.shape.area, path: researchProductionInputReadSchema.shape.path,
        offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }).strict() }),
    read_review_report: () => tool(async ({ artifactId, offset, limit }) => {
      assertActive();
      const report = input.context.reviewReports.find((entry) => entry.artifactId === artifactId);
      if (report === undefined) throw new Error('research_review_report_not_in_context');
      const result = page(JSON.stringify(report), offset, limit);
      const ranges = reportReadRanges.get(artifactId) ?? [];
      ranges.push({start: offset, end: offset + result.content.length});
      reportReadRanges.set(artifactId, ranges);
      const reports = input.context.reviewReports.map(entry => {
        let coveredThrough = 0;
        for (const range of [...(reportReadRanges.get(entry.artifactId) ?? [])].sort((a, b) => a.start - b.start)) {
          if (range.start > coveredThrough) break;
          coveredThrough = Math.max(coveredThrough, range.end);
        }
        const complete = coveredThrough >= JSON.stringify(entry).length;
        return {artifactId: entry.artifactId, complete, nextUnreadOffset: complete ? null : coveredThrough};
      });
      const allReportsRead = reports.every(entry => entry.complete);
      return { artifactId, ...result, readProgress: {reports, allReportsRead,
        nextAction: allReportsRead
          ? 'All independent reports have been read completely. Retain their findings and disagreements and submit the structured synthesis now. Do not restart report pagination.'
          : 'Continue from each report nextUnreadOffset until all reports are complete; retain previously read pages.'} };
    }, { name: 'read_review_report', description: '综合角色分页读取本轮已完成的独立评审报告。按nextOffset继续；readProgress记录实际连续读取范围，allReportsRead后提交结构化总评。',
      schema: z.object({ artifactId: z.string().min(1), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }).strict() }),
    search_knowledge: () => tool(async ({ query, limit, withContext }) => {
      assertActive();
      if (scientificInput !== undefined) {
        const terms = query.toLocaleLowerCase().split(/\s+/u);
        const matches = scientificInput.evidence.filter(source => terms.some(term => source.evidence.excerpt.toLocaleLowerCase().includes(term)));
        return [{scope: 'frozen_review_evidence', total: matches.length, hits: matches.slice(0, limit).map(source => ({
          evidenceId: source.evidence.id, sourceDigest: relationSourceDigest(source),
          excerpt: source.evidence.excerpt.slice(0, 8000), excerptChars: source.evidence.excerpt.length
        }))}, null];
      }
      const result = await input.capabilities.invoke<ResearchKnowledgeSearchRequest, ResearchKnowledgeSearchResult>('research.knowledge.search', {
        projectId: input.run.projectId, query, limit, embeddingConfigId: null
      }).catch((error: unknown) => {
        assertActive();
        if (error instanceof RocDomainError && error.code === 'research_embedding_key_unavailable') {
          throw new ToolInputParsingException('research_embedding_key_unavailable: 无法读取嵌入模型密钥，请由用户在「设置 → 向量与 RAG」重新录入密钥并保存。No search results were obtained. Do not retry until the user restores the credential. Use already available evidence only if sufficient, and explicitly retain this search limitation; otherwise report that the required source could not be examined.');
        }
        throw error;
      });
      assertActive();
      const view = knowledgeSearchView(result);
      return [{...view, hits: view.hits.map(hit => ({...hit,
        ...(withContext ? {context: input.repository.knowledge.readContext({projectId: input.run.projectId,
          chunkId: hit.chunkId, expectedIndexedVersion: hit.indexedVersion, maxChars: Math.floor(8000 / limit), neighbors: true})} : {})
      }))}, result.ranking];
    }, { name: 'search_knowledge', responseFormat: 'content_and_artifact', description: '检索本项目与全局文献材料，返回真实 chunkId 和来源定位。withContext 可读取命中父段的原文上下文，总预算 8000 字符；上下文不能冒充新的证据，捕获仍使用 chunkId。冻结评审仅返回固定输入。',
      schema: z.object({ query: z.string().trim().min(1).max(1000), limit: z.number().int().min(1).max(10), withContext: z.boolean().optional() }).strict() }),
    capture_evidence: () => tool(async ({ chunkId }) => {
      assertActive();
      const evidence = input.repository.evidence.capture({ projectId: input.run.projectId, chunkId });
      return { ...evidence, excerpt: evidence.excerpt.slice(0, 8000), excerptChars: evidence.excerpt.length };
    }, { name: 'capture_evidence', description: '从真实知识库片段保存带定位的证据快照，返回可用于主张的 evidenceId。',
      schema: z.object({ chunkId: z.string().min(1) }).strict() }),
    list_evidence: () => tool(async ({ offset, limit }) => {
      assertActive();
      const evidence = scientificInput === undefined ? input.repository.evidence.list(input.run.projectId)
        : scientificInput.evidence.map(source => source.evidence);
      return { total: evidence.length, items: evidence.slice(offset, offset + limit).map((entry) => ({
        ...entry, excerpt: entry.excerpt.slice(0, 2000), excerptChars: entry.excerpt.length
      })) };
    }, { name: 'list_evidence', description: '分页读取本项目已保存证据及其准确 ID、定位和原文。',
      schema: z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(20) }).strict() }),
    read_artifact: () => tool(async ({ artifactId, offset, limit }) => {
      const artifact = requireInput(artifactId);
      const material = scientificInput?.manuscript.artifactId === artifactId ? {...artifact,
        claims: scientificInput.claims.map(claim => ({...claim, claimHash: relationClaimHash(claim)}))} : artifact;
      return { artifactId, ...page(JSON.stringify(material), offset, limit) };
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
    list_python_environments: () => tool(async ({ offset, limit }) => {
      assertActive();
      const selections = input.repository.pythonEnvironments.list({ projectId: input.run.projectId });
      return { total: selections.length, items: selections.slice(offset, offset + limit).map(({ snapshot, snapshotHash }) => ({
        runtime: { kind: 'python', selectionId: snapshot.id, expectedHash: snapshotHash },
        version: snapshot.version, platform: snapshot.platform, architecture: snapshot.architecture,
        recordedAt: snapshot.recordedAt, codeHash: snapshot.codeHash, lockFile: snapshot.lockFile
      })) };
    }, { name: 'list_python_environments', description: '分页读取当前项目由用户明确选择的 Python 环境身份。历史选择不证明环境当前可用；启动前用 inspect_experiment_environment 取得当前环境哈希。没有选择时请用户在项目管理中选择环境。',
      schema: z.strictObject({ offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(10) }) }),
    inspect_experiment_environment: () => tool(async ({ runtime, offset, limit }) => {
      assertActive();
      const environment = researchExperimentEnvironmentSchema.parse(await input.capabilities.invoke('research.experiment.environment', {
        projectId: input.run.projectId, runtime
      }));
      assertActive();
      if (JSON.stringify(environment.runtime) !== JSON.stringify(runtime)) throw new Error('research_experiment_runtime_mismatch');
      return { runtime: environment.runtime, expectedEnvironmentHash: environment.hash, version: environment.version,
        platform: environment.platform, architecture: environment.architecture,
        ...page(JSON.stringify(environment), offset, limit) };
    }, { name: 'inspect_experiment_environment', description: '在本项目重新核验实验环境，返回 start_experiment 的 expectedEnvironmentHash 和分页环境报告。Python runtime 必须使用 list_python_environments 返回的选择身份；探针不安装依赖或创建实验。失败需解决环境后重新预览。',
      schema: z.strictObject({ runtime: researchExperimentEnvironmentRequestSchema.shape.runtime,
        offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000) }) }),
    start_experiment: () => tool(async (request) => {
      const started = await effects().startExperiment(input.run.id, input.run.projectId, request);
      return after(summarizeExperiment(started));
    }, { name: 'start_experiment', description: '启动当前项目的脚本实验。Python 先读取用户选择并预览环境，明确 source:{kind:"file",path} 或冻结 Notebook 的 source:{kind:"notebook",notebookId,expectedHash,subsetVersion:1}、sourceVersion:1、uint32 seed、arguments 和 expectedEnvironmentHash。项目和运行身份由服务绑定；同一冻结节点的相同业务参数返回已有结果，requestId 变化不重复执行。',
      schema: researchOwnedExperimentStartSchema }),
    inspect_figure_environment: () => tool(async () => {
      assertActive();
      const environment = researchFigureRendererEnvironmentSchema.parse(await input.capabilities.invoke('research.figure.environment', {
        projectId: input.run.projectId
      }));
      return after({ ...environment, expectedEnvironmentHash: environment.hash });
    }, { name: 'inspect_figure_environment', description: '读取当前项目真实 Vega-Lite 渲染环境；将 expectedEnvironmentHash 原样用于 start_figure。实验环境或文件的哈希不能代替渲染环境哈希。此查询不创建图稿。',
      schema: z.strictObject({}) }),
    start_figure: () => tool(async (request) => {
      const started = await effects().startFigure(input.run.id, input.run.projectId, request);
      return after(summarizeFigure(started));
    }, { name: 'start_figure', description: '启动当前项目的 Vega-Lite 图稿渲染；sourcePath 为 .vl.json。先用 inspect_figure_environment 读取 expectedEnvironmentHash，不能使用实验环境或文件哈希。项目和运行身份由服务绑定；同一冻结节点的相同业务参数返回已有运行。',
      schema: researchOwnedFigureStartSchema }),
    get_experiment: () => tool(async ({ experimentId, fileOffset = 0, file }) => {
      const execution = (() => {
        try {
          return effects().getExperiment(input.run.id, input.run.projectId, experimentId);
        } catch (error) {
          assertActive();
          if (error instanceof Error && error.message === 'research_experiment_not_found') {
            throw new ToolInputParsingException('research_experiment_not_found: use the exact full experimentId returned by start_experiment. Short prefixes and IDs copied from source comments are not valid.');
          }
          throw error;
        }
      })();
      const summary = { ...summarizeExperiment(execution), files: execution.files.slice(fileOffset, fileOffset + 50),
        nextFileOffset: fileOffset + 50 < execution.files.length ? fileOffset + 50 : null };
      if (file === undefined) return after(summary);
      const result = await effects().readExperimentFile(input.run.id, input.run.projectId, experimentId,
        { area: file.area, path: file.path });
      assertActive();
      if (result.encoding !== 'utf8') throw new ToolInputParsingException('research_experiment_text_required: select a UTF-8 text file from files.');
      return after({ ...summary, file: { ...result.file, ...page(result.content, file.offset, file.limit) } });
    }, { name: 'get_experiment', description: '读取本次阶段创建的脚本实验状态与文件列表，每页50项；fileOffset续读列表。可选file按字符分页读取真实input/output/log文本。failed、cancelled、interrupted为终态，停止轮询并读取log/stderr.txt诊断；成功后读取输出核验。拒绝二进制。',
      schema: z.object({ experimentId: z.string().min(1), fileOffset: z.number().int().nonnegative().optional(),
        file: researchExperimentFileRequestSchema.omit({ projectId: true, runId: true }).extend({
          offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(8000)
        }).optional() }).strict() }),
    get_figure: () => tool(async ({ runId }) => {
      return after(summarizeFigure(effects().getFigure(input.run.id, input.run.projectId, runId)));
    }, { name: 'get_figure', description: '使用 start_figure 返回的 runId 查询本次阶段创建的图稿。返回真实状态、错误、文件数和工件关联，不含二进制。failed、cancelled、interrupted 为终态，应停止轮询。',
      schema: z.object({ runId: z.string().min(1) }).strict() }),
    publish_experiment: () => tool(async ({ experimentId }) => {
      const published = await effects().publishExperiment(input.run.id, input.run.projectId, experimentId);
      return after(summarizeExperiment(published));
    }, { name: 'publish_experiment', description: '发布本次运行完成的实验。取消或替换后的迟到发布会被拒绝。',
      schema: z.object({ experimentId: z.string().min(1) }).strict() }),
    publish_figure: () => tool(async ({ runId, replacesFigureId }) => {
      const published = await effects().publishFigure(input.run.id, input.run.projectId, runId, replacesFigureId);
      return after({ figureId: published.id, artifactId: published.artifactId, runId: published.runId, status: published.status, replacesFigureId: published.replacesFigureId });
    }, { name: 'publish_figure', description: '使用 get_figure 已确认 completed 的 runId 发布本次阶段图稿。首次发布必须传 replacesFigureId: null（JSON null，不能传字符串"null"）；替换时传本项目真实草稿的 figureId，不能传 runId 或 artifactId。取消后不能发布。',
      schema: z.object({ runId: z.string().min(1), replacesFigureId: z.string().min(1).nullable() }).strict() }),
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
    }, { name: 'prepare_export', description: '准备当前项目的最终导出。项目和运行身份由服务绑定；同一冻结节点的相同业务参数返回已有作业。',
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
  // Retry attempts share candidate/import ownership just as they share the frozen node's effect receipts.
  let literatureOwner = input.repository.runs.get(input.run.id, input.run.projectId);
  while (literatureOwner.retryOfRunId !== null) {
    literatureOwner = input.repository.runs.get(literatureOwner.retryOfRunId, input.run.projectId);
  }
  const literatureTools = createLiteratureTools(input.capabilities, {
    owner: `stage:${literatureOwner.id}`, projectId: input.run.projectId, runId: input.run.id, signal: input.signal, assertActive,
    ...(input.run.stage === 'retrieval' ? {searchStrategy: requireConfirmedSearchStrategy(input.repository, input.context)} : {})
  }, { search: 'search_literature', read: 'read_literature_search', add: 'add_literature', get: 'get_literature_import', cancel: 'cancel_literature_import' });
  for (const entry of literatureTools) factories[entry.name] = () => entry;
  return input.run.toolNames.map((name) => {
    const factory = factories[name];
    if (factory === undefined) throw new Error('research_role_tool_unavailable');
    const original = factory();
    const effectClass = workerEffectClasses[name];
    if (effectClass === undefined) return original;
    return tool(async args => {
      assertActive();
      let identityArgs: unknown = args;
      if (name === 'publish_figure') {
        const request = z.object({runId: z.string().min(1), replacesFigureId: z.string().min(1).nullable()}).strict().parse(args);
        // Resolve semantic input errors before reserving a mutation effect. Ownership failures stay fatal.
        effects().getFigure(input.run.id, input.run.projectId, request.runId);
        if (request.replacesFigureId !== null) {
          try {
            input.repository.figures.get(input.run.projectId, request.replacesFigureId);
          } catch (error) {
            assertActive();
            if (error instanceof Error && error.message === 'research_figure_not_found') {
              throw new ToolInputParsingException('research_figure_not_found: replacesFigureId must be an exact existing draft figureId in this project. For a new publication use JSON null, not the string "null", a runId, or an artifactId. No publication was attempted.');
            }
            throw error;
          }
        }
      }
      if (name === 'start_experiment' || name === 'start_figure') {
        const request = name === 'start_experiment'
          ? researchOwnedExperimentStartSchema.parse(args) : researchOwnedFigureStartSchema.parse(args);
        // Reject a stale proposal before opening a host effect. The service still checks at start.
        if (name === 'start_figure' && request.expectedEnvironmentHash !== undefined) {
          const environment = await effects().inspectFigureEnvironment(input.run.id, input.run.projectId);
          assertActive();
          if (request.expectedEnvironmentHash !== environment.hash) {
            throw new ToolInputParsingException('research_figure_environment_changed: call inspect_figure_environment and copy its expectedEnvironmentHash exactly before retrying start_figure. No figure was started.');
          }
        }
        const inputFiles = await effects().readStartInputIdentity(input.run.id, input.run.projectId, request);
        assertActive();
        identityArgs = {...request, inputFiles};
      }
      return input.repository.tasks.workerEffects.execute(name, identityArgs, effectClass, () => original.invoke(args));
    }, {name, description: original.description, schema: original.schema});
  });
}

const workerEffectClasses: Partial<Record<string, import('../../services/deep-agent/tool-effect-store').ToolEffectOperationInput['effectClass']>> = {
  capture_evidence: 'workspace_mutation', save_workspace_file: 'workspace_mutation',
  save_template_file: 'workspace_mutation', compile_template: 'host_execution',
  start_experiment: 'host_execution', start_figure: 'host_execution', prepare_export: 'host_execution',
  publish_experiment: 'workspace_mutation', publish_figure: 'workspace_mutation', publish_export: 'workspace_mutation',
  search_literature: 'network_read', add_literature: 'workspace_mutation', cancel_literature_import: 'workspace_mutation'
};

function page(content: string, offset: number, limit: number) {
  return { content: content.slice(offset, offset + limit), totalChars: content.length,
    nextOffset: offset + limit < content.length ? offset + limit : null };
}

function summarizeExperiment(run: { id: string; request: { requestId: string }; ownerRunId: string | null; status: string; error: string | null; artifactId: string | null; files: unknown[] }) {
  return { experimentId: run.id, requestId: run.request.requestId, ownerRunId: run.ownerRunId, status: run.status, error: run.error,
    artifactId: run.artifactId, fileCount: run.files.length };
}

function summarizeFigure(run: { id: string; request: { requestId: string }; ownerRunId: string | null; status: string; error: string | null; artifactId: string | null; files: unknown[] }) {
  return { runId: run.id, requestId: run.request.requestId, ownerRunId: run.ownerRunId, status: run.status, error: run.error,
    artifactId: run.artifactId, fileCount: run.files.length };
}

function summarizeExport(record: { id: string; request: { requestId: string }; ownerRunId: string | null; status: string; error: string | null; artifactId: string | null; approval: string }) {
  return { exportId: record.id, requestId: record.request.requestId, ownerRunId: record.ownerRunId, status: record.status, error: record.error,
    artifactId: record.artifactId, approval: record.approval };
}

type ResearchProductionSection = Record<string, unknown> | unknown[] | null;

function productionSection(input: ResearchProductionInput, section: 'summary' | 'files' | 'environment'): ResearchProductionSection {
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
