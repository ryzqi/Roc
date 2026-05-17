import type {
  AppSettings,
  AppStatus,
  BackgroundTask,
  DiagnosticPackage,
  FilePreviewResult,
  FileTreeResult,
  McpServerSnapshot,
  MemoryCandidate,
  MemoryConflict,
  MemorySearchResult,
  MemoryStatus,
  PerformanceSample,
  PermissionsConfig,
  ProviderConfig,
  ProviderSecretStatus,
  ProviderTestResult,
  SessionSearchResult,
  SettingsSnapshot,
  SkillSnapshot,
  TraySummary,
  Workspace
} from '../../shared/types';
import { unwrap } from '../loaded-state';
import { applySettingsSnapshot } from '../settings-model';
import { emptyWorkspaceData } from './empty-states';
import type { MemoryData, OperationsData, TaskSurfaceData, WorkspaceData } from './types';

export async function loadWorkspaceData(workspace: Workspace | null): Promise<WorkspaceData> {
  if (workspace === null) {
    return emptyWorkspaceData();
  }

  const fileTree = unwrap<FileTreeResult>('file tree', await window.roc.files.listTree({ relativePath: '' }));
  const firstFile = fileTree.entries.find((entry) => entry.type === 'file');
  const filePreview =
    firstFile === undefined
      ? null
      : unwrap<FilePreviewResult>('file preview', await window.roc.files.preview({ relativePath: firstFile.relativePath }));
  const fileSearch = null;
  const gitResult = await window.roc.git.status();
  const gitBranchesResult = gitResult.ok ? await window.roc.git.listBranches() : null;

  return {
    fileTree,
    fileSearch,
    filePreview,
    gitStatus: gitResult.ok ? gitResult.data : null,
    gitBranches: gitBranchesResult !== null && gitBranchesResult.ok ? gitBranchesResult.data : null,
    gitError: gitResult.ok ? (gitBranchesResult !== null && !gitBranchesResult.ok ? gitBranchesResult.error.message : null) : gitResult.error.message,
    gitSelectedPath: null,
    gitSelectedPreview: null,
    gitLastCommit: null,
    gitLastPush: null,
    terminalError: null,
    terminalSession: null
  };
}

export async function loadTaskSurfaceData(): Promise<TaskSurfaceData> {
  const backgroundTasks = unwrap<BackgroundTask[]>('background tasks', await window.roc.tasks.listBackgroundTasks());
  const backgroundTask = backgroundTasks[0] ?? null;
  const traySummary = unwrap<TraySummary>('tray summary', await window.roc.lifecycle.getTraySummary());

  return {
    backgroundTask,
    backgroundTasks,
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
    diagnosticPackage,
    performanceSample
  };
}

export async function loadMemoryData(_mode: AppStatus['mode']): Promise<MemoryData> {
  const [memoryStatus, candidates, conflicts, memorySearch, sessionSearch] = await Promise.all([
    window.roc.memory.status(),
    window.roc.memory.listCandidates(),
    window.roc.memory.listConflicts(),
    window.roc.memory.search({ query: 'project', source: 'all' }),
    window.roc.memory.sessionSearch({ query: 'project' })
  ]);

  return {
    memoryStatus: unwrap<MemoryStatus>('memory status', memoryStatus),
    memoryCandidates: unwrap<MemoryCandidate[]>('memory candidates', candidates),
    memoryConflicts: unwrap<MemoryConflict[]>('memory conflicts', conflicts),
    memorySearch: unwrap<MemorySearchResult>('memory search', memorySearch),
    sessionSearch: unwrap<SessionSearchResult>('session search', sessionSearch),
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
  providerTestStatus: ProviderTestResult | null;
  mcpTestStatus: null;
}> {
  const snapshot = unwrap<SettingsSnapshot>('settings snapshot', await window.roc.settings.get());
  return applySettingsSnapshot(snapshot);
}
