import type {
  AppStatus,
  ActiveTaskItem,
  ApprovalMode,
  BackgroundTask,
  FilePreviewRequest,
  DiagnosticPackage,
  FilesWorkbenchPdfPreviewResult,
  FilePreviewResult,
  FileTreeResult,
  MemoryStatus,
  PerformanceSample,
  SettingsSnapshot,
  TraySummary,
  Workspace
} from '../../shared/types';
import { unwrap } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import { createRocClient } from '../shared/roc-client';
import type { LoadedSettingsState } from '../settings-model';
import { applySettingsSnapshot } from '../settings-model';
import { findNextGitSelection } from '../workbench/git-helpers';
import { emptyWorkspaceData } from './empty-states';
import type { MemoryData, OperationsData, TaskSurfaceData, WorkspaceData } from './types';

export type WorkspaceDataLoadOptions = {
  previewRelativePath?: string | null;
  fileWorkbenchPdfRelativePath?: string | null;
  fallbackToFirstFilePreview?: boolean;
  gitSelectedPath?: string | null;
};

export async function loadWorkspaceData(
  workspace: Workspace | null,
  options: WorkspaceDataLoadOptions = {},
  client: RocClient = createRocClient()
): Promise<WorkspaceData> {
  if (workspace === null) {
    return emptyWorkspaceData();
  }

  const api = client.api;
  const fileTreePromise = api.files.listTree({ relativePath: '' });
  const gitStatusPromise = api.git.status();
  const fileTree = unwrap<FileTreeResult>('file tree', await fileTreePromise);
  const filePreviewPromise = loadWorkspaceFilePreview(client, fileTree, options);
  const fileSearch = null;
  const gitResult = await gitStatusPromise;
  const gitBranchesPromise = gitResult.ok ? api.git.listBranches() : Promise.resolve(null);
  const filePreview = await filePreviewPromise;
  const fileWorkbenchPdfPreviewPromise = loadWorkspacePdfWorkbenchPreview(client, filePreview, options);
  const gitSelectedPath =
    options.gitSelectedPath === undefined || !gitResult.ok
      ? null
      : findNextGitSelection(gitResult.data.changes, options.gitSelectedPath);
  const gitSelectedPreviewPromise =
    gitSelectedPath === null
      ? Promise.resolve(null)
      : loadGitSelectedPreview(client, { relativePath: gitSelectedPath });
  const [fileWorkbenchPdfPreview, gitBranchesResult, gitSelectedPreview] = await Promise.all([
    fileWorkbenchPdfPreviewPromise,
    gitBranchesPromise,
    gitSelectedPreviewPromise
  ]);

  return {
    fileTree,
    fileSearch,
    filePreview,
    fileWorkbenchPdfPreview,
    gitStatus: gitResult.ok ? gitResult.data : null,
    gitBranches: gitBranchesResult !== null && gitBranchesResult.ok ? gitBranchesResult.data : null,
    gitError: gitResult.ok ? (gitBranchesResult !== null && !gitBranchesResult.ok ? gitBranchesResult.error.message : null) : gitResult.error.message,
    gitSelectedPath,
    gitSelectedPreview,
    gitLastCommit: null,
    gitLastPush: null,
    terminalError: null,
    terminalSession: null
  };
}

async function loadWorkspaceFilePreview(
  client: RocClient,
  fileTree: FileTreeResult,
  options: WorkspaceDataLoadOptions
): Promise<FilePreviewResult | null> {
  const previewRelativePath = options.previewRelativePath;
  if (previewRelativePath !== undefined) {
    if (previewRelativePath === null) {
      return null;
    }
    return await loadOptionalFilePreview(client, { relativePath: previewRelativePath });
  }
  if (options.fallbackToFirstFilePreview === false) {
    return null;
  }
  const firstFile = fileTree.entries.find((entry) => entry.type === 'file');
  if (firstFile === undefined) {
    return null;
  }
  return await loadOptionalFilePreview(client, { relativePath: firstFile.relativePath });
}

async function loadOptionalFilePreview(client: RocClient, request: FilePreviewRequest): Promise<FilePreviewResult | null> {
  const previewResult = await client.api.files.preview(request);
  return previewResult.ok ? previewResult.data : null;
}

async function loadWorkspacePdfWorkbenchPreview(
  client: RocClient,
  filePreview: FilePreviewResult | null,
  options: WorkspaceDataLoadOptions
): Promise<FilesWorkbenchPdfPreviewResult | null> {
  if (options.fileWorkbenchPdfRelativePath === undefined || options.fileWorkbenchPdfRelativePath === null) {
    return null;
  }
  const sharedPreview =
    filePreview?.relativePath === options.fileWorkbenchPdfRelativePath
      ? filePreview
      : await loadOptionalFilePreview(client, { relativePath: options.fileWorkbenchPdfRelativePath });
  if (sharedPreview === null || sharedPreview.mediaType !== 'application/pdf') {
    return null;
  }
  const previewResult = await client.api.files.previewPdf({ relativePath: options.fileWorkbenchPdfRelativePath });
  return previewResult.ok ? previewResult.data : null;
}

