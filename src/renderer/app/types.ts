import type { HistorySidebarItem } from '../history-sidebar';
import type {
  BackgroundTask,
  DiagnosticPackage,
  FileEntryShape,
  FilePreviewLike,
  FilePreviewResult,
  FileSearchResult,
  FileTreeResult,
  GitBranchListResult,
  GitCommitResult,
  GitFileDiffResult,
  GitPushResult,
  GitStatusResult,
  MemoryCandidate,
  MemoryConflict,
  MemoryDeleteResult,
  MemorySearchResult,
  MemoryStatus,
  PerformanceSample,
  SessionSearchResult,
  TaskSnapshot,
  TerminalSessionSnapshot,
  TraySummary
} from '../../shared/types';

export type ViewId =
  | 'chat'
  | 'tasks'
  | 'workspace'
  | 'git'
  | 'terminal'
  | 'preview'
  | 'mcp'
  | 'skills'
  | 'memory'
  | 'settings'
  | 'diagnostics'
  | 'quick'
  | 'tray';

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
  meta: string;
  icon: PreviewIconName;
  active?: boolean;
};

export type PageMeta = {
  title: string;
  topMeta: string;
  pageLabel: string;
};

export type HistoryContextMenuState = {
  threadId: string;
  x: number;
  y: number;
};

export type WorkbenchTool = 'files' | 'git' | 'terminal';
export type MainViewId = Exclude<ViewId, 'quick' | 'tray'>;

export type WorkspaceData = {
  fileTree: FileTreeResult | null;
  fileSearch: FileSearchResult | null;
  filePreview: FilePreviewResult | null;
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
  memoryCandidates: MemoryCandidate[];
  memoryConflicts: MemoryConflict[];
  memorySearch: MemorySearchResult | null;
  sessionSearch: SessionSearchResult | null;
  memoryRecovery: MemoryDeleteResult | null;
};

export type TaskSurfaceData = {
  backgroundTask: BackgroundTask | null;
  backgroundTasks: BackgroundTask[];
  traySummary: TraySummary;
};

export type OperationsData = {
  diagnosticPackage: DiagnosticPackage | null;
  performanceSample: PerformanceSample;
};

export type LazyLoadState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  key: string | null;
};

export type MemoryRecordViewModel = {
  id: string;
  layer: string;
  scope: string;
  type: string;
  confidence: string | number;
  sourceTag: string;
  status: string;
  priority: string;
  sourceRef: string;
  summary: string;
  detail: string;
  tone: string;
  lastAccessed?: string;
  accessCount?: string;
  note?: string;
};

// Re-export so consumers can import everything from one place
export type { HistorySidebarItem, FileEntryShape, FilePreviewLike };
