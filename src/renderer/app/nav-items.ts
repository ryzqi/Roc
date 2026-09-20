import { buildHistoryItems as buildHistorySidebarItems } from '../history-sidebar';
import type { LoadedState } from '../loaded-state';
import type { HistorySidebarItem, NavItem, ViewId } from './types';
import { visibleMemoryLabel } from './view-routing';

// 「对话」分组常驻侧栏：条目数恒定，视图切换时不产生布局位移。
export function buildHistoryNavItems(selectedThreadId: string | null, activeView: ViewId): NavItem[] {
  return [
    {
      id: 'chat',
      label: '研究助手',
      meta: '在当前研究项目中打开对话',
      icon: 'history',
      active: activeView === 'chat' && selectedThreadId === null
    }
  ];
}

export function buildHistoryItems(state: LoadedState): HistorySidebarItem[] {
  return buildHistorySidebarItems(
    state.taskSnapshot.threads,
    state.activeTasks.map((item) => item.threadId)
  );
}

export function buildWorkspaceNavItems(state: LoadedState): NavItem[] {
  // 用 taskSnapshot.counts（bootstrap 即有）而非懒加载的 activeTasks，避免点击后文案跳变。
  const taskCounts = state.taskSnapshot.counts;
  return [
    {
      id: 'research',
      label: '科研工作台',
      meta: '项目总览、阶段与证据',
      icon: 'microscope'
    },
    {
      id: 'workspace',
      label: '文件与代码',
      meta: state.workspace?.path ?? '未选择计算目录',
      icon: 'folder'
    },
    {
      id: 'tasks-board',
      label: '活动与运行',
      meta: `${taskCounts.running} 运行中 · ${taskCounts.pendingConfirmation} 待确认 · ${taskCounts.total} 共计`,
      badge: `${taskCounts.running}/${taskCounts.pendingConfirmation}/${taskCounts.total}`,
      ...(taskCounts.pendingConfirmation > 0 ? { badgeTone: 'alert' as const } : {}),
      icon: 'clipboard'
    },
    {
      id: 'diagnostics',
      label: '运行诊断',
      meta: `${state.taskSnapshot.counts.failed} 失败任务`,
      badge: `${state.taskSnapshot.counts.failed}`,
      ...(state.taskSnapshot.counts.failed > 0 ? { badgeTone: 'alert' as const } : {}),
      icon: 'stethoscope'
    }
  ];
}

export function buildControlNavItems(state: LoadedState): NavItem[] {
  return [
    {
      id: 'memory',
      label: '项目记忆',
      meta: visibleMemoryLabel(state),
      // 工作区路径已在 workspace-pill 与顶栏显示，dock 只在全局记忆时给出区分标记。
      ...(state.appStatus.workspace.selectedPath === null ? { badge: '全局' } : {}),
      icon: 'globe'
    },
    {
      id: 'mcp',
      label: '连接器',
      meta: `${state.mcpServers.filter((server) => server.enabled).length} 已启用`,
      badge: `${state.mcpServers.filter((server) => server.enabled).length}`,
      icon: 'nodes'
    },
    {
      id: 'skills',
      label: '技能',
      meta: `${state.skills.filter((skill) => skill.enabled && skill.status === 'ready').length} 可用`,
      badge: `${state.skills.filter((skill) => skill.enabled && skill.status === 'ready').length}`,
      icon: 'sparkles'
    }
  ];
}
