import { buildHistoryItems as buildHistorySidebarItems } from '../history-sidebar';
import type { LoadedState } from '../loaded-state';
import { countTaskNavMeta } from '../views/tasks/task-view-model';
import type { HistorySidebarItem, NavItem, ViewId } from './types';
import { visibleMemoryLabel } from './view-routing';

export function buildHistoryNavItems(selectedThreadId: string | null, activeView: ViewId): NavItem[] {
  if (activeView === 'chat') {
    return [];
  }
  return [
    {
      id: 'chat',
      label: '新建对话',
      meta: '发送首条消息后创建新会话',
      icon: 'history',
      active: selectedThreadId === null
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
  const taskCounts = countTaskNavMeta(state.activeTasks);
  return [
    {
      id: 'tasks',
      label: '任务工作台',
      meta: `${taskCounts.activeCount} 活跃 · ${taskCounts.pendingApprovalCount} 待确认 · ${taskCounts.scheduledCount} 定时`,
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
