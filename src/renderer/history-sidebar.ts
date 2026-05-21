import type { TaskThread } from '../shared/types';
import { formatBeijingDateTime } from './format-time';

export type HistorySidebarItem = {
  id: string;
  label: string;
  meta: string;
  icon: 'history';
};

const SYSTEM_HISTORY_THREAD_TITLES = new Set([
  '当前主会话',
  '快捷入口创建任务',
  '托盘接管记录',
  '记忆整理裁决',
  '任务工作台记录'
]);

export function buildHistoryItems(threads: TaskThread[], promotedThreadIds: Iterable<string>): HistorySidebarItem[] {
  const backgroundThreadIds = new Set(promotedThreadIds);
  return threads
    .filter((thread) => !backgroundThreadIds.has(thread.id))
    .filter((thread) => !isActivePromotedThread(thread))
    .filter((thread) => !SYSTEM_HISTORY_THREAD_TITLES.has(thread.title))
    .map((thread) => ({
      id: thread.id,
      label: thread.title,
      meta: formatBeijingDateTime(thread.updatedAt),
      icon: 'history'
    }));
}

function isActivePromotedThread(thread: TaskThread): boolean {
  return (
    (thread.kind === 'long_running' || thread.kind === 'background') &&
    ['running', 'waiting_user', 'waiting_next_turn', 'paused', 'pending_confirmation'].includes(thread.status)
  );
}

export function filterHistoryItems(items: HistorySidebarItem[], query: string): HistorySidebarItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return items;
  }
  return items.filter((item) => {
    const haystacks = [item.label, item.meta].map((value) => value.toLocaleLowerCase());
    return haystacks.some((value) => value.includes(normalizedQuery));
  });
}
