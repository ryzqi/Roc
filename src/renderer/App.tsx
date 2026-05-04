import {
  CircleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
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
  GitStatusChange,
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
  ShellExecutionResult,
  SkillSnapshot,
  TaskSnapshot,
  TraySummary,
  WindowStateSnapshot,
  Workspace
} from '../shared/types';

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

type HistoryRecord = {
  id: string;
  label: string;
  meta: string;
  icon: PreviewIconName;
  activeWhen?: ViewId;
  action?: () => void;
};

type PageMeta = {
  title: string;
  subtitle: string;
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
  gitError: string | null;
  terminalResult: ShellExecutionResult | null;
  terminalError: string | null;
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
  gitError: string | null;
  rtkStatus: RtkStatus;
  terminalResult: ShellExecutionResult | null;
  terminalError: string | null;
};

type IpcLikeResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

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
const WORKBENCH_VIEWS = new Set<ViewId>(['workspace', 'git', 'terminal', 'preview']);

const WORKBENCH_TOOLS: Array<{ id: WorkbenchTool; label: string; icon: PreviewIconName }> = [
  { id: 'files', label: '文件', icon: 'folder' },
  { id: 'git', label: 'Git', icon: 'git' },
  { id: 'terminal', label: '终端', icon: 'terminal' }
];

