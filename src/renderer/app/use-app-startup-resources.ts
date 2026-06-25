import { useCallback, useEffect, useRef, useState } from 'react';

import type { AppStatus, Workspace } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';
import { idleLazyLoadState } from './empty-states';
import { getStartupLoadIntent } from '../startup-load-policy';
import { createWorkspaceRefreshSubscription } from './workspace-refresh';
import { loadMemoryData, loadOperationsData, loadTaskSurfaceData, loadWorkspaceData } from './data-loading';
import type { LazyLoadState, MemoryData, OperationsData, TaskSurfaceData, ViewId, WorkbenchTool, WorkspaceData } from './types';
import type { AppBootstrap } from './use-app-bootstrap';
import { useLazyStartupResource } from './use-lazy-startup-resource';

interface UseAppStartupResourcesOptions {
  activeView: ViewId;
  client: RocClient;
  currentAppMode: AppStatus['mode'] | null;
  currentWorkspace: Workspace | null;
  selectedTaskSurfaceTaskId: string | null | undefined;
  setError: (message: string) => void;
  setState: AppBootstrap['setState'];
  state: AppBootstrap['state'];
  workbenchVisible: boolean;
  activeWorkbenchTool: WorkbenchTool;
}

export function useAppStartupResources({
  activeView,
  activeWorkbenchTool,
  client,
  currentAppMode,
  currentWorkspace,
  selectedTaskSurfaceTaskId,
  setError,
  setState,
  state,
  workbenchVisible
}: UseAppStartupResourcesOptions): {
  memoryLoadState: LazyLoadState;
  operationsLoadState: LazyLoadState;
  setWorkspaceLoadState: (next: LazyLoadState) => void;
  taskSurfaceLoadState: LazyLoadState;
  workspaceLoadState: LazyLoadState;
} {
  const [workspaceLoadState, setWorkspaceLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const [memoryLoadState, setMemoryLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const [operationsLoadState, setOperationsLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const [taskSurfaceLoadState, setTaskSurfaceLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const workspaceRefreshSubscriptionRef = useRef<ReturnType<typeof createWorkspaceRefreshSubscription> | null>(null);
  const workspaceRefreshSnapshotRef = useRef({
    workspace: null as Workspace | null,
    previewRelativePath: null as string | null,
    fileWorkbenchPdfRelativePath: null as string | null,
    gitSelectedPath: null as string | null
  });

  useEffect(() => {
    const nextSnapshot = {
      workspace: state?.workspace ?? null,
      previewRelativePath: state?.filePreview?.relativePath ?? null,
      fileWorkbenchPdfRelativePath: state?.fileWorkbenchPdfPreview?.relativePath ?? null,
      gitSelectedPath: state?.gitSelectedPath ?? null
    };
    workspaceRefreshSnapshotRef.current = nextSnapshot;
    workspaceRefreshSubscriptionRef.current?.updateSnapshot(nextSnapshot);
  }, [state?.workspace, state?.filePreview?.relativePath, state?.fileWorkbenchPdfPreview?.relativePath, state?.gitSelectedPath]);

  useEffect(() => {
    const subscription = createWorkspaceRefreshSubscription({
      initialSnapshot: workspaceRefreshSnapshotRef.current,
      load: async (workspace, options) => {
        const workspaceData = await loadWorkspaceData(workspace, options, client);
        return {
          fileTree: workspaceData.fileTree,
          filePreview: workspaceData.filePreview,
          fileWorkbenchPdfPreview: workspaceData.fileWorkbenchPdfPreview,
          gitStatus: workspaceData.gitStatus,
          gitBranches: workspaceData.gitBranches,
          gitError: workspaceData.gitError,
          gitSelectedPath: workspaceData.gitSelectedPath,
          gitSelectedPreview: workspaceData.gitSelectedPreview
        };
      },
      apply: (workspacePath, workspaceData) => {
        setState((current) => {
          if (current === null || current.workspace?.path !== workspacePath) {
            return current;
          }
          return {
            ...current,
            ...workspaceData
          };
        });
      },
      onError: (message) => {
        setError(message);
      },
      subscribe: (listener) => client.api.chat.onRunEvent(listener),
      subscribeWorkspaceChanges: (listener) => client.api.workspace.onChanged(listener)
    });
    workspaceRefreshSubscriptionRef.current = subscription;

    return () => {
      workspaceRefreshSubscriptionRef.current = null;
      subscription.dispose();
    };
  }, []);

  const startupLoadIntent = getStartupLoadIntent({
    activeView,
    activeWorkbenchTool,
    workbenchVisible
  });

  useLazyStartupResource<WorkspaceData>({
    apply: useCallback((workspaceData) => {
      setState((current) => (current === null ? current : { ...current, ...workspaceData }));
    }, []),
    cacheKey: state === null ? null : currentWorkspace?.path ?? 'no-workspace',
    enabled: state !== null && startupLoadIntent.targets.has('workspace'),
    load: useCallback(() => loadWorkspaceData(currentWorkspace, {}, client), [client, currentWorkspace]),
    loadState: workspaceLoadState,
    setLoadState: setWorkspaceLoadState
  });

  useLazyStartupResource<MemoryData>({
    apply: useCallback((memoryData) => {
      setState((current) => (current === null ? current : { ...current, ...memoryData }));
    }, []),
    cacheKey: currentAppMode,
    enabled: currentAppMode !== null && startupLoadIntent.targets.has('memory'),
    load: useCallback(() => loadMemoryData(currentAppMode as AppStatus['mode'], client), [client, currentAppMode]),
    loadState: memoryLoadState,
    setLoadState: setMemoryLoadState
  });

  useLazyStartupResource<OperationsData>({
    apply: useCallback((operationsData) => {
      setState((current) => (current === null ? current : { ...current, ...operationsData }));
    }, []),
    cacheKey: currentAppMode,
    enabled: currentAppMode !== null && startupLoadIntent.targets.has('operations'),
    load: useCallback(() => loadOperationsData(currentAppMode as AppStatus['mode'], client), [client, currentAppMode]),
    loadState: operationsLoadState,
    setLoadState: setOperationsLoadState
  });

  useLazyStartupResource<TaskSurfaceData>({
    apply: useCallback((taskSurfaceData) => {
      setState((current) => (current === null ? current : { ...current, ...taskSurfaceData }));
    }, []),
    cacheKey:
      state === null
        ? null
        : selectedTaskSurfaceTaskId === undefined
          ? 'task-surface:auto'
          : selectedTaskSurfaceTaskId === null
            ? 'task-surface:none'
            : `task-surface:${selectedTaskSurfaceTaskId}`,
    enabled: state !== null && startupLoadIntent.targets.has('taskSurface'),
    load: useCallback(() => loadTaskSurfaceData(selectedTaskSurfaceTaskId, client), [client, selectedTaskSurfaceTaskId]),
    loadState: taskSurfaceLoadState,
    setLoadState: setTaskSurfaceLoadState
  });

  return {
    memoryLoadState,
    operationsLoadState,
    setWorkspaceLoadState,
    taskSurfaceLoadState,
    workspaceLoadState
  };
}
