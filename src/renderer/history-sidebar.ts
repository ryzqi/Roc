import type { BackgroundTask, TaskThread } from '../shared/types';

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

export function buildHistoryItems(threads: TaskThread[], backgroundTasks: BackgroundTask[]): HistorySidebarItem[] {
  const backgroundThreadIds = new Set(backgroundTasks.map((task) => task.threadId));
  return threads
    .filter((thread) => !backgroundThreadIds.has(thread.id))
    .filter((thread) => !SYSTEM_HISTORY_THREAD_TITLES.has(thread.title))
    .map((thread) => ({
      id: thread.id,
      label: thread.title,
      meta: thread.updatedAt.replace('T', ' ').slice(0, 16),
      icon: 'history'
    }));
}
