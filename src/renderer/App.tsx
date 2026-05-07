import {
  Archive,
  CircleAlert,
  Code2,
  File,
  FileArchive,
  FileAudio2,
  FileCog,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo2,
  Folder,
  FolderOpen,
  GitBranch,
  RefreshCw
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { Diff, Hunk, parseDiff, type FileData as GitDiffFileData } from 'react-diff-view';
import type {
  AgentRuntimeStatus,
  AgentCapabilityPreview,
  AppStatus,
  BackgroundTask,
  ChatSubmitResult,
  DiagnosticPackage,
  DoctorSnapshot,
  FilePreviewResult,
  FileSearchResult,
  FileTreeResult,
  GitBranchListResult,
  GitBranchMutationResult,
  GitCommitResult,
  GitFileDiffResult,
  GitStatusChange,
  GitPushResult,
  GitStatusResult,
  McpServerTestResult,
  McpServerSnapshot,
  MemoryCandidate,
  MemoryConflict,
  MemoryDeleteResult,
  MemorySearchResult,
  MemoryStatus,
  PerformanceSample,
  ProviderConfig,
  ProviderTestResult,
  RtkStatus,
  SessionSearchResult,
  SkillSnapshot,
  TerminalSessionExitEvent,
  TerminalSessionOutputEvent,
  TerminalSessionSnapshot,
  TaskSnapshot,
  TraySummary,
  WindowBoundsSnapshot,
  WindowStateSnapshot,
  Workspace
} from '../shared/types';
import { getStartupLoadIntent } from './startup-load-policy';
import { buildGitDiffCacheKey, buildGitDiffTitle, normalizeGitDiffText, selectGitDiffFile } from './git-diff-adapter';
import {
  buildGitBranchSwitcherModel,
  buildGitCommitButtonState,
  buildGitSelectionModel,
  clampGitSplitWidth,
  GIT_SPLIT_DEFAULT_WIDTH,
  selectAllGitChanges
} from './git-workbench';
import '@xterm/xterm/css/xterm.css';
import 'react-diff-view/style/index.css';

type ViewId =
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
  | 'doctor'
  | 'diagnostics'
  | 'quick'
  | 'tray';

type PreviewIconName =
  | 'bot'
  | 'clipboard'
  | 'checklist'
  | 'panel-capture'
  | 'tray-upload'
  | 'stack'
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

type NavItem = {
  id: ViewId;
  label: string;
  meta: string;
  icon: PreviewIconName;
};

type HistoryItem = {
  id: string;
  label: string;
  meta: string;
  icon: PreviewIconName;
};

type PageMeta = {
  title: string;
  topMeta: string;
  pageLabel: string;
};

type WorkbenchTool = 'files' | 'git' | 'terminal';
type MainViewId = Exclude<ViewId, 'quick' | 'tray'>;
type WorkspaceData = {
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
type MemoryData = {
  memoryStatus: MemoryStatus;
  memoryCandidates: MemoryCandidate[];
  memoryConflicts: MemoryConflict[];
  memorySearch: MemorySearchResult | null;
  sessionSearch: SessionSearchResult | null;
  memoryRecovery: MemoryDeleteResult | null;
};
type CapabilityData = {
  providers: ProviderConfig[];
  defaultModelId: string | null;
  mcpServers: McpServerSnapshot[];
  skills: SkillSnapshot[];
};
type TaskSurfaceData = {
  backgroundTask: BackgroundTask | null;
  backgroundTasks: BackgroundTask[];
  traySummary: TraySummary;
};
type OperationsData = {
  diagnosticPackage: DiagnosticPackage | null;
  performanceSample: PerformanceSample;
  doctor: DoctorSnapshot;
};
type LazyLoadState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  key: string | null;
};
type MemoryRecordViewModel = {
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

type LoadedState = {
  appStatus: AppStatus;
  taskSnapshot: TaskSnapshot;
  memoryStatus: MemoryStatus;
  memoryCandidates: MemoryCandidate[];
  memoryConflicts: MemoryConflict[];
  memorySearch: MemorySearchResult | null;
  sessionSearch: SessionSearchResult | null;
  memoryRecovery: MemoryDeleteResult | null;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerTestStatus: ProviderTestResult | null;
  mcpServers: McpServerSnapshot[];
  mcpTestStatus: McpServerTestResult | null;
  skills: SkillSnapshot[];
  selectedMcpServers: string[];
  selectedSkills: string[];
  backgroundTask: BackgroundTask | null;
  backgroundTasks: BackgroundTask[];
  traySummary: TraySummary;
  diagnosticPackage: DiagnosticPackage | null;
  performanceSample: PerformanceSample;
  doctor: DoctorSnapshot;
  agent: AgentRuntimeStatus;
  agentCapabilityPreview: AgentCapabilityPreview | null;
  chatResult: ChatSubmitResult | null;
  workspace: Workspace | null;
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
  rtkStatus: RtkStatus;
  terminalError: string | null;
  terminalSession: TerminalSessionSnapshot | null;
};

type IpcLikeResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

function emptyWorkspaceData(): WorkspaceData {
  return {
    fileTree: null,
    fileSearch: null,
    filePreview: null,
    gitStatus: null,
    gitBranches: null,
    gitError: null,
    gitSelectedPath: null,
    gitSelectedPreview: null,
    gitLastCommit: null,
    gitLastPush: null,
    terminalError: null,
    terminalSession: null
  };
}

function emptyMemoryData(): MemoryData {
  return {
    memoryStatus: {
      root: '',
      truthSource: 'markdown',
      indexSource: 'sqlite',
      vectorIndex: {
        enabled: false,
        healthy: false,
        status: 'not_configured'
      },
      fullTextIndex: {
        enabled: false,
        healthy: false,
        status: 'degraded'
      },
      layers: {
        hot: { entries: 0, characters: 0, path: '' },
        warm: { entries: 0, characters: 0, path: '' },
        cold: { entries: 0, characters: 0, path: '' },
        session: { entries: 0, characters: 0, path: '' },
        candidate: { entries: 0, characters: 0, path: '' }
      },
      degradedReason: '记忆页面尚未加载。'
    },
    memoryCandidates: [],
    memoryConflicts: [],
    memorySearch: null,
    sessionSearch: null,
    memoryRecovery: null
  };
}

function emptyOperationsData(mode: AppStatus['mode']): OperationsData {
  return {
    diagnosticPackage: null,
    performanceSample: {
      id: '',
      sampledAt: '',
      mode,
      uptimeSeconds: 0,
      rssMb: 0,
      heapUsedMb: 0,
      heapTotalMb: 0,
      memoryBudgetMb: 300,
      exceedsBudget: false
    },
    doctor: {
      generatedAt: '',
      summary: {
        pass: 0,
        fail: 0,
        degraded: 0,
        skipped: 0
      },
      findings: []
    }
  };
}

function idleLazyLoadState(key: string | null = null): LazyLoadState {
  return {
    status: 'idle',
    error: null,
    key
  };
}

const MAIN_VIEW_IDS = new Set<ViewId>([
  'chat',
  'tasks',
  'workspace',
  'git',
  'terminal',
  'preview',
  'mcp',
  'skills',
  'memory',
  'settings',
  'doctor',
  'diagnostics'
]);
const FLOATING_VIEW_IDS = new Set<ViewId>(['quick', 'tray']);
const WORKBENCH_VIEWS = new Set<ViewId>(['chat', 'workspace', 'git', 'terminal', 'preview']);

const WORKBENCH_TOOLS: Array<{ id: WorkbenchTool; label: string; icon: PreviewIconName }> = [
  { id: 'files', label: '文件', icon: 'folder' },
  { id: 'git', label: 'Git', icon: 'git' },
  { id: 'terminal', label: '终端', icon: 'terminal' }
];

const PAGE_META: Record<MainViewId, PageMeta> = {
  chat: {
    title: '聊天主页',
    topMeta: '未选择工作区',
    pageLabel: '主会话'
  },
  tasks: {
    title: '任务工作台',
    topMeta: '任务状态',
    pageLabel: '任务控制'
  },
  workspace: {
    title: '工作区文件',
    topMeta: '文件视图',
    pageLabel: '工作区'
  },
  git: {
    title: 'Git 面板',
    topMeta: 'Git 状态',
    pageLabel: '工作区'
  },
  terminal: {
    title: '嵌入式终端',
    topMeta: '终端会话',
    pageLabel: '工作区'
  },
  preview: {
    title: '文件预览',
    topMeta: '预览面板',
    pageLabel: '工作区'
  },
  mcp: {
    title: 'MCP',
    topMeta: 'MCP 清单',
    pageLabel: '控制面'
  },
  skills: {
    title: 'Skill',
    topMeta: 'Skill 清单',
    pageLabel: '控制面'
  },
  memory: {
    title: '记忆中心',
    topMeta: '记忆状态',
    pageLabel: '控制面'
  },
  settings: {
    title: '设置',
    topMeta: '设置',
    pageLabel: '控制面'
  },
  doctor: {
    title: 'Doctor',
    topMeta: '诊断摘要',
    pageLabel: '控制面'
  },
  diagnostics: {
    title: '任务诊断包',
    topMeta: '失败任务',
    pageLabel: '控制面'
  }
};

function parseViewId(value: string | null): ViewId {
  if (value !== null && (MAIN_VIEW_IDS.has(value as ViewId) || FLOATING_VIEW_IDS.has(value as ViewId))) {
    return value as ViewId;
  }
  return 'chat';
}

function defaultWorkbenchTool(view: ViewId): WorkbenchTool {
  if (view === 'git') {
    return 'git';
  }
  if (view === 'terminal') {
    return 'terminal';
  }
  return 'files';
}

function parseWorkbenchTool(value: string | null, view: ViewId): WorkbenchTool {
  if ((value === 'files' || value === 'git' || value === 'terminal') && WORKBENCH_VIEWS.has(view)) {
    return value;
  }
  return defaultWorkbenchTool(view);
}

function isFloatingView(view: ViewId): boolean {
  return FLOATING_VIEW_IDS.has(view);
}

function syncRendererUrl(view: ViewId, tool: WorkbenchTool, workbenchVisible: boolean): void {
  const url = new URL(window.location.href);
  url.searchParams.set('page', view);
  if (workbenchVisible || (view !== 'chat' && WORKBENCH_VIEWS.has(view))) {
    url.searchParams.set('tool', tool);
  } else {
    url.searchParams.delete('tool');
  }
  window.history.replaceState({}, '', url);
}

function viewMeta(view: MainViewId): PageMeta {
  return PAGE_META[view];
}

function providerTypeLabel(type: ProviderConfig['type']): string {
  if (type === 'openai_compatible') {
    return '兼容服务';
  }
  if (type === 'anthropic_compatible') {
    return 'Anthropic 兼容';
  }
  if (type === 'ollama') {
    return 'Ollama';
  }
  return '自定义兼容端点';
}

function providerRuntimeStatus(provider: ProviderConfig, providerTestStatus: ProviderTestResult | null): string {
  if (providerTestStatus !== null && providerTestStatus.providerId === provider.id) {
    return providerTestStatus.status;
  }
  return provider.enabled && provider.models.some((model) => model.enabled) ? 'ready' : 'invalid';
}

function visibleWorkspaceLabel(state: LoadedState): string {
  return state.appStatus.workspace.label;
}

function visibleWorkspaceCwd(state: LoadedState): string {
  return state.workspace === null ? '未选择' : state.workspace.path;
}

function buildTopMeta(view: MainViewId, state: LoadedState): string {
  if (view === 'chat') {
    return `${state.taskSnapshot.recentEvents.filter((event) => event.type === 'message').length} 条消息 · ${visibleWorkspaceLabel(state)}`;
  }
  if (view === 'tasks') {
    return `${state.taskSnapshot.counts.total} 个任务 · 运行中 ${state.taskSnapshot.counts.running}`;
  }
  if (view === 'workspace' || view === 'git' || view === 'terminal' || view === 'preview') {
    return visibleWorkspaceLabel(state);
  }
  if (view === 'memory') {
    return `${state.memorySearch?.items.length ?? 0} 条召回 · ${state.memoryCandidates.length} 个候选`;
  }
  if (view === 'mcp') {
    return `${state.mcpServers.filter((server) => server.enabled).length} 个已启用服务`;
  }
  if (view === 'skills') {
    return `${state.skills.filter((skill) => skill.enabled && skill.status === 'ready').length} 个可用 Skill`;
  }
  if (view === 'settings') {
    return state.defaultModelId === null ? '默认模型未配置' : `默认模型 ${state.defaultModelId}`;
  }
  if (view === 'doctor') {
    return `${state.doctor.summary.pass} 通过 · ${state.doctor.summary.fail} 失败`;
  }
  return `${state.taskSnapshot.counts.failed} 个失败任务`;
}

function buildHistoryNavItems(state: LoadedState): NavItem[] {
  return [
    {
      id: 'chat',
      label: '当前对话',
      meta: `${state.taskSnapshot.recentEvents.filter((event) => event.type === 'message').length} 条消息`,
      icon: 'history'
    }
  ];
}

function buildHistoryItems(state: LoadedState): HistoryItem[] {
  const backgroundThreadIds = new Set(state.backgroundTasks.map((task) => task.threadId));
  return state.taskSnapshot.threads
    .filter((thread) => !backgroundThreadIds.has(thread.id))
    .map((thread) => ({
      id: thread.id,
      label: thread.title,
      meta: thread.updatedAt.replace('T', ' ').slice(0, 16),
      icon: 'history'
    }));
}

function buildWorkspaceNavItems(state: LoadedState): NavItem[] {
  return [
    {
      id: 'tasks',
      label: '任务工作台',
      meta: `${state.taskSnapshot.counts.running} 运行中 · ${state.taskSnapshot.counts.pendingConfirmation} 待确认`,
      icon: 'clipboard'
    },
    {
      id: 'diagnostics',
      label: '任务诊断包',
      meta: `${state.taskSnapshot.counts.failed} 失败任务`,
      icon: 'stethoscope'
    }
  ];
}

function buildControlNavItems(state: LoadedState): NavItem[] {
  return [
    {
      id: 'memory',
      label: '记忆中心',
      meta: `${state.memorySearch?.items.length ?? 0} 召回 · ${state.memoryCandidates.length} 候选`,
      icon: 'globe'
    },
    {
      id: 'doctor',
      label: 'Doctor',
      meta: `${state.doctor.summary.pass} 通过 · ${state.doctor.summary.fail} 失败`,
      icon: 'stethoscope'
    },
    {
      id: 'mcp',
      label: 'MCP',
      meta: `${state.mcpServers.filter((server) => server.enabled).length} 已启用`,
      icon: 'nodes'
    },
    {
      id: 'skills',
      label: 'Skill',
      meta: `${state.skills.filter((skill) => skill.enabled && skill.status === 'ready').length} 可用`,
      icon: 'sparkles'
    },
    {
      id: 'settings',
      label: '设置',
      meta: state.defaultModelId === null ? '默认模型未配置' : state.defaultModelId,
      icon: 'wrench'
    }
  ];
}

function unwrap<T>(label: string, result: IpcLikeResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new Error(`${label} failed: ${result.error.message}`);
}

function toggleSelection(current: string[], id: string): string[] {
  if (current.includes(id)) {
    return current.filter((item) => item !== id);
  }
  return [...current, id];
}

async function updateTurnSelection(
  updateLoadedState: (partial: Partial<LoadedState>) => void,
  enabledCapabilities: { mcpServers: string[]; skills: string[] }
): Promise<void> {
  updateLoadedState({
    selectedMcpServers: enabledCapabilities.mcpServers,
    selectedSkills: enabledCapabilities.skills,
    agentCapabilityPreview: null
  });
}

export function App(): React.JSX.Element {
  const initialParams = new URLSearchParams(window.location.search);
  const initialView = parseViewId(initialParams.get('page'));
  const [activeView, setActiveView] = useState<ViewId>(initialView);
  const [state, setState] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [workspaceSelectError, setWorkspaceSelectError] = useState<string | null>(null);
  const [activeWorkbenchTool, setActiveWorkbenchTool] = useState<WorkbenchTool>(
    parseWorkbenchTool(initialParams.get('tool'), initialView)
  );
  const [workbenchVisible, setWorkbenchVisible] = useState(
    initialView === 'chat' ? initialParams.has('tool') : WORKBENCH_VIEWS.has(initialView)
  );
  const [workbenchWidth, setWorkbenchWidth] = useState(560);
  const [windowState, setWindowState] = useState<WindowStateSnapshot>({
    maximized: false,
    minimized: false,
    fullscreen: false
  });
  const [workspaceLoadState, setWorkspaceLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const [memoryLoadState, setMemoryLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const [operationsLoadState, setOperationsLoadState] = useState<LazyLoadState>(idleLazyLoadState());
  const windowDragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    return window.roc.app.onNavigate((page) => {
      const view = parseViewId(page);
      if (isFloatingView(view)) {
        return;
      }
      setActiveView(view);
      setWorkbenchVisible(view !== 'chat' && WORKBENCH_VIEWS.has(view));
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const [appStatus, taskSnapshot, agent, workspace, rtkStatus, loadedWindowState] = await Promise.all([
        window.roc.app.getStatus(),
        window.roc.tasks.getSnapshot(),
        window.roc.agent.getStatus(),
        window.roc.workspace.getCurrent(),
        window.roc.rtk.status(),
        window.roc.window.getState()
      ]);

      const loadedWorkspace = unwrap<Workspace | null>('workspace', workspace);
      const loadedAppStatus = unwrap<AppStatus>('app status', appStatus);
      const capabilityData = await loadCapabilityData(loadedAppStatus.mode);
      const taskSurfaceData = await loadTaskSurfaceData();
      const refreshedAppStatus =
        loadedAppStatus.mode === 'smoke'
          ? unwrap<AppStatus>('refreshed app status', await window.roc.app.getStatus())
          : loadedAppStatus;
      const loadedAgent =
        loadedAppStatus.mode === 'smoke'
          ? unwrap<AgentRuntimeStatus>('refreshed agent', await window.roc.agent.getStatus())
          : unwrap<AgentRuntimeStatus>('agent', agent);
      const selectedMcpServers = capabilityData.mcpServers.filter((server) => server.enabled).map((server) => server.id);
      const selectedSkills = capabilityData.skills.filter((skill) => skill.enabled && skill.status === 'ready').map((skill) => skill.id);

      if (cancelled) {
        return;
      }

      setWindowState(unwrap<WindowStateSnapshot>('window state', loadedWindowState));
      setState({
        appStatus: refreshedAppStatus,
        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
        providers: capabilityData.providers,
        defaultModelId: capabilityData.defaultModelId,
        providerTestStatus: null,
        mcpServers: capabilityData.mcpServers,
        mcpTestStatus: null,
        skills: capabilityData.skills,
        selectedMcpServers,
        selectedSkills,
        ...taskSurfaceData,
        ...emptyOperationsData(refreshedAppStatus.mode),
        agent: loadedAgent,
        agentCapabilityPreview: null,
        chatResult: null,
        workspace: loadedWorkspace,
        rtkStatus: unwrap<RtkStatus>('rtk status', rtkStatus),
        ...emptyWorkspaceData(),
        ...emptyMemoryData()
      });
    }

    load().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : 'Roc renderer failed to load.');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeView === 'chat') {
      return;
    }
    setActiveWorkbenchTool(defaultWorkbenchTool(activeView));
  }, [activeView]);

  const currentWorkspace = state?.workspace ?? null;
  const currentAppMode = state?.appStatus.mode ?? null;
  const currentAgentExecution = state?.agent.execution ?? null;
  const currentSelectedMcpServers = state?.selectedMcpServers ?? [];
  const currentSelectedSkills = state?.selectedSkills ?? [];

  useEffect(() => {
    if (state === null) {
      return;
    }
    if (currentAgentExecution !== 'ready' || (currentSelectedMcpServers.length === 0 && currentSelectedSkills.length === 0)) {
      setState((current) =>
        current === null || current.agentCapabilityPreview === null
          ? current
          : {
              ...current,
              agentCapabilityPreview: null
            }
      );
      return;
    }

    let cancelled = false;
    void window.roc.agent
      .getCapabilityPreview({
        mcpServers: currentSelectedMcpServers,
        skills: currentSelectedSkills
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setState((current) =>
          current === null
            ? current
            : {
                ...current,
                agentCapabilityPreview: unwrap<AgentCapabilityPreview>('agent capability preview', result)
              }
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentAgentExecution, currentSelectedMcpServers, currentSelectedSkills]);

  useEffect(() => {
    if (state === null) {
      return;
    }

    const loadIntent = getStartupLoadIntent({
      activeView,
      activeWorkbenchTool,
      workbenchVisible
    });
    if (!loadIntent.targets.has('workspace')) {
      return;
    }

    const workspaceKey = currentWorkspace?.id ?? 'no-workspace';
    if (workspaceLoadState.key === workspaceKey && workspaceLoadState.status !== 'idle') {
      return;
    }

    let cancelled = false;
    setWorkspaceLoadState({
      status: 'loading',
      error: null,
      key: workspaceKey
    });
    void loadWorkspaceData(currentWorkspace)
      .then((workspaceData) => {
        if (cancelled) {
          return;
        }
        setState((current) => (current === null ? current : { ...current, ...workspaceData }));
        setWorkspaceLoadState({
          status: 'ready',
          error: null,
          key: workspaceKey
        });
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        setWorkspaceLoadState({
          status: 'error',
          error: loadError instanceof Error ? loadError.message : 'workspace data failed to load.',
          key: workspaceKey
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeView,
    activeWorkbenchTool,
    currentWorkspace,
    workbenchVisible
  ]);

  useEffect(() => {
    if (currentAppMode === null) {
      return;
    }

    const loadIntent = getStartupLoadIntent({
      activeView,
      activeWorkbenchTool,
      workbenchVisible
    });
    if (!loadIntent.targets.has('memory')) {
      return;
    }
    const memoryKey = currentAppMode;
    if (memoryLoadState.key === memoryKey && memoryLoadState.status !== 'idle') {
      return;
    }

    let cancelled = false;
    setMemoryLoadState({
      status: 'loading',
      error: null,
      key: memoryKey
    });
    void loadMemoryData(currentAppMode)
      .then((memoryData) => {
        if (cancelled) {
          return;
        }
        setState((current) => (current === null ? current : { ...current, ...memoryData }));
        setMemoryLoadState({
          status: 'ready',
          error: null,
          key: memoryKey
        });
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        setMemoryLoadState({
          status: 'error',
          error: loadError instanceof Error ? loadError.message : 'memory data failed to load.',
          key: memoryKey
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeView, activeWorkbenchTool, currentAppMode, workbenchVisible]);

  useEffect(() => {
    if (currentAppMode === null) {
      return;
    }

    const loadIntent = getStartupLoadIntent({
      activeView,
      activeWorkbenchTool,
      workbenchVisible
    });
    if (!loadIntent.targets.has('operations')) {
      return;
    }
    const operationsKey = currentAppMode;
    if (operationsLoadState.key === operationsKey && operationsLoadState.status !== 'idle') {
      return;
    }

    let cancelled = false;
    setOperationsLoadState({
      status: 'loading',
      error: null,
      key: operationsKey
    });
    void loadOperationsData(currentAppMode)
      .then((operationsData) => {
        if (cancelled) {
          return;
        }
        setState((current) => (current === null ? current : { ...current, ...operationsData }));
        setOperationsLoadState({
          status: 'ready',
          error: null,
          key: operationsKey
        });
      })
      .catch((loadError: unknown) => {
        if (cancelled) {
          return;
        }
        setOperationsLoadState({
          status: 'error',
          error: loadError instanceof Error ? loadError.message : 'operations data failed to load.',
          key: operationsKey
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeView,
    activeWorkbenchTool,
    currentAppMode,
    workbenchVisible
  ]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>('.sidebar, .sidebar-block-scroll, .canvas-scroll, .tool-stack, .workbench-tabs')
        .forEach((element) => {
          element.scrollTop = 0;
          element.scrollLeft = 0;
        });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeView, activeWorkbenchTool]);

  useEffect(() => {
    syncRendererUrl(activeView, activeWorkbenchTool, workbenchVisible);
  }, [activeView, activeWorkbenchTool, workbenchVisible]);

  useEffect(() => {
    return () => {
      windowDragRef.current = null;
    };
  }, []);

  function finishWindowDrag(pointerId?: number): void {
    const dragSession = windowDragRef.current;
    if (dragSession === null) {
      return;
    }
    if (pointerId !== undefined && dragSession.pointerId !== pointerId) {
      return;
    }
    windowDragRef.current = null;
  }

  function continueWindowDrag(clientX: number, clientY: number): void {
    const dragSession = windowDragRef.current;
    if (dragSession === null || windowState.maximized || windowState.fullscreen) {
      return;
    }
    const nextBounds: WindowBoundsSnapshot = {
      x: Math.round(clientX - dragSession.offsetX),
      y: Math.round(clientY - dragSession.offsetY),
      width: dragSession.width,
      height: dragSession.height
    };
    void window.roc.window.setBounds(nextBounds);
  }

  function startWindowDrag(event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0 || windowState.maximized || windowState.fullscreen) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest('.workband-actions') !== null) {
      return;
    }
    event.preventDefault();
    void window.roc.window.getBounds().then((result) => {
      const bounds = unwrap<WindowBoundsSnapshot>('window bounds', result);
      windowDragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - bounds.x,
        offsetY: event.clientY - bounds.y,
        width: bounds.width,
        height: bounds.height
      };
    });
  }

  async function selectWorkspaceFromDialog(): Promise<void> {
    setWorkspaceSelectError(null);
    const selected = await window.roc.workspace.selectFromDialog();
    if (!selected.ok) {
      setWorkspaceSelectError(selected.error.message);
      return;
    }
    if (selected.data === null) {
      return;
    }

    const [appStatus, workspaceData] = await Promise.all([
      window.roc.app.getStatus(),
      loadWorkspaceData(selected.data)
    ]);
    setWorkspaceLoadState({
      status: 'ready',
      error: null,
      key: selected.data.id
    });
    setState((current) =>
      current === null
        ? current
        : {
          ...current,
            appStatus: unwrap<AppStatus>('app status', appStatus),
            workspace: selected.data,
            ...workspaceData
          }
    );
  }

  const updateWorkspaceData = useCallback((partial: Partial<WorkspaceData>): void => {
    setState((current) => (current === null ? current : { ...current, ...partial }));
  }, []);

  if (error !== null) {
    return <div className="fatal">Roc 启动失败：{error}</div>;
  }

  if (state === null) {
    return <div className="boot">Roc 正在加载本地工作台</div>;
  }

  if (isFloatingView(activeView)) {
    return (
      <main className="floating-stage" data-testid={`floating-${activeView}`}>
        <ViewContent
          activeView={activeView}
          chatError={chatError}
          memoryLoadState={memoryLoadState}
          onOpenView={setActiveView}
          operationsLoadState={operationsLoadState}
          onSelectWorkspace={selectWorkspaceFromDialog}
          onSubmitChatTask={async (input) => {
            setChatError(null);
            const result = await window.roc.chat.submit({
              input,
              mode: 'task',
              enabledCapabilities: {
                mcpServers: state.selectedMcpServers,
                skills: state.selectedSkills
              }
            });
            if (!result.ok) {
              setChatError(result.error.message);
              return false;
            }
            const taskSnapshot = unwrap<TaskSnapshot>('task snapshot', await window.roc.tasks.getSnapshot());
            setState((current) => (current === null ? current : { ...current, taskSnapshot, chatResult: result.data }));
            return true;
          }}
          state={state}
          updateLoadedState={(partial) =>
            setState((current) => (current === null ? current : { ...current, ...partial }))
          }
          workspaceLoadState={workspaceLoadState}
        />
      </main>
    );
  }

  const hasWorkbench = activeView === 'chat' ? workbenchVisible : WORKBENCH_VIEWS.has(activeView);
  const meta = viewMeta(activeView as MainViewId);
  const topMeta = buildTopMeta(activeView as MainViewId, state);
  const historyNavItems = buildHistoryNavItems(state);
  const historyItems = buildHistoryItems(state);
  const workspaceNavItems = buildWorkspaceNavItems(state);
  const controlNavItems = buildControlNavItems(state);

  return (
    <div className={state.appStatus.mode === 'smoke' ? 'app-shell app-shell--smoke' : 'app-shell'} data-testid="roc-app">
      <header
        className="window-workband"
        data-testid="window-workband"
        onPointerDown={startWindowDrag}
        onPointerMove={(event) => {
          continueWindowDrag(event.screenX, event.screenY);
        }}
        onPointerUp={(event) => {
          finishWindowDrag(event.pointerId);
        }}
        onPointerCancel={(event) => {
          finishWindowDrag(event.pointerId);
        }}
        onPointerLeave={(event) => {
          if ((event.buttons & 1) === 0) {
            finishWindowDrag(event.pointerId);
          }
        }}
      >
        <div className="workband-drag-region">
          <div className="brand">
            <div className="brand-mark">R</div>
            <span>Roc / 本地工作台</span>
          </div>
        </div>
        <div className="thread-meta">
          <PreviewIcon name="folder" />
          <span>{topMeta}</span>
        </div>
        <div className="workband-actions">
          <button
            className="icon-button titlebar-button"
            data-testid="window-minimize"
            title="最小化"
            type="button"
            onClick={() => {
              void window.roc.window.minimize().then((result) => {
                setWindowState(unwrap<WindowStateSnapshot>('window minimize', result));
              });
            }}
          >
            <span className="titlebar-glyph" aria-hidden="true">−</span>
          </button>
          <button
            className="icon-button titlebar-button"
            data-testid="window-toggle-maximize"
            title={windowState.maximized ? '还原' : '最大化'}
            type="button"
            onClick={() => {
              void window.roc.window.toggleMaximize().then((result) => {
                setWindowState(unwrap<WindowStateSnapshot>('window toggle maximize', result));
              });
            }}
          >
            <span className="titlebar-glyph" aria-hidden="true">{windowState.maximized ? '↙' : '↗'}</span>
          </button>
          <button
            className="icon-button titlebar-button danger"
            data-testid="window-close"
            title="关闭"
            type="button"
            onClick={() => {
              void window.roc.window.close();
            }}
          >
            <span className="titlebar-glyph" aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      <div className={activeView === 'chat' ? 'workspace workspace--chat' : 'workspace'}>
        <aside className="sidebar">
          <div className="sidebar-head">
            <button
              className="workspace-pill"
              data-testid="workspace-select-button"
              title={visibleWorkspaceLabel(state)}
              type="button"
              onClick={() => void selectWorkspaceFromDialog()}
            >
              <PreviewIcon name="folder" />
              <span>{visibleWorkspaceLabel(state)}</span>
              <strong>选择</strong>
            </button>
            {workspaceSelectError === null ? null : <span className="inline-warning">{workspaceSelectError}</span>}
          </div>
          <SidebarNavGroup activeView={activeView} items={historyNavItems} title="对话" onSelect={setActiveView} />
          <div className="sidebar-block sidebar-block--history">
            <div className="side-title">历史会话</div>
            <div className="sidebar-block-scroll history-list">
              {historyItems.length === 0 ? (
                <div className="history-empty">暂无历史会话</div>
              ) : (
                historyItems.map((item) => (
                  <button className="nav-button" key={item.id} type="button" onClick={() => setActiveView('chat')}>
                    <PreviewIcon name={item.icon} />
                    <span className="nav-copy">
                      <span className="nav-label">{item.label}</span>
                      <span className="nav-meta">{item.meta}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
          <SidebarNavGroup className="sidebar-block sidebar-block--tasks" activeView={activeView} items={workspaceNavItems} title="任务工作台" onSelect={setActiveView} />
          <SidebarNavGroup className="sidebar-block sidebar-block--control" activeView={activeView} items={controlNavItems} title="控制区" onSelect={setActiveView} />
        </aside>

        <div
          style={hasWorkbench ? { '--workbench-width': `${workbenchWidth}px` } as React.CSSProperties : undefined}
          className={
            activeView === 'chat'
              ? hasWorkbench
                ? 'workspace-shell workspace-shell--chat'
                : 'workspace-shell workspace-shell--chat-collapsed'
              : hasWorkbench
                ? 'workspace-shell workspace-shell--with-workbench'
                : 'workspace-shell'
          }
        >
          <main className={activeView === 'chat' ? 'workspace-main workspace-main--chat' : 'workspace-main'} data-testid="active-view">
            <section className={activeView === 'chat' ? 'canvas canvas--chat' : 'canvas'}>
              <div className="canvas-scroll">
                <ViewContent
                  activeView={activeView}
                  chatError={chatError}
                  memoryLoadState={memoryLoadState}
                  onOpenView={setActiveView}
                  operationsLoadState={operationsLoadState}
                  onSelectWorkspace={selectWorkspaceFromDialog}
                  onSubmitChatTask={async (input) => {
                    setChatError(null);
                    const result = await window.roc.chat.submit({
                      input,
                      mode: 'task',
                      enabledCapabilities: {
                        mcpServers: state.selectedMcpServers,
                        skills: state.selectedSkills
                      }
                    });
                    if (!result.ok) {
                      setChatError(result.error.message);
                      return false;
                    }
                    const taskSnapshot = unwrap<TaskSnapshot>('task snapshot', await window.roc.tasks.getSnapshot());
                    setState((current) => (current === null ? current : { ...current, taskSnapshot, chatResult: result.data }));
                    return true;
                  }}
                  state={state}
                  updateLoadedState={(partial) =>
                    setState((current) => (current === null ? current : { ...current, ...partial }))
                  }
                  workspaceLoadState={workspaceLoadState}
                />
              </div>
            </section>
          </main>

          {activeView === 'chat' ? (
            <RailOverlay
              activeTool={activeWorkbenchTool}
              activeView={activeView}
              workbenchVisible={hasWorkbench}
              onOpenToolView={(tool) => {
                setActiveWorkbenchTool(tool);
                setActiveView('chat');
                setWorkbenchVisible(true);
              }}
            />
          ) : null}
          {hasWorkbench ? (
            <WorkbenchPanel
              activeTool={activeWorkbenchTool}
              activeView={activeView}
              onToolChange={setActiveWorkbenchTool}
              onClose={() => {
                setActiveView('chat');
                setWorkbenchVisible(false);
              }}
              state={state}
              updateWorkspaceData={updateWorkspaceData}
              workspaceLoadState={workspaceLoadState}
              width={workbenchWidth}
              onWidthChange={setWorkbenchWidth}
              windowState={windowState}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function gitErrorLabel(error: string | null): string {
  if (error === null) {
    return '未选择工作区';
  }
  return error;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeTestId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '-');
}

function parentRelativePath(relativePath: string): string | null {
  const parts = relativePath.split('/').filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return null;
  }
  return parts.slice(0, -1).join('/');
}

function fileLabel(relativePath: string): string {
  const parts = relativePath.split('/').filter((part) => part.length > 0);
  return parts.at(-1) ?? relativePath;
}

function fileExtension(relativePath: string): string {
  const label = fileLabel(relativePath);
  const dotIndex = label.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === label.length - 1) {
    return '';
  }
  return label.slice(dotIndex + 1).toLowerCase();
}

type TreeNode = {
  entry: FileTreeResult['entries'][number];
  depth: number;
};

function flattenTreeEntries(
  entries: FileTreeResult['entries'],
  expandedDirectories: Set<string>,
  childEntries: Record<string, FileTreeResult['entries']>
): TreeNode[] {
  const rootEntries = [...entries].sort(compareFileEntries);
  const nodes: TreeNode[] = [];

  function visit(list: FileTreeResult['entries'], depth: number): void {
    for (const entry of list) {
      nodes.push({ entry, depth });
      if (entry.type !== 'directory' || !expandedDirectories.has(entry.relativePath)) {
        continue;
      }
      const children = childEntries[entry.relativePath];
      if (children === undefined) {
        continue;
      }
      visit([...children].sort(compareFileEntries), depth + 1);
    }
  }

  visit(rootEntries, 0);
  return nodes;
}

function compareFileEntries(left: FileTreeResult['entries'][number], right: FileTreeResult['entries'][number]): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name, 'zh-Hans-CN');
}

function fileTypeLabel(preview: FilePreviewResult | null): string {
  if (preview === null) {
    return '未加载';
  }
  if (preview.kind === 'image') {
    return preview.mediaType ?? '图片';
  }
  if (preview.kind === 'binary') {
    return '二进制文件';
  }
  const extension = fileExtension(preview.relativePath);
  return extension.length === 0 ? '文本文件' : `${extension.toUpperCase()} 文件`;
}

function fileTreeIcon(entry: FileTreeResult['entries'][number], active: boolean, expanded: boolean): React.JSX.Element {
  const className = active ? 'tree-item-file-icon tree-item-file-icon--active' : 'tree-item-file-icon';
  if (entry.type === 'directory') {
    const DirectoryIcon = expanded ? FolderOpen : Folder;
    return <DirectoryIcon className={className} size={16} strokeWidth={1.8} />;
  }
  const extension = fileExtension(entry.relativePath);
  const lowerName = entry.name.toLowerCase();
  if (['md', 'txt', 'log'].includes(extension)) {
    return <FileText className={className} size={16} strokeWidth={1.8} />;
  }
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension)) {
    return <Code2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (extension === 'json') {
    return <FileJson2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension)) {
    return <FileImage className={className} size={16} strokeWidth={1.8} />;
  }
  if (['css', 'scss', 'sass', 'less'].includes(extension)) {
    return <FileType2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (['toml', 'yaml', 'yml', 'ini', 'env', 'conf'].includes(extension) || lowerName.includes('config')) {
    return <FileCog className={className} size={16} strokeWidth={1.8} />;
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) {
    return <FileArchive className={className} size={16} strokeWidth={1.8} />;
  }
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(extension)) {
    return <FileAudio2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(extension)) {
    return <FileVideo2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (['csv', 'tsv', 'xlsx', 'xls', 'doc', 'docx', 'pdf'].includes(extension)) {
    return <FileSpreadsheet className={className} size={16} strokeWidth={1.8} />;
  }
  if (['exe', 'dll', 'bin', 'dat', 'db'].includes(extension)) {
    return <Archive className={className} size={16} strokeWidth={1.8} />;
  }
  return <File className={className} size={16} strokeWidth={1.8} />;
}

function isImagePreview(preview: FilePreviewResult | null): preview is FilePreviewResult & { kind: 'image'; mediaType: string } {
  return preview !== null && preview.kind === 'image' && typeof preview.mediaType === 'string';
}

function previewTextBody(preview: FilePreviewResult | null): string {
  if (preview === null) {
    return '当前没有加载可预览内容。';
  }
  if (preview.kind === 'binary') {
    return `二进制文件，大小 ${preview.sizeBytes} bytes。`;
  }
  if (preview.kind === 'image') {
    return `图片文件，大小 ${preview.sizeBytes} bytes。`;
  }
  return preview.content;
}

function gitStatusChanges(status: GitStatusResult): GitStatusChange[] {
  return status.changes;
}

function canStageGitChange(change: GitStatusChange): boolean {
  return change.worktree !== ' ' || change.index === '?' || change.index === '!';
}

function canUnstageGitChange(change: GitStatusChange): boolean {
  return change.index !== ' ' && change.index !== '?';
}

function canDiscardGitChange(change: GitStatusChange): boolean {
  return change.index !== '?';
}

async function loadWorkspaceData(workspace: Workspace | null): Promise<WorkspaceData> {
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

async function loadTaskSurfaceData(): Promise<TaskSurfaceData> {
  const backgroundTasks = unwrap<BackgroundTask[]>('background tasks', await window.roc.tasks.listBackgroundTasks());
  const backgroundTask = backgroundTasks[0] ?? null;
  const traySummary = unwrap<TraySummary>('tray summary', await window.roc.lifecycle.getTraySummary());

  return {
    backgroundTask,
    backgroundTasks,
    traySummary
  };
}

async function loadOperationsData(mode: AppStatus['mode']): Promise<OperationsData> {
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
  const doctor = unwrap<DoctorSnapshot>('doctor', await window.roc.doctor.run());

  return {
    diagnosticPackage,
    performanceSample,
    doctor
  };
}

async function loadMemoryData(_mode: AppStatus['mode']): Promise<MemoryData> {
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

async function loadCapabilityData(_mode: AppStatus['mode']): Promise<CapabilityData> {
  const [providers, mcpServers, skills] = await Promise.all([
    window.roc.providers.list(),
    window.roc.mcp.listServers(),
    window.roc.skills.list()
  ]);
  const providerData = unwrap<{ providers: ProviderConfig[]; defaultModelId: string | null }>('providers', providers);
  const loadedMcpServers = unwrap<McpServerSnapshot[]>('mcp servers', mcpServers);
  const loadedSkills = unwrap<SkillSnapshot[]>('skills', skills);

  return {
    providers: providerData.providers,
    defaultModelId: providerData.defaultModelId,
    mcpServers: loadedMcpServers,
    skills: loadedSkills
  };
}

function ViewContent({
  activeView,
  chatError,
  memoryLoadState,
  onOpenView,
  operationsLoadState,
  onSelectWorkspace,
  onSubmitChatTask,
  state,
  updateLoadedState,
  workspaceLoadState
}: {
  activeView: ViewId;
  chatError: string | null;
  memoryLoadState: LazyLoadState;
  onOpenView: (view: ViewId) => void;
  operationsLoadState: LazyLoadState;
  onSelectWorkspace: () => Promise<void>;
  onSubmitChatTask: (input: string) => Promise<boolean>;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
  workspaceLoadState: LazyLoadState;
}): React.JSX.Element {
  if (activeView === 'tasks') {
    return <TasksView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'workspace') {
    return <WorkspaceView loadState={workspaceLoadState} onSelectWorkspace={onSelectWorkspace} state={state} />;
  }
  if (activeView === 'git') {
    return <GitView loadState={workspaceLoadState} state={state} />;
  }
  if (activeView === 'terminal') {
    return <TerminalView state={state} />;
  }
  if (activeView === 'preview') {
    return <PreviewView loadState={workspaceLoadState} state={state} />;
  }
  if (activeView === 'mcp') {
    return <McpView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'skills') {
    return <SkillsView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'memory') {
    return <MemoryView loadState={memoryLoadState} state={state} />;
  }
  if (activeView === 'settings') {
    return <SettingsView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'doctor') {
    return <DoctorView loadState={operationsLoadState} state={state} />;
  }
  if (activeView === 'diagnostics') {
    return <DiagnosticsView loadState={operationsLoadState} state={state} />;
  }
  if (activeView === 'quick') {
    return <QuickEntryView chatError={chatError} onSubmitChatTask={onSubmitChatTask} state={state} />;
  }
  if (activeView === 'tray') {
    return <TrayEntryView state={state} updateLoadedState={updateLoadedState} />;
  }
  return (
    <ChatView
      chatError={chatError}
      onOpenView={onOpenView}
      onSubmitChatTask={onSubmitChatTask}
      state={state}
      updateLoadedState={updateLoadedState}
    />
  );
}

function SidebarNavGroup({
  activeView,
  className,
  items,
  onSelect,
  title
}: {
  activeView: ViewId;
  className?: string;
  items: NavItem[];
  onSelect: (view: ViewId) => void;
  title: string;
}): React.JSX.Element {
  return (
    <div className={className === undefined ? 'sidebar-block' : className}>
      <div className="side-title">{title}</div>
      <nav className="sidebar-block-scroll nav-list" aria-label={title}>
        {items.map((item) => (
          <NavButton active={item.id === activeView} item={item} key={item.id} onClick={() => onSelect(item.id)} />
        ))}
      </nav>
    </div>
  );
}

function NavButton({ active, item, onClick }: { active: boolean; item: NavItem; onClick: () => void }): React.JSX.Element {
  return (
    <button
      className={active ? 'nav-button active' : 'nav-button'}
      data-testid={`nav-${item.id}`}
      type="button"
      onClick={onClick}
    >
      <PreviewIcon name={item.icon} />
      <span className="nav-copy">
        <span className="nav-label">{item.label}</span>
        <span className="nav-meta">{item.meta}</span>
      </span>
    </button>
  );
}

function ChatView({
  chatError,
  onOpenView,
  onSubmitChatTask,
  state,
  updateLoadedState
}: {
  chatError: string | null;
  onOpenView: (view: ViewId) => void;
  onSubmitChatTask: (input: string) => Promise<boolean>;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const [chatInput, setChatInput] = useState('');
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [activeComposerPopover, setActiveComposerPopover] = useState<'tools' | 'skills' | 'models' | null>(null);
  const visibleCapabilityServers = state.mcpServers.filter((server) => server.enabled);
  const visibleCapabilitySkills = state.skills.filter(
    (skill) => skill.enabled && skill.status === 'ready'
  );
  const allVisibleMcpSelected = visibleCapabilityServers.length > 0 && visibleCapabilityServers.every((server) => state.selectedMcpServers.includes(server.id));
  const allVisibleSkillsSelected = visibleCapabilitySkills.length > 0 && visibleCapabilitySkills.every((skill) => state.selectedSkills.includes(skill.id));
  const enabledModels = state.providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled)
        .map((model) => ({
          id: model.id,
          label: `${provider.name} / ${model.displayName}`
        }))
    );
  const trimmedInput = chatInput.trim();
  const sendDisabled = submitting || trimmedInput.length === 0 || state.agent.execution !== 'ready';

  async function submitCurrentInput(): Promise<void> {
    if (sendDisabled) {
      return;
    }
    setSubmitting(true);
    try {
      const submitted = await onSubmitChatTask(trimmedInput);
      if (submitted) {
        setChatInput('');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function selectAttachmentsFromDialog(): Promise<void> {
    const selection = await window.roc.files.selectFromDialog();
    if (!selection.ok || selection.data === null) {
      return;
    }
    setSelectedAttachments(selection.data.filePaths);
  }

  async function setVisibleMcpSelection(nextSelected: string[]): Promise<void> {
    await updateTurnSelection(updateLoadedState, {
      mcpServers: nextSelected,
      skills: state.selectedSkills
    });
  }

  async function setVisibleSkillSelection(nextSelected: string[]): Promise<void> {
    await updateTurnSelection(updateLoadedState, {
      mcpServers: state.selectedMcpServers,
      skills: nextSelected
    });
  }

  return (
    <section className="canvas-stage chat-stage" data-testid="chat-view">
      <div className="chat-empty-plane" aria-label="聊天主画布">
        <div className="chat-feedback-stack">
          {state.agent.execution !== 'ready' ? <span className="inline-warning" data-testid="chat-blocked">需要先配置默认模型</span> : null}
          {chatError === null ? null : <span className="inline-warning" data-testid="chat-error">{chatError}</span>}
          {state.agentCapabilityPreview === null ? null : <AgentCapabilityPreviewPanel preview={state.agentCapabilityPreview} />}
          {state.chatResult === null ? null : <ChatResultPanel result={state.chatResult} />}
        </div>
      </div>
      <div className="chat-bottom-stack">
        <div className="composer composer--chat">
          {selectedAttachments.length === 0 ? null : (
            <div className="chat-attachment-strip">
              {selectedAttachments.map((path) => (
                <span className="chat-attachment-pill" data-testid="chat-attachment-pill" key={path}>
                  <PreviewIcon name="paperclip" />
                  <span>{path.split(/[/\\]/).at(-1) ?? path}</span>
                </span>
              ))}
            </div>
          )}
          <textarea
            aria-label="输入消息"
            className="composer-input"
            data-testid="chat-input"
            placeholder="输入消息..."
            rows={3}
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void submitCurrentInput();
              }
            }}
          />
          <div className="composer-bottom">
            <div className="composer-left">
              <button
                className={selectedAttachments.length > 0 ? 'composer-tool active' : 'composer-tool'}
                data-testid="chat-attachment-trigger"
                type="button"
                aria-label="上传文件"
                onClick={() => void selectAttachmentsFromDialog()}
              >
                <PreviewIcon name="tray-upload" />
                {selectedAttachments.length === 0 ? null : <span className="tool-badge">{selectedAttachments.length}</span>}
              </button>
              <div
                className="composer-popover-anchor"
                onMouseEnter={() => setActiveComposerPopover('tools')}
                onMouseLeave={() => setActiveComposerPopover((current) => (current === 'tools' ? null : current))}
              >
                <button
                  className={state.selectedMcpServers.length > 0 ? 'composer-tool composer-tool--tools active' : 'composer-tool composer-tool--tools'}
                  data-testid="chat-tool-trigger"
                  type="button"
                  aria-label="工具"
                >
                  <PreviewIcon name="stack" />
                  <span className="tool-badge">{state.selectedMcpServers.length}</span>
                </button>
                {activeComposerPopover !== 'tools' ? null : (
                  <div className="composer-popover" data-testid="chat-tool-popover">
                    <div className="composer-popover-head">
                      <span>工具</span>
                      <strong>{visibleCapabilityServers.length} 个可用</strong>
                    </div>
                    <div className="composer-popover-copy">展示当前可用工具，并选择本轮要启用的项。</div>
                    <div className="composer-popover-actions">
                      <button
                        className="composer-choice composer-choice--action"
                        data-testid="chat-tool-select-all"
                        type="button"
                        onClick={() => void setVisibleMcpSelection(visibleCapabilityServers.map((server) => server.id))}
                      >
                        全选
                      </button>
                      <button
                        className="composer-choice composer-choice--action"
                        data-testid="chat-tool-clear-all"
                        type="button"
                        onClick={() => void setVisibleMcpSelection([])}
                      >
                        取消全选
                      </button>
                    </div>
                    <div className="composer-popover-list">
                      {visibleCapabilityServers.map((server) => (
                        <button
                          className={state.selectedMcpServers.includes(server.id) ? 'composer-choice active' : 'composer-choice'}
                          data-testid={`turn-mcp-${server.id}`}
                          key={server.id}
                          type="button"
                          onClick={() =>
                            void updateTurnSelection(updateLoadedState, {
                              mcpServers: toggleSelection(state.selectedMcpServers, server.id),
                              skills: state.selectedSkills
                            })
                          }
                        >
                          <span>{server.name}</span>
                          <small>{server.allowedTools?.join(', ') || 'ripgrep 搜索'}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div
                className="composer-popover-anchor"
                onMouseEnter={() => setActiveComposerPopover('skills')}
                onMouseLeave={() => setActiveComposerPopover((current) => (current === 'skills' ? null : current))}
              >
                <button
                  className={state.selectedSkills.length > 0 ? 'composer-tool composer-tool--skills active' : 'composer-tool composer-tool--skills'}
                  data-testid="chat-skill-trigger"
                  type="button"
                  aria-label="技能"
                >
                  <PreviewIcon name="checklist" />
                  <span className="tool-badge">{state.selectedSkills.length}</span>
                </button>
                {activeComposerPopover !== 'skills' ? null : (
                  <div className="composer-popover" data-testid="chat-skill-popover">
                    <div className="composer-popover-head">
                      <span>技能</span>
                      <strong>{visibleCapabilitySkills.length} 个可用</strong>
                    </div>
                    <div className="composer-popover-copy">展示当前可用技能，并选择本轮要启用的项。</div>
                    <div className="composer-popover-actions">
                      <button
                        className="composer-choice composer-choice--action"
                        data-testid="chat-skill-select-all"
                        type="button"
                        onClick={() => void setVisibleSkillSelection(visibleCapabilitySkills.map((skill) => skill.id))}
                      >
                        全选
                      </button>
                      <button
                        className="composer-choice composer-choice--action"
                        data-testid="chat-skill-clear-all"
                        type="button"
                        onClick={() => void setVisibleSkillSelection([])}
                      >
                        取消全选
                      </button>
                    </div>
                    <div className="composer-popover-list">
                      {visibleCapabilitySkills.map((skill) => (
                        <button
                          className={state.selectedSkills.includes(skill.id) ? 'composer-choice active' : 'composer-choice'}
                          data-testid={`turn-skill-${skill.id}`}
                          key={skill.id}
                          type="button"
                          onClick={() =>
                            void updateTurnSelection(updateLoadedState, {
                              mcpServers: state.selectedMcpServers,
                              skills: toggleSelection(state.selectedSkills, skill.id)
                            })
                          }
                        >
                          <span>{skill.name}</span>
                          <small>{skill.description}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div
                className="composer-popover-anchor"
                onMouseEnter={() => setActiveComposerPopover('models')}
                onMouseLeave={() => setActiveComposerPopover((current) => (current === 'models' ? null : current))}
              >
                <button className="model-pill model-pill--composer" data-testid="chat-model-trigger" type="button" aria-label="模型">
                  <PreviewIcon name="panel-capture" />
                  <span>{state.defaultModelId ?? '配置默认模型'}</span>
                  <span>▾</span>
                </button>
                {activeComposerPopover !== 'models' ? null : (
                  <div className="composer-popover composer-popover--wide" data-testid="chat-model-popover">
                    <div className="composer-popover-head">
                      <span>模型</span>
                      <strong>默认模型</strong>
                    </div>
                    <div className="composer-popover-list">
                      {enabledModels.map((model) => (
                        <button
                          className={state.defaultModelId === model.id ? 'composer-choice active' : 'composer-choice'}
                          key={model.id}
                          type="button"
                          onClick={() => {
                            void window.roc.providers.setDefaultModel(model.id).then(async () => {
                              const providers = unwrap<{ providers: ProviderConfig[]; defaultModelId: string | null }>('providers', await window.roc.providers.list());
                              updateLoadedState({ providers: providers.providers, defaultModelId: providers.defaultModelId });
                            });
                          }}
                        >
                          <span>{model.label}</span>
                          <small>{model.id}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="composer-right">
              <button
                className="send-button"
                data-testid="chat-task-submit"
                type="button"
                aria-label="发送"
                disabled={sendDisabled}
                onClick={() => void submitCurrentInput()}
              >
                <PreviewIcon name="send" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function QuickEntryView({
  chatError,
  onSubmitChatTask,
  state
}: {
  chatError: string | null;
  onSubmitChatTask: (input: string) => Promise<boolean>;
  state: LoadedState;
}): React.JSX.Element {
  const failedTasks = state.taskSnapshot.counts.failed;
  const pendingConfirmations = state.traySummary.backgroundTasks.pendingConfirmation;
  const quickTaskInput = '快捷入口创建任务';
  return (
    <section className="floating-shell floating-shell--quick" data-testid="quick-entry-view">
      <div className="mini-window" data-testid="quick-entry-visual">
        <div className="card-title">
          Roc 快捷入口
          <CompactStatusPill tone="ok" value="同步主窗口状态" />
        </div>
        <div className="card-pad">
          <div className="field-box">补充当前任务或创建新的本地任务</div>
          <div className="tab-row tab-row--quick">
            <button className="tab active" data-testid="quick-submit-task" type="button" onClick={() => void onSubmitChatTask(quickTaskInput)}>
              追加到当前任务
            </button>
            <button className="tab" data-testid="quick-open-tasks" type="button" onClick={() => void window.roc.app.openMainPage('tasks')}>
              创建新任务
            </button>
            <button className="tab" data-testid="quick-open-chat" type="button" onClick={() => void window.roc.app.openMainPage('chat')}>
              快速提问
            </button>
          </div>
        </div>
        <Row
          title="后台任务"
          sub={`${state.traySummary.backgroundTasks.running} 个运行中`}
          tag="运行中"
          tone="info"
        />
        <Row
          title="待确认"
          sub={`${pendingConfirmations} 个高影响动作`}
          tag="需确认"
          tone="warn"
        />
        <Row
          title="失败"
          sub={`${failedTasks} 个失败任务`}
          tag={failedTasks > 0 ? '可修复' : '无'}
          tone={failedTasks > 0 ? 'bad' : 'ok'}
        />
        {chatError === null ? null : <span className="inline-warning" data-testid="quick-entry-error">{chatError}</span>}
      </div>
    </section>
  );
}

function TrayEntryView({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const trayStatusTone = state.traySummary.backgroundPaused ? 'warn' : 'ok';
  const trayStatusValue = state.traySummary.backgroundPaused ? '已暂停' : '运行中';
  return (
    <section className="floating-shell floating-shell--tray" data-testid="tray-entry-view">
      <div className="tray-pop" data-testid="tray-entry-visual">
        <div className="card-title">
          Roc 常驻状态
          <CompactStatusPill tone={trayStatusTone} value={trayStatusValue} />
        </div>
        <Row title="后台任务" sub={`${state.traySummary.backgroundTasks.running} 个运行中，${state.traySummary.backgroundTasks.pendingConfirmation} 个等待用户`} tag="查看" tone="info" />
        <Row
          title="失败任务"
          sub={`${state.taskSnapshot.counts.failed} 个失败任务`}
          tag="修复"
          tone={state.taskSnapshot.counts.failed > 0 ? 'bad' : 'ok'}
        />
        <Row title="待确认" sub={`${state.traySummary.backgroundTasks.pendingConfirmation} 个高风险动作`} tag="处理" tone="warn" />
        <Row
          title="后台执行"
          sub={state.traySummary.backgroundPaused ? '后台执行已暂停' : '当前允许工作区内低风险任务'}
          tag={state.traySummary.backgroundPaused ? '恢复' : '暂停'}
          tone="info"
        />
      </div>
      <div className="floating-entry-actions">
        <button
          data-testid="tray-toggle-background"
          type="button"
          onClick={() => {
            const action = state.traySummary.backgroundPaused
              ? window.roc.lifecycle.resumeBackgroundExecution()
              : window.roc.lifecycle.pauseBackgroundExecution();
            void action.then((result) => updateLoadedState({ traySummary: unwrap<TraySummary>('tray background toggle', result) }));
          }}
        >
          {state.traySummary.backgroundPaused ? '恢复后台执行' : '暂停后台执行'}
        </button>
        <button data-testid="tray-open-tasks" type="button" onClick={() => void window.roc.app.openMainPage('tasks')}>
          打开任务
        </button>
      </div>
    </section>
  );
}

function TasksView({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const backgroundTask = state.backgroundTask;
  const runningTasks = state.traySummary.backgroundTasks.running;
  const scheduledTasks = state.backgroundTasks.filter((task) => task.scheduled).length;
  const pendingConfirmations = state.traySummary.backgroundTasks.pendingConfirmation;
  const recentEvents = state.taskSnapshot.recentEvents.slice(0, 4);
  return (
    <>
      <PageHeading kicker="任务控制" title="任务工作台" />
      <section className="canvas-stage stage-grid" data-testid="tasks-view">
        <div className="grid-3" data-testid="background-task-summary">
          <Metric
            label="后台任务"
            note={`${runningTasks} 个运行中`}
            value={state.traySummary.backgroundTasks.total}
          />
          <Metric
            label="定时任务"
            note={state.traySummary.nextRunAt === null ? '暂无计划' : `下次 ${state.traySummary.nextRunAt}`}
            value={scheduledTasks}
          />
          <Metric label="待确认" note="高风险动作" tone="warn" value={pendingConfirmations} />
        </div>
        <div className="grid-2">
          <section className="card">
            <div className="card-title">任务队列 <CompactStatusPill tone="warn" value="需处理" /></div>
            {backgroundTask === null ? (
              <Row title="后台任务" sub="当前没有后台任务或定时执行。" tag="空" tone="warn" />
            ) : (
              <>
                <Row title={backgroundTask.goal} sub={backgroundTask.triggerDescription} tag={backgroundTask.status} tone="info" />
                <Row title="触发" sub={backgroundTask.triggerDescription} tag={backgroundTask.scheduled ? '定时' : '手动'} tone="ok" />
                <Row title="下次运行" sub={backgroundTask.nextRunAt === null ? '无' : backgroundTask.nextRunAt} tag={backgroundTask.failurePolicy} tone="warn" />
              </>
            )}
          </section>
          <section className="card">
            <div className="card-title">最近任务事件</div>
            {recentEvents.length === 0 ? (
              <Row title="任务事件" sub="当前没有任务事件。" tag="空" tone="warn" />
            ) : (
              recentEvents.map((event) => (
                <Row key={event.id} title={event.type} sub={event.createdAt} tag="已记录" tone="info" />
              ))
            )}
          </section>
        </div>
        <div className="grid-2">
          {backgroundTask === null ? (
            <EmptyState testId="background-task-controls" title="暂无后台任务" />
          ) : (
            <section className="card" data-testid="background-task-controls">
              <div className="card-title">
                后台任务 <StatusPill label="状态" tone={backgroundTask.status === 'running' ? 'ok' : 'warn'} value={backgroundTask.status} />
              </div>
              <Row title="目标" sub={backgroundTask.goal} tag={backgroundTask.riskLevel} tone={backgroundTask.riskLevel === 'low' ? 'ok' : 'warn'} />
              <div className="action-strip">
                <button
                  data-testid="background-pause"
                  type="button"
                  onClick={() => {
                    void window.roc.tasks.pauseBackgroundTask(backgroundTask.id).then(async (result) => {
                      const task = unwrap<BackgroundTask>('pause background task', result);
                      const [taskSnapshot, traySummary] = await Promise.all([window.roc.tasks.getSnapshot(), window.roc.lifecycle.getTraySummary()]);
                      updateLoadedState({
                        backgroundTask: task,
                        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
                        traySummary: unwrap<TraySummary>('tray summary', traySummary)
                      });
                    });
                  }}
                >
                  暂停
                </button>
                <button
                  data-testid="background-resume"
                  type="button"
                  onClick={() => {
                    void window.roc.tasks.resumeBackgroundTask(backgroundTask.id).then(async (result) => {
                      const task = unwrap<BackgroundTask>('resume background task', result);
                      const [taskSnapshot, traySummary] = await Promise.all([window.roc.tasks.getSnapshot(), window.roc.lifecycle.getTraySummary()]);
                      updateLoadedState({
                        backgroundTask: task,
                        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
                        traySummary: unwrap<TraySummary>('tray summary', traySummary)
                      });
                    });
                  }}
                >
                  继续
                </button>
                <button
                  data-testid="background-cancel"
                  type="button"
                  onClick={() => {
                    void window.roc.tasks.cancelBackgroundTask(backgroundTask.id).then(async (result) => {
                      const task = unwrap<BackgroundTask>('cancel background task', result);
                      const [taskSnapshot, traySummary] = await Promise.all([window.roc.tasks.getSnapshot(), window.roc.lifecycle.getTraySummary()]);
                      updateLoadedState({
                        backgroundTask: task,
                        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
                        traySummary: unwrap<TraySummary>('tray summary', traySummary)
                      });
                    });
                  }}
                >
                  取消
                </button>
              </div>
            </section>
          )}
          <TraySummaryPanel traySummary={state.traySummary} />
        </div>
      </section>
    </>
  );
}

function WorkspaceView({
  loadState,
  onSelectWorkspace,
  state
}: {
  loadState: LazyLoadState;
  onSelectWorkspace: () => Promise<void>;
  state: LoadedState;
}): React.JSX.Element {
  if (state.workspace === null) {
    return (
      <>
        <PageHeading kicker="工作区" title="工作区文件" />
        <section className="canvas-stage stage-grid" data-testid="workspace-view">
          <EmptyState
            action={
              <button className="action-button" data-testid="workspace-empty-select" type="button" onClick={() => void onSelectWorkspace()}>
                选择工作区
              </button>
            }
            testId="workspace-empty"
            title="未选择工作区"
          />
          <WorkspaceStatusPanels state={state} />
        </section>
      </>
    );
  }

  if (loadState.status === 'loading') {
    return (
      <>
        <PageHeading kicker="工作区" title="工作区文件" />
        <section className="canvas-stage stage-grid" data-testid="workspace-view">
          <EmptyState testId="workspace-loading" title="工作区数据加载中" tone="loading" />
          <WorkspaceStatusPanels state={state} />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading kicker="工作区" title="工作区文件" />
        <section className="canvas-stage stage-grid" data-testid="workspace-view">
          <EmptyState testId="workspace-load-error" title="工作区数据加载失败" tone="error" />
          <WorkspaceStatusPanels state={state} />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading kicker="工作区" title="工作区文件" />
      <section className="canvas-stage stage-grid" data-testid="workspace-view">
        <div className="split">
          <section className="file-tree file-tree-surface card" data-testid="file-tree">
            {state.fileTree === null ? (
              <p className="muted">文件树未加载。</p>
            ) : (
              state.fileTree.entries.map((entry) => <TreeItem entry={entry} key={entry.relativePath} />)
            )}
          </section>
          <section className="card">
            <div className="card-title">
              文件操作预览 <CompactStatusPill tone="ok" value="工作区内" />
            </div>
            <Row title="搜索" sub="按标题、正文、任务 ID、记忆 ID 搜索" tag="可执行" tone="info" />
            <Row title="编辑" sub="写入前创建恢复点，高风险动作确认" tag="受控" tone="ok" />
            <Row title="预览" sub="Markdown、代码、图片、PDF、Office 按需加载" tag="可用" tone="ok" />
            <Row title="自动化" sub="默认限定当前工作区，外部写入需确认" tag="受控" tone="warn" />
          </section>
        </div>
        <section className="code-preview" data-testid="file-preview">
          {state.filePreview === null
            ? '# 当前工作区无可预览文本文件'
            : state.filePreview.content}
        </section>
        <WorkspaceStatusPanels state={state} />
      </section>
    </>
  );
}

function WorkspaceStatusPanels({ state }: { state: LoadedState }): React.JSX.Element {
  const terminalLabel =
    state.terminalSession === null
      ? state.workspace === null
        ? '未建立会话'
        : '打开终端后建立会话'
      : `${state.terminalSession.shell} · ${state.terminalSession.cols}×${state.terminalSession.rows}`;
  return (
    <div className="grid-3">
      <section className="card" data-testid="git-panel">
        <div className="card-title">Git</div>
        {state.gitStatus === null ? (
          <p className="muted">{gitErrorLabel(state.gitError)}</p>
        ) : (
          <Row sub={state.gitStatus.workspacePath} tag={`${state.gitStatus.changedFiles} 变更`} title={state.gitStatus.branch} tone="info" />
        )}
      </section>
      <section className="card" data-testid="terminal-panel">
        <div className="card-title">终端</div>
        <Row
          title={state.terminalSession === null ? '未连接' : state.terminalSession.status}
          sub={state.terminalError ?? terminalLabel}
          tag={state.terminalSession === null ? '空态' : '会话'}
          tone={state.terminalSession === null ? 'warn' : 'ok'}
        />
      </section>
      <section className="card" data-testid="rtk-panel">
        <div className="card-title">RTK</div>
        <Row title="资源状态" sub={state.rtkStatus.resourceState === 'ready' ? 'ready' : '缺失降级'} tag={state.rtkStatus.resourceState} tone="warn" />
        <Row title="tee" sub={state.rtkStatus.teeDir} tag={state.rtkStatus.enabledForAgentCommands ? 'agent' : 'terminal'} tone="info" />
      </section>
    </div>
  );
}

function GitView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  if (state.workspace !== null && loadState.status === 'loading') {
    return (
      <>
        <PageHeading kicker="工作区" title="Git 面板" />
        <section className="canvas-stage stage-grid" data-testid="git-view">
          <EmptyState testId="git-loading" title="Git 状态加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (state.workspace !== null && loadState.status === 'error') {
    return (
      <>
        <PageHeading kicker="工作区" title="Git 面板" />
        <section className="canvas-stage stage-grid" data-testid="git-view">
          <EmptyState testId="git-load-error" title="Git 状态加载失败" tone="error" />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading kicker="工作区" title="Git 面板" />
      <section className="canvas-stage stage-grid" data-testid="git-view">
        <div className="grid-3">
          <Metric label="变更文件" note="来自 git status" value={state.gitStatus === null ? 0 : state.gitStatus.changedFiles} />
          <Metric label="当前分支" note="本地工作区" value={state.gitStatus === null ? '无仓库' : state.gitStatus.branch} />
          <Metric label="风险动作" note="分支切换 / 创建后切换需确认" tone="warn" value={2} />
        </div>
        <section className="card">
          <div className="card-title">Git 状态</div>
          {state.gitStatus === null ? (
            <Row title="非 Git 工作区" sub={gitErrorLabel(state.gitError)} tag="空" tone="warn" />
          ) : state.gitStatus.porcelain.length === 0 ? (
            <Row title="工作区" sub="工作区干净" tag="无变更" tone="ok" />
          ) : (
            state.gitStatus.porcelain.map((item) => <Row key={item} sub={item} tag="未暂存" title="变更" tone="warn" />)
          )}
        </section>
        <section className="card">
          <div className="card-title">最近变更焦点</div>
          {state.gitStatus === null ? (
            <Row title="当前工作区" sub="当前工作区不是 Git 仓库，未生成提交说明。" tag="空" tone="warn" />
          ) : (
            <Row
              title="当前工作区"
              sub={`${state.gitStatus.porcelain.length} 条变更可进入批量暂存或分支联动。`}
              tag={state.gitStatus.branch}
              tone="info"
            />
          )}
        </section>
      </section>
    </>
  );
}

function TerminalView({ state }: { state: LoadedState }): React.JSX.Element {
  return (
    <>
      <PageHeading kicker="工作区" title="嵌入式终端" />
      <section className="canvas-stage stage-grid" data-testid="terminal-view">
        <section className="card">
          <div className="card-title">
            命令执行边界 <CompactStatusPill tone="ok" value={`cwd: ${visibleWorkspaceCwd(state)}`} />
          </div>
          <Row title="目的" sub="读取当前工作区状态并保留任务轨迹" tag="可见" tone="info" />
          <Row title="风险" sub="低风险命令直接执行，高风险命令进入确认策略" tag={state.rtkStatus.resourceState === 'ready' ? '低' : '缺失降级'} tone={state.rtkStatus.resourceState === 'ready' ? 'ok' : 'warn'} />
          <Row title="记录" sub="命令、输出、退出码写入任务轨迹" tag="开启" tone="ok" />
        </section>
        <div className="terminal terminal--main" data-testid="terminal-raw-output">
          {state.workspace === null
            ? '未选择工作区。'
            : state.terminalSession === null
              ? '在聊天页右侧打开 Terminal 后建立真实终端会话。'
              : `${state.terminalSession.shell} ${state.terminalSession.cols}x${state.terminalSession.rows} (${state.terminalSession.status})`}
        </div>
      </section>
    </>
  );
}

function PreviewView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  if (state.workspace !== null && loadState.status === 'loading') {
    return (
      <>
        <PageHeading kicker="工作区" title="文件预览" />
        <section className="canvas-stage stage-grid" data-testid="preview-view">
          <EmptyState testId="preview-loading" title="文件预览加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (state.workspace !== null && loadState.status === 'error') {
    return (
      <>
        <PageHeading kicker="工作区" title="文件预览" />
        <section className="canvas-stage stage-grid" data-testid="preview-view">
          <EmptyState testId="preview-load-error" title="文件预览加载失败" tone="error" />
        </section>
      </>
    );
  }

  const previewBody = previewTextBody(state.filePreview);
  const previewStage =
    isImagePreview(state.filePreview) ? (
      <div className="workbench-file-image-stage">
        <img
          alt={state.filePreview.relativePath}
          className="workbench-file-image-preview"
          data-testid="preview-view-image"
          src={state.filePreview.content}
        />
      </div>
    ) : (
      <div className="code-preview">{state.filePreview === null ? '当前没有加载可预览内容。' : state.filePreview.content}</div>
    );

  return (
    <>
      <PageHeading kicker="工作区" title="文件预览" />
      <section className="canvas-stage stage-grid" data-testid="preview-view">
        <div className="grid-2">
          <section className="card">
            <div className="card-title">Markdown / 文本预览</div>
            <div className="card-pad">
              <>
                <div className="page-title mini">{state.filePreview === null ? '无可预览文件' : state.filePreview.relativePath}</div>
                <div className="page-subtitle">
                  {state.filePreview === null ? '当前根目录没有可预览文本文件。' : `${state.filePreview.sizeBytes} bytes`}
                </div>
                {state.filePreview === null ? null : state.filePreview.kind === 'image' ? (
                  <p className="muted">图片预览已加载。</p>
                ) : (
                  <p className="muted">{previewBody}</p>
                )}
              </>
            </div>
          </section>
          <section className="card">
            <div className="card-title">代码 / Diff 预览</div>
            {previewStage}
          </section>
        </div>
        <section className="card">
          <div className="card-title">搜索命中</div>
          {state.fileSearch === null || state.fileSearch.matches.length === 0 ? (
            <p className="muted">没有匹配项。</p>
          ) : (
            state.fileSearch.matches.map((match) => (
              <Row
                key={`${match.relativePath}:${match.line}:${match.column}`}
                sub={match.preview}
                tag={`${match.line}:${match.column}`}
                title={match.relativePath}
                tone="info"
              />
            ))
          )}
        </section>
      </section>
    </>
  );
}

function McpView({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return (
    <>
      <PageHeading kicker="控制面" title="MCP" />
      <section className="canvas-stage stage-grid" data-testid="mcp-view">
        <div className="grid-3">
          <Metric label="MCP 服务" note={`${state.mcpServers.filter((server) => server.enabled).length} 个已启用`} value={state.mcpServers.length} />
          <Metric label="MCP 工具" note="来自服务快照" value={sumMcpTools(state.mcpServers)} />
          <Metric label="长期授权" note="均可撤销" tone="warn" value={state.mcpServers.filter((server) => server.riskLevel !== 'low').length} />
        </div>
        <McpManagementPanel state={state} updateLoadedState={updateLoadedState} />
        <SkillManagementPanel state={state} updateLoadedState={updateLoadedState} />
      </section>
    </>
  );
}

function SkillsView({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return (
    <>
      <PageHeading kicker="控制面" title="Skill" />
      <section className="canvas-stage stage-grid" data-testid="skills-view">
        <div className="grid-3">
          <Metric label="Skill 总数" note={`${state.skills.filter((skill) => skill.enabled).length} 个已启用`} value={state.skills.length} />
          <Metric label="Ready" note="可被本轮选择" tone="ok" value={state.skills.filter((skill) => skill.status === 'ready').length} />
          <Metric label="Invalid" note="需要修复依赖或描述" tone="warn" value={state.skills.filter((skill) => skill.status === 'invalid').length} />
        </div>
        <SkillManagementPanel state={state} updateLoadedState={updateLoadedState} />
        <section className="card">
          <div className="card-title">触发与依赖</div>
          <Row title="触发范围" sub="按仓库、任务类型和关键词命中" tag="受控" tone="ok" />
          <Row title="权限继承" sub="子代理默认不继承本轮 Skill" tag="隔离" tone="warn" />
        </section>
      </section>
    </>
  );
}

function McpManagementPanel({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return (
    <section className="card" data-testid="mcp-management">
      <div className="card-title">
        MCP 服务与工具
        {state.mcpTestStatus === null ? null : <StatusPill label="本地测试" tone={state.mcpTestStatus.status === 'ready' ? 'ok' : 'warn'} value={`${state.mcpTestStatus.serverId}:${state.mcpTestStatus.status}`} />}
      </div>
      {state.mcpServers.length === 0 ? (
        <p className="muted">尚未配置 MCP server。</p>
      ) : (
        state.mcpServers.map((server) => (
          <div className="row action-row" key={server.id}>
            <div>
              <div className="row-title">{server.name}</div>
              <div className="row-sub">
                {server.id}:{server.status} · {server.transport} · {server.riskLevel === undefined ? 'low' : server.riskLevel}
              </div>
            </div>
            <span className={server.enabled ? 'pill ok' : 'pill warn'}>{server.enabled ? 'enabled' : 'disabled'}</span>
            <button
              data-testid={`mcp-test-${server.id}`}
              type="button"
              onClick={() => {
                void window.roc.mcp.testServer(server.id).then((result) => {
                  updateLoadedState({ mcpTestStatus: unwrap<McpServerTestResult>('mcp test', result) });
                });
              }}
            >
              测试
            </button>
            <button
              data-testid={`mcp-toggle-${server.id}`}
              type="button"
              onClick={() => {
                void window.roc.mcp.setServerEnabled({ id: server.id, enabled: !server.enabled }).then(async () => {
                  const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', await window.roc.mcp.listServers());
                  updateLoadedState({
                    mcpServers,
                    selectedMcpServers: mcpServers.filter((item) => item.enabled).map((item) => item.id)
                  });
                });
              }}
            >
              {server.enabled ? '禁用' : '启用'}
            </button>
            <button
              data-testid={`mcp-delete-${server.id}`}
              type="button"
              onClick={() => {
                void window.roc.mcp.deleteServer(server.id).then(async () => {
                  const mcpServers = unwrap<McpServerSnapshot[]>('mcp servers', await window.roc.mcp.listServers());
                  updateLoadedState({
                    mcpServers,
                    selectedMcpServers: mcpServers.filter((item) => item.enabled).map((item) => item.id)
                  });
                });
              }}
            >
              删除
            </button>
          </div>
        ))
      )}
    </section>
  );
}

function SkillManagementPanel({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return (
    <section className="card" data-testid="skill-management">
      <div className="card-title">Skill 清单</div>
      {state.skills.length === 0 ? (
        <p className="muted">尚未导入本地 Skill。</p>
      ) : (
        state.skills.map((skill) => (
          <div className="row action-row" key={skill.id}>
            <div>
              <div className="row-title">{skill.name}</div>
              <div className="row-sub">
                {skill.id} · {skill.description}
              </div>
            </div>
            <span className={skill.enabled && skill.status === 'ready' ? 'pill ok' : 'pill warn'}>
              {skill.enabled ? skill.status : 'disabled'}
            </span>
            <button
              data-testid={`skill-toggle-${skill.id}`}
              type="button"
              onClick={() => {
                void window.roc.skills.setEnabled({ id: skill.id, enabled: !skill.enabled }).then(async () => {
                  const skills = unwrap<SkillSnapshot[]>('skills', await window.roc.skills.list());
                  updateLoadedState({
                    skills,
                    selectedSkills: skills.filter((item) => item.enabled && item.status === 'ready').map((item) => item.id)
                  });
                });
              }}
            >
              {skill.enabled ? '禁用' : '启用'}
            </button>
            <button
              data-testid={`skill-delete-${skill.id}`}
              type="button"
              onClick={() => {
                void window.roc.skills.deleteSkill(skill.id).then(async () => {
                  const skills = unwrap<SkillSnapshot[]>('skills', await window.roc.skills.list());
                  updateLoadedState({
                    skills,
                    selectedSkills: skills.filter((item) => item.enabled && item.status === 'ready').map((item) => item.id)
                  });
                });
              }}
            >
              删除
            </button>
          </div>
        ))
      )}
    </section>
  );
}

function MemoryView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);

  if (loadState.status === 'loading') {
    return (
      <>
        <PageHeading kicker="控制面" title="记忆中心" />
        <section className="canvas-stage stage-grid" data-testid="memory-view">
          <EmptyState testId="memory-loading" title="记忆中心加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading kicker="控制面" title="记忆中心" />
        <section className="canvas-stage stage-grid" data-testid="memory-view">
          <EmptyState testId="memory-load-error" title="记忆中心加载失败" tone="error" />
        </section>
      </>
    );
  }
  const recoveredId = state.memoryRecovery?.id ?? null;
  const memoryItems = state.memorySearch?.items ?? [];
  const recallItems = state.sessionSearch?.items ?? [];
  const latestActiveMemory = memoryItems.find((item) => item.layer !== 'session') ?? null;
  const selectedCandidate = state.memoryCandidates[0] ?? null;
  const liveVisibleRecords: MemoryRecordViewModel[] = [
    ...(selectedCandidate === null
      ? []
      : [
          {
            id: selectedCandidate.id,
            layer: 'candidate',
            scope: selectedCandidate.scope,
            type: selectedCandidate.type,
            confidence: selectedCandidate.confidence,
            sourceTag: selectedCandidate.source,
            status: selectedCandidate.state,
            priority: selectedCandidate.priority,
            sourceRef: selectedCandidate.sourceRef,
            summary: selectedCandidate.content,
            detail: selectedCandidate.content,
            tone: selectedCandidate.state === 'conflict_detected' ? 'warn' : 'ok'
          }
        ]),
    ...memoryItems.slice(0, 4).map((item) => ({
      id: item.id,
      layer: item.layer,
      scope: item.scope,
      type: 'project_context',
      confidence: item.confidence,
      sourceTag: item.sourceRef,
      status: item.reason,
      priority: 'medium',
      sourceRef: item.sourceRef,
      summary: item.summary,
      detail: item.summary,
      tone: item.layer === 'hot' ? 'ok' : 'info'
    }))
  ];
  const visibleRecords = liveVisibleRecords;
  const selectedRecord = visibleRecords.find((record) => record.id === selectedRecordId) ?? visibleRecords[0] ?? null;
  const selectedRecordTitle = selectedRecord === null ? 'memory-center' : memoryRecordTitle(selectedRecord);
  const draftText = selectedRecord?.summary ?? '';
  const dirty = selectedRecord !== null;
  return (
    <>
      <PageHeading
        flags={<StatusPill label="真相源" tone="ok" value={state.memoryStatus.truthSource} />}
        kicker="控制面"
        title="记忆中心"
      />
      <section className="canvas-stage stage-grid" data-testid="memory-view">
        <div className="memory-search-box">
          <span>搜索记忆 ID、正文、来源引用、scope 或会话摘要</span>
          <StatusPill label="当前范围" tone="info" value="project:Roc" />
        </div>
        <div className="memory-library-layout">
          <aside className="memory-library-sidebar">
            <div className="grid-2">
              <Metric
                label="全部记忆"
                note="含热 / 暖 / 会话回忆"
                value={Object.values(state.memoryStatus.layers).reduce((total, item) => total + item.entries, 0)}
              />
              <Metric
                label="草稿"
                note={selectedRecord === null ? '无待保存差异' : '当前条目可编辑'}
                value={selectedRecord === null ? 0 : 1}
              />
            </div>
            <section className="card">
              <div className="card-title">筛选与视图</div>
              <Row title="记忆域" sub="偏好 / 反馈 / 项目上下文 / 过程技能 / 知识笔记 / 会话回忆" tag="全部" tone="info" />
              <Row title="作用范围" sub="global / project:Roc / task threads" tag="自动约束" tone="ok" />
              <Row title="来源" sub="user_explicit / feedback / agent_extract / session_recall" tag="可筛选" tone="ok" />
            </section>
            <div className="memory-list-shell">
              <div className="memory-list-head">
                <span>记忆列表</span>
                <CompactStatusPill tone="ok" value={`${visibleRecords.length} 条记录`} />
              </div>
              <div className="memory-list-body">
                {visibleRecords.length === 0 ? (
                  <p className="muted">当前没有可显示记忆。</p>
                ) : (
                  visibleRecords.map((record) => (
                    <button
                      aria-pressed={selectedRecord?.id === record.id}
                      className={selectedRecord?.id === record.id ? 'memory-record active' : 'memory-record'}
                      key={record.id}
                      type="button"
                      onClick={() => setSelectedRecordId(record.id)}
                    >
                      <div className="memory-record-meta">
                        <span className="memory-record-title">{memoryRecordTitle(record)}</span>
                        <span className={`pill ${record.tone}`}>{record.layer}</span>
                        <span className="pill">{record.sourceTag}</span>
                      </div>
                      <div className="memory-record-copy">{record.summary}</div>
                      <div className="memory-record-meta">
                        <span className="pill">scope: {record.scope}</span>
                        <span className="pill">status: {record.status}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
            <section className="card">
              <div className="card-title">后台静默整理</div>
              <Row title="默认行为" tag="自动" tone="ok" />
            </section>
          </aside>
          <section className="memory-library-workspace">
            <div className="memory-editor-stage">
              <div className="memory-editor-topline">
                <div>
                  <div className="memory-editor-title">{selectedRecordTitle}</div>
                  {selectedRecord === null ? null : (
                    <div className="memory-editor-subtitle">{`${selectedRecord.layer} / ${selectedRecord.scope}`}</div>
                  )}
                </div>
                <CompactStatusPill tone={state.memoryStatus.degradedReason === undefined ? 'info' : 'warn'} value={state.memoryStatus.degradedReason === undefined ? '当前条目已同步' : '索引降级'} />
              </div>
              <div className="memory-editor-meta">
                {selectedRecord === null ? (
                  Object.entries(state.memoryStatus.layers).map(([layer, item]) => (
                    <span className="pill" key={layer}>{layer}: {item.entries}</span>
                  ))
                ) : (
                  <>
                    <span className={`pill ${selectedRecord.tone}`}>{selectedRecord.layer}</span>
                    <span className="pill">scope: {selectedRecord.scope}</span>
                    <span className="pill">type: {selectedRecord.type}</span>
                    <span className="pill">confidence: {selectedRecord.confidence}</span>
                    <span className="pill">source: {selectedRecord.sourceTag}</span>
                    <span className="pill">{selectedRecord.status}</span>
                    <span className="pill">{selectedRecord.priority}</span>
                  </>
                )}
              </div>
              <div className="memory-editor-main">
                <div className="memory-editor-panel">
                  <div className="memory-preview-surface">
                    {selectedRecord === null ? '来源引用：当前没有候选记忆。' : `来源引用：${selectedRecord.sourceRef}`}
                  </div>
                  <textarea className="memory-editor-textarea" readOnly value={draftText}></textarea>
                  <div className="memory-editor-copy">
                    {selectedRecord === null ? '当前没有候选内容。' : selectedRecord.note ?? selectedRecord.detail}
                  </div>
                  <div className="form-grid">
                    <FieldPreview label="最近恢复" value={recoveredId ?? latestActiveMemory?.id ?? '无恢复记录'} />
                    <FieldPreview label="召回结果" value={String(memoryItems.length)} />
                  </div>
                  <div className="memory-editor-actions">
                    <span className="memory-chip-button primary" data-testid="memory-save-status">
                      只读
                    </span>
                    <span className="memory-chip-button">
                      恢复受控
                    </span>
                    <span className="memory-chip-button">
                      归档受控
                    </span>
                    <span className="memory-chip-button warn">
                      分层受控
                    </span>
                    <span className="memory-chip-button bad">
                      删除受控
                    </span>
                  </div>
                  <section className="card">
                    <div className="card-title">删除与恢复</div>
                    <Row title="删除当前条目" sub="先展示影响范围；删除会话回忆不会自动级联删除策展记忆。" tag="受控" tone="warn" />
                    <Row title="恢复历史版本" sub="可从 cold history 恢复旧版本，并保留 superseded 轨迹。" tag="可恢复" tone="info" />
                  </section>
                </div>
              </div>
            </div>
          </section>
        </div>
        <div className="grid-2">
          <div className="notice" data-testid="memory-degraded">
            {state.memoryStatus.degradedReason === undefined ? '索引状态正常；向量索引可按需重建。' : state.memoryStatus.degradedReason}
          </div>
          <section className="card" data-testid="memory-candidates">
            <div className="card-title">候选记忆</div>
            {state.memoryCandidates.length === 0 ? <p className="muted">候选区为空。</p> : state.memoryCandidates.map((candidate) => (
              <Row key={candidate.id} sub={candidate.content} tag={candidate.state} title={candidate.type} tone={candidate.state === 'conflict_detected' ? 'warn' : 'info'} />
            ))}
          </section>
          <section className="card" data-testid="memory-conflicts">
            <div className="card-title">冲突裁决</div>
            {state.memoryConflicts.length === 0 ? <p className="muted">没有开放冲突。</p> : state.memoryConflicts.map((conflict) => (
              <Row key={conflict.id} sub={conflict.reason} tag={conflict.status} title={`${conflict.type} · ${conflict.scope}`} tone="warn" />
            ))}
          </section>
          <section className="card" data-testid="memory-search-results">
            <div className="card-title">记忆召回</div>
            {memoryItems.length === 0 ? <p className="muted">没有召回结果。</p> : memoryItems.map((item) => (
              <Row key={`${item.layer}:${item.id}`} sub={item.summary} tag={item.layer} title={item.reason} tone="ok" />
            ))}
          </section>
          <section className="card" data-testid="session-recall-results">
            <div className="card-title">会话回忆</div>
            {recallItems.length === 0 ? <p className="muted">没有会话回忆结果。</p> : recallItems.map((item) => (
              <Row key={item.id} sub={item.summary} tag={item.scope} title={item.title} tone="info" />
            ))}
          </section>
          <section className="card" data-testid="memory-recovery">
            <div className="card-title">删除恢复</div>
            {state.memoryRecovery !== null ? (
              <Row title="最近操作" sub={state.memoryRecovery.id} tag={state.memoryRecovery.status} tone="ok" />
            ) : latestActiveMemory !== null ? (
              <Row title="最近操作" sub={latestActiveMemory.id} tag="active" tone="ok" />
            ) : (
              <Row title="最近操作" sub="暂无删除恢复记录。" tag="空" tone="warn" />
            )}
          </section>
        </div>
      </section>
    </>
  );
}

function memoryRecordTitle(record: MemoryRecordViewModel): string {
  if (record.layer === 'candidate') {
    return '候选记忆';
  }
  if (record.layer === 'session_recall') {
    return '会话回忆';
  }
  return `${record.layer}记忆`;
}

function SettingsView({
  state,
  updateLoadedState
}: {
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const primaryProvider = state.providers[0] ?? null;
  const enabledModel = primaryProvider?.models.find((model) => model.enabled) ?? null;
  const connectionPreview =
    state.providerTestStatus === null
      ? '未运行'
      : state.providerTestStatus.status === 'ready'
        ? '最近检查通过'
        : state.providerTestStatus.status;
  return (
    <>
      <PageHeading kicker="控制面" title="设置" />
      <section className="canvas-stage stage-grid" data-testid="settings-view">
        <div className="split">
          <div className="settings-list">
            {['模型提供商', '默认模型', '应用基础', '授权与安全', '记忆策略', '网页与浏览器', '能力入口', '外观与语言'].map((item, index) => (
              <div className={index === 0 ? 'settings-item active' : 'settings-item'} key={item}>{item}</div>
            ))}
          </div>
          <section className="card">
            <div className="card-title">模型提供商 <StatusPill label="状态" tone="warn" value="草稿未保存" /></div>
            <div className="card-pad">
              <div className="form-grid">
                <FieldPreview label="名称" value={primaryProvider === null ? '尚未配置 provider' : primaryProvider.name} />
                <FieldPreview label="类型" value={primaryProvider === null ? '未设置' : providerTypeLabel(primaryProvider.type)} />
                <FieldPreview label="服务地址" value={primaryProvider === null ? '未设置' : primaryProvider.endpoint} />
                <FieldPreview label="凭据状态" value="已保存，隐藏显示" />
                <FieldPreview label="启用状态" value={primaryProvider !== null && primaryProvider.enabled ? '启用' : '未启用'} />
                <FieldPreview label="连接测试" value={connectionPreview} />
              </div>
              <div className="tab-row">
                <span className="tab active">保存前展示影响范围</span>
                <span className="tab">局部重置</span>
                <span className="tab">不提供导入导出</span>
              </div>
            </div>
          </section>
        </div>
        <section className="card">
          <div className="card-title">高影响变更预览</div>
          <Row title="默认模型变化" sub="会影响新任务和后台任务模型选择" tag="需确认" tone="warn" />
          <Row title="记忆策略变化" sub="会影响自动写入、热记忆准入和跨项目召回" tag="需确认" tone="warn" />
        </section>
        <div className="grid-2">
          <section className="card" data-testid="provider-settings">
            <div className="card-title">模型 Provider</div>
            <Row title="默认模型" sub={state.defaultModelId === null ? '需要配置默认模型' : state.defaultModelId} tag={state.defaultModelId === null ? '缺失' : 'ready'} tone={state.defaultModelId === null ? 'warn' : 'ok'} />
            {state.providers.length === 0 ? (
              <Row title="模型提供商" sub="尚未配置 provider" tag="blocked" tone="warn" />
            ) : (
              state.providers.map((provider) => (
                <div className="row action-row" key={provider.id}>
                  <div>
                    <div className="row-title">{provider.name}</div>
                    <div className="row-sub">
                      {provider.id} · {provider.type} · {provider.endpoint} · {provider.id}:{providerRuntimeStatus(provider, state.providerTestStatus)}
                    </div>
                  </div>
                  <span className={provider.enabled ? 'pill ok' : 'pill warn'}>{provider.enabled ? `${provider.models.length} models` : 'disabled'}</span>
                  <button data-testid={`provider-test-${provider.id}`} type="button" onClick={() => {
                    void window.roc.providers.test(provider.id).then((result) => {
                      updateLoadedState({ providerTestStatus: unwrap<ProviderTestResult>('provider test', result) });
                    });
                  }}>测试</button>
                  <button data-testid={`provider-default-${provider.id}`} type="button" onClick={() => {
                    const model = provider.models.find((item) => item.enabled);
                    if (model === undefined) {
                      return;
                    }
                    void window.roc.providers.setDefaultModel(model.id).then(async () => {
                      const providers = unwrap<{ providers: ProviderConfig[]; defaultModelId: string | null }>('providers', await window.roc.providers.list());
                      updateLoadedState({ providers: providers.providers, defaultModelId: providers.defaultModelId });
                    });
                  }}>设默认</button>
                  <button data-testid={`provider-delete-${provider.id}`} type="button" onClick={() => {
                    void window.roc.providers.delete(provider.id).then(async () => {
                      const providers = unwrap<{ providers: ProviderConfig[]; defaultModelId: string | null }>('providers', await window.roc.providers.list());
                      updateLoadedState({ providers: providers.providers, defaultModelId: providers.defaultModelId });
                    });
                  }}>删除</button>
                </div>
              ))
            )}
          </section>
        </div>
      </section>
    </>
  );
}

function DoctorView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  if (loadState.status === 'loading') {
    return (
      <>
        <PageHeading kicker="控制面" title="Doctor" />
        <section className="canvas-stage stage-grid" data-testid="doctor-view">
          <EmptyState testId="doctor-loading" title="Doctor 检查中" tone="loading" />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading kicker="控制面" title="Doctor" />
        <section className="canvas-stage stage-grid" data-testid="doctor-view">
          <EmptyState testId="doctor-load-error" title="Doctor 加载失败" tone="error" />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading kicker="控制面" title="Doctor" />
      <section className="canvas-stage stage-grid" data-testid="doctor-view">
        <div className="grid-3">
          <Metric label="通过" note="检查项 pass" tone="ok" value={state.doctor.summary.pass} />
          <Metric label="警告 / 降级" note="可执行修复" tone="warn" value={state.doctor.summary.degraded} />
          <Metric label="失败" note="需要用户处理" tone={state.doctor.summary.fail > 0 ? 'bad' : 'ok'} value={state.doctor.summary.fail} />
        </div>
        <section className="card">
          <div className="card-title">健康检查结果</div>
          {state.doctor.findings.map((finding) => (
            <Row
              key={finding.id}
              sub={finding.detail}
              tag={finding.status}
              title={finding.repairAction === undefined ? finding.title : `${finding.title} · ${finding.repairAction.label}`}
              tone={finding.status === 'pass' ? 'ok' : finding.status === 'fail' ? 'bad' : 'warn'}
            />
          ))}
          <Row title="后台任务" sub="打开任务工作台查看后台执行、失败任务和待确认项" tag="打开任务工作台" tone="info" />
        </section>
        <DiagnosticPackagePanel diagnosticPackage={state.diagnosticPackage} />
        <PerformancePanel performanceSample={state.performanceSample} />
      </section>
    </>
  );
}

function DiagnosticsView({
  loadState,
  state
}: {
  loadState: LazyLoadState;
  state: LoadedState;
}): React.JSX.Element {
  if (loadState.status === 'loading') {
    return (
      <>
        <PageHeading kicker="控制面" title="任务诊断包" />
        <section className="canvas-stage stage-grid" data-testid="diagnostics-view">
          <EmptyState testId="diagnostics-loading" title="诊断数据加载中" tone="loading" />
        </section>
      </>
    );
  }

  if (loadState.status === 'error') {
    return (
      <>
        <PageHeading kicker="控制面" title="任务诊断包" />
        <section className="canvas-stage stage-grid" data-testid="diagnostics-view">
          <EmptyState testId="diagnostics-load-error" title="诊断数据加载失败" tone="error" />
        </section>
      </>
    );
  }

  const failedEvents = state.taskSnapshot.recentEvents.filter((event) => event.type === 'error').slice(0, 3);
  return (
    <>
      <PageHeading kicker="控制面" title="任务诊断包" />
      <section className="canvas-stage stage-grid" data-testid="diagnostics-view">
        <section className="card">
          <div className="card-title">失败任务 <StatusPill label="状态" tone="bad" value={failedEvents.length === 0 ? '无失败任务' : '验证失败'} /></div>
          {failedEvents.length === 0 ? (
            <Row title="失败事件" sub="当前没有失败任务事件。" tag="空" tone="ok" />
          ) : (
            failedEvents.map((event) => (
              <Row key={event.id} title={event.type} sub={event.createdAt} tag="已记录" tone="bad" />
            ))
          )}
        </section>
        <div className="grid-2">
          <section className="card">
            <div className="card-title">关键日志</div>
            <Row title="诊断包" sub={state.diagnosticPackage === null ? '尚未生成诊断包。' : state.diagnosticPackage.path} tag={state.diagnosticPackage === null ? '空态' : '已生成'} tone={state.diagnosticPackage === null ? 'warn' : 'ok'} />
            <Row title="性能采样" sub={`${state.performanceSample.rssMb} MB RSS`} tag={state.performanceSample.exceedsBudget ? '超预算' : '正常'} tone={state.performanceSample.exceedsBudget ? 'warn' : 'ok'} />
          </section>
          <section className="card">
            <div className="card-title">恢复与脱敏</div>
            <Row title="脱敏状态" sub={state.diagnosticPackage === null ? '无诊断包' : state.diagnosticPackage.redacted ? '已脱敏' : '未通过'} tag={state.diagnosticPackage === null ? '空态' : '已检查'} tone={state.diagnosticPackage === null ? 'warn' : state.diagnosticPackage.redacted ? 'ok' : 'bad'} />
            <Row title="包含项" sub={state.diagnosticPackage === null ? '无' : state.diagnosticPackage.includes.join(', ')} tag="真实数据" tone="info" />
          </section>
        </div>
        <div className="grid-2">
          <DiagnosticPackagePanel diagnosticPackage={state.diagnosticPackage} />
          <PerformancePanel performanceSample={state.performanceSample} />
        </div>
      </section>
    </>
  );
}

function RailOverlay({
  activeTool,
  activeView,
  workbenchVisible,
  onOpenToolView
}: {
  activeTool: WorkbenchTool;
  activeView: ViewId;
  workbenchVisible: boolean;
  onOpenToolView: (tool: WorkbenchTool) => void;
}): React.JSX.Element {
  return (
    <aside className={activeView === 'chat' ? 'rail-overlay rail-overlay--chat' : 'rail-overlay'}>
      <div className={activeView === 'chat' ? 'rail rail--chat' : 'rail'}>
        {WORKBENCH_TOOLS.map((tool) => {
          return (
            <button
              aria-label={tool.label}
              aria-pressed={activeView === 'chat' && workbenchVisible && activeTool === tool.id}
              className="rail-button"
              data-tool-button={tool.id}
              key={tool.id}
              type="button"
              onClick={() => onOpenToolView(tool.id)}
            >
              <PreviewIcon name={tool.icon} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function WorkbenchPanel({
  activeTool,
  activeView,
  onClose,
  onToolChange,
  onWidthChange,
  state,
  updateWorkspaceData,
  workspaceLoadState,
  width,
  windowState
}: {
  activeTool: WorkbenchTool;
  activeView: ViewId;
  onClose: () => void;
  onToolChange: (tool: WorkbenchTool) => void;
  onWidthChange: (width: number) => void;
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
  workspaceLoadState: LazyLoadState;
  width: number;
  windowState: WindowStateSnapshot;
}): React.JSX.Element {
  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.min(760, Math.max(360, startWidth + startX - moveEvent.clientX));
      onWidthChange(nextWidth);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  return (
    <aside className="workbench" data-testid="workbench-panel">
      <div
        aria-label="调节右侧工作台宽度"
        className="workbench-resize-handle"
        data-testid="workbench-resize-handle"
        role="separator"
        tabIndex={0}
        onPointerDown={startResize}
      />
      <div className="workbench-bar">
        <div className="workbench-tabs">
          {WORKBENCH_TOOLS.map((tool) => {
            return (
              <button
                aria-pressed={activeTool === tool.id}
                className={activeTool === tool.id ? 'workbench-tab active' : 'workbench-tab'}
                data-tool-button={tool.id}
                key={tool.id}
                type="button"
                onClick={() => onToolChange(tool.id)}
              >
                <PreviewIcon name={tool.icon} />
                <span>{tool.label}</span>
              </button>
            );
          })}
        </div>
        <button aria-label="关闭右侧工作台" className="workbench-close" type="button" onClick={onClose}>
          <span className="titlebar-glyph" aria-hidden="true">×</span>
        </button>
      </div>
      <div className="workbench-panel">
        {activeTool === 'git' ? (
          <GitWorkbench loadState={workspaceLoadState} state={state} updateWorkspaceData={updateWorkspaceData} />
        ) : activeTool === 'terminal' ? (
          <TerminalWorkbench state={state} updateWorkspaceData={updateWorkspaceData} windowState={windowState} />
        ) : (
          <FilesWorkbench loadState={workspaceLoadState} state={state} updateWorkspaceData={updateWorkspaceData} />
        )}
      </div>
    </aside>
  );
}

function FilesWorkbench({
  loadState,
  state,
  updateWorkspaceData
}: {
  loadState: LazyLoadState;
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
}): React.JSX.Element {
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [directoryChildren, setDirectoryChildren] = useState<Record<string, FileTreeResult['entries']>>({});
  const [directoryLoadingPath, setDirectoryLoadingPath] = useState<string | null>(null);
  const [filePaneWidth, setFilePaneWidth] = useState(304);
  const previewPath = state.filePreview?.relativePath ?? '当前没有可预览文件';

  useEffect(() => {
    setExpandedDirectories(new Set());
    setDirectoryChildren({});
    setDirectoryLoadingPath(null);
    setFilePaneWidth(304);
  }, [state.workspace?.path]);

  async function openFilePreview(relativePath: string): Promise<void> {
    const preview = unwrap<FilePreviewResult>('file preview', await window.roc.files.preview({ relativePath }));
    updateWorkspaceData({ filePreview: preview, fileSearch: null });
  }

  async function toggleDirectory(relativePath: string): Promise<void> {
    if (expandedDirectories.has(relativePath)) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.delete(relativePath);
        return next;
      });
      return;
    }

    if (directoryChildren[relativePath] === undefined) {
      setDirectoryLoadingPath(relativePath);
      try {
        const childTree = unwrap<FileTreeResult>('file tree', await window.roc.files.listTree({ relativePath }));
        setDirectoryChildren((current) => ({ ...current, [relativePath]: childTree.entries }));
      } finally {
        setDirectoryLoadingPath((current) => (current === relativePath ? null : current));
      }
    }
    setExpandedDirectories((current) => new Set(current).add(relativePath));
  }

  useEffect(() => {
    if (state.filePreview === null) {
      return;
    }
    const parentPath = parentRelativePath(state.filePreview.relativePath);
    if (parentPath === null) {
      return;
    }
    setExpandedDirectories((current) => {
      if (current.has(parentPath)) {
        return current;
      }
      const next = new Set(current);
      next.add(parentPath);
      return next;
    });
  }, [state.filePreview?.relativePath]);

  if (state.workspace === null) {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-files-empty" title="未选择工作区" />
      </section>
    );
  }

  if (loadState.status === 'loading') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-files-loading" title="文件工作台加载中" tone="loading" />
      </section>
    );
  }

  if (loadState.status === 'error') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-files-load-error" title="文件工作台加载失败" tone="error" />
      </section>
    );
  }

  const previewBody = previewTextBody(state.filePreview);
  const treeNodes = state.fileTree === null ? [] : flattenTreeEntries(state.fileTree.entries, expandedDirectories, directoryChildren);
  const previewPanel =
    state.filePreview === null ? (
      <div className="workbench-file-empty" data-testid="workbench-file-preview">
        <strong>尚未选中文件</strong>
        <p>从左侧文件树选择一个文件后，这里会显示原内容、图片或不可直接阅读的说明。</p>
      </div>
    ) : isImagePreview(state.filePreview) ? (
      <div className="workbench-file-image-stage" data-testid="workbench-file-preview">
        <img
          alt={state.filePreview.relativePath}
          className="workbench-file-image-preview"
          data-testid="workbench-file-image-preview"
          src={state.filePreview.content}
        />
      </div>
    ) : state.filePreview.kind === 'binary' ? (
      <div className="workbench-file-empty" data-testid="workbench-file-preview">
        <strong>该文件不能直接作为文本阅读</strong>
        <p>当前文件属于二进制内容。请在外部工具中打开，或使用 Git / 文件操作继续处理。</p>
      </div>
    ) : (
      <pre className="workbench-file-preview" data-testid="workbench-file-preview">
        {previewBody}
      </pre>
    );

  function startFilePaneResize(event: React.PointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = filePaneWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      const nextWidth = Math.min(440, Math.max(228, startWidth + moveEvent.clientX - startX));
      setFilePaneWidth(nextWidth);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  return (
    <section className="tool-panel workbench-surface workbench-surface--files">
      <div className="workbench-files" style={{ '--file-pane-width': `${filePaneWidth}px` } as React.CSSProperties}>
        <section className="workbench-sidebar-pane workbench-sidebar-pane--files">
          <header className="pane-header">
            <div>
              <div className="pane-title">EXPLORER</div>
              {directoryLoadingPath === null ? null : <div className="pane-subtitle">正在展开目录</div>}
            </div>
            <CompactStatusPill tone="info" value={state.fileTree?.truncated ? '已截断' : '工作区内'} />
          </header>
          <div className="workbench-sidebar-summary">
            <span>{state.workspace.displayName}</span>
          </div>
          <section className="workbench-file-tree" data-testid="workbench-file-tree">
            {state.fileTree === null ? (
              <p className="muted">文件树未加载。</p>
            ) : (
              treeNodes.slice(0, 240).map(({ entry, depth }) => (
                <TreeItem
                  active={state.filePreview?.relativePath === entry.relativePath}
                  depth={depth}
                  expanded={expandedDirectories.has(entry.relativePath)}
                  entry={entry}
                  key={entry.relativePath}
                  loading={directoryLoadingPath === entry.relativePath}
                  onClick={
                    entry.type === 'file' ? () => void openFilePreview(entry.relativePath) : () => void toggleDirectory(entry.relativePath)
                  }
                />
              ))
            )}
          </section>
        </section>
        <div
          aria-label="调节文件树宽度"
          className="workbench-file-splitter"
          data-testid="workbench-file-splitter"
          role="separator"
          tabIndex={0}
          onPointerDown={startFilePaneResize}
        />
        <section className="workbench-content-pane">
          <header className="pane-header pane-header--content">
            <div>
              <div className="pane-path">{previewPath}</div>
            </div>
          </header>
          <div className={state.filePreview?.kind === 'text' ? 'workbench-file-body workbench-file-body--code' : 'workbench-file-body'}>
            {previewPanel}
          </div>
        </section>
      </div>
    </section>
  );
}

function buildGitChangeStateLabel(change: GitStatusChange): string {
  if (change.index === '?') {
    return '未跟踪';
  }
  if (change.index !== ' ' && change.worktree !== ' ') {
    return '已暂存 + 工作区修改';
  }
  if (change.index !== ' ') {
    return '已暂存';
  }
  return '工作区修改';
}

function findNextGitSelection(changes: GitStatusChange[], preferredPath: string | null): string | null {
  if (changes.length === 0) {
    return null;
  }
  if (preferredPath === null) {
    return changes[0]?.relativePath ?? null;
  }
  const preferredIndex = changes.findIndex((change) => change.relativePath === preferredPath);
  if (preferredIndex >= 0) {
    return changes[preferredIndex]?.relativePath ?? null;
  }
  const nextBySort = [...changes]
    .map((change) => change.relativePath)
    .sort((left, right) => left.localeCompare(right, 'en'));
  return nextBySort[0] ?? null;
}

function gitSelectionEmptyMessage(state: LoadedState): string {
  if (state.gitStatus === null || state.gitStatus.changedFiles === 0) {
    return '当前没有可选择的 Git 变更文件。';
  }
  return '从下方列表选择一个变更文件后，这里会显示当前焦点文件的状态和内容预览。';
}

type GitChangeListProps = {
  actionBusy: boolean;
  changes: GitStatusChange[];
  emptyText: string;
  selectedPath: string | null;
  selectedPathSet: Set<string>;
  title: string;
  selectable: boolean;
  onSelectGitFile: (relativePath: string) => Promise<void>;
  onToggleSelectedPath: (relativePath: string, checked: boolean) => void;
};

function GitChangeList({
  actionBusy,
  changes,
  emptyText,
  selectedPath,
  selectedPathSet,
  title,
  selectable,
  onSelectGitFile,
  onToggleSelectedPath
}: GitChangeListProps): React.JSX.Element {
  if (changes.length === 0) {
    return <div className="git-change-empty">{emptyText}</div>;
  }

  return (
    <section className="git-change-list" data-testid={`git-change-list-${title.toLowerCase().replace(/\s+/g, '-')}`}>
      {changes.map((change) => {
        const safeId = sanitizeTestId(change.relativePath);
        const active = selectedPath === change.relativePath;
        const checked = selectable ? selectedPathSet.has(change.relativePath) : canUnstageGitChange(change);
        return (
          <div className={active ? 'git-change-card selected' : 'git-change-card'} key={change.porcelain}>
            <button
              aria-pressed={active}
              className="git-change-meta"
              data-testid={`git-select-${safeId}`}
              type="button"
              onClick={() => void onSelectGitFile(change.relativePath)}
            >
              <input
                checked={checked}
                data-testid={`git-select-toggle-${safeId}`}
                disabled={actionBusy || !selectable}
                type="checkbox"
                onChange={(event) => onToggleSelectedPath(change.relativePath, event.target.checked)}
                onClick={(event) => {
                  event.stopPropagation();
                }}
              />
              <span className="git-change-path">{change.relativePath}</span>
            </button>
            <div className="git-change-side">
              <span className="git-change-state">{buildGitChangeStateLabel(change)}</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function GitWorkbench({
  loadState,
  state,
  updateWorkspaceData
}: {
  loadState: LazyLoadState;
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
}): React.JSX.Element {
  const [commitMessage, setCommitMessage] = useState('');
  const [pendingAction, setPendingAction] = useState<
    'refresh' | 'stage' | 'unstage' | 'stage-batch' | 'discard' | 'commit' | 'push' | 'branch-create' | 'branch-checkout' | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [branchDraft, setBranchDraft] = useState('');
  const [checkoutAfterCreate, setCheckoutAfterCreate] = useState(true);
  const [branchTarget, setBranchTarget] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false);
  const [gitPaneWidth, setGitPaneWidth] = useState(GIT_SPLIT_DEFAULT_WIDTH);
  const diffParseCacheRef = useRef(new Map<string, GitDiffFileData[]>());

  const changes = state.gitStatus === null ? [] : gitStatusChanges(state.gitStatus);
  const selectedPath = findNextGitSelection(changes, state.gitSelectedPath);
  const selectedChange = selectedPath === null ? null : changes.find((change) => change.relativePath === selectedPath) ?? null;
  const branchInfo = state.gitBranches;
  const currentBranch = branchInfo?.currentBranch ?? state.gitStatus?.branch ?? '';
  const selectableChanges = changes;
  const selectedPathSet = new Set(selectedPaths);
  const { allSelectableSelected, selectedCount } = buildGitSelectionModel(selectableChanges, selectedPaths);

  useEffect(() => {
    if (state.gitSelectedPath === selectedPath) {
      return;
    }
    if (selectedPath === null) {
      if (state.gitSelectedPath === null && state.gitSelectedPreview === null) {
        return;
      }
      updateWorkspaceData({
        gitSelectedPath: null,
        gitSelectedPreview: null
      });
      return;
    }
    if (state.gitSelectedPath !== selectedPath) {
      updateWorkspaceData({ gitSelectedPath: selectedPath });
    }
  }, [selectedPath, state.gitSelectedPath, state.gitSelectedPreview, updateWorkspaceData]);

  useEffect(() => {
    if (changes.length === 0) {
      if (selectedPaths.length > 0) {
        setSelectedPaths([]);
      }
      return;
    }
    const available = new Set(changes.map((change) => change.relativePath));
    const nextSelected = selectedPaths.filter((relativePath) => available.has(relativePath));
    if (nextSelected.length === selectedPaths.length) {
      return;
    }
    setSelectedPaths(nextSelected);
  }, [changes, selectedPaths]);

  useEffect(() => {
    if (branchInfo === null) {
      if (branchTarget !== '') {
        setBranchTarget('');
      }
      return;
    }
    if (branchTarget === '' || !branchInfo.branches.some((branch) => branch.name === branchTarget)) {
      setBranchTarget(branchInfo.currentBranch);
    }
  }, [branchInfo, branchTarget]);

  const selectionFiles = useMemo<GitDiffFileData[]>(() => {
    if (state.gitSelectedPreview === null) {
      return [];
    }
    const cacheKey = buildGitDiffCacheKey(state.gitSelectedPreview);
    const cachedFiles = diffParseCacheRef.current.get(cacheKey);
    if (cachedFiles !== undefined) {
      return cachedFiles;
    }
    const normalized = normalizeGitDiffText(state.gitSelectedPreview.patch);
    const files = parseDiff(normalized, { nearbySequences: 'zip' });
    diffParseCacheRef.current.set(cacheKey, files);
    return files;
  }, [state.gitSelectedPreview]);
  const selectedDiffFile = useMemo(() => {
    if (selectedChange === null || state.gitSelectedPreview === null) {
      return null;
    }
    return selectGitDiffFile(selectionFiles, selectedChange.relativePath);
  }, [selectionFiles, selectedChange, state.gitSelectedPreview]);

  async function selectGitFile(relativePath: string): Promise<void> {
    updateWorkspaceData({
      gitSelectedPath: relativePath,
      gitSelectedPreview: null
    });
    try {
      const preview = unwrap<GitFileDiffResult>('git selected file diff', await window.roc.git.fileDiff({ relativePath }));
      updateWorkspaceData({
        gitSelectedPath: relativePath,
        gitSelectedPreview: preview
      });
    } catch (selectionError) {
      setActionError(selectionError instanceof Error ? selectionError.message : '当前 Git Diff 加载失败。');
      updateWorkspaceData({
        gitSelectedPath: relativePath,
        gitSelectedPreview: null
      });
    }
  }

  async function applyGitStatusResult(status: GitStatusResult, preferredPath: string | null): Promise<void> {
    const nextSelectedPath = findNextGitSelection(status.changes, preferredPath);
    updateWorkspaceData({
      gitStatus: status,
      gitError: null,
      gitSelectedPath: nextSelectedPath,
      gitSelectedPreview: nextSelectedPath === preferredPath ? state.gitSelectedPreview : null
    });
    if (nextSelectedPath === null) {
      updateWorkspaceData({ gitSelectedPreview: null });
      return;
    }
    try {
      const preview = unwrap<GitFileDiffResult>('git selected file diff', await window.roc.git.fileDiff({ relativePath: nextSelectedPath }));
      updateWorkspaceData({
        gitSelectedPath: nextSelectedPath,
        gitSelectedPreview: preview
      });
    } catch (selectionError) {
      setActionError(selectionError instanceof Error ? selectionError.message : '当前 Git Diff 加载失败。');
      updateWorkspaceData({
        gitSelectedPath: nextSelectedPath,
        gitSelectedPreview: null
      });
    }
  }

  function applyBranchMutationResult(result: GitBranchMutationResult): void {
    updateWorkspaceData({
      gitBranches: result.branchInfo
    });
  }

  function toggleSelectedPath(relativePath: string, checked: boolean): void {
    setSelectedPaths((current) => {
      if (checked) {
        return current.includes(relativePath) ? current : [...current, relativePath];
      }
      return current.filter((path) => path !== relativePath);
    });
  }

  function selectAllGitChangesAction(): void {
    setSelectedPaths(selectAllGitChanges(selectableChanges));
  }

  function clearSelectedGitChanges(): void {
    setSelectedPaths([]);
  }

  async function refreshGitWorkspace(): Promise<void> {
    const [gitStatus, branches] = await Promise.all([window.roc.git.status(), window.roc.git.listBranches()]);
    if (gitStatus.ok && branches.ok) {
      updateWorkspaceData({
        gitBranches: branches.data
      });
      await applyGitStatusResult(gitStatus.data, state.gitSelectedPath);
      return;
    }
    const message = !gitStatus.ok ? gitStatus.error.message : !branches.ok ? branches.error.message : 'Git 状态刷新失败。';
    updateWorkspaceData({
      gitStatus: gitStatus.ok ? gitStatus.data : null,
      gitBranches: branches.ok ? branches.data : null,
      gitError: message,
      gitSelectedPath: null,
      gitSelectedPreview: null
    });
    setActionError(message);
  }

  async function refreshGitStatus(): Promise<void> {
    setPendingAction('refresh');
    setActionError(null);
    await refreshGitWorkspace();
    setPendingAction(null);
  }

  async function stageSelectedFiles(): Promise<void> {
    setPendingAction('stage-batch');
    setActionError(null);
    const result = await window.roc.git.stageFiles({ relativePaths: selectedPaths });
    if (result.ok) {
      await applyGitStatusResult(result.data, state.gitSelectedPath);
    } else {
      updateWorkspaceData({ gitError: result.error.message });
      setActionError(result.error.message);
    }
    setPendingAction(null);
  }

  async function commitChanges(): Promise<void> {
    if (!commitButtonState.enabled) {
      return;
    }
    setPendingAction('commit');
    setActionError(null);
    const result = await window.roc.git.commit({ message: commitMessage });
    if (result.ok) {
      updateWorkspaceData({
        gitStatus: result.data.status,
        gitError: null,
        gitSelectedPath: null,
        gitSelectedPreview: null,
        gitLastCommit: result.data
      });
      setSelectedPaths([]);
      setCommitMessage('');
    } else {
      updateWorkspaceData({ gitError: result.error.message });
      setActionError(result.error.message);
    }
    setPendingAction(null);
  }

  async function pushChanges(): Promise<void> {
    setPendingAction('push');
    setActionError(null);
    const result = await window.roc.git.push();
    if (result.ok) {
      updateWorkspaceData({
        gitLastPush: result.data
      });
      await applyGitStatusResult(result.data.status, state.gitSelectedPath);
    } else {
      updateWorkspaceData({ gitError: result.error.message });
      setActionError(result.error.message);
    }
    setPendingAction(null);
  }

  async function createBranch(): Promise<void> {
    const gitStatus = state.gitStatus;
    if (gitStatus === null) {
      return;
    }
    const branchName = branchDraft.trim();
    const workspacePath = gitStatus.workspacePath;
    if (
      !window.confirm(
        checkoutAfterCreate
          ? `确认在工作区 ${workspacePath} 创建并切换到分支 ${branchName} 吗？`
          : `确认在工作区 ${workspacePath} 创建分支 ${branchName} 吗？`
      )
    ) {
      return;
    }
    setPendingAction('branch-create');
    setActionError(null);
    const result = await window.roc.git.createBranch({
      name: branchName,
      checkoutAfterCreate
    });
    if (result.ok) {
      applyBranchMutationResult(result.data);
      setBranchTarget(result.data.branchInfo.currentBranch);
      setBranchDraft('');
      await applyGitStatusResult(result.data.status, state.gitSelectedPath);
    } else {
      updateWorkspaceData({ gitError: result.error.message });
      setActionError(result.error.message);
    }
    setPendingAction(null);
  }

  async function checkoutBranch(): Promise<void> {
    await checkoutNamedBranch(branchTarget);
  }

  async function checkoutNamedBranch(targetBranch: string): Promise<void> {
    const gitStatus = state.gitStatus;
    if (gitStatus === null) {
      return;
    }
    if (targetBranch.length === 0 || targetBranch === currentBranch) {
      return;
    }
    const workspacePath = gitStatus.workspacePath;
    if (!window.confirm(`确认在工作区 ${workspacePath} 切换到分支 ${targetBranch} 吗？`)) {
      return;
    }
    setPendingAction('branch-checkout');
    setActionError(null);
    const result = await window.roc.git.checkoutBranch({ name: targetBranch });
    if (result.ok) {
      applyBranchMutationResult(result.data);
      setBranchTarget(result.data.branchInfo.currentBranch);
      setBranchSwitcherOpen(false);
      await applyGitStatusResult(result.data.status, state.gitSelectedPath);
    } else {
      updateWorkspaceData({ gitError: result.error.message });
      setActionError(result.error.message);
    }
    setPendingAction(null);
  }

  function startGitPaneResize(event: React.PointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = gitPaneWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      setGitPaneWidth(clampGitSplitWidth(startWidth + moveEvent.clientX - startX));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  if (state.workspace === null) {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-git-empty" title="未选择工作区" />
      </section>
    );
  }

  if (loadState.status === 'loading') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-git-loading" title="Git 工作台加载中" tone="loading" />
      </section>
    );
  }

  if (loadState.status === 'error') {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-git-load-error" title="Git 工作台加载失败" tone="error" />
      </section>
    );
  }

  if (state.gitStatus === null) {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState
          testId="workbench-git-empty"
          title="当前工作区不是 Git 仓库"
          tone="error"
        />
      </section>
    );
  }

  const stagedCount = gitStatusChanges(state.gitStatus).filter((change) => canUnstageGitChange(change)).length;
  const dirtyCount = gitStatusChanges(state.gitStatus).filter((change) => change.worktree !== ' ').length;
  const actionBusy = pendingAction !== null;
  const commitButtonState = buildGitCommitButtonState({
    actionBusy,
    changedFiles: state.gitStatus.changedFiles,
    commitMessage
  });
  const branchSwitcherModel = buildGitBranchSwitcherModel({
    actionBusy,
    branchInfo,
    branchSearch
  });
  const visibleBranches = branchSwitcherModel.visibleBranches;
  const selectionStatus = selectedChange === null ? null : buildGitChangeStateLabel(selectedChange);
  const selectionPreview = state.gitSelectedPreview;
  const selectionPreviewPanel =
    selectedChange === null ? (
      <div className="git-selection-empty" data-testid="workbench-git-selection">
        <strong>尚未选中文件</strong>
        <p>{gitSelectionEmptyMessage(state)}</p>
      </div>
    ) : selectionPreview === null ? (
      <div className="git-selection-empty" data-testid="workbench-git-selection">
        <strong>{selectedChange.relativePath}</strong>
        <p>正在读取当前文件 diff。</p>
      </div>
    ) : selectedDiffFile === null ? (
      <div className="git-selection-empty" data-testid="workbench-git-selection">
        <strong>{selectedChange.relativePath}</strong>
        <p>当前文件没有可显示的 diff。</p>
      </div>
    ) : (
      <div className="git-diff-panel" data-testid="workbench-git-selection">
        <div className="git-diff-header">
          <div className="git-diff-titleblock">
            <div className="git-selection-title" data-testid="workbench-git-selection-path">
              {selectedChange.relativePath}
            </div>
            <div className="git-selection-subtitle">{selectionStatus}</div>
          </div>
          <span className="selection-chip active">{selectionStatus}</span>
        </div>
        <div className="git-diff-toolbar">
          <span>{buildGitDiffTitle(selectedDiffFile)}</span>
          <span>{selectedDiffFile.type}</span>
        </div>
        <div className="git-diff-body">
          <div className="git-diff-scroll" data-testid="workbench-git-selection-preview">
            <Diff
              diffType={selectedDiffFile.type}
              hunks={selectedDiffFile.hunks}
              viewType="unified"
            >
              {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
            </Diff>
          </div>
        </div>
      </div>
    );

  return (
    <section className="tool-panel workbench-surface workbench-surface--git">
      <div className="workbench-git workbench-git--split" style={{ '--git-pane-width': `${gitPaneWidth}px` } as React.CSSProperties}>
        <aside className="git-sidebar">
          <header className="git-header">
            <textarea
              className="git-commit-message"
              data-testid="workbench-git-commit-message"
              disabled={actionBusy}
              placeholder="Commit message..."
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
            <button
              className={commitButtonState.enabled ? 'git-commit-button git-commit-button--ready' : 'git-commit-button'}
              data-testid="workbench-git-commit"
              disabled={!commitButtonState.enabled}
              type="button"
              onClick={() => void commitChanges()}
            >
              ✓ Commit ({state.gitStatus.changedFiles} files)
            </button>
          </header>
          <section className="git-changes-pane" data-testid="workbench-git-changes">
            <div className="git-section-header git-section-header--staged">
              <span>STAGED CHANGES</span>
              <span className="git-section-count">{stagedCount}</span>
            </div>
            <GitChangeList
              actionBusy={actionBusy}
              changes={changes.filter((change) => canUnstageGitChange(change))}
              emptyText="No staged changes."
              selectable={false}
              selectedPath={selectedPath}
              selectedPathSet={selectedPathSet}
              title="Staged Changes"
              onSelectGitFile={selectGitFile}
              onToggleSelectedPath={toggleSelectedPath}
            />
            <div className="git-section-header">
              <span>CHANGES</span>
              <span className="git-section-count">{state.gitStatus.changedFiles - stagedCount}</span>
              <button
                className="git-stage-all-button"
                data-testid="git-select-all"
                disabled={actionBusy || selectableChanges.length === 0 || allSelectableSelected}
                type="button"
                onClick={selectAllGitChangesAction}
              >
                ALL
              </button>
            </div>
            <div className="git-batch-actions">
              <button
                className="action-button action-button--git-secondary"
                data-testid="git-clear-selection"
                disabled={actionBusy || selectedCount === 0}
                type="button"
                onClick={clearSelectedGitChanges}
              >
                清空选择
              </button>
              <button
                className="action-button action-button--git"
                data-testid="git-stage-selected"
                disabled={actionBusy || selectedCount === 0}
                type="button"
                onClick={() => void stageSelectedFiles()}
              >
                批量暂存
              </button>
              <span data-testid="git-selected-count">{selectedCount} selected</span>
            </div>
            <GitChangeList
              actionBusy={actionBusy}
              changes={changes.filter((change) => !canUnstageGitChange(change))}
              emptyText="Workspace is clean."
              selectable
              selectedPath={selectedPath}
              selectedPathSet={selectedPathSet}
              title="Changes"
              onSelectGitFile={selectGitFile}
              onToggleSelectedPath={toggleSelectedPath}
            />
          </section>
          <footer className="git-sidebar-statusbar">
            <button
              className="git-branch-status"
              data-testid="git-current-branch"
              disabled={actionBusy}
              type="button"
              onClick={() => setBranchSwitcherOpen((current) => !current)}
            >
              <GitBranch size={15} />
              <span>{currentBranch}</span>
            </button>
            <button
              className="git-status-refresh"
              aria-label="刷新 Git 状态"
              disabled={actionBusy}
              type="button"
              onClick={() => void refreshGitStatus()}
            >
              <RefreshCw size={15} />
            </button>
            <span className="git-sync-stat">↓ {stagedCount}</span>
            <span className="git-sync-stat">↑ {dirtyCount}</span>
          </footer>
          {branchSwitcherOpen ? (
            <section className="git-branch-popover" data-testid="git-branch-controls">
              <div className="git-branch-popover-head">
                <strong>SWITCH BRANCH</strong>
                <button type="button" onClick={() => setBranchSwitcherOpen(false)}>
                  ×
                </button>
              </div>
              <input
                className="git-branch-search"
                data-testid="git-branch-select"
                disabled={actionBusy}
                placeholder="Search branches..."
                value={branchSearch}
                onChange={(event) => setBranchSearch(event.target.value)}
              />
              <div className="git-branch-list">
                {visibleBranches.map((branch) => (
                  <button
                    className={branch.current ? 'git-branch-option active' : 'git-branch-option'}
                    key={branch.name}
                    type="button"
                    onClick={() => {
                      setBranchTarget(branch.name);
                      void checkoutNamedBranch(branch.name);
                    }}
                  >
                    <GitBranch size={15} />
                    <span>{branch.name}</span>
                    {branch.current ? <strong>•</strong> : null}
                  </button>
                ))}
              </div>
              <div className="git-branch-create-row">
                <input
                  className="git-branch-search"
                  data-testid="git-branch-create-input"
                  disabled={actionBusy}
                  placeholder="new branch name"
                  value={branchDraft}
                  onChange={(event) => setBranchDraft(event.target.value)}
                />
                <label className="git-branch-checkbox">
                  <input
                    checked={checkoutAfterCreate}
                    data-testid="git-branch-create-checkout"
                    disabled={actionBusy}
                    type="checkbox"
                    onChange={(event) => setCheckoutAfterCreate(event.target.checked)}
                  />
                  checkout
                </label>
                <button
                  className="git-branch-create-button"
                  data-testid="git-branch-create"
                  disabled={actionBusy || branchDraft.trim().length === 0}
                  type="button"
                  onClick={() => void createBranch()}
                >
                  Create
                </button>
              </div>
            </section>
          ) : null}
        </aside>
        <div
          aria-label="调节 Git 面板宽度"
          className="workbench-git-splitter"
          data-testid="workbench-git-splitter"
          role="separator"
          tabIndex={0}
          onPointerDown={startGitPaneResize}
        />
        <section className="git-detail-pane">
          {actionError === null ? null : (
            <span className="inline-warning" data-testid="workbench-git-action-error">
              {actionError}
            </span>
          )}
          <div className="git-selection-slot">{selectionPreviewPanel}</div>
          {state.gitLastCommit === null && state.gitLastPush === null ? null : (
            <div className="git-last-result">
              {state.gitLastCommit === null ? null : <span>最近提交：{state.gitLastCommit.commitMessage}</span>}
              {state.gitLastPush === null ? null : <span>最近 Push：{state.gitLastPush.remoteName}/{state.gitLastPush.branch}</span>}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function TerminalWorkbench({
  state,
  updateWorkspaceData,
  windowState: _windowState
}: {
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
  windowState: WindowStateSnapshot;
}): React.JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSessionSnapshot | null>(null);

  useEffect(() => {
    if (state.workspace === null || terminalHostRef.current === null) {
      updateWorkspaceData({
        terminalSession: null,
        terminalError: state.workspace === null ? '请先选择工作区。' : null
      });
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0,
      scrollback: 5000,
      allowProposedApi: true,
      minimumContrastRatio: 4.5,
      theme: {
        background: '#0b121f',
        foreground: '#dce4ef',
        cursor: '#7aa7ff',
        cursorAccent: '#0b121f',
        selectionBackground: 'rgba(122, 167, 255, 0.28)',
        black: '#1f2430',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#e5c07b',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#dce4ef',
        brightBlack: '#5c6773',
        brightRed: '#ef8a96',
        brightGreen: '#b4d39a',
        brightYellow: '#f0d399',
        brightBlue: '#82c0f5',
        brightMagenta: '#d7a3e8',
        brightCyan: '#7fcdd5',
        brightWhite: '#ffffff'
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    fitAddon.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let disposed = false;

    const onOutputDispose = window.roc.terminal.onOutput((event: TerminalSessionOutputEvent) => {
      if (event.sessionId !== sessionRef.current?.id) {
        return;
      }
      terminal.write(event.data);
    });
    const onExitDispose = window.roc.terminal.onExit((event: TerminalSessionExitEvent) => {
      if (event.sessionId !== sessionRef.current?.id) {
        return;
      }
      updateWorkspaceData({
        terminalSession: sessionRef.current === null
          ? null
          : {
              ...sessionRef.current,
              status: 'exited',
              exitCode: event.exitCode
            },
        terminalError: `终端会话已退出，退出码 ${event.exitCode}。`
      });
      terminal.write(`\r\n[session exited: ${event.exitCode}]\r\n`);
    });

    void window.roc.terminal
      .createSession({
        cwd: state.workspace.path,
        cols: Math.max(80, Math.floor((terminalHostRef.current.clientWidth || 720) / 9)),
        rows: Math.max(24, Math.floor((terminalHostRef.current.clientHeight || 420) / 18))
      })
      .then((result) => {
        if (!result.ok || disposed) {
          if (!result.ok) {
            updateWorkspaceData({ terminalSession: null, terminalError: result.error.message });
          }
          return;
        }
        sessionRef.current = result.data;
        updateWorkspaceData({ terminalSession: result.data, terminalError: null });
        fitAddon.fit();
        const nextCols = Math.max(20, terminal.cols);
        const nextRows = Math.max(5, terminal.rows);
        void window.roc.terminal.resize({
          sessionId: result.data.id,
          cols: nextCols,
          rows: nextRows
        }).then((resizeResult) => {
          if (resizeResult.ok && sessionRef.current?.id === resizeResult.data.id) {
            sessionRef.current = resizeResult.data;
            updateWorkspaceData({ terminalSession: resizeResult.data });
          }
        });
      });

    const resizeObserver = new ResizeObserver(() => {
      if (terminalRef.current === null || fitAddonRef.current === null) {
        return;
      }
      fitAddonRef.current.fit();
      if (sessionRef.current === null) {
        return;
      }
      void window.roc.terminal.resize({
        sessionId: sessionRef.current.id,
        cols: Math.max(20, terminalRef.current.cols),
        rows: Math.max(5, terminalRef.current.rows)
      }).then((result) => {
        if (result.ok && sessionRef.current?.id === result.data.id) {
          sessionRef.current = result.data;
          updateWorkspaceData({ terminalSession: result.data });
        }
      });
    });
    resizeObserver.observe(terminalHostRef.current);

    const keyDisposable = terminal.onData((data) => {
      if (sessionRef.current === null) {
        return;
      }
      void window.roc.terminal.writeInput({
        sessionId: sessionRef.current.id,
        data
      });
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      keyDisposable.dispose();
      onOutputDispose();
      onExitDispose();
      const sessionId = sessionRef.current?.id;
      if (sessionId !== undefined) {
        void window.roc.terminal.closeSession({ sessionId });
      }
      sessionRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [state.workspace?.path, updateWorkspaceData]);

  if (state.workspace === null) {
    return (
      <section className="tool-panel workbench-surface">
        <EmptyState testId="workbench-terminal-empty" title="未选择工作区" />
      </section>
    );
  }

  const terminalStatusLabel = state.terminalSession === null ? 'starting' : state.terminalSession.status;
  const terminalFooterStatus = state.terminalError;

  return (
    <section className="tool-panel workbench-surface workbench-surface--terminal">
      <div className="workbench-terminal">
        <div className="terminal-shell-frame">
          <div className="terminal-shell-topline">
            <span className="terminal-dot terminal-dot--danger" />
            <span className="terminal-dot terminal-dot--warn" />
            <span className="terminal-dot terminal-dot--ok" />
            <span className="terminal-shell-title">{state.terminalSession?.shell ?? 'PowerShell'}</span>
          </div>
          <div className="terminal-xterm-shell" data-testid="terminal-session-surface">
            <div ref={terminalHostRef} className="terminal-xterm-host" data-testid="terminal-xterm" />
          </div>
        </div>
        <footer className="workbench-footer-bar terminal-status-bar">
          <span data-role="path">{state.terminalSession?.cwd ?? state.workspace.path}</span>
          {terminalFooterStatus === null ? null : <span data-role="status" data-state={terminalStatusLabel}>{terminalFooterStatus}</span>}
        </footer>
      </div>
    </section>
  );
}

function AgentCapabilityPreviewPanel({ preview }: { preview: AgentCapabilityPreview }): React.JSX.Element {
  return (
    <section className="card agent-preview" data-testid="agent-capability-preview">
      <div className="card-title">Agent 能力预览</div>
      <div className="grid-2 compact-grid">
        <ToolRow label="模型" value={preview.modelId} tone="ok" />
        <ToolRow label="不可信上下文" value={preview.untrustedContextPolicy} tone="warn" />
        <ToolRow label="MCP" value={preview.selectedCapabilities.mcpServers.join(', ')} />
        <ToolRow label="Skills" value={preview.selectedCapabilities.skills.join(', ')} />
      </div>
      <div className="capability-card-grid" data-testid="agent-tool-cards">
        {[...preview.toolCards, ...preview.skillCards].map((card) => (
          <div className="capability-card" key={card.id}>
            <strong>{card.name}</strong>
            <span>{card.capabilityType}</span>
            <small>{card.scope} · {card.riskLevel} · {card.auditCategory}</small>
            <small>{card.untrustedContext ? '不可信上下文' : '受控上下文'}</small>
          </div>
        ))}
      </div>
      <div className="capability-card-grid" data-testid="agent-subagents">
        {preview.subagents.map((subagent) => (
          <div className="capability-card" key={subagent.id}>
            <strong>{subagent.name}</strong>
            <span>{subagent.purpose}</span>
            <small>{subagent.inheritsSkills ? 'inherits skills' : 'does not inherit skills'}</small>
          </div>
        ))}
      </div>
      {preview.skippedCapabilities.length === 0 ? null : (
        <div className="notice" data-testid="agent-skipped-capabilities">
          {preview.skippedCapabilities.map((item) => `${item.type}:${item.id}:${item.reason}`).join(', ')}
        </div>
      )}
    </section>
  );
}

function ChatResultPanel({ result }: { result: ChatSubmitResult }): React.JSX.Element {
  const taskMeta = result.status === 'task_answered' ? `${result.threadId} / ${result.runId}` : '普通聊天';
  return (
    <div className="chat-result-card" data-testid="chat-result">
      <div className="chat-result-header">
        <strong data-testid="chat-result-status">{result.status}</strong>
        <span data-testid="chat-result-model">
          {result.providerId} / {result.modelId}
        </span>
      </div>
      <p data-testid="chat-result-message">{result.assistantMessage}</p>
      <div className="chat-result-meta">
        <span>{taskMeta}</span>
        <span>{result.durationMs} ms</span>
        <span>{result.summary}</span>
      </div>
    </div>
  );
}

function DiagnosticPackagePanel({ diagnosticPackage }: { diagnosticPackage: DiagnosticPackage | null }): React.JSX.Element {
  return (
    <section className="card" data-testid="diagnostic-package-status">
      <div className="card-title">诊断包</div>
      {diagnosticPackage === null ? (
        <p className="muted">尚未生成诊断包。</p>
      ) : (
        <>
          <Row title="任务" sub={diagnosticPackage.taskId} tag={diagnosticPackage.id} tone="info" />
          <Row title="脱敏" sub={diagnosticPackage.redacted ? '通过' : '未通过'} tag={diagnosticPackage.redacted ? '通过' : '失败'} tone={diagnosticPackage.redacted ? 'ok' : 'bad'} />
          <Row title="包含项" sub={diagnosticPackage.includes.join(', ')} tag="task_snapshot" tone="ok" />
          <Row title="路径" sub={diagnosticPackage.path} tag="本地" tone="info" />
        </>
      )}
    </section>
  );
}

function PerformancePanel({ performanceSample }: { performanceSample: PerformanceSample }): React.JSX.Element {
  return (
    <section className="card" data-testid="performance-sample">
      <div className="card-title">性能采样</div>
      <Row title="RSS" sub={`${performanceSample.rssMb} MB`} tag={performanceSample.exceedsBudget ? '超预算' : '正常'} tone={performanceSample.exceedsBudget ? 'warn' : 'ok'} />
      <Row title="Heap" sub={`${performanceSample.heapUsedMb} / ${performanceSample.heapTotalMb} MB`} tag="sample" tone="info" />
      <Row title="预算" sub={`${performanceSample.memoryBudgetMb} MB`} tag={performanceSample.mode} tone="info" />
    </section>
  );
}

function FieldPreview({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="field-box">
        <span>{value}</span>
        <span>▾</span>
      </div>
    </div>
  );
}

function PageHeading({
  flags,
  kicker,
  title
}: {
  flags?: React.ReactNode;
  kicker: string;
  title: string;
}): React.JSX.Element {
  return (
    <div className="page-strip">
      <div className="page-copy">
        <div className="page-kicker">{kicker}</div>
        <h1 className="page-title">{title}</h1>
      </div>
      <div className="page-flags">
        {flags ?? (
          <>
            <CompactStatusPill tone="ok" value="工作区内" />
            <CompactStatusPill tone="info" value="右侧图标栏展开" />
          </>
        )}
      </div>
    </div>
  );
}

function PreviewIcon({ name }: { name: PreviewIconName }): React.JSX.Element {
  switch (name) {
    case 'clipboard':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6" y="5" width="12" height="15" rx="2"></rect>
          <path d="M9 5.5h6"></path>
          <path d="M9 10h6"></path>
          <path d="M9 14h4"></path>
        </svg>
      );
    case 'checklist':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 5h12"></path>
          <path d="M6 12h12"></path>
          <path d="M6 19h12"></path>
          <path d="M9 5.5l1.2 1.2L12.5 4.4"></path>
          <path d="M9 12.5l1.2 1.2L12.5 11.4"></path>
          <path d="M9 19.5l1.2 1.2L12.5 18.4"></path>
        </svg>
      );
    case 'panel-capture':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="5" width="16" height="14" rx="3"></rect>
          <path d="M8 9h8"></path>
          <path d="M8 13h5"></path>
          <path d="M15.5 14.5l2 2"></path>
        </svg>
      );
    case 'tray-upload':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 15.5v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"></path>
          <path d="M12 5v10"></path>
          <path d="M8.5 8.5L12 5l3.5 3.5"></path>
          <path d="M7 15h10"></path>
        </svg>
      );
    case 'git':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="6" r="2"></circle>
          <circle cx="18" cy="4.5" r="2"></circle>
          <circle cx="18" cy="19.5" r="2"></circle>
          <path d="M7.8 7.2l8.4-1.7"></path>
          <path d="M7.8 7.2l8.4 10.1"></path>
        </svg>
      );
    case 'globe':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M3 12h18"></path>
          <path d="M12 3c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9s1.5-6.6 4-9z"></path>
        </svg>
      );
    case 'history':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7"></path>
          <path d="M3 4v5h5"></path>
          <path d="M12 7v5l3 2"></path>
        </svg>
      );
    case 'nodes':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="6" r="2"></circle>
          <circle cx="18" cy="6" r="2"></circle>
          <circle cx="12" cy="18" r="2"></circle>
          <path d="M7.6 7.2l2.8 8"></path>
          <path d="M16.4 7.2l-2.8 8"></path>
          <path d="M8 6h8"></path>
        </svg>
      );
    case 'paperclip':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8.5 12.5l6.8-6.8a3.2 3.2 0 1 1 4.5 4.5l-9.2 9.2a5 5 0 1 1-7.1-7.1l8.9-8.9"></path>
        </svg>
      );
    case 'panel-right':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2"></rect>
          <path d="M15 4v16"></path>
        </svg>
      );
    case 'bot':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="7" width="14" height="11" rx="4"></rect>
          <path d="M12 4v3"></path>
          <circle cx="9.5" cy="12" r="1"></circle>
          <circle cx="14.5" cy="12" r="1"></circle>
        </svg>
      );
    case 'eye':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      );
    case 'send':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 11.5l15-7-4.8 15-2.7-5.1z"></path>
          <path d="M19 4.5L11.4 14.4"></path>
        </svg>
      );
    case 'sparkles':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"></path>
          <path d="M19 3v4"></path>
          <path d="M21 5h-4"></path>
        </svg>
      );
    case 'stethoscope':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4v5a4 4 0 0 0 8 0V4"></path>
          <path d="M7 4H5"></path>
          <path d="M17 4h2"></path>
          <path d="M15 13v2a4 4 0 0 0 8 0v-1.5"></path>
          <circle cx="21" cy="12" r="2"></circle>
        </svg>
      );
    case 'terminal':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7l4 4-4 4"></path>
          <path d="M11 17h9"></path>
        </svg>
      );
    case 'wrench':
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14.5 6.5a4 4 0 0 0 3.5 5.8l-8.2 8.2a2 2 0 0 1-2.8-2.8l8.2-8.2a4 4 0 0 0-5.8-3.5l2.2 2.2-2.3 2.3-2.2-2.2a4 4 0 0 1 7.4-1.8z"></path>
        </svg>
      );
    case 'folder':
    default:
      return (
        <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7.5h5l2 2h11v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
          <path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h4"></path>
        </svg>
      );
  }
}

function StatusPill({
  label,
  value,
  tone = 'neutral'
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
}): React.JSX.Element {
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-dot"></span>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function CompactStatusPill({
  tone = 'neutral',
  value
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
  value: string;
}): React.JSX.Element {
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-dot"></span>
      <span>{value}</span>
    </span>
  );
}

function TraySummaryPanel({ traySummary }: { traySummary: TraySummary }): React.JSX.Element {
  return (
    <section className="card" data-testid="tray-summary">
      <div className="card-title">托盘摘要</div>
      <Row title="常驻" sub={traySummary.residentEnabled ? '已启用' : '未启用'} tag="resident" tone="ok" />
      <Row title="后台执行" sub={traySummary.backgroundPaused ? '已暂停' : '运行中'} tag={`${traySummary.backgroundTasks.total} tasks`} tone={traySummary.backgroundPaused ? 'warn' : 'ok'} />
      <Row title="下次运行" sub={traySummary.nextRunAt === null ? '无' : traySummary.nextRunAt} tag="schedule" tone="info" />
    </section>
  );
}

function Metric({
  label,
  note,
  tone = 'neutral',
  value
}: {
  label: string;
  note: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad';
  value: number | string;
}): React.JSX.Element {
  const toneClass = tone === 'neutral' ? '' : ` metric--${tone}`;
  return (
    <div className={`metric${toneClass}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      <small>{note}</small>
    </div>
  );
}

function Row({
  sub,
  tag,
  title,
  tone = 'neutral'
}: {
  sub?: string;
  tag: string;
  title: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
}): React.JSX.Element {
  return (
    <div className="row">
      <div>
        <div className="row-title">{title}</div>
        {sub === undefined ? null : <div className="row-sub">{sub}</div>}
      </div>
      <span className={`pill ${tone}`}>{tag}</span>
    </div>
  );
}

function ToolRow({
  label,
  value,
  tone = 'neutral'
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
}): React.JSX.Element {
  return (
    <div className={`tool-row ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TreeItem({
  active = false,
  depth = 0,
  expanded = false,
  entry,
  loading = false,
  onClick
}: {
  active?: boolean;
  depth?: number;
  expanded?: boolean;
  entry: FileTreeResult['entries'][number];
  loading?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const className = active ? 'tree-item selected' : 'tree-item';
  const label = fileLabel(entry.relativePath);
  const expander = entry.type === 'directory' ? (loading ? '…' : expanded ? '▾' : '▸') : null;
  const icon = fileTreeIcon(entry, active, expanded);
  if (onClick !== undefined) {
    return (
      <button
        className={className}
        data-testid={`${entry.type === 'directory' ? 'workbench-directory' : 'workbench-file'}-${sanitizeTestId(entry.relativePath)}`}
        style={{ paddingLeft: `${14 + depth * 16}px` }}
        type="button"
        onClick={onClick}
      >
        <span className="tree-item-expander">{expander}</span>
        <span className="tree-item-icon">{icon}</span>
        <span className="tree-item-label">{label}</span>
      </button>
    );
  }
  return (
    <div className={className} style={{ paddingLeft: `${14 + depth * 16}px` }}>
      <span className="tree-item-expander">{expander}</span>
      <span className="tree-item-icon">{icon}</span>
      <span className="tree-item-label">{label}</span>
    </div>
  );
}

function PreviewTreeItem({
  iconText,
  label,
  selected = false
}: {
  iconText: string;
  label: string;
  selected?: boolean;
}): React.JSX.Element {
  return (
    <div className={selected ? 'tree-item selected' : 'tree-item'}>
      <span>{iconText}</span>
      <span>{label}</span>
    </div>
  );
}

function EmptyState({
  action,
  title,
  testId,
  tone = 'idle'
}: {
  action?: React.ReactNode;
  title: string;
  testId: string;
  tone?: 'idle' | 'loading' | 'error';
}): React.JSX.Element {
  const Icon = tone === 'loading' ? RefreshCw : CircleAlert;
  return (
    <div className={`empty-state empty-state--${tone}`} data-testid={testId}>
      <span className="empty-state-icon">
        <Icon size={24} />
      </span>
      <strong>{title}</strong>
      {action}
    </div>
  );
}

function sumMcpTools(servers: McpServerSnapshot[]): number {
  return servers.reduce((total, server) => total + server.tools, 0);
}
