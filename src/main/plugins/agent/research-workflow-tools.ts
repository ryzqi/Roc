import type {StructuredToolInterface} from '@langchain/core/tools';
import {tool} from 'langchain';
import {z} from 'zod';
import type {RocCapabilityRegistry} from '../../kernel/types';
import type {ResearchToolDescriptor} from './research-tools';
import {researchWorkflowSnapshotSchema} from '../../../shared/schemas/research';
import {
  researchCitationCoverageRequestSchema, researchCitationCoverageInspectionSchema
} from '../../../shared/schemas/research-citation-coverage';
import {
  researchConsistencyInspectSchema, researchConsistencyInspectionSchema
} from '../../../shared/schemas/research-consistency';
import {
  researchResponseMatrixInspectSchema, researchResponseMatrixInspectionSchema
} from '../../../shared/schemas/research-response-matrix';
import {researchJournalInspectionSchema, researchJournalSelectionSchema} from '../../../shared/schemas/research-journal-compliance';
import {researchArtifactInspectResultSchema} from '../../../shared/schemas/research-artifact-inspector';
import {researchManuscriptSyncInspectSchema, researchManuscriptSyncInspectionSchema} from '../../../shared/schemas/research-manuscript-sync';
import {researchArgumentOutlineInspectionSchema} from '../../../shared/schemas/research-argument-outline';
import {researchFigureConsistencyInspectSchema, researchFigureConsistencyInspectionSchema} from '../../../shared/schemas/research-figure-consistency';
import {researchExperimentExecutionSchema, researchExperimentFileContentSchema, researchExperimentFileRequestSchema} from '../../../shared/schemas/research-experiments';
import {
  researchIdeaPlanGetSchema, researchIdeaPlanHistorySchema, researchIdeaPlanInspectionSchema,
  researchIdeaPlanHistoryResultSchema, type ResearchIdeaPlanInspection
} from '../../../shared/schemas/research-idea-plans';
import {
  researchExperimentResultGetSchema, researchExperimentResultListSchema, researchExperimentResultReceiptSchema,
  researchExperimentResultListResultSchema, researchExperimentResultFileSchema, type ResearchExperimentResultReceipt
} from '../../../shared/schemas/research-experiment-results';

export const RESEARCH_WORKFLOW_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  {name: 'research_inspect_workflow', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: ['main', 'subagent']}
];

const pagination = {offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50)};
const artifactTarget = researchConsistencyInspectSchema.omit({projectId: true});
const readSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('workflow')}),
  artifactTarget.extend({kind: z.literal('artifact')}),
  researchManuscriptSyncInspectSchema.omit({projectId: true}).extend({kind: z.literal('manuscript_sync')}),
  researchManuscriptSyncInspectSchema.omit({projectId: true}).extend({kind: z.literal('argument_outline'),
    offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(20).optional()}),
  researchCitationCoverageRequestSchema.omit({projectId: true}).extend({kind: z.literal('citation_coverage')}),
  artifactTarget.extend({kind: z.literal('consistency')}),
  researchFigureConsistencyInspectSchema.omit({projectId: true}).extend({kind: z.literal('figure_consistency')}),
  researchResponseMatrixInspectSchema.omit({projectId: true}).extend({kind: z.literal('response_matrix')}),
  artifactTarget.extend({kind: z.literal('journal_compliance')}),
  artifactTarget.extend({kind: z.literal('journal_preview'), selection: researchJournalSelectionSchema.safeExtend({manualReviews: z.tuple([])})}),
  researchIdeaPlanHistorySchema.omit({projectId: true}).extend({kind: z.literal('idea_plans'), ...pagination}),
  researchIdeaPlanGetSchema.omit({projectId: true}).extend({kind: z.literal('idea_plan')}),
  z.strictObject({kind: z.literal('experiment_run'), runId: researchExperimentResultListSchema.shape.runId}),
  z.strictObject({kind: z.literal('experiment_output'), runId: researchExperimentResultListSchema.shape.runId,
    path: researchExperimentFileRequestSchema.shape.path, expectedHash: researchExperimentResultGetSchema.shape.expectedHash}),
  researchExperimentResultListSchema.omit({projectId: true}).extend({kind: z.literal('experiment_results'), ...pagination}),
  researchExperimentResultGetSchema.omit({projectId: true}).extend({kind: z.literal('experiment_result')})
]);

