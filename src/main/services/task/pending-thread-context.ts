import { requireText } from './validation';

export class PendingThreadContextStore {
  private readonly map = new Map<string, string>();

  enqueue(threadId: string, content: string): void {
    this.map.set(threadId, content);
  }

  take(threadId: string): string | null {
    const normalizedThreadId = requireText(
      threadId,
      'task_thread_id_empty',
      '任务会话 ID 不能为空。',
      '请选择一个有效的会话后再继续发送。'
    );
    const pending = this.map.get(normalizedThreadId) ?? null;
    if (pending !== null) {
      this.map.delete(normalizedThreadId);
    }
    return pending;
  }
}
