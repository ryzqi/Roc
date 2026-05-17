import { buildHistoryItems as buildHistorySidebarItems } from '../history-sidebar';
import type { LoadedState } from '../loaded-state';
import type { HistorySidebarItem, NavItem, ViewId } from './types';

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
  return buildHistorySidebarItems(state.taskSnapshot.threads, state.backgroundTasks);
}

export function buildWorkspaceNavItems(state: LoadedState): NavItem[] {
  return [
    {
      id: 'tasks',
      label: '任务工作台',
      meta: `${state.taskSnapshot.counts.running} 运行中 · ${state.taskSnapshot.counts.pendingConfirmation} 待确认`,
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
      meta: `${state.memorySearch?.items.length ?? 0} 召回 · ${state.memoryCandidates.length} 候选`,
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
