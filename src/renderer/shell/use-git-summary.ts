import { useEffect } from 'react';
import { useAsyncResource } from '../app/use-async-resource';
import type { RocClient } from '../shared/roc-client';
import { gitStatus } from '../workspace/git-store';
import { WATCH_REFRESH_WINDOW_MS } from '../workspace/watch-refresh';

export function useGitSummary(client: RocClient, workspacePath: string | null, drawerOpen: boolean): {
  branch: string | null;
  changes: number | null;
} {
  const { data, reload } = useAsyncResource(workspacePath, () => gitStatus(client), { label: '读取 Git 状态' });
  useEffect(() => {
    if (workspacePath === null || drawerOpen) return;
    reload();
    let refresh: number | undefined;
    const unsubscribe = client.api.workspace.onChanged(event => {
      if (event.workspacePath !== workspacePath || refresh !== undefined) return;
      refresh = window.setTimeout(() => {
        refresh = undefined;
        reload();
      }, WATCH_REFRESH_WINDOW_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(refresh);
    };
  }, [client, workspacePath, drawerOpen, reload]);
  return { branch: data?.branch ?? null, changes: data?.changedFiles ?? null };
}
