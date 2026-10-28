import { useCallback, useMemo } from 'react';
import useSWRImmutable from 'swr/immutable';
import { useSWRConfig } from 'swr';
import type { RocError } from '../../shared/types/common';
import type { ResearchProject } from '../../shared/types';
import type { AsyncResource, AsyncStatus } from '../app/use-async-resource';
import { IpcResourceError } from '../app/ipc-resource';
import type { RocClient } from '../shared/roc-client';

/** One unfiltered project list per renderer. Search/filter text is local to each consumer. */
export const PROJECT_LIST_RESOURCE_KEY = [
  'research',
  'projects',
  'list',
  { scope: 'all', query: null }
] as const;

export type ProjectListResource = AsyncResource<ResearchProject[]> & {
  /** The complete backend failure for callers that need category/retry policy. */
  failure: RocError | null;
};

async function loadProjectList(client: RocClient): Promise<ResearchProject[]> {
  const result = await client.api.research.listProjects();
  if (!result.ok) {
    throw new IpcResourceError(result.error);
  }
  return result.data;
}

/** Shared project-list resource used by both the portal and command palette. */
export function useProjectList(client: RocClient): ProjectListResource {
  const resource = useSWRImmutable<ResearchProject[], IpcResourceError>(
    PROJECT_LIST_RESOURCE_KEY,
    () => loadProjectList(client)
  );
  let status: AsyncStatus;
  if (resource.data !== undefined) {
    status = 'ready';
  } else if (resource.isLoading || resource.isValidating) {
    status = 'loading';
  } else if (resource.error !== undefined) {
    status = 'error';
  } else {
    status = 'idle';
  }
  const data = resource.data ?? null;
  const error = resource.isValidating ? null : resource.error?.message ?? null;
  const failure = resource.isValidating ? null : resource.error?.rocError ?? null;
  const reload = useCallback(() => {
    void resource.mutate().catch(() => undefined);
  }, [resource.mutate]);

  return useMemo(() => ({ status, data, error, failure, reload }), [status, data, error, failure, reload]);
}

/** Revalidates only the shared project list after a successful project write. */
export function useInvalidateProjectList(): () => void {
  const { mutate } = useSWRConfig();
  return useCallback(() => {
    void mutate(PROJECT_LIST_RESOURCE_KEY).catch(() => undefined);
  }, [mutate]);
}