async function loadGitSelectedPreview(client: RocClient, request: { relativePath: string }): Promise<WorkspaceData['gitSelectedPreview']> {
  const previewResult = await client.api.git.fileDiff(request);
  return previewResult.ok ? previewResult.data : null;
}

export async function loadTaskSurfaceData(selectedTaskId?: string | null, client: RocClient = createRocClient()): Promise<TaskSurfaceData> {
  const api = client.api;
  const [activeTasksResult, schedulerStatusResult, traySummaryResult] = await Promise.all([
    api.tasks.getActiveTasks(),
    api.tasks.getSchedulerStatus(),
    api.lifecycle.getTraySummary()
  ]);
  const activeTasks = unwrap<ActiveTaskItem[]>('active tasks', activeTasksResult);
  const schedulerStatus = unwrap('scheduler status', schedulerStatusResult);
  const traySummary = unwrap<TraySummary>('tray summary', traySummaryResult);
  const firstBackgroundTaskId = activeTasks.find((task) => task.taskId !== null)?.taskId ?? null;
  const selectedTaskStillActive =
    typeof selectedTaskId === 'string' && activeTasks.some((task) => task.taskId === selectedTaskId);
  const primaryTaskId =
    selectedTaskId === undefined
      ? firstBackgroundTaskId
      : selectedTaskId === null
        ? null
        : selectedTaskStillActive
          ? selectedTaskId
          : null;
  const [taskDetailResult, scheduledRunsResult] =
    primaryTaskId === null
      ? [null, null]
      : await Promise.all([
          api.tasks.getTaskDetail({ taskId: primaryTaskId }),
          api.tasks.listScheduledRuns({ taskId: primaryTaskId })
        ]);

  return {
    activeTasks,
    taskDetail: taskDetailResult === null ? null : unwrap('task detail', taskDetailResult),
    scheduledRuns: scheduledRunsResult === null ? [] : unwrap('scheduled runs', scheduledRunsResult),
    schedulerStatus,
    traySummary
  };
}

export async function loadOperationsData(mode: AppStatus['mode'], client: RocClient = createRocClient()): Promise<OperationsData> {
  const api = client.api;
  const backgroundTasksPromise = api.tasks.listBackgroundTasks();
  const performancePromise = api.diagnostics.samplePerformance({ mode, memoryBudgetMb: 450 });
  const checksPromise = api.diagnostics.runChecks();
  const backgroundTasks = unwrap<BackgroundTask[]>('background tasks', await backgroundTasksPromise);
  const backgroundTask = backgroundTasks[0] ?? null;
  const diagnosticPackagePromise =
    backgroundTask === null
      ? Promise.resolve(null)
      : api.diagnostics.createDiagnosticPackage({
          taskId: backgroundTask.id,
          errorSummary: '后台任务诊断请求'
        });
  const [performanceResult, checksResult, packageResult] = await Promise.all([
    performancePromise,
    checksPromise,
    diagnosticPackagePromise
  ]);
  const performanceSample = unwrap<PerformanceSample>('performance sample', performanceResult);
  const diagnosticChecks = unwrap('diagnostic checks', checksResult);
  const diagnosticPackage = packageResult === null ? null : unwrap<DiagnosticPackage>('diagnostic package', packageResult);

  return {
    diagnosticChecks,
    diagnosticPackage,
    performanceSample
  };
}

export async function loadMemoryData(_mode: AppStatus['mode'], client: RocClient = createRocClient()): Promise<MemoryData> {
  const memoryStatus = await client.api.memory.status();
  return {
    memoryStatus: unwrap<MemoryStatus>('memory status', memoryStatus),
    memoryRecovery: null
  };
}

export async function loadSettingsState(
  client: RocClient = createRocClient()
): Promise<LoadedSettingsState & { mcpApprovalMode: ApprovalMode }> {
  const [settingsResult, mcpConfigResult] = await Promise.all([client.api.settings.get(), client.api.mcp.getConfig()]);
  const snapshot = unwrap<SettingsSnapshot>('settings snapshot', settingsResult);
  const mcpConfig = unwrap('mcp config', mcpConfigResult);
  return {
    ...applySettingsSnapshot(snapshot),
    mcpApprovalMode: mcpConfig.approvalMode
  };
}
