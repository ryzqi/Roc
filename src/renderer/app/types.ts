import type { HistorySidebarItem } from '../history-sidebar';
import type {
  ActiveTaskItem,
  DiagnosticCheck,
  DiagnosticPackage,
  FilesWorkbenchPdfPreview,
  FilePreviewResult,
  FileSearchResult,
  FileTreeResult,
  GitBranchListResult,
  GitCommitResult,
  GitFileDiffResult,
  GitPushResult,
  GitStatusResult,
  MemoryStatus,
  PerformanceSample,
  SchedulerStatus,
  ScheduledTaskRun,
  TaskDetail,
  TerminalSessionSnapshot,
  TraySummary
} from '../../shared/types';

export type ViewId =
  | 'chat'
  | 'tasks-board'
  | 'task-detail'
  | 'workspace'
  | 'git'
  | 'terminal'
  | 'preview'
  | 'mcp'
  | 'skills'
  | 'memory'
  | 'settings'
  | 'diagnostics';

export type PreviewIconName =
  | 'bot'
  | 'clipboard'
  | 'eye'
  | 'folder'
  | 'git'
  | 'globe'
  | 'history'
  | 'nodes'
  | 'paperclip'
  | 'panel-right'
  | 'send'
  | 'sparkles'
  | 'stethoscope'
  | 'terminal'
  | 'wrench';

export type NavItem = {
  id: ViewId;
  label: string;
  // 完整文案，dock 单行放不下，降级为 title tooltip。
  meta: string;
  // 短徽标，dock 行右对齐显示；无可显示数值时省略。
  badge?: string;
  badgeTone?: 'alert';
  icon: PreviewIconName;
  active?: boolean;
};

export type WorkbenchTool = 'files' | 'git' | 'terminal';
export type MainViewId = ViewId;

export type WorkspaceData = {
  fileTree: FileTreeResult | null;
  fileSearch: FileSearchResult | null;
  filePreview: FilePreviewResult | null;
  fileWorkbenchPdfPreview: FilesWorkbenchPdfPreview | null;
  gitStatus: GitStatusResult | null;
  gitBranches: GitBranchListResult | null;
  gitError: string | null;
  gitSelectedPath: string | null;
  gitSelectedPreview: GitFileDiffResult | null;
  gitLastCommit: GitCommitResult | null;
  gitLastPush: GitPushResult | null;
  terminalError: string | null;
  terminalSession: TerminalSessionSnapshot | null;
};

export type MemoryData = {
  memoryStatus: MemoryStatus;
  memoryRecovery: null;
};

export type TaskSurfaceData = {
  activeTasks: ActiveTaskItem[];
  taskDetail: TaskDetail | null;
  scheduledRuns: ScheduledTaskRun[];
  schedulerStatus: SchedulerStatus;
  traySummary: TraySummary;
};

export type OperationsData = {
  diagnosticChecks: DiagnosticCheck[];
  diagnosticPackage: DiagnosticPackage | null;
  performanceSample: PerformanceSample;
};

export type LazyLoadState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  key: string | null;
};

export type { HistorySidebarItem };
