import { buildHistoryItems as buildHistorySidebarItems } from '../history-sidebar';
import type { LoadedState } from '../loaded-state';
import type { HistorySidebarItem, NavItem, ViewId } from './types';
import { visibleMemoryLabel } from './view-routing';

// 「对话」分组常驻侧栏：条目数恒定，视图切换时不产生布局位移。
export function buildHistoryNavItems(selectedThreadId: string | null, activeView: ViewId): NavItem[] {
  return [
    {
      id: 'chat',
      label: '新建对话',
      meta: '发送首条消息后创建新会话',
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
      id: 'tasks-board',
      label: '任务工作台',
      meta: `${taskCounts.running} 运行中 · ${taskCounts.pendingConfirmation} 待确认 · ${taskCounts.total} 共计`,
      icon: 'clipboard'
    },
    {
      id: 'diagnostics',
      label: '任务诊断包',
      meta: `${state.taskSnapshot.counts.failed} 失败任务`,
      icon: 'stethoscope'
    }
  ];
}

export function buildControlNavItems(state: LoadedState): NavItem[] {
  return [
    {
      id: 'memory',
      label: '记忆中心',
      meta: visibleMemoryLabel(state),
      icon: 'globe'
    },
    {
      id: 'mcp',
      label: 'MCP',
      meta: `${state.mcpServers.filter((server) => server.enabled).length} 已启用`,
      icon: 'nodes'
    },
    {
      id: 'skills',
      label: 'Skill',
      meta: `${state.skills.filter((skill) => skill.enabled && skill.status === 'ready').length} 可用`,
      icon: 'sparkles'
    }
  ];
}
