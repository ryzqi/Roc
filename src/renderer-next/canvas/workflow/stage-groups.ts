import type { ResearchWorkflowSnapshot } from '../../../shared/types';

/**
 * Product stage semantics, ported verbatim from
 * `src/renderer/views/research/research-stage-groups.ts` (P6/T6.1).
 *
 * The backend runs 11 workflow stages; the UI groups them into six buckets.
 * This module is pure data + pure functions on purpose: P6 adds `workflow-rules.ts`
 * on top of it and unit-tests both.
 */

export type ResearchStageGroupId = 'discover' | 'plan' | 'experiment' | 'write' | 'publish' | 'settings';

export type ResearchStageTab =
  | 'library'
  | 'knowledge'
  | 'ideas'
  | 'policies'
  | 'experiments'
  | 'figures'
  | 'manuscript'
  | 'editor'
  | 'production'
  | 'embedding';

export type ResearchStageGroup = {
  id: ResearchStageGroupId;
  label: string;
  stages: Array<ResearchWorkflowSnapshot['currentStage']>;
  tabs: Array<{ id: ResearchStageTab; label: string }>;
};

export const RESEARCH_STAGE_GROUPS: readonly ResearchStageGroup[] = [
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
    tabs: [
      { id: 'experiments', label: '实验' },
      { id: 'figures', label: '图稿' }
    ]
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

export const STAGE_GROUP_IDS: ReadonlySet<ResearchStageGroupId> = new Set(RESEARCH_STAGE_GROUPS.map((group) => group.id));

export const STAGE_TAB_IDS: ReadonlySet<ResearchStageTab> = new Set(
  RESEARCH_STAGE_GROUPS.flatMap((group) => group.tabs.map((tab) => tab.id))
);

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
  return (
    status === 'ready' || status === 'running' || status === 'paused' || status === 'waiting_approval' || status === 'failed'
  );
}

export function defaultTabForGroup(groupId: ResearchStageGroupId): ResearchStageTab {
  return RESEARCH_STAGE_GROUPS.find((group) => group.id === groupId)?.tabs[0]?.id ?? 'library';
}

export function stageGroupLabel(groupId: ResearchStageGroupId): string {
  return RESEARCH_STAGE_GROUPS.find((group) => group.id === groupId)?.label ?? '发现与阅读';
}