// Keep an object root for provider JSON schemas; the pipe enforces each kind's
// exact field set before any capability runs. Project identity is never model input.
const toolSchema = z.strictObject({
  kind: z.enum(readSchema.options.map(option => option.shape.kind.value)).describe(
    readSchema.options.map(({shape: {kind, ...fields}}) => `${kind.value}: ${Object.keys(fields).join(', ') || '无其他字段'}`).join('；')
  ),
  artifactId: artifactTarget.shape.artifactId.optional(),
  expectedHash: artifactTarget.shape.expectedHash.describe('报告首次读取传 null；方法计划和实验结果必须使用列表返回的准确哈希。').optional(),
  versionId: researchIdeaPlanGetSchema.shape.versionId.optional(),
  resultId: researchExperimentResultGetSchema.shape.resultId.optional(),
  runId: researchExperimentResultListSchema.shape.runId.optional(),
  path: researchExperimentFileRequestSchema.shape.path.optional(),
  page: researchFigureConsistencyInspectSchema.shape.page.optional(),
  selection: researchJournalSelectionSchema.optional(),
  offset: pagination.offset.optional(),
  limit: pagination.limit.optional()
}).pipe(readSchema);

type ReadRequest = z.infer<typeof readSchema>;
type Invoke = <S extends z.ZodType>(name: string, request: object, schema: S) => Promise<z.output<S>>;
type NextAction = {
  code: string;
  actor: 'agent' | 'human';
  instruction: string;
  subjectIds: string[];
};
type Finding = {code: string; severity: 'blocked' | 'needs_review' | 'information'; message: string; subjectIds: string[]};

class InspectionFindings {
  readonly findings: Finding[] = [];
  readonly nextActions: NextAction[] = [];

  add(code: string, message: string, actor: NextAction['actor'], instruction: string,
    subjectIds: string[] = [], severity: Finding['severity'] = 'needs_review'): void {
    this.findings.push({code, severity, message, subjectIds});
    this.nextActions.push({code, actor, instruction, subjectIds});
  }

  stale(status: 'current' | 'stale'): void {
    if (status === 'stale') this.add('inspection_changed', '报告已不同于请求中的 expectedHash。', 'agent',
      '使用本次返回的报告与哈希重建提案；旧报告不能继续用于保存或审批。');
  }

  result<T>(kind: ReadRequest['kind'], data: T, verification: 'current_sources' | 'stored_receipt' | 'workflow_state', limitations: string[]) {
    return {kind, status: this.findings.length > 0 ? 'attention_required' as const : 'no_findings' as const,
      verification, data, findings: this.findings, nextActions: this.nextActions,
      limitations: [...limitations, '结果仅覆盖本次 kind 与指定对象；未执行其他检查，不能据此批准研究、正文或交付。']};
  }
}

/** Read-only adapter over the production checks; never supplies a human identity. */
export function createResearchWorkflowTools(input: {
  capabilities: RocCapabilityRegistry;
  projectId: string;
  signal: AbortSignal;
}): StructuredToolInterface[] {
  const invoke: Invoke = async (name, request, schema) => {
    input.signal.throwIfAborted();
    const scopedRequest = name === 'research.workflow.get' ? {id: input.projectId} : {...request, projectId: input.projectId};
    const result = await input.capabilities.invoke(name, scopedRequest, input.signal);
    input.signal.throwIfAborted();
    return schema.parse(result);
  };
  return [tool(async request => inspect(request, invoke, input.projectId), {
    name: 'research_inspect_workflow',
    description: '只读检查当前项目的流程阻塞、工件版本、正文引用覆盖、图文数值映射、回复矩阵、期刊规则、方法计划和实验指标。'
      + '按 kind 只传其必填字段。报告首次 expectedHash=null；idea_plan/experiment_result 必须先列出再用准确 ID/hash 读取。'
      + '返回实际版本、findings、nextActions。缺检查、旧版本与未审核不等于通过；列表回执不证明当前文件有效。'
      + 'journal_compliance 检查已保存规则；journal_preview 检查候选规则，manualReviews 必须为空。人工判断由界面保存。'
      + 'workflow 只检查持久阶段状态，不是所有工件质量检查；须按当前材料继续调用对应 kind。',
    schema: toolSchema
  })];
}

