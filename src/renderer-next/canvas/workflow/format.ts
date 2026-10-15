import type {
  ResearchArtifact,
  ResearchIndexStatus,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowSnapshot
} from '../../../shared/types';

/**
 * Product labels and message mapping for the research workflow (P6/T6.1).
 *
 * Two rules decide what is in here, and both come from earlier phases' mistakes:
 *
 *   1. **Stage wording is not ours to invent.** `CONTEXT.md` fixes the eleven stage
 *      names (发现/检索/阅读/构思/方案/实验·数据/绘图/写作/审稿/修订/导出) and the old
 *      shell already used exactly these. The migration keeps them verbatim; a
 *      synonym would rename the product's own main axis.
 *   2. **Backend error text is never replaced by a generic sentence.** P5 shipped
 *      with "Roc 内部错误" hiding `research_json_invalid`, and that cost a whole
 *      debugging round. So markers are *annotated* (`research_role_output_invalid`)
 *      and unknown codes are shown raw.
 *
 * Everything here is pure: labels, sentences from a snapshot, error mapping.
 */

export const researchStageLabels: Record<ResearchWorkflowSnapshot['currentStage'], string> = {
  discovery: '发现',
  retrieval: '检索',
  reading: '阅读',
  ideation: '构思',
  planning: '方案',
  experiment: '实验 / 数据',
  figure: '绘图',
  writing: '写作',
  review: '审稿',
  revision: '修订',
  export: '导出'
};

/** What the stage is expected to produce, used in status sentences. */
export const researchStageOutputs: Record<ResearchWorkflowSnapshot['currentStage'], string> = {
  discovery: '检索策略',
  retrieval: '文献集',
  reading: '阅读笔记',
  ideation: 'Idea Canvas',
  planning: '研究方案',
  experiment: '实验运行',
  figure: '图稿',
  writing: '正文',
  review: '审稿意见',
  revision: '修订正文',
  export: '导出包'
};

export const researchStageStatusLabels: Record<ResearchWorkflowSnapshot['stages'][number]['status'], string> = {
  locked: '未开放',
  ready: '待开始',
  running: '进行中',
  waiting_approval: '待审核',
  paused: '已暂停',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败'
};

export const researchRunStatusLabels: Record<ResearchStageRun['status'], string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};

export const researchProjectStatusLabels: Record<ResearchProject['status'], string> = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档'
};

export const researchArtifactKindLabels: Record<ResearchArtifact['kind'], string> = {
  search_strategy: '检索策略',
  source_corpus: '文献集',
  reading_notes: '阅读笔记',
  idea_canvas: 'Idea Canvas',
  research_plan: '研究方案',
  experiment_run: '实验运行',
  figure: '图稿',
  manuscript: '正文',
  review_report: '审稿意见',
  revision_plan: '修订计划',
  export_package: '导出包'
};

export const researchArtifactStatusLabels: Record<ResearchArtifact['status'], string> = {
  draft: '草稿',
  approved: '已批准',
  superseded: '已替换'
};

/**
 * Stage-run error *markers* are codes, not sentences (`repository`/`stage-runtime`
 * raise `research_*` strings). Each known one gets a sentence that says what to do
 * next; the code stays visible next to it in the UI.
 */
const runErrorExplanations: Record<string, string> = {
  research_role_output_invalid: '阶段角色返回的结构化结果不符合契约，本次运行没有产出可用产物。',
  research_role_execution_failed: '阶段角色执行过程中报错，本次运行没有产出可用产物。',
  research_role_output_missing: '阶段角色没有返回结构化结果，本次运行没有产出可用产物。',
  research_run_timeout: '阶段运行超过该阶段策略里的超时上限，已被中止。',
  research_run_cancelled: '运行被用户取消。',
  research_run_paused: '运行随阶段暂停而被中断。',
  research_run_interrupted_by_shutdown: '应用退出时中断了这次运行。',
  research_run_interrupted_by_restart: '应用上次退出时中断了这次运行。',
  research_project_deleted: '项目已删除，运行被中止。',
  research_model_executor_unavailable: '没有可用的模型执行器：先在设置中心配置默认模型。',
  research_model_handle_missing: '所选模型没有可用的运行时句柄，先检查设置中心的模型配置。',
  research_stage_inputs_stale: '本阶段所需的输入产物不是已批准状态，先让上游阶段过闸门。',
  research_stage_run_active: '该阶段已有一个运行在进行，先等它结束或取消它。',
  research_stage_awaiting_gate: '该阶段已有产出在等待人工审核，先通过或退回闸门。',
  research_stage_not_runnable: '当前阶段状态不允许启动运行。',
  research_project_archived: '项目已归档，仅可阅读：无法启动阶段运行。'
};

/** One line explaining a run/stage failure, with the raw code appended. */
export function explainRunError(error: string): string {
  const code = error.trim();
  if (code.length === 0) {
    return '阶段运行失败，后端没有给出原因码。';
  }
  const explanation = runErrorExplanations[code];
  return explanation === undefined ? `阶段运行失败：${code}` : `${explanation}（${code}）`;
}

/** First sentence of a backend note, so a paragraph does not become a banner. */
export function firstSentence(value: string): string {
  const trimmed = value.trim();
  const index = trimmed.search(/[。！？\n]/u);
  return index === -1 ? trimmed : trimmed.slice(0, index + 1);
}

export function indexPhaseLabel(status: ResearchIndexStatus | null): string {
  if (status === null) {
    return '读取中';
  }
  if (status.phase === 'unavailable') return '不可用';
  if (status.phase === 'idle') return '空闲';
  if (status.phase === 'queued') return '排队中';
  if (status.phase === 'scanning') return '扫描中';
  if (status.phase === 'indexing') return '索引中';
  if (status.phase === 'paused') return '已暂停';
  return '失败';
}

/** Event tone, so the activity stream never relies on colour alone either. */
export function eventTone(type: string): 'info' | 'warn' | 'good' {
  if (type.includes('failed') || type.includes('rejected') || type.includes('cancelled')) {
    return 'warn';
  }
  if (type.includes('completed') || type.includes('granted') || type.includes('approved')) {
    return 'good';
  }
  return 'info';
}
