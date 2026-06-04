import type {
  AppSettings,
  AppStatus,
  ActiveTaskItem,
  BackgroundTask,
  HostIntegrationStatus,
  FilePreviewRequest,
  DiagnosticPackage,
  FilesWorkbenchPdfPreviewResult,
  FilePreviewResult,
  FileTreeResult,
  McpServerSnapshot,
  MemoryStatus,
  PerformanceSample,
  PermissionsConfig,
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult,
  SettingsSnapshot,
  SkillSnapshot,
  TraySummary,
  Workspace
} from '../../shared/types';
import { unwrap } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import { createRocClient } from '../shared/roc-client';
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
  options: WorkspaceDataLoadOptions = {}
): Promise<WorkspaceData> {
  if (workspace === null) {
    return emptyWorkspaceData();
  }

  const fileTree = unwrap<FileTreeResult>('file tree', await window.roc.files.listTree({ relativePath: '' }));
  const filePreview = await loadWorkspaceFilePreview(fileTree, options);
  const fileWorkbenchPdfPreview = await loadWorkspacePdfWorkbenchPreview(filePreview, options);
  const fileSearch = null;
  const gitResult = await window.roc.git.status();
  const gitBranchesResult = gitResult.ok ? await window.roc.git.listBranches() : null;
  const gitSelectedPath =
    options.gitSelectedPath === undefined || !gitResult.ok
      ? null
      : findNextGitSelection(gitResult.data.changes, options.gitSelectedPath);
  const gitSelectedPreview =
    gitSelectedPath === null ? null : await loadGitSelectedPreview({ relativePath: gitSelectedPath });

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
  fileTree: FileTreeResult,
  options: WorkspaceDataLoadOptions
): Promise<FilePreviewResult | null> {
  const previewRelativePath = options.previewRelativePath;
  if (previewRelativePath !== undefined) {
    if (previewRelativePath === null) {
      return null;
    }
    return await loadOptionalFilePreview({ relativePath: previewRelativePath });
  }
  if (options.fallbackToFirstFilePreview === false) {
    return null;
  }
  const firstFile = fileTree.entries.find((entry) => entry.type === 'file');
  if (firstFile === undefined) {
    return null;
  }
  return await loadOptionalFilePreview({ relativePath: firstFile.relativePath });
}

async function loadOptionalFilePreview(request: FilePreviewRequest): Promise<FilePreviewResult | null> {
  const previewResult = await window.roc.files.preview(request);
  return previewResult.ok ? previewResult.data : null;
}

async function loadWorkspacePdfWorkbenchPreview(
  filePreview: FilePreviewResult | null,
  options: WorkspaceDataLoadOptions
): Promise<FilesWorkbenchPdfPreviewResult | null> {
  if (options.fileWorkbenchPdfRelativePath === undefined || options.fileWorkbenchPdfRelativePath === null) {
    return null;
  }
  const sharedPreview =
    filePreview?.relativePath === options.fileWorkbenchPdfRelativePath
      ? filePreview
      : await loadOptionalFilePreview({ relativePath: options.fileWorkbenchPdfRelativePath });
  if (sharedPreview === null || sharedPreview.mediaType !== 'application/pdf') {
    return null;
  }
  const previewResult = await window.roc.files.previewPdf({ relativePath: options.fileWorkbenchPdfRelativePath });
  return previewResult.ok ? previewResult.data : null;
}

async function loadGitSelectedPreview(request: { relativePath: string }): Promise<WorkspaceData['gitSelectedPreview']> {
  const previewResult = await window.roc.git.fileDiff(request);
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
  const primaryTaskId =
    selectedTaskId === undefined
      ? firstBackgroundTaskId
      : selectedTaskId === null
        ? null
        : activeTasks.some((task) => task.taskId === selectedTaskId)
          ? selectedTaskId
          : firstBackgroundTaskId;
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

export async function loadOperationsData(mode: AppStatus['mode']): Promise<OperationsData> {
  const backgroundTasks = unwrap<BackgroundTask[]>('background tasks', await window.roc.tasks.listBackgroundTasks());
  const backgroundTask = backgroundTasks[0] ?? null;
  const performanceSample = unwrap<PerformanceSample>(
    'performance sample',
    await window.roc.diagnostics.samplePerformance({
      mode,
      memoryBudgetMb: 300
    })
  );
  const diagnosticChecks = unwrap('diagnostic checks', await window.roc.diagnostics.runChecks());
  const diagnosticPackage =
    backgroundTask === null
      ? null
      : unwrap<DiagnosticPackage>(
          'diagnostic package',
          await window.roc.diagnostics.createDiagnosticPackage({
            taskId: backgroundTask.id,
            errorSummary: '后台任务诊断请求'
          })
        );

  return {
    diagnosticChecks,
    diagnosticPackage,
    performanceSample
  };
}

export async function loadMemoryData(_mode: AppStatus['mode']): Promise<MemoryData> {
  const memoryStatus = await window.roc.memory.status();
  return {
    memoryStatus: unwrap<MemoryStatus>('memory status', memoryStatus),
    memoryRecovery: null
  };
}

export async function loadSettingsState(): Promise<{
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerSecretStatus: ProviderSecretStatus[];
  permissions: PermissionsConfig;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
  hostIntegration: HostIntegrationStatus;
  providerTestStatus: ProviderTestResult | null;
  mcpTestStatus: null;
}> {
  const snapshot = unwrap<SettingsSnapshot>('settings snapshot', await window.roc.settings.get());
  return applySettingsSnapshot(snapshot);
}
