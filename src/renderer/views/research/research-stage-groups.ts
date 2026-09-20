import type { ResearchWorkflowSnapshot } from '../../../shared/types';

export type ResearchStageGroupId = 'discover' | 'plan' | 'experiment' | 'write' | 'publish' | 'settings';
export type ResearchStageTab =
  | 'library'
  | 'knowledge'
  | 'ideas'
  | 'policies'
  | 'experiments'
  | 'manuscript'
  | 'editor'
  | 'production'
  | 'embedding';

export const RESEARCH_STAGE_GROUPS: Array<{
  id: ResearchStageGroupId;
  label: string;
  stages: Array<ResearchWorkflowSnapshot['currentStage']>;
  tabs: Array<{ id: ResearchStageTab; label: string }>;
}> = [
  {
    id: 'discover',
    label: '发现与阅读',
    stages: ['discovery', 'retrieval', 'reading'],
    tabs: [
      { id: 'library', label: '文献库' },
      { id: 'knowledge', label: '知识库' }
    ]
  },
  {
    id: 'plan',
    label: '构思与计划',
    stages: ['ideation', 'planning'],
    tabs: [{ id: 'ideas', label: '构思' }]
  },
  {
    id: 'experiment',
    label: '实验与检查',
    stages: ['experiment', 'figure'],
    tabs: [{ id: 'experiments', label: '实验' }]
  },
  {
    id: 'write',
    label: '写作与审阅',
    stages: ['writing', 'review', 'revision'],
    tabs: [
      { id: 'manuscript', label: '正文' },
      { id: 'editor', label: '文稿' }
    ]
  },
  {
    id: 'publish',
    label: '发布与复现',
    stages: ['export'],
    tabs: [{ id: 'production', label: '图稿导出' }]
  },
  {
    id: 'settings',
    label: '项目设置',
    stages: [],
    tabs: [
      { id: 'embedding', label: '嵌入配置' },
      { id: 'policies', label: '阶段模型' }
    ]
  }
];

export function stageGroupForStage(stage: ResearchWorkflowSnapshot['currentStage'] | null): ResearchStageGroupId {
  if (stage === null) {
    return 'discover';
  }
  return RESEARCH_STAGE_GROUPS.find((group) => group.stages.includes(stage))?.id ?? 'discover';
}

export function isCurrentStageGroup(
  groupId: ResearchStageGroupId,
  currentStage: ResearchWorkflowSnapshot['currentStage'] | null
): boolean {
  if (groupId === 'settings' || currentStage === null) {
    return false;
  }
  return stageGroupForStage(currentStage) === groupId;
}

export function stageGroupWriteAllowed(
  groupId: ResearchStageGroupId,
  currentStage: ResearchWorkflowSnapshot['currentStage'] | null,
  status: ResearchWorkflowSnapshot['stages'][number]['status'] | undefined
): boolean {
  if (groupId === 'settings') {
    return true;
  }
  const group = RESEARCH_STAGE_GROUPS.find((item) => item.id === groupId);
  if (group === undefined || currentStage === null || status === undefined) {
    return false;
  }
  if (!group.stages.includes(currentStage)) {
    return false;
  }
  return status === 'ready' || status === 'running' || status === 'paused' || status === 'waiting_approval' || status === 'failed';
}
