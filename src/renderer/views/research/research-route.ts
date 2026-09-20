import {
  RESEARCH_STAGE_GROUPS,
  stageGroupForStage,
  type ResearchStageGroupId,
  type ResearchStageTab
} from './research-stage-groups';

export type ResearchCanvasView = 'overview' | 'activity' | 'provenance' | 'stage';

export type ResearchRoute = {
  projectId: string | null;
  view: ResearchCanvasView;
  stageGroup: ResearchStageGroupId;
  stageTab: ResearchStageTab;
};

const CANVAS_VIEWS = new Set<ResearchCanvasView>(['overview', 'activity', 'provenance', 'stage']);
const STAGE_GROUPS = new Set<ResearchStageGroupId>(RESEARCH_STAGE_GROUPS.map((group) => group.id));
const STAGE_TABS = new Set<ResearchStageTab>(RESEARCH_STAGE_GROUPS.flatMap((group) => group.tabs.map((tab) => tab.id)));

export function parseResearchRoute(search: URLSearchParams): ResearchRoute {
  const projectId = emptyToNull(search.get('project'));
  const view = parseCanvasView(search.get('view'));
  const parsedStage = parseStage(search.get('stage'));
  return {
    projectId,
    view,
    stageGroup: parsedStage.group,
    stageTab: parsedStage.tab
  };
}

export function readResearchRoute(): ResearchRoute {
  return parseResearchRoute(new URLSearchParams(window.location.search));
}

export function writeResearchRoute(route: ResearchRoute, mode: 'replace' | 'push' = 'replace'): void {
  const url = new URL(window.location.href);
  if (route.projectId === null) {
    url.searchParams.delete('project');
  } else {
    url.searchParams.set('project', route.projectId);
  }
  if (route.view === 'overview') {
    url.searchParams.delete('view');
  } else {
    url.searchParams.set('view', route.view);
  }
  if (route.view === 'stage') {
    url.searchParams.set('stage', route.stageTab === defaultTabForGroup(route.stageGroup) ? route.stageGroup : route.stageTab);
  } else {
    url.searchParams.delete('stage');
  }
  if (mode === 'push') {
    window.history.pushState({}, '', url);
    return;
  }
  window.history.replaceState({}, '', url);
}

export function sameResearchRoute(left: ResearchRoute, right: ResearchRoute): boolean {
  if (left.projectId !== right.projectId || left.view !== right.view) {
    return false;
  }
  if (left.view !== 'stage') {
    return true;
  }
  return left.stageGroup === right.stageGroup && left.stageTab === right.stageTab;
}

export function researchRouteFromState(input: {
  projectId: string | null;
  view: ResearchCanvasView;
  stageGroup: ResearchStageGroupId;
  stageTab: ResearchStageTab;
}): ResearchRoute {
  const group = RESEARCH_STAGE_GROUPS.find((item) => item.id === input.stageGroup) ?? RESEARCH_STAGE_GROUPS[0]!;
  const tab = group.tabs.some((item) => item.id === input.stageTab) ? input.stageTab : group.tabs[0]!.id;
  return {
    projectId: input.projectId,
    view: input.view,
    stageGroup: group.id,
    stageTab: tab
  };
}

function parseCanvasView(value: string | null): ResearchCanvasView {
  if (value === 'service') {
    return 'stage';
  }
  if (value !== null && CANVAS_VIEWS.has(value as ResearchCanvasView)) {
    return value as ResearchCanvasView;
  }
  return 'overview';
}

function parseStage(value: string | null): { group: ResearchStageGroupId; tab: ResearchStageTab } {
  if (value === null || value.trim().length === 0) {
    return { group: 'discover', tab: 'library' };
  }
  if (STAGE_GROUPS.has(value as ResearchStageGroupId)) {
    const group = value as ResearchStageGroupId;
    return { group, tab: defaultTabForGroup(group) };
  }
  if (STAGE_TABS.has(value as ResearchStageTab)) {
    const tab = value as ResearchStageTab;
    const group = RESEARCH_STAGE_GROUPS.find((item) => item.tabs.some((entry) => entry.id === tab))?.id ?? 'discover';
    return { group, tab };
  }
  const workflowStage = RESEARCH_STAGE_GROUPS.flatMap((item) => item.stages).find((stage) => stage === value);
  if (workflowStage !== undefined) {
    const group = stageGroupForStage(workflowStage);
    return { group, tab: defaultTabForGroup(group) };
  }
  return { group: 'discover', tab: 'library' };
}

function defaultTabForGroup(groupId: ResearchStageGroupId): ResearchStageTab {
  return RESEARCH_STAGE_GROUPS.find((group) => group.id === groupId)?.tabs[0]?.id ?? 'library';
}

function emptyToNull(value: string | null): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  return value;
}
