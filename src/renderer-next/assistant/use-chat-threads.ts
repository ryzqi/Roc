import { useCallback, useMemo, useState } from 'react';
import type { TaskThread } from '../../shared/types';
import { errorMessage } from '../app/loaded-state';
import { useAsyncResource } from '../app/use-async-resource';
import type { RocClient } from '../shared/roc-client';
import { deleteThread, listThreads } from './session-store';

/**
 * Chat thread list for the sidebar's 会话 tab (T4.7).
 *
 * **Contract note.** The plan names `agent.sessions.list` as the source, but that call takes
 * `{ threadId, limit }` and returns *that thread's messages*. The only enumeration of threads
 * is `tasks.getSnapshot()`, whose `threads[]` carry `{ id, kind, title, goal, status,
 * createdAt, updatedAt }`. So this hook reads the snapshot and keeps `kind === 'chat'`.
 *
 * `taskThreadSchema` has **no project field**, so "filter by the current project" cannot be
 * done from real data. Rather than filter on a title prefix (which would silently hide real
 * sessions), the list shows what the backend actually has and the UI says so; the missing
 * association is registered as a backend task order.
 *
 * Threads with nothing in them are still returned by the backend after a run starts, and
 * `title` is what the user recognises, so sorting is by `updatedAt` (most recent first) and
 * the title falls back to `goal` before an id.
 */

export type ChatThreadRow = {
  id: string;
  title: string;
  status: TaskThread['status'];
  updatedAt: string;
};

export type ChatThreadsState = {
  status: 'loading' | 'ready' | 'error';
  threads: ChatThreadRow[];
  error: string | null;
  reload: () => void;
  remove: (threadId: string) => Promise<boolean>;
  removing: string | null;
  removeError: string | null;
};

function toRow(thread: TaskThread): ChatThreadRow {
  const title = thread.title.trim();
  const goal = thread.goal.trim();
  return {
    id: thread.id,
    title: title.length > 0 ? title : goal.length > 0 ? goal : thread.id,
    status: thread.status,
    updatedAt: thread.updatedAt
  };
}

export function useChatThreads(client: RocClient): ChatThreadsState {
  const resource = useAsyncResource('assistant:threads', () => listThreads(client), { label: '读取会话列表' });
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [localRemoved, setLocalRemoved] = useState<readonly string[]>([]);
  const reload = resource.reload;

  const threads = useMemo(() => {
    const all = resource.data?.threads ?? [];
    return all
      .filter((thread) => thread.kind === 'chat')
      .filter((thread) => !localRemoved.includes(thread.id))
      .map(toRow)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [localRemoved, resource.data]);

  const remove = useCallback(
    async (threadId: string): Promise<boolean> => {
      setRemoving(threadId);
      setRemoveError(null);
      try {
        const result = await deleteThread(client, threadId);
        if (!result.ok) {
          setRemoveError(result.error.message);
          return false;
        }
        // Drop it locally as well: the snapshot that just answered is already stale, and
        // re-listing would flash the deleted row back for a frame.
        setLocalRemoved((current) => [...current, threadId]);
        reload();
        return true;
      } catch (error) {
        setRemoveError(errorMessage(error));
        return false;
      } finally {
        setRemoving(null);
      }
    },
    [client, reload]
  );

  return {
    status: resource.status === 'idle' ? 'loading' : resource.status,
    threads,
    error: resource.error,
    reload,
    remove,
    removing,
    removeError
  };
}
