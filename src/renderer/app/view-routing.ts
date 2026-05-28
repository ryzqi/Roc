import type { LoadedState } from '../loaded-state';
import type { MainViewId, PageMeta, PreviewIconName, ViewId, WorkbenchTool } from './types';

export const MAIN_VIEW_IDS = new Set<ViewId>([
  'chat',
  'tasks',
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

export const FLOATING_VIEW_IDS = new Set<ViewId>(['quick', 'tray']);

export const WORKBENCH_VIEWS = new Set<ViewId>(['chat', 'workspace', 'git', 'terminal', 'preview']);

export const WORKBENCH_TOOLS: Array<{ id: WorkbenchTool; label: string; icon: PreviewIconName }> = [
  { id: 'files', label: '文件', icon: 'folder' },
  { id: 'git', label: 'Git', icon: 'git' },
  { id: 'terminal', label: '终端', icon: 'terminal' }
];

export const PAGE_META: Record<MainViewId, PageMeta> = {
  chat: {
    title: '聊天主页',
    topMeta: '未选择工作区',
    pageLabel: '主会话'
  },
  tasks: {
    title: '任务工作台',
    topMeta: '任务状态',
    pageLabel: '任务控制'
  },
  workspace: {
    title: '工作区文件',
    topMeta: '文件视图',
    pageLabel: '工作区'
  },
  git: {
    title: 'Git 面板',
    topMeta: 'Git 状态',
    pageLabel: '工作区'
  },
  terminal: {
    title: '嵌入式终端',
    topMeta: '终端会话',
    pageLabel: '工作区'
  },
  preview: {
    title: '文件预览',
    topMeta: '预览面板',
    pageLabel: '工作区'
  },
  mcp: {
    title: 'MCP',
    topMeta: 'MCP 清单',
    pageLabel: '控制面'
  },
  skills: {
    title: 'Skill',
    topMeta: 'Skill 清单',
    pageLabel: '控制面'
  },
  memory: {
    title: '记忆中心',
    topMeta: '记忆状态',
    pageLabel: '控制面'
  },
  settings: {
    title: '设置',
    topMeta: '设置',
    pageLabel: '控制面'
  },
  diagnostics: {
    title: '任务诊断包',
    topMeta: '失败任务',
    pageLabel: '控制面'
  }
};

export function parseViewId(value: string | null): ViewId {
  if (value !== null && (MAIN_VIEW_IDS.has(value as ViewId) || FLOATING_VIEW_IDS.has(value as ViewId))) {
    return value as ViewId;
  }
  return 'chat';
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

export function isFloatingView(view: ViewId): boolean {
  return FLOATING_VIEW_IDS.has(view);
}

export function syncRendererUrl(view: ViewId, tool: WorkbenchTool, workbenchVisible: boolean): void {
  const url = new URL(window.location.href);
  url.searchParams.set('page', view);
  if (workbenchVisible || (view !== 'chat' && WORKBENCH_VIEWS.has(view))) {
    url.searchParams.set('tool', tool);
  } else {
    url.searchParams.delete('tool');
  }
  window.history.replaceState({}, '', url);
}

export function visibleWorkspaceLabel(state: LoadedState): string {
  return state.appStatus.workspace.label;
}

export function visibleWorkspaceCwd(state: LoadedState): string {
  return state.workspace === null ? '未选择' : state.workspace.path;
}

export function buildTopMeta(view: MainViewId, state: LoadedState): string {
  if (view === 'chat') {
    return visibleWorkspaceLabel(state);
  }
  if (view === 'tasks') {
    return `${state.taskSnapshot.counts.total} 个任务 · 运行中 ${state.taskSnapshot.counts.running}`;
  }
  if (view === 'workspace' || view === 'git' || view === 'terminal' || view === 'preview') {
    return visibleWorkspaceLabel(state);
  }
  if (view === 'memory') {
    return 'Phase 1 占位';
  }
  if (view === 'mcp') {
    return `${state.mcpServers.filter((server) => server.enabled).length} 个已启用服务`;
  }
  if (view === 'skills') {
    return `${state.skills.filter((skill) => skill.enabled && skill.status === 'ready').length} 个可用 Skill`;
  }
  if (view === 'settings') {
    return state.defaultModelId === null ? '默认模型未配置' : `默认模型 ${state.defaultModelId}`;
  }
  return `${state.taskSnapshot.counts.failed} 个失败任务`;
}
