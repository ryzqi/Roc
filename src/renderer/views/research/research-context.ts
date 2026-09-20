import type {
  ResearchArtifact,
  ResearchIndexStatus,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot
} from '../../../shared/types';
import type { ResearchWorkbenchSnapshot } from './research-workbench';
import { researchStageLabels } from './research-workflow';

export type ResearchPendingGate = {
  stage: ResearchWorkflowSnapshot['currentStage'];
  reason: string;
};

export type ResearchArtifactSummary = {
  total: number;
  approved: number;
  draft: number;
};

export type ResearchServiceHealth = {
  modelsReady: boolean | null;
  modelsDownloading: boolean;
  modelsError: string | null;
  indexPhase: ResearchIndexStatus['phase'] | null;
  indexError: string | null;
};

export type ResearchContext = {
  projectId: string | null;
  project: ResearchProject | null;
  workflow: ResearchWorkflowSnapshot | null;
  currentStage: ResearchWorkflowSnapshot['currentStage'] | null;
  activeRuns: ResearchStageRun[];
  pendingGates: ResearchPendingGate[];
  recentEvents: ResearchWorkflowEvent[];
  artifactSummary: ResearchArtifactSummary;
  indexStatus: ResearchIndexStatus | null;
  serviceHealth: ResearchServiceHealth;
};

export type ResearchServiceHealthInput = {
  modelsReady: boolean | null;
  modelsDownloading: boolean;
  modelsError: string | null;
};

const ACTIVE_RUN_STATUSES = new Set<ResearchStageRun['status']>(['queued', 'running']);

export function createResearchContext(
  snapshot: Pick<ResearchWorkbenchSnapshot, 'project' | 'workflow' | 'events' | 'runs' | 'artifacts' | 'indexStatus'>,
  health: ResearchServiceHealthInput
): ResearchContext {
  const project = snapshot.project;
  const workflow = snapshot.workflow;
  return {
    projectId: project?.id ?? null,
    project,
    workflow,
    currentStage: workflow?.currentStage ?? project?.currentStage ?? null,
    activeRuns: snapshot.runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)),
    pendingGates: pendingGates(workflow),
    recentEvents: snapshot.events,
    artifactSummary: artifactSummary(snapshot.artifacts),
    indexStatus: snapshot.indexStatus,
    serviceHealth: {
      modelsReady: health.modelsReady,
      modelsDownloading: health.modelsDownloading,
      modelsError: health.modelsError,
      indexPhase: snapshot.indexStatus?.phase ?? null,
      indexError: snapshot.indexStatus?.error ?? null
    }
  };
}

function pendingGates(workflow: ResearchWorkflowSnapshot | null): ResearchPendingGate[] {
  if (workflow === null) {
    return [];
  }
  return workflow.stages.flatMap((stage) => {
    if (stage.status === 'waiting_approval') {
      return [{ stage: stage.stage, reason: '阶段产物等待审核' }];
    }
    if (stage.status === 'blocked') {
      return [{ stage: stage.stage, reason: '阶段已阻塞' }];
    }
    return [];
  });
}

function artifactSummary(artifacts: ResearchArtifact[]): ResearchArtifactSummary {
  return {
    total: artifacts.length,
    approved: artifacts.filter((item) => item.status === 'approved').length,
    draft: artifacts.filter((item) => item.status === 'draft').length
  };
}

export function buildResearchTopMeta(context: ResearchContext): string {
  if (context.project === null) {
    return '创建研究项目';
  }
  const stage = context.currentStage === null ? '未开始' : researchStageLabels[context.currentStage];
  return `${context.project.title} · ${stage} · 运行 ${context.activeRuns.length} · 闸门 ${context.pendingGates.length}`;
}