async function inspect(target: ReadRequest, invoke: Invoke, projectId: string): Promise<unknown> {
  const findings = new InspectionFindings();
  switch (target.kind) {
    case 'artifact': {
      const result = await invoke('research.artifacts.inspect', {artifactId: target.artifactId, expectedVersion: target.expectedHash}, researchArtifactInspectResultSchema);
      findings.stale(result.status);
      const {artifact, version, origin, ideaCanvas, ideaPlan, claims, manuscript} = result.snapshot;
      return findings.result(target.kind, {artifact, version, origin, ideaCanvas, ideaPlan, manuscript: manuscript?.sections,
        claims: claims.slice(0, 40), claimCount: claims.length},
        'stored_receipt', ['工件版本用于锁定建议依据；当前磁盘材料需由对应检查核对。']);
    }
    case 'manuscript_sync': {
      const data = await invoke('research.manuscriptSync.inspect', {artifactId: target.artifactId}, researchManuscriptSyncInspectionSchema);
      if (data.status === 'conflict' || data.status === 'changed') findings.add(`manuscript_sync_${data.status}`,
        '工作稿与受控正文存在差异。', 'human', '在写作工作区核对并采纳选定修改，然后重新检查受影响的来源和审核。', [target.artifactId]);
      return findings.result(target.kind, data, 'current_sources', ['差异仅覆盖工作稿与受控正文。']);
    }
    case 'argument_outline': {
      const data = await invoke('research.argumentOutlines.inspect', {artifactId: target.artifactId}, researchArgumentOutlineInspectionSchema);
      if (data.latest === null || !data.latestCurrent) findings.add('argument_outline_needs_review', '大纲尚未保存或引用材料已变化。', 'agent',
        '按每节问题组织准确主张、条件和缺口，保存论证大纲提案后交由人工审核。', [target.artifactId]);
      const offset = target.offset ?? 0, limit = target.limit ?? 10;
      const matrix = data.matrix.slice(offset, offset + limit).map(row => ({...row,
        claim: {...row.claim, content: row.claim.content.slice(0, 1200)},
        sources: row.sources.slice(0, 6).map(source => ({...source, evidence: {...source.evidence, excerpt: source.evidence.excerpt.slice(0, 400)}})),
        relations: row.relations.slice(0, 12), sourcesTruncated: row.sources.length > 6, relationsTruncated: row.relations.length > 12}));
      return findings.result(target.kind, {...data, matrix, total: data.matrix.length,
        nextOffset: offset + limit < data.matrix.length ? offset + limit : null}, 'stored_receipt',
        ['矩阵区分已记录的支持、反证和限定，不替代来源阅读；省略的来源按真实 ID 单独读取。']);
    }
    case 'workflow': {
      const data = await invoke('research.workflow.get', {id: projectId}, researchWorkflowSnapshotSchema);
      const stage = data.stages.find(item => item.stage === data.currentStage);
      if (stage === undefined) throw new Error('research_stage_not_found');
      if (data.projectStatus === 'archived') findings.add('project_archived', '项目已归档，只能读取。', 'human',
        '在项目管理中决定是否恢复项目；不要尝试写入归档项目。', [projectId], 'blocked');
      else if (data.projectStatus === 'paused') findings.add('project_paused', '项目已暂停。', 'human',
        '在项目管理中确认继续项目。', [projectId], 'blocked');
      if (['blocked', 'failed'].includes(stage.status)) findings.add(`stage_${stage.status}`, stage.lastError ?? '阶段无法继续。',
        'agent', '读取当前阶段运行和工件，依据真实错误补齐材料或形成修复提案；不要直接批准。', stage.artifactIds, 'blocked');
      else if (stage.status === 'waiting_approval') findings.add('stage_waiting_approval', '当前阶段等待人工审核。', 'human',
        '阅读当前工件和检查报告，再通过已有人工闸门决定。', stage.artifactIds, 'blocked');
      else if (stage.status === 'paused') findings.add('stage_paused', '当前阶段已暂停。', 'human',
        '确认恢复当前阶段后继续原任务。', stage.artifactIds, 'blocked');
      else if (stage.status === 'locked') findings.add('stage_locked', '当前阶段尚未解锁。', 'agent',
        '检查前置阶段和未完成闸门，不绕过阶段依赖。', stage.artifactIds, 'blocked');
      else if (stage.status === 'ready' && data.projectStatus === 'active') findings.nextActions.push({code: 'stage_ready', actor: 'agent',
        instruction: '读取当前阶段输入；准备齐全后用 research_run_stage 执行授权范围内的阶段任务。', subjectIds: stage.artifactIds});
      else if (stage.status === 'running' && data.projectStatus === 'active') findings.nextActions.push({code: 'stage_running', actor: 'agent',
        instruction: '通过 research_stage_runs 读取现有运行，不重复启动相同工作。', subjectIds: stage.activeRunId === null ? [] : [stage.activeRunId]});
      return findings.result(target.kind, data, 'workflow_state', ['阶段状态不证明文献、主张、图稿、方法或交付材料已通过检查。']);
    }
    case 'citation_coverage': {
      const {kind: _, ...request} = target;
      const data = await invoke('research.manuscript.citationCoverage', request, researchCitationCoverageInspectionSchema);
      findings.stale(data.status);
      for (const paragraph of data.report.paragraphs) {
        for (const issue of paragraph.issues) findings.add(`citation_${issue.kind}`, `主张 ${paragraph.claim.id} 存在 ${issue.kind}。`,
          issue.kind.startsWith('unreviewed') ? 'human' : 'agent',
          '检查报告中的真实原文、主张和关系版本；必要时补证或提交引用审核提案，人工决定独立保存。',
          [paragraph.claim.id, issue.subjectId]);
      }
      if (data.report.counts.paragraphs === 0) findings.add('citation_no_paragraphs', '没有可核查的正文段落。', 'agent',
        '先保存有明确主张与来源的正文，再检查覆盖。', [target.artifactId]);
      return findings.result(target.kind, data, 'current_sources', ['引文可定位与文献身份一致，不等于原文支持论断。']);
    }
    case 'consistency': {
      const {kind: _, ...request} = target;
      const data = await invoke('research.consistency.inspect', request, researchConsistencyInspectionSchema);
      findings.stale(data.status);
      if (data.report.counts.changed > 0) findings.add('consistency_changed', '部分数值映射绑定的主张已变化。', 'agent',
        '按当前主张位置与真实指标重建映射提案，保留旧审核。', data.report.locations.filter(item => !item.current).map(item => item.binding.claimId));
      if (data.report.counts.inconsistent > 0) findings.add('consistency_mismatch', '正文数值与实际指标按已保存规则计算后不一致。', 'agent',
        '逐项核查单位、舍入、容差及实际来源，提出修订；不能放宽容差使其通过。',
        data.report.locations.filter(item => !item.calculation.consistent).map(item => item.binding.claimId));
      if (data.report.counts.unmappedValues > 0) findings.add('consistency_unmapped', '仍有未映射的正文数值。', 'agent',
        '为真实数值位置匹配指标与证据并形成提案；无法匹配时明确未核查。', data.report.unmappedClaimIds);
      if (data.report.review === null) findings.add('consistency_not_reviewed', '尚无已保存的数值映射审核。', 'human',
        '审阅数值映射提案；无数值时明确其适用范围，不把空映射称为检查通过。', [target.artifactId]);
      return findings.result(target.kind, data, 'current_sources', ['数值一致性不证明统计方法、科学结论或图中实际绘制数据正确。']);
    }
    case 'response_matrix': {
      const {kind: _, ...request} = target;
      const data = await invoke('research.responseMatrix.inspect', request, researchResponseMatrixInspectionSchema);
      findings.stale(data.status);
      if (data.report.review === null) findings.add('response_matrix_missing', '尚无已保存的回复矩阵。', 'agent',
        '根据真实审稿意见形成逐项回复与修改位置提案；缺意见时说明材料不足。', [target.artifactId]);
      else if (!data.report.reviewCurrent) findings.add('response_matrix_changed', '回复矩阵与当前正文、来源或复核结果不一致。', 'agent',
        '重新定位修改位置和证据，保留原始审稿意见，提交新版本提案。', [target.artifactId]);
      if (data.report.openCommentIds.length > 0) findings.add('response_comments_open', '仍有未处置的审稿意见。', 'agent',
        '逐项提出补实验、改稿或有依据的不同意回复；由人工决定处置。', data.report.openCommentIds);
      if (!data.report.canEdit) findings.add('response_matrix_read_only', '当前稿件或阶段不能新增回复审核。', 'human',
        '在现有流程确认是否需要开启修订；不要修改批准或归档的历史。', [target.artifactId], 'information');
      return findings.result(target.kind, data, 'current_sources', ['意见被处置不证明修改正确，也不代表审稿人接受回复。']);
    }
    case 'figure_consistency': {
      const {kind: _, ...request} = target;
      const data = await invoke('research.figureConsistency.inspect', request, researchFigureConsistencyInspectionSchema);
      findings.stale(data.status);
      const {counts, artifactId, review} = data.report;
      if (review === null || counts.unmapped > 0 || counts.changed > 0 || counts.inconsistent > 0) {
        findings.add('figure_mapping_needs_review', '图稿有待核对的数值映射。', 'agent',
          '用实际场景项和已核对指标构造映射提案；保留未映射位置。', [artifactId]);
      }
      return findings.result(target.kind, data, 'current_sources', ['分页返回实际绘制数据；核对覆盖范围由映射决定。']);
    }
    case 'journal_compliance':
    case 'journal_preview': {
      const {artifactId, expectedHash} = target;
      const data = await invoke('research.journalCompliance.inspect', {artifactId, expectedHash,
        selection: target.kind === 'journal_preview' ? target.selection : null}, researchJournalInspectionSchema);
      findings.stale(data.status);
      if (data.report.selection === null) findings.add('journal_rules_missing', '未选择已保存的期刊规则，尚未执行投稿检查。', 'agent',
        '读取目标期刊官方规范，形成带来源与日期的规则提案，交由人工核对保存。', [target.artifactId]);
      else {
        for (const check of data.report.checks) {
          if (check.status === 'fail') findings.add('journal_rule_failed', check.detail, 'agent',
            '按准确规则来源修复材料或说明不符合项；不能静默放宽规则。', [check.ruleId, ...check.subjectIds]);
          if (check.status === 'manual') {
            const review = data.report.selection.manualReviews.find(item => item.ruleId === check.ruleId);
            if (review === undefined || review.decision === 'fail') findings.add('journal_manual_review', check.detail, 'human',
              '按规则和真实材料填写人工判断与理由；自动结果仍保留 manual。', [check.ruleId, ...check.subjectIds]);
          }
        }
        if (!data.report.reviewCurrent && target.kind === 'journal_compliance') findings.add('journal_review_changed', '已保存投稿审核与当前材料不一致。', 'human',
          '核查本次材料与规则后保存新审核版本；不能复用旧批准。', [target.artifactId]);
      }
      return findings.result(target.kind, data, 'current_sources', ['只检查已保存的规则与选择的材料，不证明完整投稿包、匿名性或录用资格。']);
    }
    case 'idea_plans': {
      const {kind: _, ...request} = target;
      const data = await invoke('research.ideaPlans.history', request, researchIdeaPlanHistoryResultSchema);
      if (data.total === 0) findings.add('idea_plan_missing', '尚无已保存的方法计划。', 'agent',
        '根据 Idea Canvas 提出假设、反证条件、设计和指标计划，交由人工审阅。', [target.artifactId]);
      return findings.result(target.kind, {...data, nextOffset: target.offset + data.items.length < data.total ? target.offset + data.items.length : null},
        'stored_receipt', ['此为计划历史页；使用返回的 version.id/versionHash 调用 idea_plan 核对准确版本。']);
    }
    case 'idea_plan': {
      const {kind: _, ...request} = target;
      const data = await invoke('research.ideaPlans.get', request, researchIdeaPlanInspectionSchema);
      inspectPlan(data, findings);
      return findings.result(target.kind, data, 'stored_receipt', [
        '核验保存计划、冻结回执、最新版与 Canvas 版本；未重验计划引用的全部原始文件。',
        '冻结计划不证明预注册或设计的科学有效性；记录样本量不证明已计算功效。'
      ]);
    }
    case 'experiment_run': {
      const run = await invoke('research.experiment.get', {runId: target.runId}, researchExperimentExecutionSchema);
      const {id, artifactId, status, files, inputHash, exitCode, error, request} = run;
      if (status !== 'completed') findings.add('experiment_incomplete', error ?? '实验尚未成功完成。', 'agent',
        '查看执行终态和日志，确认运行完成后再提议审核结果。', [id]);
      return findings.result(target.kind, {id, artifactId, status, files, inputHash, exitCode, error, engine: request.engine},
        'stored_receipt', ['输出哈希通过 experiment_output 重验。']);
    }
    case 'experiment_output': {
      const {runId, path, expectedHash} = target;
      const data = await invoke('research.experiment.read', {runId, area: 'output', path}, researchExperimentFileContentSchema);
      if (data.file.sha256 !== expectedHash) throw new Error('research_experiment_snapshot_changed');
      const result = researchExperimentResultFileSchema.parse(JSON.parse(data.content));
      return findings.result(target.kind, {runId, file: data.file, result}, 'current_sources', ['原始输出等待指标口径和方法审核。']);
    }
    case 'experiment_results': {
      const {kind: _, ...request} = target;
      const data = await invoke('research.experimentResults.list', request, researchExperimentResultListResultSchema);
      if (data.total === 0) findings.add('experiment_result_missing', '该实验尚无已审核的指标结果回执。', 'human',
        '先确认实验终态与真实输出，再审核指标定义和方法；不要从日志猜造结果。', [target.runId]);
      return findings.result(target.kind, {...data, nextOffset: target.offset + data.items.length < data.total ? target.offset + data.items.length : null},
        'stored_receipt', ['列表只核验保存回执；使用 snapshot.id/snapshotHash 调用 experiment_result 重验当前执行与文件。']);
    }
    case 'experiment_result': {
      const {kind: _, ...request} = target;
      const data = await invoke('research.experimentResults.get', request, researchExperimentResultReceiptSchema);
      inspectResult(data, findings);
      return findings.result(target.kind, data, 'current_sources', ['来源核验与指标审核不等于独立复现、统计显著或科学批准。']);
    }
  }
}

