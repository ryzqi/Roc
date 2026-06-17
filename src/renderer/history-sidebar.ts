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
  '记忆整理裁决',
  '任务工作台记录'
]);

export function buildHistoryItems(threads: TaskThread[], _promotedThreadIds: Iterable<string>): HistorySidebarItem[] {
  return threads
    .filter((thread) => thread.kind === 'chat')
    .filter((thread) => !SYSTEM_HISTORY_THREAD_TITLES.has(thread.title))
    .map((thread) => ({
      id: thread.id,
      label: thread.title,
      meta: formatBeijingDateTime(thread.updatedAt),
      icon: 'history'
    }));
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
