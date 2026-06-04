import { useEffect, useMemo, useRef, useState } from 'react';
import { parseDiff, type FileData as GitDiffFileData } from 'react-diff-view';
import type { GitFileDiffResult, GitStatusChange } from '../../shared/types';
import type { WorkspaceData } from '../app/types';
import { buildGitDiffCacheKey, normalizeGitDiffText, selectGitDiffFile } from '../git-diff-adapter';
import { buildGitDiffPreviewRequest } from '../git-workbench';
import { unwrap, type IpcLikeResult } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import { createRocClient } from '../shared/roc-client';

type GitDiffPreviewState = {
  failedPath: string | null;
  loadingPath: string | null;
};

type GitDiffPreviewControllerInput = {
  fileDiff: (request: { relativePath: string }) => Promise<IpcLikeResult<GitFileDiffResult>>;
  onActionError: (message: string | null) => void;
  onStateChange?: (state: GitDiffPreviewState) => void;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
};

type UseGitDiffPreviewInput = {
  client?: RocClient;
  onActionError: (message: string | null) => void;
  selectedChange: GitStatusChange | null;
  selectedPath: string | null;
  selectedPreview: GitFileDiffResult | null;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
};

function setGitDiffPreviewState(
  stateRef: { current: GitDiffPreviewState },
  nextState: GitDiffPreviewState,
  onStateChange?: (state: GitDiffPreviewState) => void
): void {
  stateRef.current = nextState;
  onStateChange?.(nextState);
}

export function createGitDiffPreviewController({
  fileDiff,
  onActionError,
  onStateChange,
  updateWorkspaceData
}: GitDiffPreviewControllerInput): {
  getState: () => GitDiffPreviewState;
  load: (relativePath: string) => Promise<void>;
} {
  const stateRef = {
    current: {
      failedPath: null,
      loadingPath: null
    } satisfies GitDiffPreviewState
  };
  let requestId = 0;

  return {
    getState(): GitDiffPreviewState {
      return stateRef.current;
    },
    async load(relativePath: string): Promise<void> {
      requestId += 1;
      const activeRequestId = requestId;
      setGitDiffPreviewState(
        stateRef,
        {
          failedPath: stateRef.current.failedPath === relativePath ? null : stateRef.current.failedPath,
          loadingPath: relativePath
        },
        onStateChange
      );
      onActionError(null);
      try {
        const preview = unwrap('git selected file diff', await fileDiff({ relativePath }));
        if (requestId !== activeRequestId) {
          return;
        }
        updateWorkspaceData({
          gitSelectedPath: relativePath,
          gitSelectedPreview: preview
        });
        setGitDiffPreviewState(
          stateRef,
          {
            failedPath: stateRef.current.failedPath === relativePath ? null : stateRef.current.failedPath,
            loadingPath: null
          },
          onStateChange
        );
      } catch (selectionError) {
        if (requestId !== activeRequestId) {
          return;
        }
        setGitDiffPreviewState(
          stateRef,
          {
            failedPath: relativePath,
            loadingPath: null
          },
          onStateChange
        );
        onActionError(selectionError instanceof Error ? selectionError.message : '当前 Git Diff 加载失败。');
        updateWorkspaceData({
          gitSelectedPath: relativePath,
          gitSelectedPreview: null
        });
      }
    }
  };
}

export function useGitDiffPreview({
  client,
  onActionError,
  selectedChange,
  selectedPath,
  selectedPreview,
  updateWorkspaceData
}: UseGitDiffPreviewInput): {
  failedPath: string | null;
  loadingPath: string | null;
  loadGitDiffPreview: (relativePath: string) => Promise<void>;
  selectedDiffFile: GitDiffFileData | null;
  selectionPreview: GitFileDiffResult | null;
} {
  const [previewState, setPreviewState] = useState<GitDiffPreviewState>({
    failedPath: null,
    loadingPath: null
  });
  const actionErrorRef = useRef(onActionError);
  const updateWorkspaceDataRef = useRef(updateWorkspaceData);
  const diffParseCacheRef = useRef(new Map<string, GitDiffFileData[]>());
  const controllerRef = useRef<ReturnType<typeof createGitDiffPreviewController> | null>(null);

  actionErrorRef.current = onActionError;
  updateWorkspaceDataRef.current = updateWorkspaceData;

  if (controllerRef.current === null) {
    controllerRef.current = createGitDiffPreviewController({
      fileDiff: async ({ relativePath }) => (client ?? createRocClient()).api.git.fileDiff({ relativePath }),
      onActionError: (message) => {
        actionErrorRef.current(message);
      },
      onStateChange: setPreviewState,
      updateWorkspaceData: (partial) => {
        updateWorkspaceDataRef.current(partial);
      }
    });
  }

  const selectionPreview =
    selectedChange === null || selectedPreview === null || selectedPreview.relativePath !== selectedChange.relativePath
      ? null
      : selectedPreview;

  const selectionFiles = useMemo<GitDiffFileData[]>(() => {
    if (selectionPreview === null) {
      return [];
    }
    const cacheKey = buildGitDiffCacheKey(selectionPreview);
    const cachedFiles = diffParseCacheRef.current.get(cacheKey);
    if (cachedFiles !== undefined) {
      return cachedFiles;
    }
    const files = parseDiff(normalizeGitDiffText(selectionPreview.patch), { nearbySequences: 'zip' });
    diffParseCacheRef.current.set(cacheKey, files);
    return files;
  }, [selectionPreview]);

  const selectedDiffFile = useMemo(() => {
    if (selectedChange === null || selectionPreview === null) {
      return null;
    }
    return selectGitDiffFile(selectionFiles, selectedChange.relativePath);
  }, [selectedChange, selectionFiles, selectionPreview]);

  useEffect(() => {
    const request = buildGitDiffPreviewRequest({
      failedPath: previewState.failedPath,
      loadingPath: previewState.loadingPath,
      selectedPath,
      selectedPreview
    });
    if (request === null) {
      return;
    }
    void controllerRef.current?.load(request.relativePath);
  }, [previewState.failedPath, previewState.loadingPath, selectedPath, selectedPreview]);

  return {
    failedPath: previewState.failedPath,
    loadingPath: previewState.loadingPath,
    loadGitDiffPreview: async (relativePath: string) => {
      await controllerRef.current?.load(relativePath);
    },
    selectedDiffFile,
    selectionPreview
  };
}