function inspectPlan(data: ResearchIdeaPlanInspection, findings: InspectionFindings): void {
  const subjectIds = [data.version.id];
  if (!data.isLatest || !data.canvasCurrent) findings.add('idea_plan_changed', '计划不是最新版或与当前 Idea Canvas 不一致。', 'agent',
    '读取当前 Canvas 和最新计划，保留旧版并提交修订提案。', subjectIds);
  if (data.freeze === null) findings.add('idea_plan_not_frozen', '方法计划尚未经人工冻结。', 'human',
    '审阅假设、方法、指标和反证条件后，明确决定是否冻结此版本。', subjectIds);
  if (data.version.request.body.sampleSize.kind === 'not_calculated') findings.add('sample_size_not_calculated',
    data.version.request.body.sampleSize.reason, 'agent', '说明样本量计算的适用性与所缺输入；不得将记录视为已完成计算。', subjectIds);
}

function inspectResult(data: ResearchExperimentResultReceipt, findings: InspectionFindings): void {
  for (const metric of data.snapshot.result.metrics) {
    for (const field of ['uncertainty', 'confidenceInterval', 'effect'] as const) {
      const value = metric[field];
      if (value.kind === 'unavailable') findings.add(`metric_${field}_unavailable`, value.reason, 'agent',
        '在结果陈述中保留未估计状态；仅在研究设计和输入支持时提出后续计算。', [data.snapshot.id, metric.id], 'information');
    }
  }
}