const PAGE_META: Record<MainViewId, PageMeta> = {
  chat: {
    title: '聊天主页',
    subtitle: '聊天是入口；涉及执行、文件、Git、终端、网页或长期任务时升级为可追踪任务会话。',
    topMeta: '未选择工作区',
    pageLabel: '主会话'
  },
  tasks: {
    title: '任务工作台',
    subtitle: '后台任务、定时任务、执行轮次、追加指令、恢复点和验证结果读取同一任务状态。',
    topMeta: '任务状态',
    pageLabel: '任务控制'
  },
  workspace: {
    title: '工作区文件',
    subtitle: '工作区是默认执行边界；文件浏览、搜索、预览、编辑和高风险操作都进入任务轨迹。',
    topMeta: '文件视图',
    pageLabel: '工作区'
  },
  git: {
    title: 'Git 面板',
    subtitle: '查看状态、diff、历史和提交；push、回滚、批量暂存等动作进入确认策略。',
    topMeta: 'Git 状态',
    pageLabel: '工作区'
  },
  terminal: {
    title: '嵌入式终端',
    subtitle: '终端绑定当前工作区，命令目的、目录、输出、退出状态和风险级别保持可见。',
    topMeta: '终端会话',
    pageLabel: '工作区'
  },
  preview: {
    title: '文件预览',
    subtitle: '文本、代码、Markdown、PDF、Office 和图片按需加载，大文件有明确限制和提示。',
    topMeta: '预览面板',
    pageLabel: '工作区'
  },
  mcp: {
    title: 'MCP',
    subtitle: '统一查看 MCP 服务、MCP 工具、健康、授权和最近调用，异常项继续进入 Doctor 与任务轨迹。',
    topMeta: 'MCP 清单',
    pageLabel: '控制面'
  },
  skills: {
    title: 'Skill',
    subtitle: '统一管理 Skill 能力包、触发条件、依赖、启停状态与最近命中记录。',
    topMeta: 'Skill 清单',
    pageLabel: '控制面'
  },
  memory: {
    title: '记忆中心',
    subtitle: '查看、搜索、筛选、编辑、合并、禁用、恢复、删除、归档和手动触发整理。',
    topMeta: '记忆状态',
    pageLabel: '控制面'
  },
  settings: {
    title: '设置',
    subtitle: '设置作为一级页面，修改先进入草稿态；高影响配置保存前展示影响范围。',
    topMeta: '设置',
    pageLabel: '控制面'
  },
  doctor: {
    title: 'Doctor',
    subtitle: '检查模型、工具、MCP、Skill、工作区、记忆索引、后台队列、托盘和恢复点。',
    topMeta: '诊断摘要',
    pageLabel: '控制面'
  },
  diagnostics: {
    title: '任务诊断包',
    subtitle: '失败任务提供输入、计划、执行轮次、工具调用、关键日志、恢复点和未完成事项。',
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

function syncRendererUrl(view: ViewId, tool: WorkbenchTool): void {
  const url = new URL(window.location.href);
  url.searchParams.set('page', view);
  if (WORKBENCH_VIEWS.has(view)) {
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
      label: '当前主会话',
      meta: `${state.taskSnapshot.recentEvents.filter((event) => event.type === 'message').length} 条消息`,
      icon: 'history'
    }
  ];
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

function buildVisibleTerminalOutput(state: LoadedState): string {
  if (state.terminalResult !== null) {
    return state.terminalResult.stdout;
  }

  return state.terminalError ?? '终端尚未生成输出。';
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
  const result = await window.roc.agent.getCapabilityPreview(enabledCapabilities);
  updateLoadedState({
    selectedMcpServers: enabledCapabilities.mcpServers,
    selectedSkills: enabledCapabilities.skills,
    agentCapabilityPreview: unwrap<AgentCapabilityPreview>('agent capability preview', result)
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
  const [workbenchWidth, setWorkbenchWidth] = useState(560);
  const [windowState, setWindowState] = useState<WindowStateSnapshot>({
    maximized: false,
    minimized: false,
    fullscreen: false
  });

  useEffect(() => {
    return window.roc.app.onNavigate((page) => {
      const view = parseViewId(page);
      if (isFloatingView(view)) {
        return;
      }
      setActiveView(view);
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
      const workspaceData = await loadWorkspaceData(loadedWorkspace);
      const loadedAppStatus = unwrap<AppStatus>('app status', appStatus);
      const memoryData = await loadMemoryData(loadedAppStatus.mode);
      const capabilityData = await loadCapabilityData(loadedAppStatus.mode);
      const phase6Data = await loadPhase6Data(loadedAppStatus.mode);
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
      const agentCapabilityPreview =
        loadedAgent.execution === 'ready'
          ? unwrap<AgentCapabilityPreview>(
              'agent capability preview',
              await window.roc.agent.getCapabilityPreview({
                mcpServers: selectedMcpServers,
                skills: selectedSkills
              })
            )
          : null;

      if (cancelled) {
        return;
      }

      setWindowState(unwrap<WindowStateSnapshot>('window state', loadedWindowState));
      setState({
        appStatus: refreshedAppStatus,
        taskSnapshot: unwrap<TaskSnapshot>('task snapshot', taskSnapshot),
        ...memoryData,
        providers: capabilityData.providers,
        defaultModelId: capabilityData.defaultModelId,
        providerTestStatus: capabilityData.providerTestStatus,
        mcpServers: capabilityData.mcpServers,
        mcpTestStatus: capabilityData.mcpTestStatus,
        skills: capabilityData.skills,
        selectedMcpServers,
        selectedSkills,
        ...phase6Data,
        agent: loadedAgent,
        agentCapabilityPreview,
        chatResult: null,
        workspace: loadedWorkspace,
        rtkStatus: unwrap<RtkStatus>('rtk status', rtkStatus),
        ...workspaceData
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
    setActiveWorkbenchTool(defaultWorkbenchTool(activeView));
  }, [activeView]);

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
    syncRendererUrl(activeView, activeWorkbenchTool);
  }, [activeView, activeWorkbenchTool]);

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

  function updateWorkspaceData(partial: Partial<WorkspaceData>): void {
    setState((current) => (current === null ? current : { ...current, ...partial }));
  }

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
          onOpenView={setActiveView}
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
        />
      </main>
    );
  }

  const hasWorkbench = WORKBENCH_VIEWS.has(activeView);
  const meta = viewMeta(activeView as MainViewId);
  const topMeta = buildTopMeta(activeView as MainViewId, state);
  const historyNavItems = buildHistoryNavItems(state);
  const workspaceNavItems = buildWorkspaceNavItems(state);
  const controlNavItems = buildControlNavItems(state);
  const historyRecords: HistoryRecord[] = [
    { id: 'quick-entry', label: '快捷入口', meta: `${state.traySummary.backgroundTasks.running} 个后台任务`, icon: 'panel-right', action: () => void window.roc.app.openQuickEntry() },
    { id: 'tray-entry', label: '托盘接管记录', meta: '后台状态同步', icon: 'panel-right', action: () => void window.roc.app.openTrayEntry() },
    {
      id: 'memory-record',
      label: '记忆整理裁决',
      meta: `记忆中心 · ${state.memoryConflicts.length} 条待确认`,
      icon: 'globe',
      activeWhen: 'memory',
      action: () => setActiveView('memory')
    },
    {
      id: 'task-record',
      label: '任务工作台记录',
      meta: `任务工作台 · 运行中 ${state.taskSnapshot.counts.running}`,
      icon: 'clipboard',
      activeWhen: 'tasks',
      action: () => setActiveView('tasks')
    }
  ];

  return (
    <div className={state.appStatus.mode === 'smoke' ? 'app-shell app-shell--smoke' : 'app-shell'} data-testid="roc-app">
      <header className="window-workband" data-testid="window-workband">
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

      <div className="workspace">
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
          <div className="sidebar-block sidebar-block--history">
            <div className="side-title">历史会话</div>
            <div className="sidebar-block-scroll history-list">
              <NavButton active={activeView === 'chat'} item={historyNavItems[0]} onClick={() => setActiveView('chat')} />
              {historyRecords.map((record) => (
                <button
                  className={record.activeWhen === activeView ? 'nav-button active' : 'nav-button'}
                  key={record.id}
                  type="button"
                  onClick={record.action}
                >
                  <PreviewIcon name={record.icon} />
                  <span className="nav-copy">
                    <span className="nav-label">{record.label}</span>
                    <span className="nav-meta">{record.meta}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <SidebarNavGroup className="sidebar-block sidebar-block--tasks" activeView={activeView} items={workspaceNavItems} title="任务工作台" onSelect={setActiveView} />
          <SidebarNavGroup className="sidebar-block sidebar-block--control" activeView={activeView} items={controlNavItems} title="控制区" onSelect={setActiveView} />
        </aside>

        <div
          style={hasWorkbench ? { '--workbench-width': `${workbenchWidth}px` } as React.CSSProperties : undefined}
          className={
            activeView === 'chat'
              ? 'workspace-shell workspace-shell--chat'
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
                  onOpenView={setActiveView}
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
                />
              </div>
            </section>
          </main>

          {hasWorkbench ? (
            <WorkbenchPanel
              activeTool={activeWorkbenchTool}
              activeView={activeView}
              onToolChange={setActiveWorkbenchTool}
              onClose={() => setActiveView('chat')}
              state={state}
              updateWorkspaceData={updateWorkspaceData}
              width={workbenchWidth}
              onWidthChange={setWorkbenchWidth}
              windowState={windowState}
            />
          ) : (
            <RailOverlay
              activeView={activeView}
              onOpenToolView={(view, tool) => {
                setActiveWorkbenchTool(tool);
                setActiveView(view);
              }}
            />
          )}
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

function sanitizeTestId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '-');
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

async function loadWorkspaceData(workspace: Workspace | null): Promise<WorkspaceData> {
  if (workspace === null) {
    return {
      fileTree: null,
      fileSearch: null,
      filePreview: null,
      gitStatus: null,
      gitError: null,
      terminalResult: null,
      terminalError: null
    };
  }

  const fileTree = unwrap<FileTreeResult>('file tree', await window.roc.files.listTree({ relativePath: '' }));
  const firstFile = fileTree.entries.find((entry) => entry.type === 'file');
  const filePreview =
    firstFile === undefined
      ? null
      : unwrap<FilePreviewResult>('file preview', await window.roc.files.preview({ relativePath: firstFile.relativePath }));
  const fileSearch = null;
  const gitResult = await window.roc.git.status();
  const terminalResult = await window.roc.shell.execute({
    command: 'dir',
    cwd: workspace.path,
    source: 'terminal'
  });

  return {
    fileTree,
    fileSearch,
    filePreview,
    gitStatus: gitResult.ok ? gitResult.data : null,
    gitError: gitResult.ok ? null : gitResult.error.message,
    terminalResult: terminalResult.ok ? terminalResult.data : null,
    terminalError: terminalResult.ok ? null : terminalResult.error.message
  };
}

async function loadPhase6Data(
  mode: AppStatus['mode']
): Promise<{
  backgroundTask: BackgroundTask | null;
  backgroundTasks: BackgroundTask[];
  traySummary: TraySummary;
  diagnosticPackage: DiagnosticPackage | null;
  performanceSample: PerformanceSample;
  doctor: DoctorSnapshot;
}> {
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
  const [traySummary, doctor] = await Promise.all([window.roc.lifecycle.getTraySummary(), window.roc.doctor.run()]);

  return {
    backgroundTask,
    backgroundTasks,
    traySummary: unwrap<TraySummary>('tray summary', traySummary),
    diagnosticPackage,
    performanceSample,
    doctor: unwrap<DoctorSnapshot>('doctor', doctor)
  };
}

async function loadMemoryData(_mode: AppStatus['mode']): Promise<{
  memoryStatus: MemoryStatus;
  memoryCandidates: MemoryCandidate[];
  memoryConflicts: MemoryConflict[];
  memorySearch: MemorySearchResult | null;
  sessionSearch: SessionSearchResult | null;
  memoryRecovery: MemoryDeleteResult | null;
}> {
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

async function loadCapabilityData(_mode: AppStatus['mode']): Promise<{
  providers: ProviderConfig[];
  defaultModelId: string | null;
  providerTestStatus: ProviderTestResult | null;
  mcpServers: McpServerSnapshot[];
  mcpTestStatus: McpServerTestResult | null;
  skills: SkillSnapshot[];
}> {
  const [providers, mcpServers, skills] = await Promise.all([
    window.roc.providers.list(),
    window.roc.mcp.listServers(),
    window.roc.skills.list()
  ]);
  const providerData = unwrap<{ providers: ProviderConfig[]; defaultModelId: string | null }>('providers', providers);
  const loadedMcpServers = unwrap<McpServerSnapshot[]>('mcp servers', mcpServers);
  const loadedSkills = unwrap<SkillSnapshot[]>('skills', skills);
  const providerTestStatus =
    providerData.providers.length === 0
      ? null
      : unwrap<ProviderTestResult>('provider test', await window.roc.providers.test(providerData.providers[0].id));
  const mcpTestStatus =
    loadedMcpServers.length === 0
      ? null
      : unwrap<McpServerTestResult>('mcp test', await window.roc.mcp.testServer(loadedMcpServers[0].id));

  return {
    providers: providerData.providers,
    defaultModelId: providerData.defaultModelId,
    providerTestStatus,
    mcpServers: loadedMcpServers,
    mcpTestStatus,
    skills: loadedSkills
  };
}

function ViewContent({
  activeView,
  chatError,
  onOpenView,
  onSelectWorkspace,
  onSubmitChatTask,
  state,
  updateLoadedState
}: {
  activeView: ViewId;
  chatError: string | null;
  onOpenView: (view: ViewId) => void;
  onSelectWorkspace: () => Promise<void>;
  onSubmitChatTask: (input: string) => Promise<boolean>;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  if (activeView === 'tasks') {
    return <TasksView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'workspace') {
    return <WorkspaceView onSelectWorkspace={onSelectWorkspace} state={state} />;
  }
  if (activeView === 'git') {
    return <GitView state={state} />;
  }
  if (activeView === 'terminal') {
    return <TerminalView state={state} />;
  }
  if (activeView === 'preview') {
    return <PreviewView state={state} />;
  }
  if (activeView === 'mcp') {
    return <McpView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'skills') {
    return <SkillsView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'memory') {
    return <MemoryView state={state} />;
  }
  if (activeView === 'settings') {
    return <SettingsView state={state} updateLoadedState={updateLoadedState} />;
  }
  if (activeView === 'doctor') {
    return <DoctorView state={state} />;
  }
  if (activeView === 'diagnostics') {
    return <DiagnosticsView state={state} />;
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
  const [submitting, setSubmitting] = useState(false);
  const visibleCapabilityServers = state.mcpServers.filter((server) => server.enabled);
  const visibleCapabilitySkills = state.skills.filter(
    (skill) => skill.enabled && skill.status === 'ready'
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

  return (
    <section className="canvas-stage chat-stage" data-testid="chat-view">
      <div className="chat-empty-plane" aria-label="聊天主画布"></div>
      <div className="chat-bottom-stack">
        {visibleCapabilityServers.length === 0 && visibleCapabilitySkills.length === 0 ? null : (
          <div className="capability-strip capability-strip--visible">
            {visibleCapabilityServers.map((server) => (
              <button
                className={state.selectedMcpServers.includes(server.id) ? 'selection-chip active' : 'selection-chip'}
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
                MCP {server.id}
              </button>
            ))}
            {visibleCapabilitySkills.map((skill) => (
              <button
                className={state.selectedSkills.includes(skill.id) ? 'selection-chip active' : 'selection-chip'}
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
                Skill {skill.id}
              </button>
            ))}
          </div>
        )}
        <div className="composer composer--chat">
          <textarea
            aria-label="输入消息"
            className="composer-input"
            data-testid="chat-input"
            placeholder="输入消息"
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
              <button className="composer-tool active" type="button" aria-label="工作区文件" onClick={() => onOpenView('workspace')}>
                <PreviewIcon name="folder" />
                <span className="tool-badge">T</span>
              </button>
              <button
                className={state.selectedMcpServers.length > 0 ? 'composer-tool active' : 'composer-tool'}
                type="button"
                aria-label="已启用 MCP"
                onClick={() => onOpenView('mcp')}
              >
                <PreviewIcon name="nodes" />
                <span className="tool-badge">{state.selectedMcpServers.length}</span>
              </button>
              <button
                className={state.selectedSkills.length > 0 ? 'composer-tool active' : 'composer-tool'}
                type="button"
                aria-label="已启用 Skill"
                onClick={() => onOpenView('skills')}
              >
                <PreviewIcon name="sparkles" />
                <span className="tool-badge">{state.selectedSkills.length}</span>
              </button>
              <button className="model-pill" type="button" onClick={() => onOpenView('settings')}>
                <PreviewIcon name="bot" />
                <span>{state.defaultModelId ?? '配置默认模型'}</span>
                <span>▾</span>
              </button>
            </div>
            <div className="composer-right">
              <button className="ghost-button" type="button" aria-label="可见性" onClick={() => onOpenView('memory')}>
                <PreviewIcon name="eye" />
              </button>
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
        <div className="chat-runtime-panels">
          <div className="capability-status" data-testid="turn-capabilities">
            <span data-testid="turn-mcp-selection">MCP 本轮 {state.selectedMcpServers.length}</span>
            <span data-testid="turn-skill-selection">Skill 本轮 {state.selectedSkills.length}</span>
            <span data-testid="turn-capability-ids">
              {[...state.selectedMcpServers, ...state.selectedSkills].join(', ')}
            </span>
          </div>
          {state.chatResult === null ? null : <ChatResultPanel result={state.chatResult} />}
          {state.agentCapabilityPreview === null ? null : <AgentCapabilityPreviewPanel preview={state.agentCapabilityPreview} />}
        </div>
        {state.agent.execution !== 'ready' ? <span className="inline-warning" data-testid="chat-blocked">需要先配置默认模型</span> : null}
        {chatError === null ? null : <span className="inline-warning" data-testid="chat-error">{chatError}</span>}
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
      <PageHeading kicker="任务控制" subtitle="后台任务、定时任务、执行轮次、追加指令、恢复点和验证结果读取同一任务状态。" title="任务工作台" />
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
            <EmptyState testId="background-task-controls" title="暂无后台任务" detail="当前没有后台任务或定时执行。" />
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
  onSelectWorkspace,
  state
}: {
  onSelectWorkspace: () => Promise<void>;
  state: LoadedState;
}): React.JSX.Element {
  if (state.workspace === null) {
    return (
      <>
        <PageHeading kicker="工作区" subtitle="工作区是默认执行边界；文件浏览、搜索、预览、编辑和高风险操作都进入任务轨迹。" title="工作区文件" />
        <section className="canvas-stage stage-grid" data-testid="workspace-view">
          <EmptyState
            action={
              <button className="action-button" data-testid="workspace-empty-select" type="button" onClick={() => void onSelectWorkspace()}>
                选择工作区
              </button>
            }
            testId="workspace-empty"
            title="未选择工作区"
            detail="请选择默认工作区后再读取文件、Git 和终端状态。"
          />
          <WorkspaceStatusPanels state={state} />
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading kicker="工作区" subtitle="工作区是默认执行边界；文件浏览、搜索、预览、编辑和高风险操作都进入任务轨迹。" title="工作区文件" />
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
        {state.terminalResult === null ? (
          <p className="muted">{state.terminalError}</p>
        ) : (
          <pre className="terminal">{state.terminalResult.stdout}</pre>
        )}
      </section>
      <section className="card" data-testid="rtk-panel">
        <div className="card-title">RTK</div>
        <Row title="资源状态" sub={state.rtkStatus.resourceState === 'ready' ? 'ready' : '缺失降级'} tag={state.rtkStatus.resourceState} tone="warn" />
        <Row title="tee" sub={state.rtkStatus.teeDir} tag={state.rtkStatus.enabledForAgentCommands ? 'agent' : 'terminal'} tone="info" />
      </section>
    </div>
  );
}

function GitView({ state }: { state: LoadedState }): React.JSX.Element {
  return (
    <>
      <PageHeading kicker="工作区" subtitle="查看状态、diff、历史和提交；push、回滚、批量暂存等动作进入确认策略。" title="Git 面板" />
      <section className="canvas-stage stage-grid" data-testid="git-view">
        <div className="grid-3">
          <Metric label="变更文件" note="来自 git status" value={state.gitStatus === null ? 0 : state.gitStatus.changedFiles} />
          <Metric label="当前分支" note="本地工作区" value={state.gitStatus === null ? '无仓库' : state.gitStatus.branch} />
          <Metric label="风险动作" note="push / 回滚需确认" tone="warn" value={2} />
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
              sub={`${state.gitStatus.porcelain.length} 条 porcelain 状态等待确认。`}
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
      <PageHeading kicker="工作区" subtitle="终端绑定当前工作区，命令目的、目录、输出、退出状态和风险级别保持可见。" title="嵌入式终端" />
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
          {buildVisibleTerminalOutput(state)}
        </div>
      </section>
    </>
  );
}

function PreviewView({ state }: { state: LoadedState }): React.JSX.Element {
  return (
    <>
      <PageHeading kicker="工作区" subtitle="文本、代码、Markdown、PDF、Office 和图片按需加载，大文件有明确限制和提示。" title="文件预览" />
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
              </>
            </div>
          </section>
          <section className="card">
            <div className="card-title">代码 / Diff 预览</div>
            <div className="code-preview">{state.filePreview === null ? '当前没有加载可预览内容。' : state.filePreview.content}</div>
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
      <PageHeading kicker="控制面" subtitle="统一查看 MCP 服务、MCP 工具、健康、授权和最近调用，异常项继续进入 Doctor 与任务轨迹。" title="MCP" />
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
      <PageHeading kicker="控制面" subtitle="统一管理 Skill 能力包、触发条件、依赖、启停状态与最近命中记录。" title="Skill" />
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

function MemoryView({ state }: { state: LoadedState }): React.JSX.Element {
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
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
        subtitle="查看、搜索、筛选、编辑、合并、禁用、恢复、删除、归档和手动触发整理。"
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
              <Row title="默认行为" sub="候选、冲突与升降级由模型后台静默处理。" tag="自动" tone="ok" />
              <p className="memory-side-note">这里只保留状态提示，不再展示一整块后台整理结果。</p>
            </section>
          </aside>
          <section className="memory-library-workspace">
            <div className="memory-editor-stage">
              <div className="memory-editor-topline">
                <div>
                  <div className="memory-editor-title">{selectedRecordTitle}</div>
                  <div className="memory-editor-subtitle">
                    {selectedRecord === null
                      ? '右侧编辑台是这页主工作区，正文预览、修改、元信息和高风险操作都集中在这里。'
                      : `当前选中：${selectedRecord.layer} / ${selectedRecord.scope}。右侧编辑台是这页主工作区，正文预览、修改、元信息和高风险操作都集中在这里。`}
                  </div>
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
      <PageHeading kicker="控制面" subtitle="设置作为一级页面，修改先进入草稿态；高影响配置保存前展示影响范围。" title="设置" />
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

function DoctorView({ state }: { state: LoadedState }): React.JSX.Element {
  return (
    <>
      <PageHeading kicker="控制面" subtitle="检查模型、工具、MCP、Skill、工作区、记忆索引、后台队列、托盘和恢复点。" title="Doctor" />
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

function DiagnosticsView({ state }: { state: LoadedState }): React.JSX.Element {
  const failedEvents = state.taskSnapshot.recentEvents.filter((event) => event.type === 'error').slice(0, 3);
  return (
    <>
      <PageHeading kicker="控制面" subtitle="失败任务、关键日志、脱敏包和性能采样集中展示。" title="任务诊断包" />
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
  activeView,
  onOpenToolView
}: {
  activeView: ViewId;
  onOpenToolView: (view: ViewId, tool: WorkbenchTool) => void;
}): React.JSX.Element {
  return (
    <aside className={activeView === 'chat' ? 'rail-overlay rail-overlay--chat' : 'rail-overlay'}>
      <div className={activeView === 'chat' ? 'rail rail--chat' : 'rail'}>
        {WORKBENCH_TOOLS.map((tool) => {
          const nextView: ViewId = tool.id === 'files' ? 'workspace' : tool.id;
          return (
            <button
              aria-label={tool.label}
              aria-pressed={activeView === nextView}
              className="rail-button"
              data-tool-button={tool.id}
              key={tool.id}
              type="button"
              onClick={() => onOpenToolView(nextView, tool.id)}
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
          <GitWorkbench state={state} updateWorkspaceData={updateWorkspaceData} />
        ) : activeTool === 'terminal' ? (
          <TerminalWorkbench state={state} updateWorkspaceData={updateWorkspaceData} windowState={windowState} />
        ) : (
          <FilesWorkbench state={state} updateWorkspaceData={updateWorkspaceData} />
        )}
      </div>
    </aside>
  );
}

function FilesWorkbench({
  state,
  updateWorkspaceData
}: {
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
}): React.JSX.Element {
  const fileCount = state.fileTree?.entries.length ?? 0;
  const previewPath = state.filePreview?.relativePath ?? '当前没有可预览文件';
  const searchCount = state.fileSearch?.matches.length ?? 0;
  async function openFilePreview(relativePath: string): Promise<void> {
    const preview = unwrap<FilePreviewResult>('file preview', await window.roc.files.preview({ relativePath }));
    let fileSearch: FileSearchResult | null = null;
    if (preview.kind === 'text') {
      const firstToken = preview.content.split(/\s+/).find((token) => token.trim().length > 0);
      if (firstToken !== undefined) {
        const search = await window.roc.files.search({ query: firstToken, maxResults: 8 });
        fileSearch = search.ok ? search.data : null;
      }
    }
    updateWorkspaceData({ filePreview: preview, fileSearch });
  }

  return (
    <section className="tool-panel">
      <div className="tool-stack">
        <div className="dock-preview-card">
          <div>
            <div className="dock-preview-title">文件</div>
            <div className="dock-preview-subtitle">查看当前工作区文件、预览目录和选中文件上下文。</div>
          </div>
          <div className="dock-preview-copy">{state.workspace === null ? '未选择工作区。' : state.workspace.path}</div>
        </div>
        <section className="file-tree" data-testid="workbench-file-tree">
          {state.fileTree === null ? (
            <p className="muted">未选择工作区。</p>
          ) : (
            state.fileTree.entries.slice(0, 80).map((entry) => (
              <TreeItem
                active={state.filePreview?.relativePath === entry.relativePath}
                entry={entry}
                key={entry.relativePath}
                onClick={entry.type === 'file' ? () => void openFilePreview(entry.relativePath) : undefined}
              />
            ))
          )}
        </section>
        <section className="code-preview workbench-preview" data-testid="workbench-file-preview">
          {state.filePreview === null
            ? '当前没有加载可预览内容。'
            : `${state.filePreview.relativePath}\n\n${
                state.filePreview.kind === 'binary' ? `二进制文件，大小 ${state.filePreview.sizeBytes} bytes。` : state.filePreview.content
              }`}
        </section>
        <section className="card">
          <div className="card-title">当前文件上下文</div>
          <Row title="文件总数" sub={state.workspace === null ? '未选择工作区' : state.workspace.path} tag={`${fileCount} 项`} tone="info" />
          <Row title="当前预览" sub={previewPath} tag={state.filePreview === null ? '空态' : '已加载'} tone={state.filePreview === null ? 'warn' : 'ok'} />
          <Row title="搜索命中" sub="当前查询" tag={`${searchCount} 条`} tone="info" />
          <Row title="RTK" sub={state.rtkStatus.teeDir} tag={state.rtkStatus.resourceState === 'ready' ? '可用' : '缺失降级'} tone="warn" />
        </section>
      </div>
    </section>
  );
}

function GitWorkbench({
  state,
  updateWorkspaceData
}: {
  state: LoadedState;
  updateWorkspaceData: (partial: Partial<WorkspaceData>) => void;
}): React.JSX.Element {
  async function refreshGitStatus(): Promise<void> {
    const gitStatus = await window.roc.git.status();
    updateWorkspaceData({
      gitStatus: gitStatus.ok ? gitStatus.data : null,
      gitError: gitStatus.ok ? null : gitStatus.error.message
    });
  }

  async function stageFile(relativePath: string): Promise<void> {
    const gitStatus = unwrap<GitStatusResult>('git stage file', await window.roc.git.stageFile({ relativePath }));
    updateWorkspaceData({ gitStatus, gitError: null });
  }

  async function unstageFile(relativePath: string): Promise<void> {
    const gitStatus = unwrap<GitStatusResult>('git unstage file', await window.roc.git.unstageFile({ relativePath }));
    updateWorkspaceData({ gitStatus, gitError: null });
  }

  return (
    <section className="tool-panel">
      <div className="tool-stack">
        <div className="dock-preview-card">
          <div>
            <div className="dock-preview-title">Git</div>
            <div className="dock-preview-subtitle">状态、diff 和提交风险继续集中在右侧工作台。</div>
          </div>
          <div className="dock-preview-copy">{state.gitStatus === null ? gitErrorLabel(state.gitError) : state.gitStatus.branch}</div>
        </div>
        <section className="card">
          <div className="card-title">Git 常用操作</div>
          <div className="action-strip">
            <button type="button" onClick={() => void refreshGitStatus()}>刷新 status</button>
            <button type="button" disabled={state.gitStatus === null} onClick={() => void refreshGitStatus()}>
              查看 changes
            </button>
          </div>
        </section>
        <section className="card" data-testid="workbench-git-changes">
          <div className="card-title">Changes</div>
          {state.gitStatus === null ? (
            <Row title="当前工作区" sub={gitErrorLabel(state.gitError)} tag="非 Git 仓库" tone="warn" />
          ) : state.gitStatus.porcelain.length === 0 ? (
            <Row title="工作区" sub={state.gitStatus.workspacePath} tag="干净" tone="ok" />
          ) : (
            gitStatusChanges(state.gitStatus).map((change) => {
              const safeId = sanitizeTestId(change.relativePath);
              return (
                <div className="row action-row git-change-row" key={change.porcelain}>
                  <div>
                    <div className="row-title">{change.porcelain}</div>
                    <div className="row-sub">{change.relativePath}</div>
                  </div>
                  <span className="pill warn">{`${change.index}${change.worktree}`}</span>
                  <button
                    data-testid={`git-stage-${safeId}`}
                    disabled={!canStageGitChange(change)}
                    type="button"
                    onClick={() => void stageFile(change.relativePath)}
                  >
                    暂存
                  </button>
                  <button
                    data-testid={`git-unstage-${safeId}`}
                    disabled={!canUnstageGitChange(change)}
                    type="button"
                    onClick={() => void unstageFile(change.relativePath)}
                  >
                    取消暂存
                  </button>
                </div>
              );
            })
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
  const [command, setCommand] = useState('dir');
  const [running, setRunning] = useState(false);

  async function runCommand(): Promise<void> {
    if (state.workspace === null) {
      updateWorkspaceData({ terminalResult: null, terminalError: '请先选择工作区。' });
      return;
    }
    const trimmedCommand = command.trim();
    if (trimmedCommand.length === 0) {
      updateWorkspaceData({ terminalResult: null, terminalError: '命令不能为空。' });
      return;
    }
    setRunning(true);
    try {
      const result = await window.roc.shell.execute({
        command: trimmedCommand,
        cwd: state.workspace.path,
        source: 'terminal'
      });
      if (!result.ok) {
        updateWorkspaceData({ terminalResult: null, terminalError: result.error.message });
        return;
      }
      updateWorkspaceData({ terminalResult: result.data, terminalError: null });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="tool-panel">
      <div className="tool-stack">
        <div className="dock-preview-card">
          <div>
            <div className="dock-preview-title">Terminal</div>
            <div className="dock-preview-subtitle">命令执行边界、输出和状态保持可见。</div>
          </div>
          <div className="dock-preview-copy">{visibleWorkspaceCwd(state)}</div>
        </div>
        <div className="terminal-session">
          <pre className="terminal" data-testid="terminal-live-output">
            {state.terminalResult === null
              ? buildVisibleTerminalOutput(state)
              : `> ${state.terminalResult.command}\n${state.terminalResult.stdout}${state.terminalResult.stderr}`}
          </pre>
          <div className="terminal-command-row">
            <input
              data-testid="terminal-command-input"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void runCommand();
                }
              }}
            />
            <button data-testid="terminal-run-command" disabled={running} type="button" onClick={() => void runCommand()}>
              {running ? '运行中' : '运行'}
            </button>
          </div>
        </div>
        <section className="card">
          <div className="card-title">终端边界</div>
          <Row title="目录" sub="限定当前工作区" tag="受控" tone="ok" />
          <Row title="高风险命令" sub="仍然进入确认策略" tag="开启" tone="warn" />
        </section>
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
  subtitle,
  title
}: {
  flags?: React.ReactNode;
  kicker: string;
  subtitle: string;
  title: string;
}): React.JSX.Element {
  return (
    <div className="page-strip">
      <div className="page-copy">
        <div className="page-kicker">{kicker}</div>
        <h1 className="page-title">{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
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
  return (
    <div className={`metric ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      <span className="row-sub">{note}</span>
    </div>
  );
}

function Row({
  sub,
  tag,
  title,
  tone = 'neutral'
}: {
  sub: string;
  tag: string;
  title: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info';
}): React.JSX.Element {
  return (
    <div className="row">
      <div>
        <div className="row-title">{title}</div>
        <div className="row-sub">{sub}</div>
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
  entry,
  onClick
}: {
  active?: boolean;
  entry: FileTreeResult['entries'][number];
  onClick?: () => void;
}): React.JSX.Element {
  const className = active || entry.type === 'file' ? 'tree-item selected' : 'tree-item';
  if (onClick !== undefined) {
    return (
      <button className={className} data-testid={`workbench-file-${sanitizeTestId(entry.relativePath)}`} type="button" onClick={onClick}>
        <span>{entry.type === 'directory' ? '▸' : '•'}</span>
        <span>{entry.relativePath}</span>
      </button>
    );
  }
  return (
    <div className={className}>
      <span>{entry.type === 'directory' ? '▸' : '•'}</span>
      <span>{entry.relativePath}</span>
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
  detail,
  testId
}: {
  action?: React.ReactNode;
  title: string;
  detail: string;
  testId: string;
}): React.JSX.Element {
  return (
    <div className="empty-state" data-testid={testId}>
      <CircleAlert size={24} />
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}

function sumMcpTools(servers: McpServerSnapshot[]): number {
  return servers.reduce((total, server) => total + server.tools, 0);
}
