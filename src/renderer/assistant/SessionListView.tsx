import { useState } from 'react';
import { MessagesSquare, Plus, Trash2 } from 'lucide-react';
import type { RocClient } from '../shared/roc-client';
import { formatRelativeBeijing } from '../shared/format';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { EmptyState } from '../shell/EmptyState';
import { useChatThreads } from './use-chat-threads';

/**
 * 会话 tab (T4.7): the assistant's chat threads.
 *
 * Ownership split that matters: the **shell** owns which thread is selected (the sidebar
 * chooses it, the assistant panel renders it), so this view only reports clicks. Deleting is
 * the one destructive action and goes through `ConfirmDialog` — it removes the thread's
 * history for good, which the dialog says out loud.
 *
 * Renaming is deliberately absent (backend order B3): the backend has no rename call, and a
 * local-only rename would silently revert.
 */
export type SessionListViewProps = {
  client: RocClient;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  /** Clears the selection so the next prompt starts a fresh thread (T4.7). */
  onStartNewThread: () => void;
  /** Called after a delete so the shell can drop a selection that no longer exists. */
  onThreadDeleted: (threadId: string) => void;
};

export function SessionListView({
  client,
  activeThreadId,
  onSelectThread,
  onStartNewThread,
  onThreadDeleted
}: SessionListViewProps): React.JSX.Element {
  const threads = useChatThreads(client);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);

  if (threads.status === 'loading' && threads.threads.length === 0) {
    return (
      <p className="px-3 py-4 text-muted" role="status" data-testid="session-list-loading">
        正在读取会话…
      </p>
    );
  }

  if (threads.error !== null) {
    return (
      <div className="px-3 py-4">
        <p role="alert" className="text-[var(--st-bad)] text-[var(--font-meta-size)]" data-testid="session-list-error">
          {threads.error}
        </p>
        <button
          type="button"
          onClick={threads.reload}
          className="mt-2 h-[var(--control-height-compact)] rounded-control border border-line px-2 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
        >
          <span className="text-[var(--font-meta-size)]">重试</span>
        </button>
      </div>
    );
  }

  if (threads.threads.length === 0) {
    return (
      <EmptyState
        compact
        icon={MessagesSquare}
        title="暂无会话"
        description="在助手面板发送第一条指令时会自动建立会话。"
        testId="sidebar-empty-sessions"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="session-list">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={onStartNewThread}
          data-testid="session-new"
          className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
        >
          <Plus size={11} aria-hidden="true" />
          <span className="text-[var(--font-meta-size)]">新建会话</span>
        </button>
        <span className="min-w-0 flex-1 truncate text-subtle text-[var(--font-micro-size)]">
          {activeThreadId === null ? '新会话（首次发送时创建）' : ''}
        </span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {threads.threads.map((thread) => {
          const active = thread.id === activeThreadId;
          return (
            <li key={thread.id} className="group flex items-center">
              <button
                type="button"
                onClick={() => onSelectThread(thread.id)}
                title={thread.title}
                data-testid={`session-row-${thread.id}`}
                aria-current={active ? 'true' : undefined}
                className={
                  active
                    ? 'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-control bg-accent-soft px-2 py-1 text-left active:bg-[var(--accent-soft-strong)]'
                    : 'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-control px-2 py-1 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                }
              >
                <span className="w-full truncate text-[var(--font-meta-size)]">{thread.title}</span>
                <span className="text-subtle text-[var(--font-micro-size)]">
                  {formatRelativeBeijing(thread.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                disabled={threads.removing === thread.id}
                onClick={() => setPendingDelete({ id: thread.id, title: thread.title })}
                aria-label={`删除会话 ${thread.title}`}
                data-testid={`session-delete-${thread.id}`}
                className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-control text-subtle hover:text-[var(--st-bad)] active:bg-[var(--overlay-active)] disabled:opacity-40"
              >
                <Trash2 size={11} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>

      <p className="shrink-0 px-2 py-1 text-subtle text-[var(--font-micro-size)]">
        后端没有「会话按项目归属」字段，这里显示的是全部对话会话；重命名无接口（B3）。
      </p>

      {threads.removeError === null ? null : (
        <p role="alert" className="px-3 pb-2 text-[var(--st-bad)] text-[var(--font-micro-size)]">
          {threads.removeError}
        </p>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除会话？"
        message={`将删除「${pendingDelete?.title ?? ''}」的全部消息记录。`}
        detail="该操作不可恢复。"
        confirmLabel="删除"
        tone="destructive"
        testId="session-delete-confirm"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target !== null) {
            void threads.remove(target.id).then((ok) => {
              if (ok) {
                onThreadDeleted(target.id);
              }
            });
          }
        }}
      />
    </div>
  );
}
