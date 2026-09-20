import type { LoadedState } from '../loaded-state';
import type { MainViewId, PreviewIconName, ResearchShellMode, ViewId, WorkbenchTool } from './types';

const MAIN_VIEW_IDS = new Set<ViewId>([
  'chat',
  'research',
  'tasks-board',
  'task-detail',
  'workspace',
  'git',
  'terminal',
  'preview',
  'mcp',
  'skills',
  'memory',
  'settings',
  'diagnostics'
]);

export const WORKBENCH_VIEWS = new Set<ViewId>(['chat', 'workspace', 'git', 'terminal', 'preview']);

export const RESEARCH_SHELL_QUERY = 'shell';
export const RESEARCH_SHELL_STORAGE_KEY = 'roc.research.shell';

export const WORKBENCH_TOOLS: Array<{ id: WorkbenchTool; label: string; icon: PreviewIconName }> = [
  { id: 'files', label: '文件', icon: 'folder' },
  { id: 'git', label: 'Git', icon: 'git' },
  { id: 'terminal', label: '终端', icon: 'terminal' }
];

export function parseViewId(value: string | null): ViewId {
  if (value !== null && MAIN_VIEW_IDS.has(value as ViewId)) {
    return value as ViewId;
  }
  return 'chat';
}

export function parseResearchShellMode(search: URLSearchParams, stored: string | null = null): ResearchShellMode {
  const fromQuery = search.get(RESEARCH_SHELL_QUERY);
  if (fromQuery === 'research' || fromQuery === 'legacy') {
    return fromQuery;
  }
  return stored === 'research' ? 'research' : 'legacy';
}

export function readResearchShellMode(): ResearchShellMode {
  return parseResearchShellMode(
    new URLSearchParams(window.location.search),
    window.localStorage.getItem(RESEARCH_SHELL_STORAGE_KEY)
  );
}

export function persistResearchShellMode(mode: ResearchShellMode): void {
  if (mode === 'research') {
    window.localStorage.setItem(RESEARCH_SHELL_STORAGE_KEY, 'research');
  } else {
    window.localStorage.removeItem(RESEARCH_SHELL_STORAGE_KEY);
  }
  const url = new URL(window.location.href);
  if (mode === 'research') {
    url.searchParams.set(RESEARCH_SHELL_QUERY, 'research');
  } else {
    url.searchParams.set(RESEARCH_SHELL_QUERY, 'legacy');
  }
  window.history.replaceState({}, '', url);
}

export function defaultWorkbenchTool(view: ViewId): WorkbenchTool {
  if (view === 'git') {
    return 'git';
  }
  if (view === 'terminal') {
    return 'terminal';
  }
  return 'files';
}

export function parseWorkbenchTool(value: string | null, view: ViewId): WorkbenchTool {
  if ((value === 'files' || value === 'git' || value === 'terminal') && WORKBENCH_VIEWS.has(view)) {
    return value;
  }
  return defaultWorkbenchTool(view);
}

export function syncRendererUrl(view: ViewId, tool: WorkbenchTool, workbenchVisible: boolean): void {
  const url = new URL(window.location.href);
  url.searchParams.set('page', view);
  if (workbenchVisible || (view !== 'chat' && WORKBENCH_VIEWS.has(view))) {
    url.searchParams.set('tool', tool);
  } else {
    url.searchParams.delete('tool');
  }
  if (view === 'research') {
    const mode = parseResearchShellMode(url.searchParams, window.localStorage.getItem(RESEARCH_SHELL_STORAGE_KEY));
    if (mode === 'research') {
      url.searchParams.set(RESEARCH_SHELL_QUERY, 'research');
    } else if (url.searchParams.get(RESEARCH_SHELL_QUERY) === 'legacy') {
      url.searchParams.set(RESEARCH_SHELL_QUERY, 'legacy');
    } else {
      url.searchParams.delete(RESEARCH_SHELL_QUERY);
    }
  } else {
    url.searchParams.delete(RESEARCH_SHELL_QUERY);
  }
  window.history.replaceState({}, '', url);
}

export function visibleWorkspaceLabel(state: LoadedState): string {
  return state.appStatus.workspace.label;
}

export function visibleMemoryLabel(state: LoadedState): string {
  // 与 main 侧 memory-store-repository 的 workspaceLabel 同源（都来自 settings.defaultWorkspace），
  // 但 appStatus 在 bootstrap 阶段即可用，不像 memoryStatus 要等 memory 视图懒加载。
  if (state.appStatus.workspace.selectedPath === null) {
    return '全局记忆';
  }
  return state.appStatus.workspace.label;
}

export function visibleWorkspaceCwd(state: LoadedState): string {
  return state.workspace === null ? '未选择' : state.workspace.path;
}

export function buildTopMeta(view: MainViewId, state: LoadedState): string {
  if (view === 'chat') {
    return visibleWorkspaceLabel(state);
  }
  if (view === 'tasks-board' || view === 'task-detail') {
    const runningCount = state.activeTasks.filter((task) => task.status === 'running').length;
    return `${state.activeTasks.length} 个任务 · 运行中 ${runningCount}`;
  }
  if (view === 'workspace' || view === 'git' || view === 'terminal' || view === 'preview') {
    return visibleWorkspaceLabel(state);
  }
  if (view === 'memory') {
    return visibleMemoryLabel(state);
  }
  if (view === 'mcp') {
    return `${state.mcpServers.filter((server) => server.enabled).length} 个已启用服务`;
  }
  if (view === 'skills') {
    return `${state.skills.filter((skill) => skill.enabled && skill.status === 'ready').length} 个可用 Skill`;
  }
  if (view === 'research') {
    return '项目流程与证据追踪';
  }
  if (view === 'settings') {
    return state.defaultModelId === null ? '默认模型未配置' : `默认模型 ${state.defaultModelId}`;
  }
  return `${state.taskSnapshot.counts.failed} 个失败任务`;
}
