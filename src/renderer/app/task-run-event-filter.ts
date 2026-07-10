import type { ChatRunEvent, TaskDetail, TaskSnapshot } from '../../shared/types';

export function syncKnownTaskRunIds(input: {
  target: Set<string>;
  snapshot: TaskSnapshot;
  taskDetail: TaskDetail | null;
}): void {
  const backgroundThreadIds = new Set(
    input.snapshot.threads.filter((thread) => thread.kind === 'background').map((thread) => thread.id)
  );
  for (const event of input.snapshot.recentEvents) {
    if (backgroundThreadIds.has(event.threadId)) {
      input.target.add(event.runId);
    }
  }
  if (input.taskDetail !== null && input.taskDetail.backgroundTask !== null) {
    input.target.add(input.taskDetail.backgroundTask.runId);
  }
}

export function shouldApplyTaskRunEvent(known: Set<string>, event: ChatRunEvent): boolean {
  if (event.type === 'run_started') {
    if (event.mode !== 'task') {
      return false;
    }
    known.add(event.runId);
    return true;
  }
  return known.has(event.runId);
}

export function completeTaskRunEvent(known: Set<string>, event: ChatRunEvent): void {
  if (event.type === 'run_completed' || event.type === 'run_failed') {
    known.delete(event.runId);
  }
}
