import type { ResearchArtifact, ResearchIndexStatus, ResearchProject, ResearchStageRun, ResearchWorkflowEvent, ResearchWorkflowSnapshot } from '../../../shared/types';

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

export function currentStageState(workflow: ResearchWorkflowSnapshot): ResearchWorkflowSnapshot['stages'][number] {
  return workflow.stages.find((stage) => stage.stage === workflow.currentStage) ?? workflow.stages[0]!;
}

export function nextStageLabel(workflow: ResearchWorkflowSnapshot): string | null {
  const index = workflow.stages.findIndex((stage) => stage.stage === workflow.currentStage);
  const next = workflow.stages[index + 1];
  return next === undefined ? null : researchStageLabels[next.stage];
}

export function nextActionLabel(workflow: ResearchWorkflowSnapshot): string {
  const status = currentStageState(workflow).status;
  if (status === 'ready') return '开始当前阶段';
  if (status === 'running') return currentStageState(workflow).gateRequired ? '生成产物后提交审核' : '完成当前阶段';
  if (status === 'paused') return '恢复当前阶段';
  if (status === 'waiting_approval') return '审核当前产物';
  if (status === 'failed' || status === 'blocked') return '查看失败原因并重试';
  if (status === 'completed') return nextStageLabel(workflow) === null ? '流程已完成' : `进入${nextStageLabel(workflow)}`;
  return '等待阶段开放';
}

export function formatResearchTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function artifactStatusLabel(status: ResearchArtifact['status']): string {
  if (status === 'approved') return '已批准';
  if (status === 'superseded') return '已替换';
  return '草稿';
}

export function eventTone(type: string): 'info' | 'warn' | 'good' {
  if (type.includes('failed') || type.includes('rejected') || type.includes('cancelled')) return 'warn';
  if (type.includes('completed') || type.includes('granted') || type.includes('approved')) return 'good';
  return 'info';
}

export function latestCurrentRun(runs: ResearchStageRun[], workflow: ResearchWorkflowSnapshot): ResearchStageRun | null {
  return runs.find((run) => run.stage === workflow.currentStage && run.parentRunId === null) ?? null;
}

export function currentArtifacts(artifacts: ResearchArtifact[], workflow: ResearchWorkflowSnapshot): ResearchArtifact[] {
  const ids = new Set(currentStageState(workflow).artifactIds);
  return artifacts.filter((artifact) => ids.has(artifact.id));
}

export function reviewDecisionRequired(workflow: ResearchWorkflowSnapshot): boolean {
  return currentStageState(workflow).stage === 'review' && currentStageState(workflow).status === 'waiting_approval';
}

export function indexPhaseLabel(status: ResearchIndexStatus | null): string {
  if (status === null) return '读取中';
  if (status.phase === 'unavailable') return '不可用';
  if (status.phase === 'idle') return '空闲';
  if (status.phase === 'queued') return '排队中';
  if (status.phase === 'scanning') return '扫描中';
  if (status.phase === 'indexing') return '索引中';
  if (status.phase === 'paused') return '已暂停';
  return '失败';
}
