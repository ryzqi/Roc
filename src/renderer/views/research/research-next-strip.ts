import type { ResearchArtifact, ResearchStageRun, ResearchWorkflowSnapshot } from '../../../shared/types';
import { currentArtifacts, currentStageState, nextStageLabel, reviewDecisionRequired } from './research-workflow';

const STAGE_NAME: Record<ResearchWorkflowSnapshot['currentStage'], string> = {
  discovery: '发现',
  retrieval: '检索',
  reading: '阅读',
  ideation: '构思',
  planning: '方案',
  experiment: '实验',
  figure: '绘图',
  writing: '写作',
  review: '审稿',
  revision: '修订',
  export: '导出'
};

const STAGE_OUTPUT: Record<ResearchWorkflowSnapshot['currentStage'], string> = {
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

export type ResearchStripCommand =
  | { type: 'start' }
  | { type: 'retry' }
  | { type: 'restart'; instruction: string }
  | { type: 'complete' }
  | { type: 'submit' }
  | { type: 'approve'; reviewDecision?: 'accept' }
  | { type: 'reject' }
  | { type: 'revise' }
  | { type: 'cancel' };

export type ResearchStripButton = {
  label: string;
  command: ResearchStripCommand;
  testId: string;
};

export type ResearchNextStripModel = {
  summary: string | null;
  status: string | null;
  primary: ResearchStripButton | null;
  secondary: ResearchStripButton[];
};

export function buildResearchNextStrip(input: {
  workflow: ResearchWorkflowSnapshot;
  runs: ResearchStageRun[];
  artifacts: ResearchArtifact[];
  description: string;
}): ResearchNextStripModel {
  const stage = currentStageState(input.workflow);
  const parents = input.runs
    .filter((run) => run.stage === input.workflow.currentStage && run.parentRunId === null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const latest = parents[0] ?? null;
  const active = latest !== null && (latest.status === 'queued' || latest.status === 'running');
  if (active && latest !== null) {
    return {
      summary: null,
      status: runningLabel(input.workflow.currentStage),
      primary: null,
      secondary: [{ label: '取消运行', command: { type: 'cancel' }, testId: 'research-cancel-run' }]
    };
  }
  if (stage.status === 'waiting_approval') {
    const summary = artifactTitle(input.artifacts, input.workflow);
    if (reviewDecisionRequired(input.workflow)) {
      return {
        summary,
        status: null,
        primary: { label: '接受稿件', command: { type: 'approve', reviewDecision: 'accept' }, testId: 'research-review-accept' },
        secondary: [
          { label: '退回修改', command: { type: 'reject' }, testId: 'research-next-reject' },
          { label: '要求修订', command: { type: 'revise' }, testId: 'research-review-revise' }
        ]
      };
    }
    return {
      summary,
      status: null,
      primary: { label: '确认通过', command: { type: 'approve' }, testId: 'research-approve' },
      secondary: [{ label: '退回修改', command: { type: 'reject' }, testId: 'research-next-reject' }]
    };
  }
  const stopped = stage.status === 'failed' || stage.status === 'blocked' || stage.status === 'paused'
    || (stage.status === 'running' && stage.lastError !== null);
  if (stopped || (latest !== null && (latest.status === 'failed' || latest.status === 'cancelled' || latest.status === 'interrupted'))) {
    const retryable = latest !== null && (latest.status === 'failed' || latest.status === 'cancelled' || latest.status === 'interrupted');
    const instruction = latest?.instruction.trim() || input.description.trim();
    return {
      summary: firstSentence(stage.lastError ?? latest?.error ?? '角色已停止。'),
      status: null,
      primary: retryable
        ? { label: '用同一阶段指令重试', command: { type: 'retry' }, testId: 'research-retry-run' }
        : { label: '用同一阶段指令重试', command: { type: 'restart', instruction }, testId: 'research-retry-run' },
      secondary: []
    };
  }
  const produced = currentArtifacts(input.artifacts, input.workflow);
  const finished = latest?.status === 'completed' || produced.length > 0;
  if (stage.status === 'running' && finished) {
    if (stage.gateRequired && produced.length > 0) {
      return {
        summary: produced[produced.length - 1]?.title ?? null,
        status: null,
        primary: { label: '提交审核', command: { type: 'submit' }, testId: 'research-next-submit' },
        secondary: []
      };
    }
    if (!stage.gateRequired) {
      return {
        summary: produced[produced.length - 1]?.title ?? null,
        status: null,
        primary: { label: completeLabel(input.workflow), command: { type: 'complete' }, testId: 'research-next-complete' },
        secondary: []
      };
    }
  }
  return {
    summary: null,
    status: null,
    primary: { label: startLabel(input.workflow.currentStage), command: { type: 'start' }, testId: 'research-start-run' },
    secondary: []
  };
}

function startLabel(stage: ResearchWorkflowSnapshot['currentStage']): string {
  if (stage === 'discovery') return '开始发现：写出检索策略';
  return `开始${STAGE_NAME[stage]}：${STAGE_OUTPUT[stage]}`;
}

function runningLabel(stage: ResearchWorkflowSnapshot['currentStage']): string {
  if (stage === 'discovery') return '正在写出检索策略';
  return `正在准备${STAGE_OUTPUT[stage]}`;
}

function completeLabel(workflow: ResearchWorkflowSnapshot): string {
  if (workflow.currentStage === 'discovery') return '完成发现，进入检索';
  const next = nextStageLabel(workflow);
  return next === null ? `完成${STAGE_NAME[workflow.currentStage]}` : `完成${STAGE_NAME[workflow.currentStage]}，进入${next}`;
}

function artifactTitle(artifacts: ResearchArtifact[], workflow: ResearchWorkflowSnapshot): string | null {
  const produced = currentArtifacts(artifacts, workflow);
  return produced[produced.length - 1]?.title ?? null;
}

function firstSentence(value: string): string {
  const trimmed = value.trim();
  const index = trimmed.search(/[。！？\n]/u);
  return index === -1 ? trimmed : trimmed.slice(0, index + 1);
}
